import fsp from "node:fs/promises";
import path from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
  DEFAULT_COMPLETION_POLICY,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_ACKNOWLEDGED_SUCCESS_TTL_MS,
  DEFAULT_STALE_RUN_MS,
  DEFAULT_SUCCESS_VISIBILITY_GRACE_MS,
  MESSAGE_TYPE_ATTENTION,
  MESSAGE_TYPE_COMPLETION,
   MESSAGE_TYPE_PIN,
  MESSAGE_TYPE_FAILURE,
  MESSAGE_TYPE_HIDDEN_SUMMARY,
  MESSAGE_TYPE_LAUNCH,
  PERSISTED_STATE_ENTRY,
  STATUS_KEY,
  WIDGET_KEY,
} from "../defaults.js";
import type { LaunchChildRequest, LaunchGroupRequest, LaunchResult, Launcher, LauncherRuntimeContext, NormalizedRunUpdate } from "../launcher/interface.js";
import { PiSubagentsAdapter } from "../launcher/pi-subagents-adapter.js";
import { createPersistedState, restorePersistedState } from "../state/persistence.js";
import { RunRegistry } from "../state/run-registry.js";
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
import { GLYPH_PINNED } from "../ui/glyphs.js";
import { createWidgetContent } from "../ui/widget.js";
import { formatCompactThousands, formatDuration } from "../utils/time.js";

export interface LazySubagentsControllerOptions {
  launcher?: Launcher;
  pollIntervalMs?: number;
  readUpdateTimeoutMs?: number;
  now?: () => number;
  createRunId?: () => string;
}

export type ControllerLaunchChildRequest = Omit<LaunchChildRequest, "runId">;
export type ControllerLaunchGroupRequest = Omit<LaunchGroupRequest, "runId">;

const DEFAULT_READ_UPDATE_TIMEOUT_MS = 500;

class ReadUpdateTimeoutError extends Error {
  constructor(runId: string, timeoutMs: number) {
    super(`Timed out reading update for ${runId} after ${timeoutMs}ms`);
  }
}

