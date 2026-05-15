import {
  DEFAULT_COMPLETED_RETENTION_LIMIT,
  DEFAULT_RECENT_EVENT_LIMIT,
  DEFAULT_RECENT_RUN_LIMIT,
} from "../defaults.js";
import type { RunCounts, RunEvent, RunRecord, RunRegistrySnapshot, RunStatus } from "../types.js";

const ACTIVE_STATUSES = new Set<RunStatus>(["queued", "running", "blocked", "paused"]);
const TERMINAL_STATUSES = new Set<RunStatus>(["completed", "failed", "cancelled"]);

export interface RunRegistryOptions {
  recentEventLimit?: number;
  recentRunLimit?: number;
  completedRetentionLimit?: number;
}

export interface SerializedRunRegistryState {
  runs: RunRecord[];
  surfacedCompletionKeys: string[];
  acknowledgedRunIds: string[];
  pinnedRunIds: string[];
}

export type RunUpdatePatch = Partial<Omit<RunRecord, "id" | "recentEvents">> & {
  recentEvents?: RunEvent[];
};

function cloneRun<T>(value: T): T {
  return structuredClone(value);
}

function createCounts(): RunCounts {
  return {
    queued: 0,
    running: 0,
    blocked: 0,
    completed: 0,
    failed: 0,
    cancelled: 0,
    paused: 0,
    attentionNeeded: 0,
  };
}

function isActiveStatus(status: RunStatus): boolean {
  return ACTIVE_STATUSES.has(status);
}

