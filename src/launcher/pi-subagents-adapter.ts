import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

import { getAgentDir } from "@earendil-works/pi-coding-agent";

import { getAgentProfile, listAvailableAgentProfiles, type AgentProfile } from "./agent-profiles.js";
import type {
  ContinueLaunchRequest,
  LaunchChildRequest,
  LaunchGroupRequest,
  LaunchResult,
  LaunchWorkflowRequest,
  Launcher,
  LauncherRuntimeContext,
  NormalizedRunUpdate,
} from "./interface.js";
import type { RunChildProgress, RunEvent, RunStatus } from "../types.js";

type DirectAsyncState = "queued" | "running" | "complete" | "failed" | "paused" | "cancelled";
type DirectActivityState = "active_long_running" | "needs_attention";

type DirectAsyncStatusStep = {
  id?: string;
  agent?: string;
  taskSummary?: string;
  dependsOn?: string[];
  retries?: number;
  maxAttempts?: number;
  attempt?: number;
  outputMode?: "text" | "json";
  outputSchema?: string;
  when?: string;
  fanOutFrom?: {
    step?: string;
    path?: string;
    idField?: string;
    maxItems?: number;
  };
  fanOutParentId?: string;
  summary?: string;
  structuredOutput?: Record<string, unknown>;
  status?: "pending" | "running" | "completed" | "skipped" | "failed" | "paused" | "cancelled";
  currentTool?: string;
  toolCount?: number;
  totalTokens?: number;
  promptTokens?: number;
  cacheReadTokens?: number;
  cacheHitRate?: number;
  sessionFile?: string;
  outputFile?: string;
};

type DirectAsyncStatus = {
  runId?: string;
  mode: "single" | "parallel" | "workflow";
  state: DirectAsyncState;
  activityState?: DirectActivityState;
  startedAt: number;
  lastUpdate?: number;
  endedAt?: number;
  sessionFile?: string;
  outputFile?: string;
  currentTool?: string;
  toolCount?: number;
  totalTokens?: number;
  promptTokens?: number;
  cacheReadTokens?: number;
  cacheHitRate?: number;
  steps?: DirectAsyncStatusStep[];
};

type DirectResultFile = {
  id?: string;
  runId?: string;
  state?: "complete" | "failed" | "paused" | "cancelled";
  success?: boolean;
  summary?: string;
  timestamp?: number;
  sessionFile?: string;
  toolCount?: number;
  totalTokens?: number;
  promptTokens?: number;
  cacheReadTokens?: number;
  cacheHitRate?: number;
  results?: Array<{
    stepId?: string;
    taskSummary?: string;
    dependsOn?: string[];
    agent?: string;
    summary?: string;
    structuredOutput?: Record<string, unknown>;
    status?: "completed" | "skipped" | "failed" | "paused" | "cancelled";
    skipped?: boolean;
    skipReason?: string;
    attempt?: number;
    maxAttempts?: number;
    attempts?: Array<{ attempt: number; success: boolean; error?: string }>;
    error?: string;
    output?: string;
    sessionFile?: string;
    totalTokens?: number;
    promptTokens?: number;
    cacheReadTokens?: number;
    cacheHitRate?: number;
    toolCount?: number;
    artifactPaths?: {
      outputPath?: string;
    };
  }>;
};

export interface PiSubagentsAdapterOptions {
  piBin?: string;
  asyncDirRoot?: string;
  resultsDir?: string;
}

interface RunnerChildConfig {
  id?: string;
  agent: string;
  taskSummary: string;
  prompt: string;
  dependsOn?: string[];
  retries?: number;
  outputMode?: "text" | "json";
  outputSchema?: string;
  when?: string;
  fanOutFrom?: {
    step: string;
    path: string;
    idField?: string;
    maxItems?: number;
  };
  cwd: string;
  sessionDir: string;
  outputFile: string;
  profile: AgentProfile;
  resolvedModel?: string;
  resolvedThinking?: string;
  profileByAgent?: Record<string, AgentProfile>;
  resolvedByAgent?: Record<string, { resolvedModel?: string; resolvedThinking?: string }>;
}

