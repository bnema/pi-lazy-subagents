import { describe, expect, test } from "vitest";

import { buildCompletionFingerprint, createCompletionDedupeState, hasCompletionBeenSurfaced, markCompletionSurfaced } from "../src/state/dedupe.js";
import { createPersistedState, createEmptyPersistedState, restorePersistedState } from "../src/state/persistence.js";
import { RunRegistry } from "../src/state/run-registry.js";
import type { RunRecord } from "../src/types.js";

function createRun(overrides: Partial<RunRecord> = {}): RunRecord {
  const now = overrides.startedAt ?? 1;
  return {
    id: overrides.id ?? "run-1",
    kind: overrides.kind ?? "single",
    agent: overrides.agent ?? "researcher",
    title: overrides.title ?? "Research task",
    taskSummary: overrides.taskSummary ?? "Investigate the thing",
    status: overrides.status ?? "completed",
    startedAt: now,
    updatedAt: overrides.updatedAt ?? now,
    completedAt: overrides.completedAt ?? overrides.updatedAt ?? now,
    completionPolicy: overrides.completionPolicy ?? "follow_up_when_idle",
    sessionFile: overrides.sessionFile,
    artifactPath: overrides.artifactPath,
    resultPreview: overrides.resultPreview,
    errorPreview: overrides.errorPreview,
    attentionNeeded: overrides.attentionNeeded ?? false,
    groupId: overrides.groupId,
    children: overrides.children,
    recentEvents: overrides.recentEvents ?? [],
  };
}

describe("completion dedupe", () => {
  test("marks fingerprints idempotently", () => {
    const state = createCompletionDedupeState();
    const fingerprint = buildCompletionFingerprint({
      runId: "run-1",
      status: "completed",
      completedAt: 42,
    });

    expect(markCompletionSurfaced(state, { runId: "run-1", completionFingerprint: fingerprint, surfacedAt: 100 })).toBe(true);
    expect(hasCompletionBeenSurfaced(state, fingerprint)).toBe(true);
    expect(markCompletionSurfaced(state, { runId: "run-1", completionFingerprint: fingerprint, surfacedAt: 101 })).toBe(false);
    expect(state.records).toHaveLength(1);
  });
});

describe("persistence", () => {
  test("round-trips registry state including dedupe metadata", () => {
    const registry = new RunRegistry();
    registry.upsert(createRun({ id: "run-1", updatedAt: 5, resultPreview: "done" }));
    registry.markCompletionSurfaced("run-1", "run-1:completed:5");
    registry.acknowledgeRun("run-1");

    const persisted = createPersistedState(registry.serialize(), 123);
    const restored = restorePersistedState(persisted);
    const restoredRegistry = new RunRegistry({}, restored);

    expect(restored.version).toBe(1);
    expect(restored.updatedAt).toBe(123);
    expect(restoredRegistry.get("run-1")?.resultPreview).toBe("done");
    expect(restoredRegistry.hasSurfacedCompletion("run-1:completed:5")).toBe(true);
    expect(restoredRegistry.isAcknowledged("run-1")).toBe(true);
  });

  test("falls back to an empty persisted state for invalid input", () => {
    expect(restorePersistedState({ version: 999 })).toEqual(createEmptyPersistedState());
    expect(restorePersistedState(null)).toEqual(createEmptyPersistedState());
  });
});
