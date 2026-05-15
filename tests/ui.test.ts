import { describe, expect, test } from "vitest";

import { buildFooterStatus } from "../src/ui/status.js";
import {
  createCompletionMessagePayload,
  createFailureMessagePayload,
  createLaunchMessagePayload,
  formatRunMessageBody,
} from "../src/ui/messages.js";
import { buildWidgetLines } from "../src/ui/widget.js";
import type { RunRecord, RunRegistrySnapshot } from "../src/types.js";

function createRun(overrides: Partial<RunRecord> = {}): RunRecord {
  const now = overrides.startedAt ?? 1;
  return {
    id: overrides.id ?? "run-1",
    kind: overrides.kind ?? "single",
    agent: overrides.agent ?? "researcher",
    title: overrides.title ?? "Research auth flow",
    taskSummary: overrides.taskSummary ?? "Investigate auth flow",
    status: overrides.status ?? "running",
    startedAt: now,
    updatedAt: overrides.updatedAt ?? now,
    completedAt: overrides.completedAt,
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

describe("visibility helpers", () => {
  test("builds a richer footer summary with live tool, token, and timing context", () => {
    const running = createRun({ id: "run-1", status: "running", startedAt: 30_000, updatedAt: 59_000, title: "Research auth flow" });
    (running as any).currentTool = "bash";
    (running as any).totalTokens = 126_400;
    const blocked = createRun({ id: "run-2", status: "blocked", updatedAt: 58_000, title: "Needs human input", attentionNeeded: true });
    const completed = createRun({ id: "run-3", status: "completed", updatedAt: 57_000, completedAt: 57_000, agent: "planner" });
    const snapshot = createSnapshot([running, blocked, completed]);

    const status = buildFooterStatus(snapshot, 60_000, {
      fg: (_color: string, text: string) => `<${text}>`,
    } as any);

    expect(status).toContain("<●>");
    expect(status).toContain("1 running");
    expect(status).toContain("1 blocked");
    expect(status).toContain("bash");
    expect(status).toContain("126k");
    expect(status).toContain("upd 1s");
    expect(status).toContain("last finish 3s");
  });

  test("builds colorized widget lines with live health, token, and recent outcome context", () => {
    const running = createRun({ id: "run-1", status: "running", startedAt: 50_000, updatedAt: 59_000, title: "Research auth flow" });
    (running as any).currentTool = "read";
    (running as any).toolCount = 3;
    (running as any).totalTokens = 1_240;
    running.recentEvents = [{ id: "progress-1", category: "progress", timestamp: 59_000, summary: "Inspecting auth.ts" }];
    const blocked = createRun({ id: "run-2", status: "blocked", startedAt: 45_000, updatedAt: 52_000, title: "Needs human input", attentionNeeded: true });
    blocked.recentEvents = [{ id: "attention-1", category: "attention", timestamp: 52_000, summary: "Waiting on a decision about provider choice" }];
    const completed = createRun({ id: "run-3", status: "completed", updatedAt: 58_000, completedAt: 58_000, title: "Plan done", agent: "planner", resultPreview: "Found 3 files" });
    const snapshot = createSnapshot([running, blocked, completed]);

    const lines = buildWidgetLines(snapshot, 60_000, 6, {
      fg: (_color: string, text: string) => `<${text}>`,
      dim: (text: string) => `(${text})`,
      muted: (text: string) => `{${text}}`,
      bold: (text: string) => `*${text}*`,
    } as any);

    expect(lines[0]).toContain("<↻>");
    expect(lines[0]).toContain("elapsed 10s");
    expect(lines[0]).toContain("upd 1s");
    expect(lines[0]).toContain("read");
    expect(lines[0]).toContain("3 tools");
    expect(lines[0]).toContain("1.2k");
    expect(lines[1]).toContain("Research auth flow");
    expect(lines[1]).toContain("Inspecting auth.ts");
    expect(lines[2]).toContain("<!>");
    expect(lines[2]).toContain("quiet 8s");
    expect(lines[4]).toContain("<✓>");
    expect(lines[4]).toContain("done 2s ago");
    expect(lines[5]).toContain("Found 3 files");
  });

  test("formats launch, completion, and failure message payloads", () => {
    const running = createRun({ id: "run-1", status: "running", title: "Research auth flow" });
    const completed = createRun({ id: "run-2", status: "completed", title: "Plan auth flow", resultPreview: "Found 3 files", completedAt: 90 });
    (completed as any).totalTokens = 247_000;
    const failed = createRun({ id: "run-3", status: "failed", title: "Implement auth flow", errorPreview: "worker failed" });

    const launch = createLaunchMessagePayload(running);
    const completion = createCompletionMessagePayload(completed);
    const failure = createFailureMessagePayload(failed);

    expect(formatRunMessageBody(launch, false)).toContain("Launched");
    expect(formatRunMessageBody(completion, false)).toContain("247k tokens");
    expect(formatRunMessageBody(completion, false)).toContain("Found 3 files");
    expect(formatRunMessageBody(completion, true)).toContain("/lazy-subagents result run-2");
    expect(formatRunMessageBody(failure, true)).toContain("worker failed");
  });
});
