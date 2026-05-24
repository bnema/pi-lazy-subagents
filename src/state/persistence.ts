import type { CompletionPolicy, RunEvent, RunEventCategory, RunKind, RunLaunchRef, RunRecord, RunStatus } from "../types.js";
import { COMPLETION_POLICIES, RUN_EVENT_CATEGORIES, RUN_KINDS, RUN_STATUSES } from "../types.js";

import type { SerializedRunRegistryState } from "./run-registry.js";

export interface PersistedLazySubagentsState extends SerializedRunRegistryState {
  version: 1;
  updatedAt: number;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string");
}

function isRunKind(value: string): value is RunKind {
  return RUN_KINDS.includes(value as RunKind);
}

function isRunStatus(value: string): value is RunStatus {
  return RUN_STATUSES.includes(value as RunStatus);
}

function isCompletionPolicy(value: string): value is CompletionPolicy {
  return COMPLETION_POLICIES.includes(value as CompletionPolicy);
}

function isRunEventCategory(value: string): value is RunEventCategory {
  return RUN_EVENT_CATEGORIES.includes(value as RunEventCategory);
}

function normalizeLaunchRef(value: unknown): RunLaunchRef | undefined {
  if (!isObject(value)) return undefined;

  const runId = asString(value.runId);
  const asyncId = asString(value.asyncId);
  if (!runId || !asyncId) return undefined;

  return {
    runId,
    asyncId,
    asyncDir: asString(value.asyncDir),
    resultPath: asString(value.resultPath),
    sessionFile: asString(value.sessionFile),
    artifactPath: asString(value.artifactPath),
  };
}

function normalizeRunRecord(value: unknown): RunRecord | undefined {
  if (!isObject(value)) return undefined;

  const id = asString(value.id);
  const kind = asString(value.kind);
  const agent = asString(value.agent);
  const title = asString(value.title);
  const taskSummary = asString(value.taskSummary);
  const status = asString(value.status);
  const startedAt = asNumber(value.startedAt);
  const updatedAt = asNumber(value.updatedAt);
  const completionPolicy = asString(value.completionPolicy);
  const attentionNeeded = typeof value.attentionNeeded === "boolean" ? value.attentionNeeded : false;

  if (!id || !kind || !agent || !title || !taskSummary || !status || startedAt === undefined || updatedAt === undefined) {
    return undefined;
  }

  if (!isRunKind(kind)) return undefined;
  if (!isRunStatus(status)) return undefined;
  if (completionPolicy && !isCompletionPolicy(completionPolicy)) {
    // Legacy persisted policy values are accepted but normalized below. Subagents now always report back.
  }

  const recentEvents: RunEvent[] = Array.isArray(value.recentEvents)
    ? value.recentEvents
        .map((event): RunEvent | undefined => {
          if (!isObject(event)) return undefined;
          const eventId = asString(event.id);
          const category = asString(event.category);
          const timestamp = asNumber(event.timestamp);
          const summary = asString(event.summary);
          const key = asString(event.key);
          const eventStatus = asString(event.status);
          const details = isObject(event.details) ? event.details : undefined;

          if (!eventId || !category || timestamp === undefined || !summary) return undefined;
          if (!isRunEventCategory(category)) return undefined;
          if (eventStatus && !isRunStatus(eventStatus)) return undefined;

          const normalizedEventStatus: RunStatus | undefined = eventStatus && isRunStatus(eventStatus) ? eventStatus : undefined;

          return {
            id: eventId,
            category,
            timestamp,
            summary,
            key,
            status: normalizedEventStatus,
            details,
          };
        })
        .filter((event): event is RunEvent => Boolean(event))
    : [];

  return {
    id,
    kind,
    agent,
    title,
    taskSummary,
    status,
    startedAt,
    updatedAt,
    completedAt: asNumber(value.completedAt),
    completionPolicy: "wake_if_idle",
    sessionFile: asString(value.sessionFile),
    artifactPath: asString(value.artifactPath),
    resultPreview: asString(value.resultPreview),
    errorPreview: asString(value.errorPreview),
    currentTool: asString(value.currentTool),
    toolCount: asNumber(value.toolCount),
    totalTokens: asNumber(value.totalTokens),
    model: asString(value.model),
    attentionNeeded,
    groupId: asString(value.groupId),
    children: Array.isArray(value.children) ? asStringArray(value.children) : undefined,
    launchRef: normalizeLaunchRef(value.launchRef),
    recentEvents,
  };
}

export function createEmptyPersistedState(): PersistedLazySubagentsState {
  return {
    version: 1,
    runs: [],
    surfacedCompletionKeys: [],
    acknowledgedRunIds: [],
    pinnedRunIds: [],
    updatedAt: 0,
  };
}

export function createPersistedState(state: SerializedRunRegistryState, updatedAt = Date.now()): PersistedLazySubagentsState {
  return {
    version: 1,
    runs: state.runs.map((run) => structuredClone(run)),
    surfacedCompletionKeys: [...new Set(state.surfacedCompletionKeys)],
    acknowledgedRunIds: [...new Set(state.acknowledgedRunIds)],
    pinnedRunIds: [...new Set(state.pinnedRunIds ?? [])],
    updatedAt,
  };
}

export function restorePersistedState(value: unknown): PersistedLazySubagentsState {
  if (!isObject(value) || value.version !== 1) {
    return createEmptyPersistedState();
  }

  const runs = Array.isArray(value.runs)
    ? value.runs.map((run) => normalizeRunRecord(run)).filter((run): run is RunRecord => Boolean(run))
    : [];

  return {
    version: 1,
    runs,
    surfacedCompletionKeys: [...new Set(asStringArray(value.surfacedCompletionKeys))],
    acknowledgedRunIds: [...new Set(asStringArray(value.acknowledgedRunIds))],
    pinnedRunIds: [...new Set(asStringArray(value.pinnedRunIds))],
    updatedAt: asNumber(value.updatedAt) ?? 0,
  };
}
