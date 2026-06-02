import { describe, expect, test } from "vitest";

import { RunRegistry } from "../src/state/run-registry.js";
import type { RunEvent, RunRecord } from "../src/types.js";

function createRun(overrides: Partial<RunRecord> = {}): RunRecord {
  const now = overrides.startedAt ?? 1;
  return {
    id: overrides.id ?? "run-1",
    kind: overrides.kind ?? "single",
    agent: overrides.agent ?? "researcher",
    title: overrides.title ?? "Research task",
    taskSummary: overrides.taskSummary ?? "Investigate the thing",
    status: overrides.status ?? "queued",
    startedAt: now,
    updatedAt: overrides.updatedAt ?? now,
    completedAt: overrides.completedAt,
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

function createEvent(overrides: Partial<RunEvent> = {}): RunEvent {
  return {
    id: overrides.id ?? "event-1",
    category: overrides.category ?? "progress",
    timestamp: overrides.timestamp ?? 1,
    summary: overrides.summary ?? "working",
    key: overrides.key,
    status: overrides.status,
    details: overrides.details,
  };
}

describe("RunRegistry", () => {
  test("tracks added runs, status transitions, and aggregate counts", () => {
    const registry = new RunRegistry();

    registry.upsert(createRun({ id: "run-1", status: "queued", updatedAt: 1 }));
    registry.upsert(createRun({ id: "run-2", status: "running", updatedAt: 2, attentionNeeded: true }));

    registry.updateRun("run-1", { status: "completed", updatedAt: 3, completedAt: 3 });

    const snapshot = registry.snapshot();
    expect(snapshot.counts.queued).toBe(0);
    expect(snapshot.counts.running).toBe(1);
    expect(snapshot.counts.completed).toBe(1);
    expect(snapshot.counts.attentionNeeded).toBe(1);
    expect(snapshot.activeRuns.map((run) => run.id)).toEqual(["run-2"]);
    expect(snapshot.recentRuns.map((run) => run.id)).toEqual(["run-1"]);
  });

  test("merges progress events by stable key and keeps a bounded recent buffer", () => {
    const registry = new RunRegistry({ recentEventLimit: 3 });
    registry.upsert(createRun({ id: "run-1", status: "running" }));

    registry.recordEvent("run-1", createEvent({ id: "progress-1", key: "spinner", summary: "10%" }));
    registry.recordEvent("run-1", createEvent({ id: "progress-2", key: "spinner", timestamp: 2, summary: "50%" }));
    registry.recordEvent("run-1", createEvent({ id: "tool-1", category: "tool", timestamp: 3, summary: "Used bash" }));
    registry.recordEvent("run-1", createEvent({ id: "progress-3", key: "phase", timestamp: 4, summary: "phase 2" }));

    const run = registry.get("run-1");
    expect(run?.recentEvents.map((event) => event.id)).toEqual(["progress-2", "tool-1", "progress-3"]);
    expect(run?.recentEvents[0]?.summary).toBe("50%");
  });

  test("marks terminal event transitions with completedAt and prunes when retention is exceeded", () => {
    const registry = new RunRegistry({ completedRetentionLimit: 1, recentRunLimit: 1 });

    registry.upsert(createRun({ id: "run-1", status: "running", updatedAt: 1 }));
    registry.upsert(createRun({ id: "run-2", status: "completed", updatedAt: 2, completedAt: 2 }));

    registry.recordEvent(
      "run-1",
      createEvent({ id: "completion", timestamp: 3, summary: "done", status: "completed" }),
    );

    expect(registry.get("run-1")?.completedAt).toBe(3);
    expect(registry.get("run-2")).toBeUndefined();
  });

  test("prunes old terminal runs while keeping active ones and the most recent terminal records", () => {
    const registry = new RunRegistry({ completedRetentionLimit: 2, recentRunLimit: 2 });

    registry.upsert(createRun({ id: "old-complete", status: "completed", updatedAt: 1, completedAt: 1 }));
    registry.upsert(createRun({ id: "recent-failed", status: "failed", updatedAt: 2, completedAt: 2 }));
    registry.upsert(createRun({ id: "newest-complete", status: "completed", updatedAt: 3, completedAt: 3 }));
    registry.upsert(createRun({ id: "still-running", status: "running", updatedAt: 4 }));

    registry.prune();

    expect(registry.get("old-complete")).toBeUndefined();
    expect(registry.get("recent-failed")?.status).toBe("failed");
    expect(registry.get("newest-complete")?.status).toBe("completed");
    expect(registry.get("still-running")?.status).toBe("running");
  });

  test("keeps pinned terminal runs and drops their surfaced completion fingerprints only when removed", () => {
    const registry = new RunRegistry({ completedRetentionLimit: 1, recentRunLimit: 1 });

    registry.upsert(createRun({ id: "pinned-complete", status: "completed", updatedAt: 1, completedAt: 1 }));
    registry.pinRun("pinned-complete");
    registry.upsert(createRun({ id: "newest-complete", status: "completed", updatedAt: 2, completedAt: 2 }));
    registry.markCompletionSurfaced("pinned-complete", "pinned-complete:completed:1");

    registry.prune();
    expect(registry.get("pinned-complete")?.status).toBe("completed");
    expect(registry.hasSurfacedCompletion("pinned-complete:completed:1")).toBe(true);

    expect(registry.deleteRun("pinned-complete")).toBe(true);
    expect(registry.hasSurfacedCompletion("pinned-complete:completed:1")).toBe(false);
  });

  describe("name-based addressing", () => {
    test("claimName registers a valid unique name and resolveTarget finds it", () => {
      const registry = new RunRegistry();
      registry.upsert(createRun({ id: "run-1", status: "running" }));

      expect(registry.claimName("run-1", "my-agent")).toBe(true);
      expect(registry.getNameForRun("run-1")).toBe("my-agent");
      expect(registry.resolveTarget("my-agent")).toBe("run-1");
      // Case-insensitive resolution.
      expect(registry.resolveTarget("MY-AGENT")).toBe("run-1");
      // Direct id lookup still works.
      expect(registry.resolveTarget("run-1")).toBe("run-1");
    });

    test("claimName rejects invalid names", () => {
      const registry = new RunRegistry();
      registry.upsert(createRun({ id: "run-1", status: "running" }));

      expect(registry.claimName("run-1", "")).toBe(false);
      expect(registry.claimName("run-1", "  ")).toBe(false);
      expect(registry.claimName("run-1", "my agent")).toBe(false);
      expect(registry.claimName("run-1", "-leading-hyphen")).toBe(false);
    });

    test("claimName rejects names already claimed by another non-archived run", () => {
      const registry = new RunRegistry();
      registry.upsert(createRun({ id: "run-1", status: "running" }));
      registry.upsert(createRun({ id: "run-2", status: "running" }));

      expect(registry.claimName("run-1", "shared-name")).toBe(true);
      expect(registry.claimName("run-2", "shared-name")).toBe(false);
      expect(registry.resolveTarget("shared-name")).toBe("run-1");
    });

    test("claimName succeeds when previous owner is archived", () => {
      const registry = new RunRegistry();
      registry.upsert(createRun({ id: "run-1", status: "completed", completedAt: 1 }));
      registry.upsert(createRun({ id: "run-2", status: "running" }));

      registry.claimName("run-1", "reusable");
      registry.archiveRun("run-1");

      expect(registry.claimName("run-2", "reusable")).toBe(true);
      expect(registry.resolveTarget("reusable")).toBe("run-2");
    });

    test("claimName rejects archived runs", () => {
      const registry = new RunRegistry();
      registry.upsert(createRun({ id: "run-1", status: "completed", completedAt: 1, archived: true }));

      expect(registry.claimName("run-1", "archived-name")).toBe(false);
      expect(registry.resolveTarget("archived-name")).toBeUndefined();
    });

    test("names must not collide with existing run IDs", () => {
      const registry = new RunRegistry();
      registry.upsert(createRun({ id: "run-1", status: "running" }));

      // "run-1" is an existing run ID, so it can't be used as a name.
      expect(registry.claimName("run-1", "run-1")).toBe(false);
      expect(registry.isNameAvailable("run-1")).toBe(false);
    });

    test("deleteRun frees the name so another run can claim it after deletion", () => {
      const registry = new RunRegistry();
      registry.upsert(createRun({ id: "run-1", status: "completed", completedAt: 1 }));
      registry.claimName("run-1", "freed");

      registry.deleteRun("run-1");
      // After deletion, the name is released.
      expect(registry.resolveTarget("freed")).toBeUndefined();

      registry.upsert(createRun({ id: "run-2", status: "running" }));
      expect(registry.claimName("run-2", "freed")).toBe(true);
    });

    test("updateRun preserves the previous name when a rename cannot be claimed", () => {
      const registry = new RunRegistry();
      registry.upsert(createRun({ id: "run-1", status: "running", name: "valid-name" }));

      const updated = registry.updateRun("run-1", { name: "invalid name" });

      expect(updated.name).toBe("valid-name");
      expect(registry.getNameForRun("run-1")).toBe("valid-name");
      expect(registry.resolveTarget("valid-name")).toBe("run-1");
      expect(registry.resolveTarget("invalid name")).toBeUndefined();
    });

    test("upsert clears an unclaimable name instead of leaving a phantom value", () => {
      const registry = new RunRegistry();

      const inserted = registry.upsert(createRun({ id: "run-1", status: "running", name: "run-1" }));

      expect(inserted.name).toBeUndefined();
      expect(registry.getNameForRun("run-1")).toBeUndefined();
      expect(registry.resolveTarget("run-1")).toBe("run-1");
    });

    test("restore clears persisted names that cannot be claimed", () => {
      const registry = new RunRegistry({}, {
        runs: [
          createRun({ id: "run-1", status: "running", name: "shared" }),
          createRun({ id: "run-2", status: "running", name: "shared" }),
        ],
        surfacedCompletionKeys: [],
        acknowledgedRunIds: [],
        pinnedRunIds: [],
      });

      expect(registry.getNameForRun("run-1")).toBe("shared");
      expect(registry.getNameForRun("run-2")).toBeUndefined();
      expect(registry.resolveTarget("shared")).toBe("run-1");
    });

    test("isNameAvailable returns true for unclaimed valid names", () => {
      const registry = new RunRegistry();
      registry.upsert(createRun({ id: "run-1", status: "running" }));

      expect(registry.isNameAvailable("fresh-name")).toBe(true);
      registry.claimName("run-1", "fresh-name");
      expect(registry.isNameAvailable("fresh-name")).toBe(false);
    });

    test("resolveTarget returns undefined for unknown name", () => {
      const registry = new RunRegistry();
      expect(registry.resolveTarget("no-such-name")).toBeUndefined();
      expect(registry.resolveTarget("no-such-id")).toBeUndefined();
    });
  });

  describe("archive and lifecycle", () => {
    test("archiveRun marks run as archived and releases its name", () => {
      const registry = new RunRegistry();
      registry.upsert(createRun({ id: "run-1", status: "completed", completedAt: 1 }));
      registry.claimName("run-1", "to-archive");

      expect(registry.archiveRun("run-1")).toBe(true);
      expect(registry.isArchived("run-1")).toBe(true);
      expect(registry.resolveTarget("to-archive")).toBeUndefined();
      // Still findable by ID.
      expect(registry.resolveTarget("run-1")).toBe("run-1");
      expect(registry.get("run-1")?.archived).toBe(true);
    });

    test("archiveRun returns false for unknown run", () => {
      const registry = new RunRegistry();
      expect(registry.archiveRun("no-such-run")).toBe(false);
    });

    test("isArchived returns false for unarchived and missing runs", () => {
      const registry = new RunRegistry();
      registry.upsert(createRun({ id: "run-1", status: "running" }));
      expect(registry.isArchived("run-1")).toBe(false);
      expect(registry.isArchived("no-such-run")).toBe(false);
    });
  });
});