interface RunnerConfig {
  runId: string;
  mode: "single" | "parallel" | "workflow" | "continue";
  maxConcurrency?: number;
  piBin: string;
  asyncDir: string;
  resultsDir: string;
  resultPath: string;
  statusPath: string;
  eventsPath: string;
  continueSessionFile?: string;
  children: RunnerChildConfig[];
}

type LazySubagentSettingsFile = {
  defaultProvider?: unknown;
  defaultModel?: unknown;
  defaultThinkingLevel?: unknown;
  subagents?: {
    agentOverrides?: Record<string, { model?: unknown; thinking?: unknown }>;
  };
};

function sanitizeTempScopeSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "unknown";
}

export function resolveTempScopeId(
  options: {
    env?: NodeJS.ProcessEnv;
    getuid?: (() => number) | undefined;
  } = {},
): string {
  const env = options.env ?? process.env;
  const getuid = Object.hasOwn(options, "getuid") ? options.getuid : process.getuid?.bind(process);

  if (typeof getuid === "function") {
    return `uid-${getuid()}`;
  }

  for (const key of ["USERNAME", "USER", "LOGNAME"] as const) {
    const value = env[key];
    if (value) return `user-${sanitizeTempScopeSegment(value)}`;
  }

  try {
    const username = os.userInfo().username;
    if (username) return `user-${sanitizeTempScopeSegment(username)}`;
  } catch {
    // Fall through to home-based scoping.
  }

  const homedir = env.USERPROFILE ?? env.HOME;
  if (homedir) return `home-${sanitizeTempScopeSegment(homedir)}`;

  try {
    const fallbackHomedir = os.homedir();
    if (fallbackHomedir) return `home-${sanitizeTempScopeSegment(fallbackHomedir)}`;
  } catch {
    // Fall through to shared scope.
  }

  return "shared";
}

function resolveLazyTempRoot(): string {
  return path.join(os.tmpdir(), `pi-lazy-subagents-${resolveTempScopeId()}`);
}

function defaultAsyncDirRoot(): string {
  return path.join(resolveLazyTempRoot(), "async-runs");
}

function defaultResultsDir(): string {
  return path.join(resolveLazyTempRoot(), "results");
}

function isTerminalStatus(status: RunStatus): boolean {
  return status === "completed" || status === "skipped" || status === "failed" || status === "cancelled" || status === "paused";
}

function summarizeText(text: string | undefined, maxLength = 240): string | undefined {
  const singleLine = text?.replace(/\s+/g, " ").trim();
  if (!singleLine) return undefined;
  return singleLine.length <= maxLength ? singleLine : `${singleLine.slice(0, maxLength - 1).trimEnd()}…`;
}

function getResultArtifactPath(result: DirectResultFile): string | undefined {
  for (const child of result.results ?? []) {
    if (child.artifactPaths?.outputPath) return child.artifactPaths.outputPath;
  }
  return undefined;
}

function getResultSessionFile(result: DirectResultFile): string | undefined {
  return result.sessionFile ?? result.results?.find((child) => child.sessionFile)?.sessionFile;
}

function normalizeText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function findNearestProjectSettingsPath(cwd: string): string | undefined {
  let currentDir = cwd;
  while (true) {
    const candidate = path.join(currentDir, ".pi", "settings.json");
    if (fs.existsSync(candidate)) return candidate;
    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) return undefined;
    currentDir = parentDir;
  }
}

function getBuiltinAgentModelOverride(settings: LazySubagentSettingsFile | undefined, agentName: string): string | false | undefined {
  const override = settings?.subagents?.agentOverrides?.[agentName]?.model;
  if (override === false) return false;
  return normalizeText(override);
}

