import fsp from "node:fs/promises";
import path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  DEFAULT_COMPLETION_POLICY,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_ACKNOWLEDGED_SUCCESS_TTL_MS,
  DEFAULT_NAMED_RUN_LEASE_MS,
  DEFAULT_STALE_RUN_MS,
  DEFAULT_SUCCESS_VISIBILITY_GRACE_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  MAX_WAIT_TIMEOUT_MS,
  MESSAGE_TYPE_ATTENTION,
  MESSAGE_TYPE_COMPLETION,
  MESSAGE_TYPE_PIN,
  MESSAGE_TYPE_FAILURE,
  MESSAGE_TYPE_LAUNCH,
  PERSISTED_STATE_ENTRY,
  STATUS_KEY,
  WIDGET_KEY,
} from "../defaults.js";
import type { LaunchChildRequest, LaunchGroupRequest, LaunchResult, LaunchWorkflowRequest, Launcher, LauncherRuntimeContext, NormalizedRunUpdate } from "../launcher/interface.js";
import type { WorkflowStepResult } from "../launcher/workflow-results.js";
import { legacyResultPathFromAsyncDir, PiSubagentsAdapter } from "../launcher/pi-subagents-adapter.js";
import { createPersistedState, restorePersistedState } from "../state/persistence.js";
import { RunRegistry, validateRunName } from "../state/run-registry.js";
import { buildCompletionFingerprint } from "../state/dedupe.js";
import type { RunEvent, RunRecord, RunRegistrySnapshot, RunStatus } from "../types.js";
import { decideCompletionRouting } from "./completion-router.js";
import { buildHiddenSummary } from "./hidden-summary.js";
import {
  createAttentionMessagePayload,
  createCompletionMessagePayload,
  createFailureMessagePayload,
  createLaunchMessagePayload,
  formatRunMessageBody,
  type RunMessagePayload,
} from "../ui/messages.js";
import { buildFooterStatus } from "../ui/status.js";
import { buildWidgetLines, createWidgetContent } from "../ui/widget.js";
import { buildLiveRunViewModel } from "../ui/live-run-view-model.js";
import { formatCompactThousands, formatDuration } from "../utils/time.js";
import { summarizeSingleLine } from "../utils/text.js";
import { clampCacheHitRate } from "../utils/usage-metrics.js";

export interface LazySubagentsControllerOptions {
  launcher?: Launcher;
  pollIntervalMs?: number;
  readUpdateTimeoutMs?: number;
  now?: () => number;
  createRunId?: () => string;
}

export type ControllerLaunchChildRequest = Omit<LaunchChildRequest, "runId">;
export type ControllerLaunchGroupRequest = Omit<LaunchGroupRequest, "runId">;
export type ControllerLaunchWorkflowRequest = Omit<LaunchWorkflowRequest, "runId">;

export interface WaitProgressDetails {
  kind: "wait-progress";
  runId: string;
  status: RunStatus;
  lines: string[];
}

export type WaitProgressUpdate = {
  content: Array<{ type: "text"; text: string }>;
  details: WaitProgressDetails;
};

export type WaitForRunSignalResult =
  | { status: "ready"; run: RunRecord }
  | { status: "timeout"; run?: RunRecord }
  | { status: "not_found" }
  | { status: "ambiguous"; activeRuns: RunRecord[] }
  | { status: "no_active_runs" }
  | { status: "aborted" };

const DEFAULT_READ_UPDATE_TIMEOUT_MS = 500;

class ReadUpdateTimeoutError extends Error {
  constructor(runId: string, timeoutMs: number) {
    super(`Timed out reading update for ${runId} after ${timeoutMs}ms`);
  }
}

function isTerminalStatus(status: RunStatus): boolean {
  return status === "completed" || status === "skipped" || status === "failed" || status === "cancelled" || status === "paused";
}

function isPinnedPanelEligibleStatus(status: RunStatus): boolean {
  return status === "queued" || status === "running" || status === "blocked" || status === "paused";
}

function isPersistedStateEntry(value: unknown): value is { data?: unknown } {
  return typeof value === "object"
    && value !== null
    && "type" in value
    && (value as { type?: unknown }).type === "custom"
    && "customType" in value
    && (value as { customType?: unknown }).customType === PERSISTED_STATE_ENTRY;
}

function getCurrentBranchEntries(ctx: ExtensionContext): unknown[] {
  const sessionManager = ctx.sessionManager as ExtensionContext["sessionManager"] & {
    getBranch?: () => unknown[];
  };
  return typeof sessionManager.getBranch === "function"
    ? sessionManager.getBranch()
    : sessionManager.getEntries();
}

function readLatestPersistedState(ctx: ExtensionContext): ReturnType<typeof restorePersistedState> {
  const entry = [...getCurrentBranchEntries(ctx)].reverse().find((candidate) => isPersistedStateEntry(candidate));
  return restorePersistedState(entry?.data);
}

function buildLaunchEvent(run: RunRecord, timestamp: number): RunEvent {
  return {
    id: `${run.id}:${timestamp}:launch`,
    category: "launch",
    timestamp,
    summary: `Launched ${run.agent} · ${run.title || run.taskSummary}`,
    status: run.status,
  };
}

const SINGLE_WORKFLOW_REFERENCE_PATTERN = /^\{\{\s*([A-Za-z0-9_-]+)\.([A-Za-z0-9_.-]+)\s*\}\}$/u;

function extractWorkflowReferenceStepIds(template: string | undefined): string[] {
  if (!template) return [];
  return [...String(template).matchAll(/\{\{\s*([A-Za-z0-9_-]+)\.[A-Za-z0-9_.-]+\s*\}\}/gu)]
    .map((match) => match[1])
    .filter((stepId) => stepId !== "item");
}

function isSingleWorkflowReference(template: string | undefined): boolean {
  return Boolean(template && SINGLE_WORKFLOW_REFERENCE_PATTERN.test(template.trim()));
}

function appendUniqueWorkflowDependency(dependsOn: string[], dependencyId: string | undefined): void {
  const normalizedDependencyId = dependencyId?.trim();
  if (normalizedDependencyId && !dependsOn.includes(normalizedDependencyId)) {
    dependsOn.push(normalizedDependencyId);
  }
}

function assertValidWorkflowRequest(request: ControllerLaunchWorkflowRequest): void {
  if (request.maxConcurrency !== undefined && (!Number.isInteger(request.maxConcurrency) || request.maxConcurrency < 1)) {
    throw new Error("maxConcurrency must be an integer greater than or equal to 1.");
  }

  const steps = request.steps;
  if (steps.length === 0) {
    throw new Error("Workflow requests must include at least one step.");
  }

  const normalizedSteps = steps.map((step) => ({
    step,
    id: step.id.trim(),
    dependsOn: (step.dependsOn ?? []).map((dependencyId) => dependencyId.trim()),
  }));

  const ids = new Set<string>();
  for (const { step, id, dependsOn } of normalizedSteps) {
    if (!id) {
      throw new Error("Workflow step ids must be non-empty strings.");
    }
    if (ids.has(id)) {
      throw new Error(`Duplicate workflow step id: ${id}`);
    }
    ids.add(id);
    step.id = id;
    step.dependsOn = dependsOn;

    if (step.retries !== undefined && (!Number.isInteger(step.retries) || step.retries < 0)) {
      throw new Error(`Workflow step ${id} has an invalid retries value. Expected a non-negative integer.`);
    }
    if (step.when !== undefined && (typeof step.when !== "string" || step.when.trim().length === 0)) {
      throw new Error(`Workflow step ${id} has an invalid when value. Expected a non-empty string.`);
    }
    if (step.when !== undefined && !isSingleWorkflowReference(step.when)) {
      throw new Error(`Workflow step ${id} when must be a single workflow reference like {{triage.structured.runSecurity}}.`);
    }
    if (step.fanOutFrom) {
      const sourceStep = step.fanOutFrom.step?.trim();
      const pathExpression = step.fanOutFrom.path?.trim();
      if (!sourceStep || !pathExpression) {
        throw new Error(`Workflow step ${id} has an invalid fanOutFrom value. Expected step and path.`);
      }
      step.fanOutFrom.step = sourceStep;
      step.fanOutFrom.path = pathExpression;
      if (step.fanOutFrom.maxItems !== undefined && (!Number.isInteger(step.fanOutFrom.maxItems) || step.fanOutFrom.maxItems < 0)) {
        throw new Error(`Workflow step ${id} has an invalid fanOutFrom maxItems value. Expected a non-negative integer.`);
      }
    }

    for (const referencedStepId of extractWorkflowReferenceStepIds(step.prompt)) {
      appendUniqueWorkflowDependency(dependsOn, referencedStepId);
    }
    for (const referencedStepId of extractWorkflowReferenceStepIds(step.when)) {
      appendUniqueWorkflowDependency(dependsOn, referencedStepId);
    }
    if (step.fanOutFrom) {
      appendUniqueWorkflowDependency(dependsOn, step.fanOutFrom.step);
    }
  }

  for (const { id, step, dependsOn } of normalizedSteps) {
    for (const referencedStepId of extractWorkflowReferenceStepIds(step.prompt)) {
      if (!ids.has(referencedStepId)) {
        throw new Error(`Workflow step ${id} prompt references unknown step ${referencedStepId}.`);
      }
    }

    for (const referencedStepId of extractWorkflowReferenceStepIds(step.when)) {
      if (!ids.has(referencedStepId)) {
        throw new Error(`Workflow step ${id} when references unknown step ${referencedStepId}.`);
      }
    }

    if (step.fanOutFrom) {
      const sourceStep = step.fanOutFrom.step;
      if (!ids.has(sourceStep)) {
        throw new Error(`Workflow step ${id} fanOutFrom references unknown step ${sourceStep}.`);
      }
      if (sourceStep === id) {
        throw new Error(`Workflow step ${id} cannot fanOutFrom itself.`);
      }
      const source = normalizedSteps.find((candidate) => candidate.id === sourceStep)?.step;
      if (source?.outputMode !== "json") {
        throw new Error(`Workflow step ${id} fanOutFrom source ${sourceStep} must use outputMode=json.`);
      }
    }

    for (const dependencyId of dependsOn) {
      if (!dependencyId) {
        throw new Error(`Workflow step ${id} has an empty dependency id.`);
      }
      if (!ids.has(dependencyId)) {
        throw new Error(`Workflow step ${id} depends on unknown step ${dependencyId}.`);
      }
      if (dependencyId === id) {
        throw new Error(`Workflow step ${id} cannot depend on itself.`);
      }
    }
  }

  const stepsById = new Map(normalizedSteps.map(({ id, dependsOn }) => [id, dependsOn]));
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (stepId: string): void => {
    if (visited.has(stepId)) return;
    if (visiting.has(stepId)) {
      throw new Error(`Workflow dependency cycle detected at step ${stepId}.`);
    }

    visiting.add(stepId);
    for (const dependencyId of stepsById.get(stepId) ?? []) {
      visit(dependencyId);
    }
    visiting.delete(stepId);
    visited.add(stepId);
  };

  for (const { id } of normalizedSteps) {
    visit(id);
  }
}

