import { describe, expect, test } from "vitest";

import { buildLazySubagentsHelp, formatStatusReport, parseLazySubagentsCommand } from "../src/orchestration/commands.js";
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

describe("lazy-subagents command parsing", () => {
  test("help output includes built-in agent profiles and examples", () => {
    const help = buildLazySubagentsHelp();

    expect(help).toContain("delegate");
    expect(help).toContain("reviewer");
    expect(help).toContain("scout");
    expect(help).toContain("Examples:");
    expect(help).toContain("defaults agent to delegate");
  });

  test("parses run, status, result, pickup, pin, clear, and cancel commands", () => {
    expect(parseLazySubagentsCommand('run reviewer "Review the auth diff" --policy manual_pickup --title "Review auth diff"')).toEqual({
      action: "run",
      agent: "reviewer",
      prompt: "Review the auth diff",
      completionPolicy: "manual_pickup",
      title: "Review auth diff",
    });

    expect(parseLazySubagentsCommand("status run-1")).toEqual({ action: "status", runId: "run-1" });
    expect(parseLazySubagentsCommand("result run-1")).toEqual({ action: "result", runId: "run-1" });
    expect(parseLazySubagentsCommand("pickup run-1")).toEqual({ action: "pickup", runId: "run-1" });
    expect(parseLazySubagentsCommand("pin run-1")).toEqual({ action: "pin", runId: "run-1" });
    expect(parseLazySubagentsCommand("clear all")).toEqual({ action: "clear", scope: "all" });
    expect(parseLazySubagentsCommand("cancel run-1")).toEqual({ action: "cancel", runId: "run-1" });
  });

  test("formats a richer status report for active and recent runs", () => {
    const running = createRun({ id: "run-1", status: "running", startedAt: 50_000, updatedAt: 59_000, completedAt: undefined });
    (running as any).currentTool = "read";
    (running as any).toolCount = 3;
    running.recentEvents = [{ id: "progress-1", category: "progress", timestamp: 59_000, summary: "Inspecting auth.ts" }];
    const completed = createRun({ id: "run-2", status: "completed", startedAt: 40_000, updatedAt: 58_000, completedAt: 58_000, agent: "reviewer", resultPreview: "Found 3 issues" });
    const snapshot = createSnapshot([running, completed]);

    const report = formatStatusReport(snapshot, undefined, 60_000);

    expect(report).toContain("Active runs: 1");
    expect(report).toContain("elapsed: 10s");
    expect(report).toContain("updated: 1s ago");
    expect(report).toContain("tool: read");
    expect(report).toContain("tools used: 3");
    expect(report).toContain("last event: Inspecting auth.ts");
    expect(report).toContain("Found 3 issues");
    expect(report).toContain("result available: /lazy-subagents result run-2");
  });
});