function getBuiltinAgentThinkingOverride(settings: LazySubagentSettingsFile | undefined, agentName: string): string | false | undefined {
  const override = settings?.subagents?.agentOverrides?.[agentName]?.thinking;
  if (override === false) return false;
  return normalizeText(override);
}

function buildDefaultModelReference(
  userSettings: LazySubagentSettingsFile | undefined,
  projectSettings: LazySubagentSettingsFile | undefined,
): string | undefined {
  const provider = normalizeText(projectSettings?.defaultProvider) ?? normalizeText(userSettings?.defaultProvider);
  const model = normalizeText(projectSettings?.defaultModel) ?? normalizeText(userSettings?.defaultModel);
  if (!model) return undefined;
  return model.includes("/") || !provider ? model : `${provider}/${model}`;
}

function resolveEffectiveModel(
  profile: Pick<AgentProfile, "source" | "model">,
  agentName: string,
  settings: {
    userSettings?: LazySubagentSettingsFile;
    projectSettings?: LazySubagentSettingsFile;
  },
): string | undefined {
  const projectOverride = profile.source === "builtin" ? getBuiltinAgentModelOverride(settings.projectSettings, agentName) : undefined;
  const userOverride = profile.source === "builtin" && projectOverride === undefined
    ? getBuiltinAgentModelOverride(settings.userSettings, agentName)
    : undefined;
  const explicitModel = projectOverride === false
    ? undefined
    : userOverride === false
      ? undefined
      : projectOverride ?? userOverride ?? profile.model;
  return explicitModel ?? buildDefaultModelReference(settings.userSettings, settings.projectSettings);
}

function resolveEffectiveThinking(
  profile: Pick<AgentProfile, "source" | "thinking">,
  agentName: string,
  settings: {
    userSettings?: LazySubagentSettingsFile;
    projectSettings?: LazySubagentSettingsFile;
  },
): string | undefined {
  const projectOverride = profile.source === "builtin" ? getBuiltinAgentThinkingOverride(settings.projectSettings, agentName) : undefined;
  const userOverride = profile.source === "builtin" && projectOverride === undefined
    ? getBuiltinAgentThinkingOverride(settings.userSettings, agentName)
    : undefined;
  const explicitThinking = projectOverride === false
    ? undefined
    : userOverride === false
      ? undefined
      : projectOverride ?? userOverride ?? profile.thinking;
  return explicitThinking
    ?? normalizeText(settings.projectSettings?.defaultThinkingLevel)
    ?? normalizeText(settings.userSettings?.defaultThinkingLevel);
}

function formatResolvedModelLabel(model: string | undefined, thinking: string | undefined): string | undefined {
  if (!model) return thinking ? `(default) • ${thinking}` : undefined;
  const separatorIndex = model.indexOf("/");
  const formattedModel = separatorIndex > 0
    ? `(${model.slice(0, separatorIndex)}) ${model.slice(separatorIndex + 1)}`
    : model;
  return thinking ? `${formattedModel} • ${thinking}` : formattedModel;
}

