import type { RunStatus } from "../types.js";

export interface CompletionFingerprintInput {
  runId: string;
  status: RunStatus;
  completedAt?: number;
}

export interface CompletionDedupeRecord {
  runId: string;
  completionFingerprint: string;
  surfacedAt: number;
}

export interface CompletionDedupeState {
  records: CompletionDedupeRecord[];
}

export function createCompletionDedupeState(): CompletionDedupeState {
  return { records: [] };
}

export function buildCompletionFingerprint(input: CompletionFingerprintInput): string {
  return `${input.runId}:${input.status}:${input.completedAt ?? "na"}`;
}

export function hasCompletionBeenSurfaced(state: CompletionDedupeState, fingerprint: string): boolean {
  return state.records.some((record) => record.completionFingerprint === fingerprint);
}

export function markCompletionSurfaced(state: CompletionDedupeState, record: CompletionDedupeRecord): boolean {
  if (hasCompletionBeenSurfaced(state, record.completionFingerprint)) {
    return false;
  }

  state.records.push(structuredClone(record));
  return true;
}