function isTerminalStatus(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled" || status === "paused";
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

function equalUpdate(existing: RunRecord, update: NormalizedRunUpdate): boolean {
  return existing.status === update.status
    && existing.updatedAt === update.updatedAt
    && existing.completedAt === update.completedAt
    && existing.sessionFile === update.sessionFile
    && existing.artifactPath === update.artifactPath
    && existing.resultPreview === update.resultPreview
    && existing.errorPreview === update.errorPreview
    && existing.currentTool === update.currentTool
    && existing.toolCount === update.toolCount
    // equalUpdate compares against mergeTotalTokens because missing totals should preserve an existing non-zero value; the tests also cover the zero-update case, so we deliberately merge instead of comparing directly.
    && existing.totalTokens === mergeTotalTokens(existing.totalTokens, update.totalTokens)
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

function summarizeSingleLine(text: string | undefined, maxLength = 160): string | undefined {
  const singleLine = text?.replace(/\s+/g, " ").trim();
  if (!singleLine) return undefined;
  return singleLine.length <= maxLength ? singleLine : `${singleLine.slice(0, maxLength - 1).trimEnd()}…`;
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
  if (options.isPinned) return true;
  if (run.status === "failed" || run.status === "paused") return true;
  if (run.status === "completed" && run.completionPolicy === "manual_pickup" && !options.isAcknowledged) return true;
  if (run.status !== "completed") return false;
  if (options.isAcknowledged) return false;
  if (run.completedAt === undefined) return true;
  return options.now - run.completedAt <= DEFAULT_SUCCESS_VISIBILITY_GRACE_MS;
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
    this.currentCtx = undefined;
  }

  async launchChild(request: ControllerLaunchChildRequest, ctx: ExtensionContext): Promise<RunRecord> {
    this.captureContext(ctx);

    const runId = this.createRunId();
    const timestamp = this.now();
    const completionPolicy = request.completionPolicy ?? DEFAULT_COMPLETION_POLICY;

    try {
      const launch = await this.launcher.launchChild(
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
    }
  }

  async launchGroup(request: ControllerLaunchGroupRequest, ctx: ExtensionContext): Promise<RunRecord> {
    this.captureContext(ctx);

    const runId = this.createRunId();
    const timestamp = this.now();
    const completionPolicy = request.completionPolicy ?? DEFAULT_COMPLETION_POLICY;

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
    }
  }

  async getRunResult(runId: string): Promise<string | undefined> {
    if (this.trackedLaunches.has(runId)) {
      await this.pollOnce();
    }

    const run = this.registry.get(runId);
    if (!run) return undefined;

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
    if (ctx) this.captureContext(ctx);
    const run = this.registry.get(runId);
    if (!run) return false;

    this.registry.pinRun(runId);
    if (run.launchRef) {
      await this.refreshProgressLines(runId, run.launchRef);
    }

    this.pi.sendMessage({
      customType: MESSAGE_TYPE_PIN,
      content: `Pinned lazy subagent progress for ${run.id}.`,
      display: true,
      details: { runId },
    });

    this.persistState();
    this.renderUi();
    return true;
  }

  getPinnedRunLines(runId: string, expanded = false): string[] {
    const run = this.registry.get(runId);
    if (!run) return [`Pinned lazy subagent ${runId} not found.`];

    const title = run.title || run.taskSummary;
    const stats = this.progressStats.get(runId);
    const metaParts = [run.agent, run.status];
    if (stats?.turnCount) metaParts.push(`${stats.turnCount} turns`);
    if (stats?.lastTurnTokens) metaParts.push(`last ${formatCompactThousands(stats.lastTurnTokens)} tok`);
    if (run.currentTool) metaParts.push(run.currentTool);
    if (run.toolCount !== undefined && run.toolCount > 0) metaParts.push(`${run.toolCount} tools`);
    if (run.totalTokens !== undefined && run.totalTokens > 0) metaParts.push(`${formatCompactThousands(run.totalTokens)} tokens`);

    const detailLines = this.progressLines.get(runId)
      ?? run.recentEvents.map((event) => summarizeSingleLine(event.summary)).filter((line): line is string => Boolean(line));
    const visibleLines = detailLines.slice(Math.max(0, detailLines.length - (expanded ? 20 : 8)));

    return [
      `${GLYPH_PINNED} ${title}`,
      metaParts.join(" · "),
      ...(run.model ? [`model ${run.model}`] : []),
      ...(expanded ? [`run ${run.id}`] : []),
      ...visibleLines.map((line) => `  ${line}`),
    ];
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
          const applied = this.applyUpdate(runId, update);
          if ((applied.stateChanged || applied.recordedEvent) && this.registry.isPinned(runId)) {
            await this.refreshProgressLines(runId, launch);
          }
        }
        this.scanRunHealth();
        const removedAcknowledgedRuns = this.cleanupAcknowledgedCompletedRuns();
        if (removedAcknowledgedRuns) this.persistState();
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

  private applyUpdate(runId: string, update: NormalizedRunUpdate): ApplyUpdateResult {
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
      this.registry.updateRun(runId, {
        status: update.status,
        updatedAt: update.updatedAt,
        completedAt: update.completedAt ?? existing.completedAt,
        sessionFile: update.sessionFile ?? existing.sessionFile,
        artifactPath: update.artifactPath ?? existing.artifactPath,
        resultPreview: update.resultPreview ?? existing.resultPreview,
        errorPreview: update.errorPreview ?? existing.errorPreview,
        currentTool: update.currentTool,
        toolCount: update.toolCount,
        totalTokens: mergeTotalTokens(existing.totalTokens, update.totalTokens),
        attentionNeeded: update.attentionNeeded ?? false,
      });
    }

    if (hasNewEvent && update.event) {
      this.registry.recordEvent(runId, update.event);
    }

    const next = this.registry.get(runId)!;
    if (hasStateChange) {
      if (isTerminalStatus(next.status)) {
        this.trackedLaunches.delete(runId);
        this.handleTerminalTransition(next);
      } else if ((!previousAttention && next.attentionNeeded) || (previousStatus !== "blocked" && next.status === "blocked")) {
        this.sendVisiblePayload(createAttentionMessagePayload(next));
      }

      this.persistState();
      this.renderUi();
    }

    return { stateChanged: hasStateChange, recordedEvent: hasNewEvent };
  }

  private handleTerminalTransition(run: RunRecord): void {
    const fingerprint = buildCompletionFingerprint({
      runId: run.id,
      status: run.status,
      completedAt: run.completedAt,
    });

    if (!this.registry.markCompletionSurfaced(run.id, fingerprint)) return;

    if (run.status === "completed") {
      this.sendVisiblePayload(createCompletionMessagePayload(run));
    } else if (run.status === "failed") {
      this.sendVisiblePayload(createFailureMessagePayload(run));
    } else if (run.status === "paused") {
      this.sendVisiblePayload(createAttentionMessagePayload(run));
    }

    if (run.status === "cancelled") return;

    const decision = decideCompletionRouting(run, {
      isIdle: this.currentCtx?.isIdle() ?? true,
      hasPendingMessages: this.currentCtx?.hasPendingMessages() ?? false,
    });

    if (!decision.triggerTurn || !decision.deliverAs || (decision.action !== "follow_up" && decision.action !== "wake")) {
      return;
    }

    const summary = buildHiddenSummary(run, this.registry.snapshot());
    this.pi.sendMessage(
      {
        customType: MESSAGE_TYPE_HIDDEN_SUMMARY,
        content: summary.text,
        display: false,
        details: summary,
      },
      {
        triggerTurn: decision.triggerTurn,
        deliverAs: decision.deliverAs,
      },
    );
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

  private async readResultText(run: RunRecord): Promise<string | undefined> {
    const resultPath = run.launchRef?.resultPath;
    if (!resultPath) return undefined;

    try {
      const raw = await fsp.readFile(resultPath, "utf8");
      const parsed = JSON.parse(raw) as {
        summary?: string;
        results?: Array<{ agent?: string; output?: string; error?: string }>;
      };

      const outputs = parsed.results
        ?.map((entry) => {
          const text = normalizeResultText(entry.output ?? entry.error);
          if (!text) return undefined;
          return entry.agent ? `[${entry.agent}]\n${text}` : text;
        })
        .filter((entry): entry is string => Boolean(entry));

      if (outputs && outputs.length > 0) {
        return outputs.length === 1 ? outputs[0] : outputs.join("\n\n");
      }

      return normalizeResultText(parsed.summary);
    } catch {
      return undefined;
    }
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
      run.status === "completed"
      && !this.registry.isPinned(run.id)
      && !this.registry.isAcknowledged(run.id)
      && run.completionPolicy !== "manual_pickup"
      && run.completedAt !== undefined
      && now - run.completedAt <= DEFAULT_SUCCESS_VISIBILITY_GRACE_MS
    ));
  }

  private hasPendingAcknowledgedCleanupWindow(now = this.now()): boolean {
    return this.registry.snapshot().runs.some((run) => (
      run.status === "completed"
      && !this.registry.isPinned(run.id)
      && this.registry.isAcknowledged(run.id)
      && run.completedAt !== undefined
      && now - run.completedAt <= DEFAULT_ACKNOWLEDGED_SUCCESS_TTL_MS
    ));
  }

  private cleanupAcknowledgedCompletedRuns(now = this.now()): boolean {
    const removed = this.registry.clearRuns((run) => (
      run.status === "completed"
      && !this.registry.isPinned(run.id)
      && this.registry.isAcknowledged(run.id)
      && run.completedAt !== undefined
      && now - run.completedAt > DEFAULT_ACKNOWLEDGED_SUCCESS_TTL_MS
    ));

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
    const removedAcknowledgedRuns = this.cleanupAcknowledgedCompletedRuns();
    if (removedAcknowledgedRuns) this.persistState();
    this.syncTrackedLaunchesFromSnapshot();

    for (const run of this.registry.snapshot().runs) {
      if (!this.registry.isPinned(run.id) || !run.launchRef) continue;
      await this.refreshProgressLines(run.id, run.launchRef);
    }

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
    ctx.ui.setStatus(STATUS_KEY, buildFooterStatus(snapshot, ctx.ui.theme));
    ctx.ui.setWidget(
      WIDGET_KEY,
      createWidgetContent(snapshot, this.now(), 6, { isPinned: (runId) => this.registry.isPinned(runId) }),
    );
    (ctx.ui as typeof ctx.ui & { requestRender?: () => void }).requestRender?.();
  }

  private queuePoll(): void {
    void this.pollOnce().catch((error) => {
      const message = error instanceof Error ? error.stack ?? error.message : String(error);
      console.error("[pi-lazy-subagents] pollOnce failed:", message);
    });
  }

  private refreshPoller(): void {
    if (this.trackedLaunches.size === 0 && !this.hasPendingUiGraceWindow() && !this.hasPendingAcknowledgedCleanupWindow()) {
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