async function buildRunnerChildren(
  children: Array<Pick<RunnerChildConfig, "id" | "agent" | "taskSummary" | "prompt" | "dependsOn" | "retries" | "outputMode" | "outputSchema" | "when" | "fanOutFrom"> & { cwd?: string }>,
  baseCwd: string,
  asyncDir: string,
): Promise<RunnerChildConfig[]> {
  const settingsCache = new Map<string, Promise<{
    userSettings?: LazySubagentSettingsFile;
    projectSettings?: LazySubagentSettingsFile;
  }>>();

  const loadSettingsForCwd = (cwd: string) => {
    let promise = settingsCache.get(cwd);
    if (!promise) {
      promise = loadLazySubagentSettings(cwd);
      settingsCache.set(cwd, promise);
    }
    return promise;
  };

  return await Promise.all(children.map(async (child, index) => {
    const cwd = child.cwd ?? baseCwd;
    const settings = await loadSettingsForCwd(cwd);
    const profile = child.fanOutFrom && child.agent.includes("{{") ? getAgentProfile("delegate") : getAgentProfile(child.agent);
    const profileByAgent = Object.fromEntries(listAvailableAgentProfiles().map((availableProfile) => [availableProfile.name, availableProfile]));
    const resolvedByAgent = Object.fromEntries(Object.entries(profileByAgent).map(([agentName, availableProfile]) => [agentName, {
      resolvedModel: resolveEffectiveModel(availableProfile, agentName, settings),
      resolvedThinking: resolveEffectiveThinking(availableProfile, agentName, settings),
    }]));
    return {
      id: child.id,
      agent: child.agent,
      taskSummary: child.taskSummary,
      prompt: child.prompt,
      dependsOn: child.dependsOn,
      retries: child.retries,
      outputMode: child.outputMode,
      outputSchema: child.outputSchema,
      when: child.when,
      fanOutFrom: child.fanOutFrom,
      cwd,
      sessionDir: childSessionDir(asyncDir, index),
      outputFile: childOutputFile(index),
      profile,
      resolvedModel: resolveEffectiveModel(profile, child.agent, settings),
      resolvedThinking: resolveEffectiveThinking(profile, child.agent, settings),
      profileByAgent,
      resolvedByAgent,
    };
  }));
}

function summarizeResolvedModels(children: RunnerChildConfig[]): string | undefined {
  const resolved = children
    .map((child) => ({ agent: child.agent, label: formatResolvedModelLabel(child.resolvedModel, child.resolvedThinking) }))
    .filter((child): child is { agent: string; label: string } => typeof child.label === "string" && child.label.length > 0);

  if (resolved.length === 0) return undefined;
  const uniqueLabels = [...new Set(resolved.map((child) => child.label))];
  if (uniqueLabels.length === 1) return uniqueLabels[0];
  return resolved.map((child) => `${child.agent}: ${child.label}`).join(", ");
}

async function loadLazySubagentSettings(cwd: string): Promise<{
  userSettings?: LazySubagentSettingsFile;
  projectSettings?: LazySubagentSettingsFile;
}> {
  const userSettingsPath = path.join(getAgentDir(), "settings.json");
  const projectSettingsPath = findNearestProjectSettingsPath(cwd);
  const [userSettings, projectSettings] = await Promise.all([
    readJsonFile<LazySubagentSettingsFile>(userSettingsPath),
    readJsonFile<LazySubagentSettingsFile>(projectSettingsPath),
  ]);
  return { userSettings, projectSettings };
}

function buildEvent(runId: string, status: RunStatus, updatedAt: number, summary: string | undefined, attentionNeeded = false): RunEvent | undefined {
  const message = summary ?? `${runId} ${status}`;
  if (attentionNeeded) {
    return {
      id: `${runId}:${updatedAt}:attention`,
      category: "attention",
      timestamp: updatedAt,
      summary: message,
      status,
    };
  }

  if (status === "completed" || status === "skipped") {
    return {
      id: `${runId}:${updatedAt}:completion`,
      category: "completion",
      timestamp: updatedAt,
      summary: message,
      status,
    };
  }

  if (status === "failed") {
    return {
      id: `${runId}:${updatedAt}:failure`,
      category: "failure",
      timestamp: updatedAt,
      summary: message,
      status,
    };
  }

  return {
    id: `${runId}:${updatedAt}:progress`,
    category: "progress",
    timestamp: updatedAt,
    summary: message,
    status,
  };
}

export function mapAsyncStateToRunStatus(state: DirectAsyncState): RunStatus {
  switch (state) {
    case "queued":
      return "queued";
    case "running":
      return "running";
    case "complete":
      return "completed";
    case "failed":
      return "failed";
    case "paused":
      return "paused";
    case "cancelled":
      return "cancelled";
  }
}

