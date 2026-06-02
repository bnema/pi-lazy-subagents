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
    completionPolicy: overrides.completionPolicy ?? "wake_if_idle",
    sessionFile: overrides.sessionFile,
    artifactPath: overrides.artifactPath,
    resultPreview: overrides.resultPreview,
    errorPreview: overrides.errorPreview,
    attentionNeeded: overrides.attentionNeeded ?? false,
    name: overrides.name,
    cwd: overrides.cwd,
    leaseExpiry: overrides.leaseExpiry,
    archived: overrides.archived,
    groupId: overrides.groupId,
    children: overrides.children,
    launchRef: overrides.launchRef,
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

  test("round-trips name, cwd, leaseExpiry, and archived fields", () => {
    const registry = new RunRegistry();
    registry.upsert(createRun({
      id: "run-1",
      status: "completed",
      updatedAt: 10,
      completedAt: 10,
      name: "my-agent",
      cwd: "/home/user/project",
      leaseExpiry: 1_000_000,
    }));
    registry.upsert(createRun({
      id: "run-2",
      status: "completed",
      updatedAt: 20,
      completedAt: 20,
      name: "archived-one",
      cwd: "/tmp",
      leaseExpiry: 2_000_000,
      archived: true,
    }));
    registry.acknowledgeRun("run-1");

    const persisted = createPersistedState(registry.serialize(), 123);
    const restored = restorePersistedState(persisted);
    const restoredRegistry = new RunRegistry({}, restored);

    const r1 = restoredRegistry.get("run-1")!;
    expect(r1.name).toBe("my-agent");
    expect(r1.cwd).toBe("/home/user/project");
    expect(r1.leaseExpiry).toBe(1_000_000);
    expect(r1.archived).toBeUndefined();
    expect(restoredRegistry.isAcknowledged("run-1")).toBe(true);
    // Named non-archived runs are resolvable by name.
    expect(restoredRegistry.resolveTarget("my-agent")).toBe("run-1");
    // Archived run name should not be indexed.
    expect(restoredRegistry.resolveTarget("archived-one")).toBeUndefined();

    const r2 = restoredRegistry.get("run-2")!;
    expect(r2.name).toBe("archived-one");
    expect(r2.cwd).toBe("/tmp");
    expect(r2.leaseExpiry).toBe(2_000_000);
    expect(r2.archived).toBe(true);
    // Archived run still findable by ID.
    expect(restoredRegistry.resolveTarget("run-2")).toBe("run-2");
  });

  test("round-trips runs with cwd and child session launchRef", () => {
    const registry = new RunRegistry();
    registry.upsert(createRun({
      id: "run-1",
      status: "completed",
      updatedAt: 5,
      completedAt: 5,
      cwd: "/home/user/project",
      launchRef: {
        runId: "run-1",
        asyncId: "async-1",
        asyncDir: "/tmp/lazy-subagents/run-1",
        sessionFile: "/tmp/lazy-subagents/run-1/session.jsonl",
        resultPath: "/tmp/lazy-subagents/run-1/result.json",
      },
    }));

    const persisted = createPersistedState(registry.serialize(), 456);
    const restored = restorePersistedState(persisted);
    const restoredRegistry = new RunRegistry({}, restored);

    const run = restoredRegistry.get("run-1")!;
    expect(run.cwd).toBe("/home/user/project");
    expect(run.launchRef?.asyncId).toBe("async-1");
    expect(run.launchRef?.asyncDir).toBe("/tmp/lazy-subagents/run-1");
    expect(run.launchRef?.sessionFile).toBe("/tmp/lazy-subagents/run-1/session.jsonl");
  });
});