function equalUpdate(existing: RunRecord, update: NormalizedRunUpdate): boolean {
  return existing.status === update.status
    && existing.updatedAt === update.updatedAt
    && existing.completedAt === update.completedAt
    && existing.sessionFile === update.sessionFile
    && existing.artifactPath === update.artifactPath
    && existing.resultPreview === update.resultPreview
    && existing.errorPreview === update.errorPreview
    && existing.currentTool === update.currentTool
    && (update.childProgress === undefined || JSON.stringify(existing.childProgress ?? []) === JSON.stringify(update.childProgress))
    && existing.toolCount === update.toolCount
    // equalUpdate compares against mergeTotalTokens because missing totals should preserve an existing non-zero value; the tests also cover the zero-update case, so we deliberately merge instead of comparing directly.
    && existing.totalTokens === mergeTotalTokens(existing.totalTokens, update.totalTokens)
    && existing.promptTokens === (update.promptTokens ?? existing.promptTokens)
    && existing.cacheReadTokens === (update.cacheReadTokens ?? existing.cacheReadTokens)
    && existing.cacheHitRate === (clampCacheHitRate(update.cacheHitRate ?? existing.cacheHitRate) ?? existing.cacheHitRate)
    && existing.attentionNeeded === (update.attentionNeeded ?? false);
}

function runtimeContext(pi: ExtensionAPI, ctx: ExtensionContext): LauncherRuntimeContext {
  return {
    pi,
    cwd: ctx.cwd,
    sessionId: ctx.sessionManager.getSessionId(),
    currentModelProvider: ctx.model?.provider,
  };
}

function messageTypeForPayload(payload: RunMessagePayload): string {
  switch (payload.kind) {
    case "launch":
      return MESSAGE_TYPE_LAUNCH;
    case "completion":
      return MESSAGE_TYPE_COMPLETION;
    case "failure":
      return MESSAGE_TYPE_FAILURE;
    case "attention":
      return MESSAGE_TYPE_ATTENTION;
  }
}

function mergeTotalTokens(existing: number | undefined, incoming: number | undefined): number | undefined {
  if (incoming === undefined) return existing;
  if (existing === undefined) return incoming;
  return Math.max(existing, incoming);
}

interface RunHealthAlert {
  event: RunEvent;
  status?: RunStatus;
}

interface ApplyUpdateResult {
  stateChanged: boolean;
  recordedEvent: boolean;
}

function buildRunHealthAlerts(run: RunRecord, now: number): RunHealthAlert[] {
  if (isTerminalStatus(run.status)) return [];

  const alerts: RunHealthAlert[] = [];
  const silenceMs = Math.max(0, now - run.updatedAt);
  if (silenceMs >= DEFAULT_STALE_RUN_MS) {
    const staleWindow = Math.floor(silenceMs / DEFAULT_STALE_RUN_MS);
    alerts.push({
      status: "blocked",
      event: {
        id: `${run.id}:health:stale:${run.updatedAt}:${staleWindow}`,
        category: "attention",
        timestamp: run.updatedAt,
        summary: `No progress from ${run.agent} for ${formatDuration(silenceMs)}. The child may be stuck; inspect /lazy-subagents status ${run.id}.`,
        status: "blocked",
      },
    });
  }

  return alerts;
}

function formatPickupMessage(run: RunRecord, result: string): string {
  return [
    "Lazy subagent result",
    `Run: ${run.id}`,
    `Agent: ${run.agent}`,
    `Task: ${run.title || run.taskSummary}`,
    `Status: ${run.status}`,
    "",
    result,
  ].join("\n");
}

const COMPLETION_RESULT_EXCERPT_MAX_CHARS = 12_000;

type ParsedRunResult = {
  summary?: string;
  results?: WorkflowStepResult[];
};

type CompletionReportLink = {
  label: string;
  path: string;
};

type CompletionResultDetails = {
  text?: string;
  summary?: string;
  reports: CompletionReportLink[];
};

function truncateCompletionResult(text: string): string {
  if (text.length <= COMPLETION_RESULT_EXCERPT_MAX_CHARS) return text;
  return `${text.slice(0, COMPLETION_RESULT_EXCERPT_MAX_CHARS).trimEnd()}\n\n[Result excerpt truncated. Read the full report path above.]`;
}

function collectCompletionReports(run: RunRecord, childReports: CompletionReportLink[], includeParentReports: boolean): CompletionReportLink[] {
  const reports: CompletionReportLink[] = [];
  const seen = new Set<string>();

  const addReport = (label: string, reportPath: string | undefined): void => {
    const normalizedPath = normalizeResultText(reportPath);
    if (!normalizedPath || seen.has(normalizedPath)) return;
    seen.add(normalizedPath);
    reports.push({ label, path: normalizedPath });
  };

  if (includeParentReports) {
    addReport("Full report", run.artifactPath);
    addReport("Result file", run.launchRef?.resultPath);
    addReport("Session file", run.sessionFile);
  }

  for (const report of childReports) {
    addReport(report.label, report.path);
  }

  return reports;
}

function formatCompletionInput(run: RunRecord, summary: string, result?: CompletionResultDetails): string {
  const signal = run.status === "completed" || run.status === "skipped"
    ? "DONE"
    : run.status === "failed"
      ? "FAILED"
      : "ATTENTION";
  const reportPath = run.artifactPath ?? run.launchRef?.resultPath ?? run.sessionFile;
  const includeParentReports = run.kind !== "single";
  const reports = collectCompletionReports(run, result?.reports ?? [], includeParentReports);
  const lines = [`[${signal}] ${run.title || run.taskSummary}`, ""];

  if (reports.length > 0) {
    lines.push("Reports:");
    for (const report of reports) {
      lines.push(`- ${report.label}: ${report.path}`);
    }
    lines.push("");
  } else if (reportPath) {
    lines.push(`Full report: ${reportPath}`, "");
  }

  if (result?.summary) {
    lines.push("Summary:", result.summary, "");
  }

  if (result?.text && run.status === "completed") {
    lines.push("Result excerpt:", truncateCompletionResult(result.text));
    return lines.join("\n");
  }

  lines.push(summary);
  return lines.join("\n");
}

function normalizeResultText(text: string | undefined): string | undefined {
  const normalized = text?.trim();
  return normalized ? normalized : undefined;
}