export function computeResultPath(resultsDir: string, asyncId: string): string {
  return path.join(resultsDir, `${asyncId}.json`);
}

export function legacyResultPathFromAsyncDir(asyncDir: string, asyncId: string): string {
  return computeResultPath(path.join(asyncDir, "..", "..", "results"), asyncId);
}

export function normalizeAsyncLaunchResult(
  runId: string,
  asyncId: string,
  asyncDir: string,
  resultsDir: string,
  model?: string,
): LaunchResult {
  return {
    runId,
    asyncId,
    asyncDir,
    resultPath: computeResultPath(resultsDir, asyncId),
    model,
  };
}

function selectPrimaryStep(status: Pick<DirectAsyncStatus, "steps">): DirectAsyncStatusStep | undefined {
  const steps = status.steps ?? [];
  return steps.find((step) => step.status === "running") ?? steps[0];
}

function normalizeStepProgress(step: DirectAsyncStatusStep): RunChildProgress {
  return {
    id: step.id,
    agent: step.agent,
    taskSummary: step.taskSummary,
    status: step.status,
  };
}

function isFanOutAggregateResult(result: NonNullable<DirectResultFile["results"]>[number]): boolean {
  const structured = result.structuredOutput;
  return Boolean(
    structured
      && typeof structured === "object"
      && "children" in structured
      && Array.isArray((structured as { children?: unknown }).children),
  );
}

export function normalizeAsyncStatus(
  runId: string,
  asyncDir: string,
  status: Pick<
    DirectAsyncStatus,
    "runId" | "mode" | "state" | "activityState" | "startedAt" | "lastUpdate" | "endedAt" | "sessionFile" | "outputFile" | "currentTool" | "toolCount" | "totalTokens" | "promptTokens" | "cacheReadTokens" | "cacheHitRate" | "steps"
  >,
): NormalizedRunUpdate {
  const mappedStatus = mapAsyncStateToRunStatus(status.state);
  const attentionNeeded = status.activityState === "needs_attention" || mappedStatus === "paused";
  const localStatus: RunStatus = attentionNeeded && mappedStatus === "running" ? "blocked" : mappedStatus;
  const updatedAt = status.lastUpdate ?? status.endedAt ?? status.startedAt;
  const completedAt = isTerminalStatus(localStatus) ? status.endedAt ?? updatedAt : undefined;
  const primaryStep = selectPrimaryStep(status);
  const currentTool = primaryStep?.currentTool ?? status.currentTool;
  const toolCount = status.toolCount ?? primaryStep?.toolCount;
  const totalTokens = status.totalTokens ?? primaryStep?.totalTokens;
  const promptTokens = status.promptTokens ?? primaryStep?.promptTokens;
  const cacheReadTokens = status.cacheReadTokens ?? primaryStep?.cacheReadTokens;
  const cacheHitRate = status.cacheHitRate ?? primaryStep?.cacheHitRate;
  const outputFile = primaryStep?.outputFile ?? status.outputFile;
  const sessionFile = primaryStep?.sessionFile ?? status.sessionFile;
  const childProgress = status.steps?.map(normalizeStepProgress);
  const artifactPath = outputFile
    ? path.isAbsolute(outputFile)
      ? outputFile
      : path.join(asyncDir, outputFile)
    : undefined;
  const summary = summarizeText(
    attentionNeeded
      ? `${status.runId ?? runId} needs attention`
      : currentTool
        ? `${status.runId ?? runId} ${localStatus} · ${currentTool}`
        : `${status.runId ?? runId} ${localStatus}`,
  );

  return {
    runId,
    status: localStatus,
    updatedAt,
    completedAt,
    sessionFile,
    artifactPath,
    currentTool,
    toolCount,
    totalTokens,
    promptTokens,
    cacheReadTokens,
    cacheHitRate,
    attentionNeeded,
    childProgress,
    event: buildEvent(runId, localStatus, updatedAt, summary, attentionNeeded),
  };
}

