import {
  DEFAULT_COMPLETED_RETENTION_LIMIT,
  DEFAULT_RECENT_EVENT_LIMIT,
  DEFAULT_RECENT_RUN_LIMIT,
  MAX_RUN_NAME_LENGTH,
  RUN_NAME_PATTERN,
} from "../defaults.js";
import type { RunCounts, RunEvent, RunRecord, RunRegistrySnapshot, RunStatus } from "../types.js";

const ACTIVE_STATUSES = new Set<RunStatus>(["queued", "running", "blocked", "paused"]);
const TERMINAL_STATUSES = new Set<RunStatus>(["completed", "skipped", "failed", "cancelled"]);

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
    skipped: 0,
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

function inferRunIdFromFingerprint(fingerprint: string): string | undefined {
  const separatorIndex = fingerprint.indexOf(":");
  if (separatorIndex <= 0) return undefined;
  return fingerprint.slice(0, separatorIndex);
}

function validateRunName(name: string): string | null {
  const trimmed = name.trim().toLowerCase();
  if (!trimmed || trimmed.length > MAX_RUN_NAME_LENGTH) return null;
  if (!RUN_NAME_PATTERN.test(trimmed)) return null;
  return trimmed;
}

export class RunRegistry {
  private readonly recentEventLimit: number;
  private readonly recentRunLimit: number;
  private readonly completedRetentionLimit: number;
  private readonly runs = new Map<string, RunRecord>();
  private readonly nameIndex = new Map<string, string>();
  private readonly surfacedCompletionKeys = new Set<string>();
  private readonly surfacedCompletionKeysByRun = new Map<string, Set<string>>();
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
      if (normalized.name && !normalized.archived) {
        this.tryClaimName(normalized.id, normalized.name);
      }
    }

    for (const fingerprint of initialState.surfacedCompletionKeys) {
      const runId = inferRunIdFromFingerprint(fingerprint);
      if (!runId) {
        this.surfacedCompletionKeys.add(fingerprint);
        continue;
      }
      this.trackSurfacedCompletionFingerprint(runId, fingerprint);
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
    if (normalized.name && !normalized.archived) {
      this.tryClaimName(normalized.id, normalized.name);
    }
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

    if (patch.name !== undefined && patch.name !== existing.name) {
      this.releaseName(runId);
      if (nextRun.name && !nextRun.archived) {
        this.tryClaimName(runId, nextRun.name);
      }
    }

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

  markCompletionSurfaced(runId: string, fingerprint: string): boolean {
    if (this.surfacedCompletionKeys.has(fingerprint)) return false;
    this.trackSurfacedCompletionFingerprint(runId, fingerprint);
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

  // --- Name-based addressing ---

  /**
   * Resolve a target string to a run ID. Tries exact run ID match first,
   * then falls back to name lookup (case-insensitive).
   */
  resolveTarget(target: string): string | undefined {
    if (this.runs.has(target)) return target;
    const normalized = target.trim().toLowerCase();
    return this.nameIndex.get(normalized);
  }

  /**
   * Claim a name for a run. Returns false if the name is invalid or already
   * claimed by a different non-archived run.
   */
  claimName(runId: string, name: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;

    const normalized = validateRunName(name);
    if (!normalized) return false;

    // Names must not collide with existing run IDs.
    if (this.runs.has(normalized)) return false;

    const existingOwner = this.nameIndex.get(normalized);
    if (existingOwner !== undefined && existingOwner !== runId) {
      const existingRun = this.runs.get(existingOwner);
      if (existingRun && !existingRun.archived) return false;
    }

    // Release any previous name held by this run.
    this.releaseName(runId);

    this.nameIndex.set(normalized, runId);
    run.name = name;
    return true;
  }

  /** Release a run's name from the index. */
  releaseName(runId: string): void {
    for (const [name, owner] of this.nameIndex.entries()) {
      if (owner === runId) {
        this.nameIndex.delete(name);
        return;
      }
    }
  }

  isNameAvailable(name: string): boolean {
    const normalized = validateRunName(name);
    if (!normalized) return false;
    if (this.runs.has(normalized)) return false;
    const owner = this.nameIndex.get(normalized);
    if (!owner) return true;
    const ownerRun = this.runs.get(owner);
    return Boolean(ownerRun?.archived);
  }

  getNameForRun(runId: string): string | undefined {
    return this.runs.get(runId)?.name;
  }

  // --- Archive / retire ---

  archiveRun(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    this.releaseName(runId);
    this.runs.set(runId, { ...run, archived: true });
    return true;
  }

  isArchived(runId: string): boolean {
    return Boolean(this.runs.get(runId)?.archived);
  }

  deleteRun(runId: string): boolean {
    const deleted = this.runs.delete(runId);
    if (!deleted) return false;
    this.clearRunMetadata(runId);
    return true;
  }

  clearRuns(predicate: (run: RunRecord) => boolean): string[] {
    const removed: string[] = [];
    for (const [runId, run] of this.runs.entries()) {
      if (!predicate(run)) continue;
      this.runs.delete(runId);
      this.clearRunMetadata(runId);
      removed.push(runId);
    }
    return removed;
  }

  prune(): void {
    const terminalRuns = [...this.runs.values()].filter((run) => isTerminalStatus(run.status)).sort(sortByUpdatedAtDescending);
    const keepTerminalIds = new Set(terminalRuns.slice(0, this.completedRetentionLimit).map((run) => run.id));

    for (const [runId, run] of this.runs.entries()) {
      if (isTerminalStatus(run.status) && !keepTerminalIds.has(runId) && !this.pinnedRunIds.has(runId)) {
        this.runs.delete(runId);
        this.clearRunMetadata(runId);
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

  private trackSurfacedCompletionFingerprint(runId: string, fingerprint: string): void {
    this.surfacedCompletionKeys.add(fingerprint);
    const fingerprints = this.surfacedCompletionKeysByRun.get(runId) ?? new Set<string>();
    fingerprints.add(fingerprint);
    this.surfacedCompletionKeysByRun.set(runId, fingerprints);
  }

  private tryClaimName(runId: string, name: string): void {
    const normalized = validateRunName(name);
    if (!normalized) return;

    // Names must not collide with existing run IDs.
    if (this.runs.has(normalized) && normalized !== runId) return;

    const existingOwner = this.nameIndex.get(normalized);
    if (existingOwner !== undefined && existingOwner !== runId) {
      const existingRun = this.runs.get(existingOwner);
      if (existingRun && !existingRun.archived) return;
    }

    this.nameIndex.set(normalized, runId);
  }

  private clearRunMetadata(runId: string): void {
    this.releaseName(runId);
    this.acknowledgedRunIds.delete(runId);
    this.pinnedRunIds.delete(runId);
    const fingerprints = this.surfacedCompletionKeysByRun.get(runId);
    if (fingerprints) {
      for (const fingerprint of fingerprints) {
        this.surfacedCompletionKeys.delete(fingerprint);
      }
      this.surfacedCompletionKeysByRun.delete(runId);
    }
  }
}

export const __testHooks = {
  isActiveStatus,
  isTerminalStatus,
  mergeRecentEvents,
};