function extractEventTotalTokens(event: Record<string, any>): number | undefined {
  const candidates = [
    event?.message?.usage?.totalTokens,
    event?.assistantMessageEvent?.partial?.usage?.totalTokens,
    event?.assistantMessageEvent?.message?.usage?.totalTokens,
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate)) {
      return candidate;
    }
  }

  return undefined;
}

function extractAssistantText(message: { role?: string; content?: Array<{ type?: string; text?: string }> } | undefined): string | undefined {
  if (!message || message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
  const text = message.content
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n")
    .trim();
  return text || undefined;
}

function formatToolProgressDetail(event: Record<string, any>): string | undefined {
  const args = event.args;
  if (!args || typeof args !== "object") return undefined;

  switch (event.toolName) {
    case "bash":
      return summarizeSingleLine(typeof args.command === "string" ? args.command : undefined, 120);
    case "read":
    case "write":
    case "edit":
      return summarizeSingleLine(typeof args.path === "string" ? args.path : undefined, 120);
    case "grep":
      return summarizeSingleLine(typeof args.pattern === "string" ? `/${args.pattern}/` : undefined, 80);
    case "find":
      return summarizeSingleLine(typeof args.pattern === "string" ? args.pattern : undefined, 80);
    default:
      try {
        return summarizeSingleLine(JSON.stringify(args), 120);
      } catch {
        return undefined;
      }
  }
}

function formatProgressLine(rawLine: string): string | undefined {
  let envelope: { index?: number; raw?: string } | undefined;
  try {
    envelope = JSON.parse(rawLine) as { index?: number; raw?: string };
  } catch {
    return summarizeSingleLine(rawLine);
  }

  if (!envelope?.raw) return undefined;

  let event: Record<string, any>;
  try {
    event = JSON.parse(envelope.raw) as Record<string, any>;
  } catch {
    return summarizeSingleLine(envelope.raw);
  }

  const prefix = typeof envelope.index === "number" && envelope.index > 0 ? `#${envelope.index + 1} · ` : "";
  const tokenSuffix = (() => {
    const totalTokens = extractEventTotalTokens(event);
    return totalTokens && totalTokens > 0 ? ` · ${formatCompactThousands(totalTokens)} tokens` : "";
  })();

  switch (event.type) {
    case "tool_execution_start": {
      const detail = formatToolProgressDetail(event);
      return `${prefix}tool start · ${event.toolName ?? "unknown"}${detail ? ` · ${detail}` : ""}`;
    }
    case "tool_execution_end":
      return `${prefix}tool end · ${event.toolName ?? "unknown"}`;
    case "message_end": {
      const preview = summarizeSingleLine(extractAssistantText(event.message));
      return preview ? `${prefix}assistant · ${preview}${tokenSuffix}` : undefined;
    }
    case "turn_end":
      return `${prefix}turn end${tokenSuffix}`;
    default:
      return undefined;
  }
}

function createSnapshotCounts(runs: RunRecord[]): RunRegistrySnapshot["counts"] {
  return {
    queued: runs.filter((run) => run.status === "queued").length,
    running: runs.filter((run) => run.status === "running").length,
    blocked: runs.filter((run) => run.status === "blocked").length,
    completed: runs.filter((run) => run.status === "completed").length,
    skipped: runs.filter((run) => run.status === "skipped").length,
    failed: runs.filter((run) => run.status === "failed").length,
    cancelled: runs.filter((run) => run.status === "cancelled").length,
    paused: runs.filter((run) => run.status === "paused").length,
    attentionNeeded: runs.filter((run) => run.attentionNeeded).length,
  };
}

function shouldKeepRunVisibleInUi(
  run: RunRecord,
  options: { isPinned: boolean; isAcknowledged: boolean; now: number },
): boolean {
  if (!isTerminalStatus(run.status)) return true;
  if (run.archived) return false;
  if (options.isPinned && run.status !== "completed" && run.status !== "skipped") return true;
  if (run.attentionNeeded) return true;
  if (run.status === "failed" || run.status === "paused") return true;

  if (run.status !== "completed" && run.status !== "skipped") return false;
  if (options.isAcknowledged) return false;
  if (run.completedAt === undefined) return true;
  return options.now - run.completedAt <= DEFAULT_SUCCESS_VISIBILITY_GRACE_MS;
}

/**
 * Compute lease expiry for a named completed run.
 * Returns the existing leaseExpiry if set, otherwise computes a fresh
 * one from completedAt + leaseMs.
 */
function computeLeaseExpiry(
  run: RunRecord,
  leaseMs: number = DEFAULT_NAMED_RUN_LEASE_MS,
): number | undefined {
  if (!run.name) return undefined;
  if (run.completedAt === undefined) return undefined;
  return run.leaseExpiry ?? run.completedAt + leaseMs;
}

export class LazySubagentsController {
  private registry = new RunRegistry();
  private readonly launcher: Launcher;
  private readonly pollIntervalMs: number;
  private readonly readUpdateTimeoutMs: number;
  private readonly now: () => number;
  private readonly createRunId: () => string;
  private readonly trackedLaunches = new Map<string, LaunchResult>();
  private readonly progressLines = new Map<string, string[]>();
  private readonly progressStats = new Map<string, { turnCount: number; lastTurnTokens?: number }>();
  private readonly surfacedPinnedMessages = new Set<string>();
  private readonly reservedLaunchNames = new Set<string>();
  private pinnedWidgetVisible = true;
  private renderedStatus: string | undefined;
  private renderedWidgetSignature: string | undefined;
  private currentCtx: ExtensionContext | undefined;
  private poller: ReturnType<typeof setInterval> | undefined;
  private activePoll: Promise<void> | undefined;

  constructor(
    private readonly pi: ExtensionAPI,
    options: LazySubagentsControllerOptions = {},
  ) {
    this.launcher = options.launcher ?? new PiSubagentsAdapter();
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.readUpdateTimeoutMs = options.readUpdateTimeoutMs ?? DEFAULT_READ_UPDATE_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.createRunId = options.createRunId ?? (() => crypto.randomUUID());
  }

  captureContext(ctx: ExtensionContext): void {
    this.currentCtx = ctx;
  }

  getSnapshot(): RunRegistrySnapshot {
    return this.registry.snapshot();
  }

  acknowledgeRun(runId: string): boolean {
    const run = this.registry.get(runId);
    if (!run) return false;

    this.registry.acknowledgeRun(runId);
    this.cleanupExpiredNamedRunLeases();
    this.cleanupAcknowledgedCompletedRuns();
    this.persistState();
    this.renderUi();
    this.refreshPoller();
    return true;
  }

  async handleSessionStart(ctx: ExtensionContext): Promise<void> {
    await this.restoreBranchState(ctx);
  }

  async handleSessionTree(ctx: ExtensionContext): Promise<void> {
    await this.restoreBranchState(ctx);
  }

  async handleSessionShutdown(ctx: ExtensionContext): Promise<void> {
    this.stopPoller();
    this.progressLines.clear();
    this.progressStats.clear();
    if (ctx.hasUI) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
      ctx.ui.setWidget(WIDGET_KEY, undefined);
    }
    this.renderedStatus = undefined;
    this.renderedWidgetSignature = undefined;
    this.currentCtx = undefined;
  }

  private reserveLaunchName(name: string | undefined): { normalizedName?: string; release: () => void } {
    if (!name) return { release: () => undefined };
    const normalizedName = validateRunName(name);
    if (!normalizedName) {
      throw new Error(`Invalid run name "${name}". Names must be 1-64 characters, lowercase alphanumeric, hyphens, or underscores, starting with alphanumeric.`);
    }
    if (this.reservedLaunchNames.has(normalizedName) || !this.registry.isNameAvailable(normalizedName)) {
      throw new Error(`Run name "${name}" is already in use by another non-archived run.`);
    }
    this.reservedLaunchNames.add(normalizedName);
    return { normalizedName, release: () => this.reservedLaunchNames.delete(normalizedName) };
  }

  async launchChild(request: ControllerLaunchChildRequest, ctx: ExtensionContext): Promise<RunRecord> {
    this.captureContext(ctx);
    const nameReservation = this.reserveLaunchName(request.name);
    const normalizedName = nameReservation.normalizedName;
    const cwd = request.cwd ?? ctx.cwd;

    const runId = this.createRunId();
    const timestamp = this.now();
    const completionPolicy = DEFAULT_COMPLETION_POLICY;

    try {
      const launch = await this.launcher.launchChild(
        {
          ...request,
          runId,
          title: request.title,
          taskSummary: request.taskSummary,
          cwd,
        },
        runtimeContext(this.pi, ctx),
      );

      const run: RunRecord = {
        id: runId,
        kind: "single",
        agent: request.agent,
        title: request.title,
        taskSummary: request.taskSummary,
        status: "queued",
        startedAt: timestamp,
        updatedAt: timestamp,
        completionPolicy,
        sessionFile: launch.sessionFile,
        artifactPath: launch.artifactPath,
        model: launch.model,
        name: normalizedName,
        cwd,
        leaseExpiry: normalizedName ? timestamp + DEFAULT_NAMED_RUN_LEASE_MS : undefined,
        attentionNeeded: false,
        launchRef: launch,
        recentEvents: [],
      };

      this.registry.upsert(run);
      this.registry.recordEvent(run.id, buildLaunchEvent(run, timestamp));
      this.trackedLaunches.set(run.id, launch);
      const stored = this.registry.get(run.id)!;
      this.sendVisiblePayload(createLaunchMessagePayload(stored));
      this.persistState();
      this.renderUi(ctx);
      this.refreshPoller();
      this.queuePoll();
      return stored;
    } catch (error) {
      const failed: RunRecord = {
        id: runId,
        kind: "single",
        agent: request.agent,
        title: request.title,
        taskSummary: request.taskSummary,
        status: "failed",
        startedAt: timestamp,
        updatedAt: timestamp,
        completedAt: timestamp,
        completionPolicy,
        errorPreview: error instanceof Error ? error.message : String(error),
        attentionNeeded: true,
        recentEvents: [],
      };
      this.registry.upsert(failed);
      this.registry.recordEvent(failed.id, {
        id: `${failed.id}:${timestamp}:launch`,
        category: "launch",
        timestamp,
        summary: `Failed to launch ${failed.agent} · ${failed.title || failed.taskSummary}`,
      });
      const stored = this.registry.get(failed.id)!;
      this.sendVisiblePayload(createFailureMessagePayload(stored));
      this.persistState();
      this.renderUi(ctx);
      return stored;
    } finally {
      nameReservation.release();
    }
  }

  async launchGroup(request: ControllerLaunchGroupRequest, ctx: ExtensionContext): Promise<RunRecord> {
    this.captureContext(ctx);
    if (request.name) {
      throw new Error("Run names are only supported for single runs.");
    }
    const nameReservation = this.reserveLaunchName(request.name);
    const normalizedName = nameReservation.normalizedName;

    const runId = this.createRunId();
    const timestamp = this.now();
    const completionPolicy = DEFAULT_COMPLETION_POLICY;

    try {
      const launch = await this.launcher.launchGroup(
        {
          ...request,
          runId,
          title: request.title,
          taskSummary: request.taskSummary,
        },
        runtimeContext(this.pi, ctx),
      );

      const run: RunRecord = {
        id: runId,
        kind: "group",
        agent: request.children.map((child) => child.agent).join(", "),
        title: request.title,
        taskSummary: request.taskSummary,
        status: "queued",
        startedAt: timestamp,
        updatedAt: timestamp,
        completionPolicy,
        sessionFile: launch.sessionFile,
        artifactPath: launch.artifactPath,
        model: launch.model,
        name: normalizedName,
        cwd: request.cwd,
        leaseExpiry: normalizedName ? timestamp + DEFAULT_NAMED_RUN_LEASE_MS : undefined,
        attentionNeeded: false,
        launchRef: launch,
        recentEvents: [],
      };

      this.registry.upsert(run);
      this.registry.recordEvent(run.id, buildLaunchEvent(run, timestamp));
      this.trackedLaunches.set(run.id, launch);
      const stored = this.registry.get(run.id)!;
      this.sendVisiblePayload(createLaunchMessagePayload(stored));
      this.persistState();
      this.renderUi(ctx);
      this.refreshPoller();
      this.queuePoll();
      return stored;
    } catch (error) {
      const failed: RunRecord = {
        id: runId,
        kind: "group",
        agent: request.children.map((child) => child.agent).join(", "),
        title: request.title,
        taskSummary: request.taskSummary,
        status: "failed",
        startedAt: timestamp,
        updatedAt: timestamp,
        completedAt: timestamp,
        completionPolicy,
        errorPreview: error instanceof Error ? error.message : String(error),
        attentionNeeded: true,
        recentEvents: [],
      };
      this.registry.upsert(failed);
      this.registry.recordEvent(failed.id, {
        id: `${failed.id}:${timestamp}:launch`,
        category: "launch",
        timestamp,
        summary: `Failed to launch ${failed.agent} · ${failed.title || failed.taskSummary}`,
      });
      const stored = this.registry.get(failed.id)!;
      this.sendVisiblePayload(createFailureMessagePayload(stored));
      this.persistState();
      this.renderUi(ctx);
      return stored;
    } finally {
      nameReservation.release();
    }
  }

  async launchWorkflow(request: ControllerLaunchWorkflowRequest, ctx: ExtensionContext): Promise<RunRecord> {
    this.captureContext(ctx);
    assertValidWorkflowRequest(request);
    if (request.name) {
      throw new Error("Run names are only supported for single runs.");
    }
    const nameReservation = this.reserveLaunchName(request.name);
    const normalizedName = nameReservation.normalizedName;

    const runId = this.createRunId();
    const timestamp = this.now();
    const completionPolicy = DEFAULT_COMPLETION_POLICY;

    try {
      const launch = await this.launcher.launchWorkflow(
        {
          ...request,
          runId,
          title: request.title,
          taskSummary: request.taskSummary,
        },
        runtimeContext(this.pi, ctx),
      );

      const run: RunRecord = {
        id: runId,
        kind: "workflow",
        agent: request.steps.map((step) => step.agent).join(", "),
        title: request.title,
        taskSummary: request.taskSummary,
        status: "queued",
        startedAt: timestamp,
        updatedAt: timestamp,
        completionPolicy,
        sessionFile: launch.sessionFile,
        artifactPath: launch.artifactPath,
        model: launch.model,
        name: normalizedName,
        cwd: request.cwd,
        leaseExpiry: normalizedName ? timestamp + DEFAULT_NAMED_RUN_LEASE_MS : undefined,
        attentionNeeded: false,
        launchRef: launch,
        recentEvents: [],
      };

      this.registry.upsert(run);
      this.registry.recordEvent(run.id, buildLaunchEvent(run, timestamp));
      this.trackedLaunches.set(run.id, launch);
      const stored = this.registry.get(run.id)!;
      this.sendVisiblePayload(createLaunchMessagePayload(stored));
      this.persistState();
      this.renderUi(ctx);
      this.refreshPoller();
      this.queuePoll();
      return stored;
    } catch (error) {
      const failed: RunRecord = {
        id: runId,
        kind: "workflow",
        agent: request.steps.map((step) => step.agent).join(", "),
        title: request.title,
        taskSummary: request.taskSummary,
        status: "failed",
        startedAt: timestamp,
        updatedAt: timestamp,
        completedAt: timestamp,
        completionPolicy,
        errorPreview: error instanceof Error ? error.message : String(error),
        attentionNeeded: true,
        recentEvents: [],
      };
      this.registry.upsert(failed);
      this.registry.recordEvent(failed.id, {
        id: `${failed.id}:${timestamp}:launch`,
        category: "launch",
        timestamp,
        summary: `Failed to launch ${failed.agent} · ${failed.title || failed.taskSummary}`,
      });
      const stored = this.registry.get(failed.id)!;
      this.sendVisiblePayload(createFailureMessagePayload(stored));
      this.persistState();
      this.renderUi(ctx);
      return stored;
    } finally {
      nameReservation.release();
    }
  }

  async continueChild(
    target: string,
    prompt: string,
    title: string,
    ctx: ExtensionContext,
  ): Promise<RunRecord> {
    this.captureContext(ctx);

    const now = this.now();

    // 1. Resolve target (run ID first, then name)
    const runId = this.registry.resolveTarget(target);
    if (!runId) {
      throw new Error(`No run found for target: ${target}`);
    }

    const existing = this.registry.get(runId);
    if (!existing) {
      throw new Error(`Run not found: ${runId}`);
    }

    // 2. Validate the run
    if (existing.kind !== "single") {
      throw new Error(`Cannot continue ${existing.kind} runs. Only single runs can be continued.`);
    }

    if (existing.archived) {
      throw new Error(`Cannot continue archived run: ${runId}`);
    }

    // isTerminalStatus intentionally allows paused runs: a paused single run is
    // idle/suspended and may be continued by runId in the same session lineage.
    if (!isTerminalStatus(existing.status)) {
      throw new Error(`Cannot continue active run: ${runId} (currently ${existing.status})`);
    }

    if (existing.status === "cancelled") {
      throw new Error(`Cannot continue cancelled run: ${runId}`);
    }

    if (existing.status === "failed") {
      throw new Error(`Cannot continue failed run: ${runId}`);
    }

    // For named runs, reject if the persisted or derived lease has expired.
    const effectiveLeaseExpiry = computeLeaseExpiry(existing);
    if (existing.name && effectiveLeaseExpiry !== undefined && now > effectiveLeaseExpiry) {
      throw new Error(`Cannot continue ${target}: lease has expired.`);
    }

    // Need a launchRef with asyncDir
    if (!existing.launchRef?.asyncDir) {
      throw new Error(`Run ${runId} has no async directory. Cannot continue.`);
    }

    // Need the launcher to support continue
    if (!this.launcher.continueChild) {
      throw new Error("The current launcher does not support run continuation.");
    }

    const asyncDir = existing.launchRef.asyncDir;
    const statusPath = path.join(asyncDir, "status.json");
    const resultPath = existing.launchRef.resultPath ?? legacyResultPathFromAsyncDir(asyncDir, existing.launchRef.asyncId);
    const eventsPath = path.join(asyncDir, "events.jsonl");

    // Find the session file to continue from
    const sessionFile = existing.sessionFile ?? existing.launchRef.sessionFile;
    if (!sessionFile) {
      throw new Error(`Run ${runId} has no saved session file to continue from.`);
    }

    // 3. Backup stale artifacts so readUpdate won't return the previous result.
    //    On launcher failure we restore these backups to avoid data loss.
    const backupPaths: string[] = [];
    const restoreBackups = async (): Promise<void> => {
      for (const src of backupPaths) {
        try {
          await fsp.rename(`${src}.cont-bak`, src);
        } catch (restoreError) {
          console.warn(`[pi-lazy-subagents] failed to restore continuation artifact ${src}:`, restoreError);
        }
      }
    };
    const backupFile = async (src: string): Promise<void> => {
      const dst = `${src}.cont-bak`;
      try {
        await fsp.rename(src, dst);
        backupPaths.push(src);
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: string }).code : undefined;
        if (code === "ENOENT") return;
        throw new Error(`Failed to backup continuation artifact ${src}: ${error instanceof Error ? error.message : String(error)}`);
      }
    };
    try {
      await backupFile(statusPath);
      await backupFile(resultPath);
      await backupFile(eventsPath);
      if (existing.artifactPath) {
        await backupFile(existing.artifactPath);
      }
    } catch (error) {
      await restoreBackups();
      throw error;
    }

    // 4. Reset the run and renew the lease
    const newLeaseExpiry = existing.name
      ? now + DEFAULT_NAMED_RUN_LEASE_MS
      : undefined;

    this.registry.updateRun(runId, {
      status: "queued",
      updatedAt: now,
      completedAt: undefined,
      resultPreview: undefined,
      errorPreview: undefined,
      currentTool: undefined,
      toolCount: undefined,
      attentionNeeded: false,
      leaseExpiry: newLeaseExpiry,
    });

    // 5. Launch via launcher
    const cwd = existing.cwd ?? ctx.cwd;
    let launch: LaunchResult;
    try {
      launch = await this.launcher.continueChild({
        runId,
        title,
        taskSummary: title,
        prompt,
        agent: existing.agent,
        asyncDir,
        statusPath,
        resultPath,
        eventsPath,
        sessionFile,
        artifactPath: existing.artifactPath,
        cwd,
      }, runtimeContext(this.pi, ctx));
    } catch (error) {
      // Restore backup files so prior results are not lost.
      await restoreBackups();

      // Revert the run back to its previous terminal state and metadata.
      this.registry.updateRun(runId, {
        title: existing.title,
        taskSummary: existing.taskSummary,
        status: existing.status,
        updatedAt: existing.updatedAt,
        completedAt: existing.completedAt,
        resultPreview: existing.resultPreview,
        errorPreview: existing.errorPreview,
        currentTool: existing.currentTool,
        toolCount: existing.toolCount,
        attentionNeeded: existing.attentionNeeded,
        sessionFile: existing.sessionFile,
        artifactPath: existing.artifactPath,
        launchRef: existing.launchRef,
        leaseExpiry: existing.leaseExpiry,
      });
      throw error;
    }

    const nextLaunch: LaunchResult = {
      ...launch,
      sessionFile: launch.sessionFile ?? sessionFile,
      artifactPath: launch.artifactPath ?? existing.artifactPath,
    };
    this.trackedLaunches.set(runId, nextLaunch);
    const stored = this.registry.updateRun(runId, {
      title,
      taskSummary: title,
      updatedAt: now,
      sessionFile: nextLaunch.sessionFile,
      artifactPath: nextLaunch.artifactPath,
      launchRef: nextLaunch,
      leaseExpiry: newLeaseExpiry,
    });
    this.registry.recordEvent(runId, buildLaunchEvent(stored, now));
    this.persistState();
    try {
      this.sendVisiblePayload(createLaunchMessagePayload(stored));
      this.renderUi(ctx);
    } catch (error) {
      console.warn("[pi-lazy-subagents] failed to emit continuation launch UI state:", error);
    }
    this.refreshPoller();
    this.queuePoll();

    // Clean up backup files now that the new launch has succeeded
    for (const src of backupPaths) {
      try { await fsp.unlink(`${src}.cont-bak`); } catch { /* ok */ }
    }

    return stored;
  }

  async waitForRunSignal(
    runId?: string,
    options: { timeoutMs?: number; signal?: AbortSignal; ctx?: ExtensionContext } = {},
  ): Promise<WaitForRunSignalResult> {
    const requestedTimeoutMs = options.timeoutMs;
    const normalizedTimeoutMs = typeof requestedTimeoutMs === "number" && Number.isFinite(requestedTimeoutMs) && requestedTimeoutMs > 0
      ? requestedTimeoutMs
      : DEFAULT_WAIT_TIMEOUT_MS;
    const timeoutMs = Math.min(normalizedTimeoutMs, MAX_WAIT_TIMEOUT_MS);
    const startedWaitingAt = this.now();
    let latchedSelectedRunId = runId;

    const selectRun = (): WaitForRunSignalResult => {
      const snapshot = this.registry.snapshot();
      if (latchedSelectedRunId) {
        const run = snapshot.runs.find((candidate) => candidate.id === latchedSelectedRunId);
        return run ? { status: "ready", run } : { status: "not_found" };
      }

      if (snapshot.activeRuns.length === 0) return { status: "no_active_runs" };
      if (snapshot.activeRuns.length > 1) return { status: "ambiguous", activeRuns: snapshot.activeRuns };
      latchedSelectedRunId = snapshot.activeRuns[0].id;
      return { status: "ready", run: snapshot.activeRuns[0] };
    };

    const isReady = (run: RunRecord): boolean => isTerminalStatus(run.status) || run.attentionNeeded || run.status === "blocked";

    while (true) {
      if (options.signal?.aborted) return { status: "aborted" };

      let selected = selectRun();
      if (selected.status !== "ready") return selected;
      if (isReady(selected.run)) return selected;

      await this.pollOnce();
      selected = selectRun();
      if (selected.status !== "ready") return selected;
      if (isReady(selected.run)) return selected;

      const remaining = timeoutMs - (this.now() - startedWaitingAt);
      if (remaining <= 0) return { status: "timeout", run: selected.run };

      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(this.pollIntervalMs, remaining));
      });
    }
  }

  async getRunResult(runId: string): Promise<string | undefined> {
    if (this.trackedLaunches.has(runId)) {
      await this.pollOnce();
    }

    const run = this.registry.get(runId);
    if (!run) return undefined;

    if (run.kind === "group" || run.kind === "workflow") {
      const resultText = await this.readResultText(run);
      if (resultText) return resultText;

      return await this.readArtifactText(run);
    }

    const artifactText = await this.readArtifactText(run);
    if (artifactText) return artifactText;

    const resultText = await this.readResultText(run);
    return resultText;
  }

  async pickupRun(runId: string, ctx?: ExtensionContext): Promise<boolean> {
    if (ctx) this.captureContext(ctx);
    const run = this.registry.get(runId);
    if (!run) return false;

    const result = await this.getRunResult(runId);
    if (!result) return false;

    const activeCtx = ctx ?? this.currentCtx;
    const message = formatPickupMessage(run, result);
    if (activeCtx?.isIdle() && !activeCtx.hasPendingMessages()) {
      this.pi.sendUserMessage(message);
    } else {
      this.pi.sendUserMessage(message, { deliverAs: "steer" });
    }

    this.acknowledgeRun(runId);
    return true;
  }

  async pinRun(runId: string, ctx?: ExtensionContext): Promise<boolean> {
    return (await this.pinRunWithOutcome(runId, ctx)) === "pinned";
  }

  async setPinnedWidgetVisible(visible: boolean, ctx?: ExtensionContext): Promise<void> {
    if (ctx) this.captureContext(ctx);
    this.pinnedWidgetVisible = visible;
    if (visible) {
      for (const [runId, launch] of this.trackedLaunches.entries()) {
        if (this.shouldShowPinnedPanelForRun(runId)) await this.refreshProgressLines(runId, launch);
      }
    }
    this.renderedWidgetSignature = undefined;
    this.renderUi(ctx ?? this.currentCtx);
  }

  async pinRunWithOutcome(runId: string, ctx?: ExtensionContext): Promise<"pinned" | "not_found" | "not_pinnable"> {
    if (ctx) this.captureContext(ctx);
    const run = this.registry.get(runId);
    if (!run) return "not_found";
    if (!isPinnedPanelEligibleStatus(run.status)) {
      await this.surfacePinnedRun(runId, ctx, { sendMessage: false });
      return "not_pinnable";
    }
    this.pinnedWidgetVisible = true;
    return (await this.surfacePinnedRun(runId, ctx, { sendMessage: false })) ? "pinned" : "not_found";
  }

  private async surfacePinnedRun(runId: string, ctx?: ExtensionContext, options: { sendMessage?: boolean } = {}): Promise<boolean> {
    if (ctx) this.captureContext(ctx);
    const run = this.registry.get(runId);
    if (!run) return false;
    const shouldSendMessage = options.sendMessage ?? false;
    if (!isPinnedPanelEligibleStatus(run.status)) {
      if (this.registry.isPinned(runId)) {
        this.registry.unpinRun(runId);
        this.surfacedPinnedMessages.delete(runId);
        this.persistState();
      }
      this.renderUi();
      return true;
    }

    const alreadyPinned = this.registry.isPinned(runId);

    if (!alreadyPinned) {
      this.registry.pinRun(runId);
    }
    if (run.launchRef) {
      await this.refreshProgressLines(runId, run.launchRef);
    }

    if (shouldSendMessage && !this.surfacedPinnedMessages.has(runId)) {
      this.pi.sendMessage({
        customType: MESSAGE_TYPE_PIN,
        content: `Pinned lazy subagent progress for ${run.id}.`,
        display: true,
        details: { runId },
      });
      this.surfacedPinnedMessages.add(runId);
    }

    if (!alreadyPinned) this.persistState();
    this.renderUi();
    return true;
  }

  getPinnedRunLines(runId: string, expanded = false): string[] {
    const run = this.registry.get(runId);
    if (!run) return [`Pinned lazy subagent ${runId} not found.`];

    return buildLiveRunViewModel(run, {
      expanded,
      progressLines: this.progressLines.get(runId),
      progressStats: this.progressStats.get(runId),
    }).lines;
  }

  private getPinnedProgressLines(runId: string): string[] {
    const run = this.registry.get(runId);
    if (!run) return [];

    return buildLiveRunViewModel(run, {
      progressLines: this.progressLines.get(runId),
      progressStats: this.progressStats.get(runId),
    }).detailLines;
  }

  async cancelRun(runId: string, ctx?: ExtensionContext): Promise<boolean> {
    if (ctx) this.captureContext(ctx);
    const launch = this.trackedLaunches.get(runId);
    const run = this.registry.get(runId);
    if (!launch || !run || !this.launcher.cancel) return false;

    const cancelled = await this.launcher.cancel(launch);
    if (!cancelled) return false;

    const timestamp = this.now();
    this.trackedLaunches.delete(runId);
    this.registry.updateRun(runId, {
      status: "cancelled",
      updatedAt: timestamp,
      completedAt: timestamp,
      attentionNeeded: false,
      errorPreview: "Cancelled by user",
    });
    this.registry.recordEvent(runId, {
      id: `${runId}:${timestamp}:cancelled`,
      category: "failure",
      timestamp,
      summary: `Cancelled ${run.agent} · ${run.title || run.taskSummary}`,
      status: "cancelled",
    });

    this.persistState();
    this.renderUi();
    this.refreshPoller();
    return true;
  }

  clearRuns(scope: "completed" | "all" = "completed", runId?: string): number {
    const removed = runId
      ? this.registry.clearRuns((run) => run.id === runId && (scope === "all" || isTerminalStatus(run.status)))
      : this.registry.clearRuns((run) => scope === "all" || isTerminalStatus(run.status));

    for (const id of removed) {
      this.trackedLaunches.delete(id);
      this.progressLines.delete(id);
      this.surfacedPinnedMessages.delete(id);
    }

    if (removed.length > 0) {
      this.persistState();
      this.renderUi();
      this.refreshPoller();
    }

    return removed.length;
  }

  async pollOnce(): Promise<void> {
    while (this.activePoll) {
      await this.activePoll;
      await Promise.resolve();
    }

    const pollPromise = (async () => {
      try {
        for (const [runId, launch] of [...this.trackedLaunches.entries()]) {
          let update: NormalizedRunUpdate | undefined;
          try {
            update = await Promise.race([
              this.launcher.readUpdate(launch),
              new Promise<undefined>((_, reject) => {
                setTimeout(() => reject(new ReadUpdateTimeoutError(runId, this.readUpdateTimeoutMs)), this.readUpdateTimeoutMs);
              }),
            ]);
          } catch (error) {
            if (error instanceof ReadUpdateTimeoutError) {
              console.warn(`[pi-lazy-subagents] ${error.message}`);
              update = undefined;
            } else {
              update = {
                runId,
                status: "failed",
                updatedAt: this.now(),
                completedAt: this.now(),
                errorPreview: error instanceof Error ? error.message : String(error),
                attentionNeeded: true,
              };
            }
          }
          if (!update) continue;
          const applied = await this.applyUpdate(runId, update);
          if ((applied.stateChanged || applied.recordedEvent) && this.shouldShowPinnedPanelForRun(runId)) {
            await this.refreshProgressLines(runId, launch);
          }
        }
        this.scanRunHealth();
        const releasedExpiredNames = this.cleanupExpiredNamedRunLeases();
        const removedAcknowledgedRuns = this.cleanupAcknowledgedCompletedRuns();
        if (releasedExpiredNames || removedAcknowledgedRuns) this.persistState();
        this.renderUi();
      } finally {
        this.refreshPoller();
      }
    })();

    this.activePoll = pollPromise;
    try {
      await pollPromise;
    } finally {
      if (this.activePoll === pollPromise) {
        this.activePoll = undefined;
      }
    }
  }

  private async applyUpdate(runId: string, update: NormalizedRunUpdate): Promise<ApplyUpdateResult> {
    const existing = this.registry.get(runId);
    if (!existing) return { stateChanged: false, recordedEvent: false };
    if (isTerminalStatus(existing.status)) return { stateChanged: false, recordedEvent: false };

    const hasStateChange = !equalUpdate(existing, update);
    const hasNewEvent = Boolean(update.event && !existing.recentEvents.some((event) => event.id === update.event?.id));
    if (!hasStateChange && !hasNewEvent) {
      return { stateChanged: false, recordedEvent: false };
    }

    const previousStatus = existing.status;
    const previousAttention = existing.attentionNeeded;

    if (hasStateChange) {
      const isNewTerminal = isTerminalStatus(update.status) && !isTerminalStatus(existing.status);
      const newLease = isNewTerminal && existing.name && update.completedAt !== undefined
        ? update.completedAt + DEFAULT_NAMED_RUN_LEASE_MS
        : undefined;

      this.registry.updateRun(runId, {
        status: update.status,
        updatedAt: update.updatedAt,
        completedAt: update.completedAt ?? existing.completedAt,
        sessionFile: update.sessionFile ?? existing.sessionFile,
        artifactPath: update.artifactPath ?? existing.artifactPath,
        resultPreview: update.resultPreview ?? existing.resultPreview,
        errorPreview: update.errorPreview ?? existing.errorPreview,
        currentTool: update.currentTool,
        childProgress: update.childProgress ?? existing.childProgress,
        toolCount: update.toolCount,
        totalTokens: mergeTotalTokens(existing.totalTokens, update.totalTokens),
        promptTokens: update.promptTokens ?? existing.promptTokens,
        cacheReadTokens: update.cacheReadTokens ?? existing.cacheReadTokens,
        cacheHitRate: clampCacheHitRate(update.cacheHitRate ?? existing.cacheHitRate),
        attentionNeeded: update.attentionNeeded ?? false,
        leaseExpiry: newLease ?? existing.leaseExpiry,
      });
    }

    if (hasNewEvent && update.event) {
      this.registry.recordEvent(runId, update.event);
    }

    const next = this.registry.get(runId)!;
    if (hasStateChange) {
      if (isTerminalStatus(next.status)) {
        this.trackedLaunches.delete(runId);
        await this.handleTerminalTransition(next);
      } else if ((!previousAttention && next.attentionNeeded) || (previousStatus !== "blocked" && next.status === "blocked")) {
        this.sendVisiblePayload(createAttentionMessagePayload(next));
      }

      this.persistState();
      this.renderUi();
    }

    return { stateChanged: hasStateChange, recordedEvent: hasNewEvent };
  }

  private async surfaceRestoredTerminalCompletions(): Promise<void> {
    for (const run of this.registry.snapshot().runs) {
      if (!isTerminalStatus(run.status) || run.status === "cancelled") continue;
      const fingerprint = buildCompletionFingerprint({
        runId: run.id,
        status: run.status,
        completedAt: run.completedAt,
      });
      if (this.registry.hasSurfacedCompletion(fingerprint)) continue;
      await this.handleTerminalTransition(run);
    }
  }

  private getCompletionRoutingDecision(run: RunRecord): ReturnType<typeof decideCompletionRouting> {
    return decideCompletionRouting(run, {
      isIdle: this.currentCtx?.isIdle() ?? true,
      hasPendingMessages: this.currentCtx?.hasPendingMessages() ?? false,
    });
  }

  private shouldTriggerCompletionTurn(run: RunRecord): boolean {
    const decision = this.getCompletionRoutingDecision(run);
    return Boolean(decision.triggerTurn && decision.deliverAs && (decision.action === "follow_up" || decision.action === "wake"));
  }

  private async handleTerminalTransition(run: RunRecord): Promise<void> {
    if (!this.currentCtx && this.shouldTriggerCompletionTurn(run)) {
      return;
    }

    const fingerprint = buildCompletionFingerprint({
      runId: run.id,
      status: run.status,
      completedAt: run.completedAt,
    });

    if (!this.registry.markCompletionSurfaced(run.id, fingerprint)) return;

    if (run.status === "completed" || run.status === "skipped") {
      this.registry.unpinRun(run.id);
      this.surfacedPinnedMessages.delete(run.id);
      if (!run.name) {
        this.sendVisiblePayload(createCompletionMessagePayload(run));
      }
    } else if (run.status === "failed") {
      this.sendVisiblePayload(createFailureMessagePayload(run));
    } else if (run.status === "paused") {
      this.sendVisiblePayload(createAttentionMessagePayload(run));
    }

    if (run.status === "cancelled") return;

    const decision = this.getCompletionRoutingDecision(run);

    if (!decision.triggerTurn || !decision.deliverAs || (decision.action !== "follow_up" && decision.action !== "wake")) {
      return;
    }

    const result = run.status === "completed" || run.status === "skipped" ? await this.getCompletionResultDetails(run) : undefined;
    const summary = buildHiddenSummary(run, this.registry.snapshot(), { includePreview: !result?.text });
    const content = formatCompletionInput(run, summary.text, result);
    const isIdle = this.currentCtx?.isIdle() ?? false;
    const hasPendingMessages = this.currentCtx?.hasPendingMessages() ?? true;

    this.pi.sendMessage({
      customType: run.status === "failed" ? MESSAGE_TYPE_FAILURE : run.status === "paused" ? MESSAGE_TYPE_ATTENTION : MESSAGE_TYPE_COMPLETION,
      content,
      display: false,
      details: { runId: run.id, status: run.status, routedCompletion: true },
    }, {
      triggerTurn: isIdle && !hasPendingMessages,
      deliverAs: decision.deliverAs,
    });

    if (run.status === "completed" || run.status === "skipped") {
      this.registry.acknowledgeRun(run.id);
    }
  }

  private async readArtifactText(run: RunRecord): Promise<string | undefined> {
    if (!run.artifactPath) return undefined;

    try {
      const raw = await fsp.readFile(run.artifactPath, "utf8");
      return normalizeResultText(raw);
    } catch {
      return undefined;
    }
  }

  private async readResultFile(run: RunRecord): Promise<ParsedRunResult | undefined> {
    const resultPath = run.launchRef?.resultPath;
    if (!resultPath) return undefined;

    try {
      const raw = await fsp.readFile(resultPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
      const result = parsed as ParsedRunResult;
      return {
        ...result,
        results: Array.isArray(result.results) ? result.results : [],
      };
    } catch {
      return undefined;
    }
  }

  private formatParsedResultText(parsed: ParsedRunResult): string | undefined {
    const outputs = parsed.results
      ?.map((entry) => {
        const rawText = entry.skipped ? `Skipped: ${entry.skipReason ?? entry.error ?? "workflow step skipped"}` : entry.output?.trim() ? entry.output : entry.error;
        const text = normalizeResultText(rawText);
        if (!text) return undefined;
        const label = entry.stepId ?? entry.taskSummary ?? entry.agent;
        return label ? `[${label}]\n${text}` : text;
      })
      .filter((entry): entry is string => Boolean(entry));

    if (outputs && outputs.length > 0) {
      return outputs.length === 1 ? outputs[0] : outputs.join("\n\n");
    }

    return normalizeResultText(parsed.summary);
  }

  private formatParsedResultReports(parsed: ParsedRunResult): CompletionReportLink[] {
    return (parsed.results ?? [])
      .map((entry) => {
        const reportPath = normalizeResultText(entry.artifactPaths?.outputPath);
        if (!reportPath) return undefined;
        const label = [entry.agent, entry.taskSummary].filter(Boolean).join(" / ") || entry.stepId || "report";
        return { label, path: reportPath };
      })
      .filter((entry): entry is CompletionReportLink => Boolean(entry));
  }

  private async readResultText(run: RunRecord): Promise<string | undefined> {
    const parsed = await this.readResultFile(run);
    return parsed ? this.formatParsedResultText(parsed) : undefined;
  }

  private async getCompletionResultDetails(run: RunRecord): Promise<CompletionResultDetails | undefined> {
    if (run.kind === "single") {
      const artifactText = await this.readArtifactText(run);
      if (artifactText) return { text: artifactText, reports: [] };
    }

    const parsed = await this.readResultFile(run);
    if (parsed) {
      const parsedText = this.formatParsedResultText(parsed);
      const summary = normalizeResultText(parsed.summary);
      const text = parsedText && parsedText.trim() !== summary?.trim() ? parsedText : undefined;
      const reports = this.formatParsedResultReports(parsed);
      if (text || summary || reports.length > 0) return { text, summary, reports };
    }

    const artifactText = await this.readArtifactText(run);
    return artifactText ? { text: artifactText, reports: [] } : undefined;
  }

  private getLiveUiSnapshot(now = this.now()): RunRegistrySnapshot {
    const snapshot = this.registry.snapshot();
    const visibleRuns = snapshot.runs.filter((run) => shouldKeepRunVisibleInUi(run, {
      isPinned: this.registry.isPinned(run.id),
      isAcknowledged: this.registry.isAcknowledged(run.id),
      now,
    }));

    return {
      runs: visibleRuns,
      counts: createSnapshotCounts(visibleRuns),
      activeRuns: visibleRuns.filter((run) => ["queued", "running", "blocked", "paused"].includes(run.status)),
      recentRuns: visibleRuns.filter((run) => !["queued", "running", "blocked", "paused"].includes(run.status)).slice(0, snapshot.recentRuns.length || 8),
    };
  }

  private hasPendingUiGraceWindow(now = this.now()): boolean {
    return this.registry.snapshot().runs.some((run) => (
      (run.status === "completed" || run.status === "skipped")
      && !this.registry.isPinned(run.id)
      && !this.registry.isAcknowledged(run.id)
      && run.completedAt !== undefined
      && now - run.completedAt <= DEFAULT_SUCCESS_VISIBILITY_GRACE_MS
    ));
  }

  private hasPendingAcknowledgedCleanupWindow(now = this.now()): boolean {
    return this.registry.snapshot().runs.some((run) => (
      (run.status === "completed" || run.status === "skipped")
      && !this.registry.isPinned(run.id)
      && this.registry.isAcknowledged(run.id)
      && run.completedAt !== undefined
      && now - run.completedAt <= DEFAULT_ACKNOWLEDGED_SUCCESS_TTL_MS
    ));
  }

  /**
   * Keep the poller alive while any named completed/skipped run is still
   * within its lease window, so the UI refreshes at lease expiry. Acknowledged
   * named runs still need this because cleanup preserves them until the lease
   * ends.
   */
  private hasPendingNamedLeaseWindow(now = this.now()): boolean {
    return this.registry.snapshot().runs.some((run) => {
      const leaseExpiry = computeLeaseExpiry(run);
      return (run.status === "completed" || run.status === "skipped")
        && !this.registry.isPinned(run.id)
        && Boolean(run.name)
        && leaseExpiry !== undefined
        && now <= leaseExpiry;
    });
  }

  private unpinUnpinnableRuns(): boolean {
    let changed = false;
    for (const run of this.registry.snapshot().runs) {
      if (!isPinnedPanelEligibleStatus(run.status) && this.registry.isPinned(run.id)) {
        this.registry.unpinRun(run.id);
        this.surfacedPinnedMessages.delete(run.id);
        changed = true;
      }
    }
    return changed;
  }

  private cleanupExpiredNamedRunLeases(now = this.now()): boolean {
    const removed = this.registry.clearRuns((run) => {
      const leaseExpiry = computeLeaseExpiry(run);
      return Boolean(run.name)
        && !this.registry.isPinned(run.id)
        && (run.status === "completed" || run.status === "skipped")
        && leaseExpiry !== undefined
        && now > leaseExpiry;
    });

    for (const runId of removed) {
      this.trackedLaunches.delete(runId);
      this.progressLines.delete(runId);
      this.progressStats.delete(runId);
    }

    return removed.length > 0;
  }

  /**
   * Remove acknowledged completed/skipped runs after their TTL.
   * Named runs are preserved until their lease expires, even if acknowledged.
   */
  private cleanupAcknowledgedCompletedRuns(now = this.now()): boolean {
    const removed = this.registry.clearRuns((run) => {
      const leaseExpiry = computeLeaseExpiry(run);
      return (run.status === "completed" || run.status === "skipped")
        && !this.registry.isPinned(run.id)
        && this.registry.isAcknowledged(run.id)
        && run.completedAt !== undefined
        && now - run.completedAt > DEFAULT_ACKNOWLEDGED_SUCCESS_TTL_MS
        && !(run.name && leaseExpiry !== undefined && now <= leaseExpiry);
    });

    for (const runId of removed) {
      this.trackedLaunches.delete(runId);
      this.progressLines.delete(runId);
      this.progressStats.delete(runId);
    }

    return removed.length > 0;
  }

  private async restoreBranchState(ctx: ExtensionContext): Promise<void> {
    this.captureContext(ctx);
    const persisted = readLatestPersistedState(ctx);
    this.registry = new RunRegistry({}, persisted);
    this.progressLines.clear();
    this.progressStats.clear();
    const unpinnedUnpinnableRuns = this.unpinUnpinnableRuns();
    const releasedExpiredNames = this.cleanupExpiredNamedRunLeases();
    const removedAcknowledgedRuns = this.cleanupAcknowledgedCompletedRuns();
    if (unpinnedUnpinnableRuns || releasedExpiredNames || removedAcknowledgedRuns) this.persistState();
    this.syncTrackedLaunchesFromSnapshot();

    for (const run of this.registry.snapshot().runs) {
      if (!this.shouldShowPinnedPanelForRun(run.id) || !run.launchRef) continue;
      await this.refreshProgressLines(run.id, run.launchRef);
    }

    await this.surfaceRestoredTerminalCompletions();
    this.renderUi(ctx);
    this.refreshPoller();
    if (this.trackedLaunches.size > 0) {
      await this.pollOnce();
    }
  }

  private scanRunHealth(): void {
    let changed = false;

    for (const run of this.registry.snapshot().activeRuns) {
      const current = this.registry.get(run.id);
      if (!current) continue;

      for (const alert of buildRunHealthAlerts(current, this.now())) {
        if (current.recentEvents.some((event) => event.id === alert.event.id)) {
          continue;
        }

        this.registry.updateRun(run.id, {
          status: alert.status ?? current.status,
          attentionNeeded: true,
        });
        this.registry.recordEvent(run.id, alert.event);
        this.sendVisiblePayload(createAttentionMessagePayload(this.registry.get(run.id)!), { triggerTurn: true });
        changed = true;
      }
    }

    if (changed) {
      this.persistState();
      this.renderUi();
    }
  }

  private async refreshProgressLines(runId: string, launch: LaunchResult): Promise<void> {
    if (!launch.asyncDir) return;

    const eventsPath = path.join(launch.asyncDir, "events.jsonl");
    try {
      const raw = await fsp.readFile(eventsPath, "utf8");
      let turnCount = 0;
      let lastTurnTokens: number | undefined;
      const lines = raw
        .split(/\r?\n/u)
        .map((line) => line.trim())
        .filter(Boolean)
        .map((line) => {
          try {
            const envelope = JSON.parse(line) as { raw?: string };
            if (envelope?.raw) {
              const event = JSON.parse(envelope.raw) as Record<string, any>;
              if (event.type === "message_end" && event.message?.role === "assistant") {
                turnCount += 1;
                const totalTokens = extractEventTotalTokens(event);
                if (totalTokens && totalTokens > 0) lastTurnTokens = totalTokens;
              }
            }
          } catch {
            // Best-effort metadata extraction only.
          }
          return formatProgressLine(line);
        })
        .filter((line): line is string => Boolean(line));

      if (lines.length > 0) this.progressLines.set(runId, lines.slice(Math.max(0, lines.length - 24)));
      else this.progressLines.delete(runId);

      if (turnCount > 0 || lastTurnTokens !== undefined) this.progressStats.set(runId, { turnCount, lastTurnTokens });
      else this.progressStats.delete(runId);
    } catch {
      // Best-effort pinned progress only.
    }
  }

  private hasExplicitPinnedPanelRun(): boolean {
    return this.registry.snapshot().runs.some((run) => this.registry.isPinned(run.id) && isPinnedPanelEligibleStatus(run.status));
  }

  private shouldShowPinnedPanelForRun(runId: string): boolean {
    if (!this.pinnedWidgetVisible) return false;
    const run = this.registry.get(runId);
    if (!run || !isPinnedPanelEligibleStatus(run.status)) return false;
    return this.hasExplicitPinnedPanelRun() ? this.registry.isPinned(runId) : true;
  }

  private syncTrackedLaunchesFromSnapshot(): void {
    this.trackedLaunches.clear();
    for (const run of this.registry.snapshot().activeRuns) {
      if (run.launchRef) {
        this.trackedLaunches.set(run.id, run.launchRef);
      }
    }
  }

  private persistState(): void {
    this.pi.appendEntry(PERSISTED_STATE_ENTRY, createPersistedState(this.registry.serialize(), this.now()));
  }

  private renderUi(ctx = this.currentCtx): void {
    if (!ctx?.hasUI) return;

    const snapshot = this.getLiveUiSnapshot();
    const timestamp = this.now();
    const widgetOptions = {
      isPinned: (runId: string) => this.shouldShowPinnedPanelForRun(runId),
      getPinnedProgressLines: (runId: string) => this.getPinnedProgressLines(runId),
    };
    const status = buildFooterStatus(snapshot, ctx.ui.theme);
    const widgetLines = buildWidgetLines(snapshot, timestamp, 7, ctx.ui.theme, widgetOptions);
    const widgetSignature = widgetLines.length > 0 ? JSON.stringify(widgetLines) : undefined;

    const statusChanged = status !== this.renderedStatus;
    const widgetChanged = widgetSignature !== this.renderedWidgetSignature;
    if (!statusChanged && !widgetChanged) return;

    if (statusChanged) {
      ctx.ui.setStatus(STATUS_KEY, status);
      this.renderedStatus = status;
    }
    if (widgetChanged) {
      ctx.ui.setWidget(WIDGET_KEY, createWidgetContent(snapshot, timestamp, 7, widgetOptions));
      this.renderedWidgetSignature = widgetSignature;
    }

    (ctx.ui as typeof ctx.ui & { requestRender?: () => void }).requestRender?.();
  }

  private queuePoll(): void {
    void this.pollOnce().catch((error) => {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error("[pi-lazy-subagents] pollOnce failed:", message);
    });
  }

  private refreshPoller(): void {
    if (this.trackedLaunches.size === 0 && !this.hasPendingUiGraceWindow() && !this.hasPendingAcknowledgedCleanupWindow() && !this.hasPendingNamedLeaseWindow()) {
      this.stopPoller();
      return;
    }

    if (this.poller) return;
    this.poller = setInterval(() => {
      this.queuePoll();
    }, this.pollIntervalMs);
    this.poller.unref?.();
  }

  private stopPoller(): void {
    if (!this.poller) return;
    clearInterval(this.poller);
    this.poller = undefined;
  }

  private sendVisiblePayload(payload: RunMessagePayload, options?: { triggerTurn?: boolean; deliverAs?: "steer" | "followUp" | "nextTurn" }): void {
    this.pi.sendMessage({
      customType: messageTypeForPayload(payload),
      content: formatRunMessageBody(payload, false),
      display: true,
      details: payload,
    }, options);
  }
}

export const __testHooks = {
  shouldKeepRunVisibleInUi,
  computeLeaseExpiry,
};