export function normalizeAsyncResult(runId: string, result: DirectResultFile): NormalizedRunUpdate {
  const baseStatus: RunStatus = result.state === "paused"
    ? "paused"
    : result.state === "cancelled"
      ? "cancelled"
      : result.state === "failed" || result.success === false
        ? "failed"
        : "completed";
  const updatedAt = result.timestamp ?? Date.now();
  const summary = summarizeText(
    result.summary
      ?? result.results?.find((child) => child.error)?.error
      ?? result.results?.find((child) => child.output)?.output
      ?? result.results?.find((child) => child.skipped)?.skipReason,
  );

  const metricResults = result.results?.filter((child) => !isFanOutAggregateResult(child));
  const toolCounts = metricResults?.map((child) => child.toolCount).filter((value): value is number => typeof value === "number");
  const tokenTotals = metricResults?.map((child) => child.totalTokens).filter((value): value is number => typeof value === "number");
  const promptTokenTotals = metricResults?.map((child) => child.promptTokens).filter((value): value is number => typeof value === "number");
  const cacheReadTokenTotals = metricResults?.map((child) => child.cacheReadTokens).filter((value): value is number => typeof value === "number");
  const promptTokens = result.promptTokens ?? (promptTokenTotals && promptTokenTotals.length > 0 ? promptTokenTotals.reduce((sum, value) => sum + value, 0) : undefined);
  const cacheReadTokens = result.cacheReadTokens ?? (cacheReadTokenTotals && cacheReadTokenTotals.length > 0 ? cacheReadTokenTotals.reduce((sum, value) => sum + value, 0) : undefined);

  return {
    runId,
    status: baseStatus,
    updatedAt,
    completedAt: updatedAt,
    sessionFile: getResultSessionFile(result),
    artifactPath: getResultArtifactPath(result),
    toolCount: result.toolCount ?? (toolCounts && toolCounts.length > 0 ? toolCounts.reduce((sum, value) => sum + value, 0) : undefined),
    totalTokens: result.totalTokens ?? (tokenTotals && tokenTotals.length > 0 ? tokenTotals.reduce((sum, value) => sum + value, 0) : undefined),
    promptTokens,
    cacheReadTokens,
    cacheHitRate: result.cacheHitRate ?? (promptTokens && promptTokens > 0 ? ((cacheReadTokens ?? 0) / promptTokens) * 100 : undefined),
    resultPreview: baseStatus === "completed" || baseStatus === "paused" ? summary : undefined,
    errorPreview: baseStatus === "failed" || baseStatus === "cancelled" ? summary : undefined,
    attentionNeeded: baseStatus === "paused",
    event: buildEvent(runId, baseStatus, updatedAt, summary, baseStatus === "paused"),
  };
}

async function readJsonFile<T>(filePath: string | undefined): Promise<T | undefined> {
  if (!filePath) return undefined;

  try {
    const raw = await fsp.readFile(filePath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as T) : undefined;
  } catch {
    return undefined;
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(value, null, 2), "utf8");
}

function runnerPath(): string {
  return fileURLToPath(new URL("./direct-runner.mjs", import.meta.url));
}

function childSessionDir(asyncDir: string, index: number): string {
  return path.join(asyncDir, `session-${index}`);
}

function childOutputFile(index: number): string {
  return `output-${index}.log`;
}

async function spawnDetachedRunner(configPath: string, cwd: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, [runnerPath(), configPath], {
      cwd,
      detached: true,
      stdio: "ignore",
    });

    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

export class PiSubagentsAdapter implements Launcher {
  private readonly piBin: string;
  private readonly asyncDirRoot: string;
  private readonly resultsDir: string;

  constructor(options: PiSubagentsAdapterOptions = {}) {
    this.piBin = options.piBin ?? process.env.PI_LAZY_SUBAGENTS_PI_BIN ?? "pi";
    this.asyncDirRoot = options.asyncDirRoot ?? defaultAsyncDirRoot();
    this.resultsDir = options.resultsDir ?? defaultResultsDir();
  }