function isTerminalStatus(status: RunStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function sortByUpdatedAtDescending(left: RunRecord, right: RunRecord): number {
  return right.updatedAt - left.updatedAt || right.startedAt - left.startedAt || left.id.localeCompare(right.id);
}

function mergeRecentEvents(events: RunEvent[], nextEvent: RunEvent, limit: number): RunEvent[] {
  const buffer = events.map((event) => cloneRun(event));
  const event = cloneRun(nextEvent);

  if (event.category === "progress" && event.key) {
    const index = buffer.findIndex((existing) => existing.category === "progress" && existing.key === event.key);
    if (index >= 0) {
      buffer[index] = event;
      return buffer.slice(Math.max(0, buffer.length - limit));
    }
  }

  buffer.push(event);
  return buffer.slice(Math.max(0, buffer.length - limit));
}

function normalizeRun(run: RunRecord, recentEventLimit: number): RunRecord {
  const normalized = cloneRun(run);
  normalized.recentEvents = [];
  for (const event of run.recentEvents) {
    normalized.recentEvents = mergeRecentEvents(normalized.recentEvents, event, recentEventLimit);
  }
  return normalized;
}

export class RunRegistry {
  private readonly recentEventLimit: number;
  private readonly recentRunLimit: number;
  private readonly completedRetentionLimit: number;
  private readonly runs = new Map<string, RunRecord>();
  private readonly surfacedCompletionKeys = new Set<string>();
  private readonly acknowledgedRunIds = new Set<string>();
  private readonly pinnedRunIds = new Set<string>();

  constructor(options: RunRegistryOptions = {}, initialState?: SerializedRunRegistryState) {
    this.recentEventLimit = options.recentEventLimit ?? DEFAULT_RECENT_EVENT_LIMIT;
    this.recentRunLimit = options.recentRunLimit ?? DEFAULT_RECENT_RUN_LIMIT;
    this.completedRetentionLimit = options.completedRetentionLimit ?? DEFAULT_COMPLETED_RETENTION_LIMIT;

    if (!initialState) return;

    for (const run of initialState.runs) {
      const normalized = normalizeRun(run, this.recentEventLimit);
      this.runs.set(normalized.id, normalized);
    }

    for (const fingerprint of initialState.surfacedCompletionKeys) {
      this.surfacedCompletionKeys.add(fingerprint);
    }

    for (const runId of initialState.acknowledgedRunIds) {
      this.acknowledgedRunIds.add(runId);
    }

    for (const runId of initialState.pinnedRunIds ?? []) {
      this.pinnedRunIds.add(runId);
    }

    this.prune();
  }

  upsert(run: RunRecord): RunRecord {
    const normalized = normalizeRun(run, this.recentEventLimit);
    this.runs.set(normalized.id, normalized);
    this.prune();
    return cloneRun(normalized);
  }

  get(runId: string): RunRecord | undefined {
    const run = this.runs.get(runId);
    return run ? cloneRun(run) : undefined;
  }

  updateRun(runId: string, patch: RunUpdatePatch): RunRecord {
    const existing = this.runs.get(runId);
    if (!existing) {
      throw new Error(`Run not found: ${runId}`);
    }

    const nextRun: RunRecord = {
      ...existing,
      ...cloneRun(patch),
      id: existing.id,
      recentEvents: patch.recentEvents ? normalizeRun({ ...existing, recentEvents: patch.recentEvents }, this.recentEventLimit).recentEvents : existing.recentEvents,
    };

    this.runs.set(runId, nextRun);
    this.prune();
    return cloneRun(nextRun);
  }

  recordEvent(runId: string, event: RunEvent): RunRecord {
    const existing = this.runs.get(runId);
    if (!existing) {
      throw new Error(`Run not found: ${runId}`);
    }

    const nextStatus = event.status ?? existing.status;
    const recentEvents = mergeRecentEvents(existing.recentEvents, event, this.recentEventLimit);
    const nextRun: RunRecord = {
      ...existing,
      recentEvents,
      updatedAt: Math.max(existing.updatedAt, event.timestamp),
      status: nextStatus,
      completedAt: isTerminalStatus(nextStatus) ? existing.completedAt ?? event.timestamp : existing.completedAt,
    };

    this.runs.set(runId, nextRun);
    this.prune();
    return cloneRun(nextRun);
  }

  markCompletionSurfaced(fingerprint: string): boolean {
    if (this.surfacedCompletionKeys.has(fingerprint)) return false;
    this.surfacedCompletionKeys.add(fingerprint);
    return true;
  }

  hasSurfacedCompletion(fingerprint: string): boolean {
    return this.surfacedCompletionKeys.has(fingerprint);
  }

  acknowledgeRun(runId: string): void {
    this.acknowledgedRunIds.add(runId);
  }

  isAcknowledged(runId: string): boolean {
    return this.acknowledgedRunIds.has(runId);
  }

  pinRun(runId: string): void {
    this.pinnedRunIds.add(runId);
  }

  unpinRun(runId: string): void {
    this.pinnedRunIds.delete(runId);
  }

  isPinned(runId: string): boolean {
    return this.pinnedRunIds.has(runId);
  }

  deleteRun(runId: string): boolean {
    const deleted = this.runs.delete(runId);
    if (!deleted) return false;
    this.acknowledgedRunIds.delete(runId);
    this.pinnedRunIds.delete(runId);
    return true;
  }

  clearRuns(predicate: (run: RunRecord) => boolean): string[] {
    const removed: string[] = [];
    for (const [runId, run] of this.runs.entries()) {
      if (!predicate(run)) continue;
      this.runs.delete(runId);
      this.acknowledgedRunIds.delete(runId);
      this.pinnedRunIds.delete(runId);
      removed.push(runId);
    }
    return removed;
  }

  prune(): void {
    const terminalRuns = [...this.runs.values()].filter((run) => isTerminalStatus(run.status)).sort(sortByUpdatedAtDescending);
    const keepTerminalIds = new Set(terminalRuns.slice(0, this.completedRetentionLimit).map((run) => run.id));

    for (const [runId, run] of this.runs.entries()) {
      if (isTerminalStatus(run.status) && !keepTerminalIds.has(runId)) {
        this.runs.delete(runId);
        this.acknowledgedRunIds.delete(runId);
        this.pinnedRunIds.delete(runId);
      }
    }
  }

  snapshot(): RunRegistrySnapshot {
    this.prune();

    const runs = [...this.runs.values()].map((run) => cloneRun(run)).sort(sortByUpdatedAtDescending);
    const counts = createCounts();

    for (const run of runs) {
      counts[run.status] += 1;
      if (run.attentionNeeded) counts.attentionNeeded += 1;
    }

    const activeRuns = runs.filter((run) => isActiveStatus(run.status));
    const recentRuns = runs.filter((run) => !isActiveStatus(run.status)).slice(0, this.recentRunLimit);

    return {
      runs,
      counts,
      activeRuns,
      recentRuns,
    };
  }

  serialize(): SerializedRunRegistryState {
    this.prune();
    return {
      runs: [...this.runs.values()].map((run) => cloneRun(run)).sort(sortByUpdatedAtDescending),
      surfacedCompletionKeys: [...this.surfacedCompletionKeys],
      acknowledgedRunIds: [...this.acknowledgedRunIds],
      pinnedRunIds: [...this.pinnedRunIds],
    };
  }
}

export const __testHooks = {
  isActiveStatus,
  isTerminalStatus,
  mergeRecentEvents,
};
