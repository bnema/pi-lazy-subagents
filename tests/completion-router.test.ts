import { describe, expect, test } from "vitest";

import { decideCompletionRouting } from "../src/orchestration/completion-router.js";
import { buildHiddenSummary } from "../src/orchestration/hidden-summary.js";
import type { RunRecord, RunRegistrySnapshot } from "../src/types.js";

function createRun(overrides: Partial<RunRecord> = {}): RunRecord {
  const now = overrides.startedAt ?? 1;
  return {
    id: overrides.id ?? "run-1",
    kind: overrides.kind ?? "single",
    agent: overrides.agent ?? "researcher",
    title: overrides.title ?? "Research auth flow",
    taskSummary: overrides.taskSummary ?? "Inspect the auth implementation",
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
    launchRef: overrides.launchRef,
    recentEvents: overrides.recentEvents ?? [],
  };
}

function createSnapshot(runs: RunRecord[]): RunRegistrySnapshot {
  const activeRuns = runs.filter((run) => ["queued", "running", "blocked", "paused"].includes(run.status));
  const recentRuns = runs.filter((run) => !activeRuns.includes(run));
  return {
    runs,
    counts: {
      queued: runs.filter((run) => run.status === "queued").length,
      running: runs.filter((run) => run.status === "running").length,
      blocked: runs.filter((run) => run.status === "blocked").length,
      completed: runs.filter((run) => run.status === "completed").length,
      failed: runs.filter((run) => run.status === "failed").length,
      cancelled: runs.filter((run) => run.status === "cancelled").length,
      paused: runs.filter((run) => run.status === "paused").length,
      attentionNeeded: runs.filter((run) => run.attentionNeeded).length,
    },
    activeRuns,
    recentRuns,
  };
}

describe("completion routing", () => {
  test("maps completion policies into notify, follow-up, wake, or manual decisions", () => {
    expect(decideCompletionRouting(createRun({ completionPolicy: "notify_only" }), { isIdle: true, hasPendingMessages: false }).action).toBe("notify");
    expect(decideCompletionRouting(createRun({ completionPolicy: "follow_up_when_idle" }), { isIdle: true, hasPendingMessages: false }).action).toBe("follow_up");
    expect(decideCompletionRouting(createRun({ completionPolicy: "manual_pickup" }), { isIdle: true, hasPendingMessages: false }).action).toBe("manual");
    expect(decideCompletionRouting(createRun({ completionPolicy: "wake_if_idle" }), { isIdle: true, hasPendingMessages: false }).action).toBe("wake");
    expect(decideCompletionRouting(createRun({ completionPolicy: "wake_if_idle" }), { isIdle: false, hasPendingMessages: false }).action).toBe("follow_up");
    expect(decideCompletionRouting(createRun({ completionPolicy: "wake_if_idle" }), { isIdle: true, hasPendingMessages: true }).action).toBe("follow_up");
  });
});

describe("hidden completion summaries", () => {
  test("builds a compact orchestration summary from run state", () => {
    const run = createRun({
      agent: "reviewer",
      title: "Review auth diff",
      resultPreview: "Found 3 issues in auth.ts",
      sessionFile: "/tmp/session.jsonl",
      artifactPath: "/tmp/output.log",
    });

    const summary = buildHiddenSummary(run, createSnapshot([run]));

    expect(summary.text).toContain("Lazy subagent update");
    expect(summary.text).toContain("reviewer");
    expect(summary.text).toContain("Found 3 issues in auth.ts");
    expect(summary.text).toContain("/tmp/session.jsonl");
    expect(summary.snapshot.recentRuns[0]?.id).toBe("run-1");
  });
});