  private async launch(config: RunnerConfig, cwd: string): Promise<LaunchResult> {
    await fsp.mkdir(config.asyncDir, { recursive: true });
    await fsp.mkdir(this.resultsDir, { recursive: true });

    const configPath = path.join(config.asyncDir, "config.json");
    await fsp.writeFile(configPath, JSON.stringify(config, null, 2), "utf8");
    await spawnDetachedRunner(configPath, cwd);

    return {
      ...normalizeAsyncLaunchResult(config.runId, config.runId, config.asyncDir, this.resultsDir, summarizeResolvedModels(config.children)),
      resultPath: config.resultPath,
    };
  }

  async continueChild(request: ContinueLaunchRequest, _runtime: LauncherRuntimeContext): Promise<LaunchResult> {
    // The controller renames stale artifacts to .cont-bak before calling us.
    // We just set up the runner config and spawn.
    const children = await buildRunnerChildren([
      {
        agent: request.agent,
        taskSummary: request.taskSummary,
        prompt: request.prompt,
        cwd: request.cwd,
      },
    ], request.cwd, request.asyncDir);

    const config: RunnerConfig = {
      runId: request.runId,
      mode: "continue",
      piBin: this.piBin,
      asyncDir: request.asyncDir,
      resultsDir: this.resultsDir,
      resultPath: request.resultPath,
      statusPath: request.statusPath,
      eventsPath: request.eventsPath,
      continueSessionFile: request.sessionFile,
      children,
    };

    return await this.launch(config, request.cwd);
  }

  async launchChild(request: LaunchChildRequest, runtime: LauncherRuntimeContext): Promise<LaunchResult> {
    const cwd = request.cwd ?? runtime.cwd;
    const asyncDir = path.join(this.asyncDirRoot, request.runId);
    const config: RunnerConfig = {
      runId: request.runId,
      mode: "single",
      piBin: this.piBin,
      asyncDir,
      resultsDir: this.resultsDir,
      resultPath: computeResultPath(this.resultsDir, request.runId),
      statusPath: path.join(asyncDir, "status.json"),
      eventsPath: path.join(asyncDir, "events.jsonl"),
      children: await buildRunnerChildren([
        {
          agent: request.agent,
          taskSummary: request.taskSummary,
          prompt: request.prompt,
          cwd,
        },
      ], cwd, asyncDir),
    };

    return await this.launch(config, cwd);
  }

  async launchGroup(request: LaunchGroupRequest, runtime: LauncherRuntimeContext): Promise<LaunchResult> {
    const cwd = request.cwd ?? runtime.cwd;
    const asyncDir = path.join(this.asyncDirRoot, request.runId);
    const config: RunnerConfig = {
      runId: request.runId,
      mode: "parallel",
      piBin: this.piBin,
      asyncDir,
      resultsDir: this.resultsDir,
      resultPath: computeResultPath(this.resultsDir, request.runId),
      statusPath: path.join(asyncDir, "status.json"),
      eventsPath: path.join(asyncDir, "events.jsonl"),
      children: await buildRunnerChildren(request.children, cwd, asyncDir),
    };

    return await this.launch(config, cwd);
  }

  async launchWorkflow(request: LaunchWorkflowRequest, runtime: LauncherRuntimeContext): Promise<LaunchResult> {
    const cwd = request.cwd ?? runtime.cwd;
    const asyncDir = path.join(this.asyncDirRoot, request.runId);
    const config: RunnerConfig = {
      runId: request.runId,
      mode: "workflow",
      maxConcurrency: request.maxConcurrency,
      piBin: this.piBin,
      asyncDir,
      resultsDir: this.resultsDir,
      resultPath: computeResultPath(this.resultsDir, request.runId),
      statusPath: path.join(asyncDir, "status.json"),
      eventsPath: path.join(asyncDir, "events.jsonl"),
      children: await buildRunnerChildren(request.steps, cwd, asyncDir),
    };

    return await this.launch(config, cwd);
  }

  async readUpdate(launch: LaunchResult): Promise<NormalizedRunUpdate | undefined> {
    const result = await readJsonFile<DirectResultFile>(launch.resultPath);
    if (result) {
      return normalizeAsyncResult(launch.runId, result);
    }

    const asyncDir = launch.asyncDir ?? path.join(this.asyncDirRoot, launch.asyncId);
    const status = await readJsonFile<DirectAsyncStatus>(path.join(asyncDir, "status.json"));
    if (!status) return undefined;
    return normalizeAsyncStatus(launch.runId, asyncDir, status);
  }

  async cancel(launch: LaunchResult): Promise<boolean> {
    const asyncDir = launch.asyncDir ?? path.join(this.asyncDirRoot, launch.asyncId);
    const statusPath = path.join(asyncDir, "status.json");
    const resultPath = launch.resultPath ?? computeResultPath(this.resultsDir, launch.asyncId);
    const status = await readJsonFile<{
      runId?: string;
      mode?: "single" | "parallel" | "workflow";
      startedAt?: number;
      sessionFile?: string;
      pid?: number;
      steps?: Array<{ id?: string; taskSummary?: string; dependsOn?: string[]; agent?: string; pid?: number; sessionFile?: string; outputFile?: string }>;
    }>(statusPath);
    const pids = [...new Set([status?.pid, ...(status?.steps?.map((step) => step.pid) ?? [])])].filter(
      (value): value is number => typeof value === "number" && value > 0,
    );

    if (pids.length === 0) return false;

    let handledCount = 0;
    for (const pid of pids) {
      try {
        process.kill(pid, "SIGTERM");
        handledCount += 1;
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error ? (error as { code?: string }).code : undefined;
        if (code === "ESRCH") {
          handledCount += 1;
        }
      }
    }

    if (handledCount === 0) return false;

    const timestamp = Date.now();
    const persistedRunId = status?.runId ?? launch.runId;
    await writeJsonFile(statusPath, {
      runId: persistedRunId,
      mode: status?.mode ?? "single",
      pid: status?.pid,
      state: "cancelled",
      startedAt: status?.startedAt ?? timestamp,
      lastUpdate: timestamp,
      endedAt: timestamp,
      sessionFile: status?.sessionFile ?? launch.sessionFile,
      steps: (status?.steps ?? []).map((step, index) => ({
        ...step,
        index,
        agent: step.agent ?? `child-${index + 1}`,
        pid: step.pid,
        sessionFile: step.sessionFile,
        outputFile: step.outputFile,
        status: "cancelled",
        error: "Cancelled by user",
      })),
    });
    await writeJsonFile(resultPath, {
      id: persistedRunId,
      runId: persistedRunId,
      state: "cancelled",
      success: false,
      summary: "Cancelled by user",
      timestamp,
      sessionFile: status?.sessionFile ?? launch.sessionFile,
      results: (status?.steps ?? []).map((step, index) => ({
        stepId: step.id,
        taskSummary: step.taskSummary,
        dependsOn: step.dependsOn,
        agent: step.agent ?? `child-${index + 1}`,
        error: "Cancelled by user",
        success: false,
        sessionFile: step.sessionFile,
        artifactPaths: step.outputFile
          ? { outputPath: path.join(asyncDir, step.outputFile) }
          : undefined,
      })),
    });

    return true;
  }
}

export const __testHooks = {
  buildRunnerChildren,
  computeResultPath,
  legacyResultPathFromAsyncDir,
  mapAsyncStateToRunStatus,
  normalizeAsyncLaunchResult,
  normalizeAsyncStatus,
  normalizeAsyncResult,
  resolveEffectiveModel,
  resolveEffectiveThinking,
  summarizeResolvedModels,
  resolveTempScopeId,
};
