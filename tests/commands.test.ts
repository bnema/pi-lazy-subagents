import { describe, expect, test } from "vitest";

import { buildLazySubagentsAgentList, buildLazySubagentsHelp, executeLazySubagentsCommand, formatStatusReport, formatWaitReport, parseLazySubagentsCommand } from "../src/orchestration/commands.js";
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
    completionPolicy: overrides.completionPolicy ?? "wake_if_idle",
    sessionFile: overrides.sessionFile,
    artifactPath: overrides.artifactPath,
    resultPreview: overrides.resultPreview,
    errorPreview: overrides.errorPreview,
    model: overrides.model,
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
      skipped: runs.filter((run) => run.status === "skipped").length,
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
  test("help output includes list usage, tool usage, and wait guidance", () => {
    const help = buildLazySubagentsHelp();

    expect(help).toContain("/lazy-subagents list");
    expect(help).toContain("/lazy-subagents continue");
    expect(help).toContain("lazy_subagents action=list");
    expect(help).toContain("inspect available sub agents before choosing one");
    expect(help).toContain("Slash command usage:");
    expect(help).toContain("Tool usage:");
    expect(help).toContain("action=parallel");
    expect(help).toContain("action=workflow");
    expect(help).toContain("Examples:");
    expect(help).toContain("defaults agent to delegate");
    expect(help).toContain("Signals arrive automatically");
    expect(help).toContain("Do not poll");
    expect(help).toContain("Use result after completion");
    expect(help).toContain("workflow is for dependent pipelines");
    expect(help).toContain("wait blocks");
    expect(help).toContain("Run lifecycle:");
    expect(help).toContain("auto-hide");
    expect(help).toContain("followup-able");
    expect(help).toContain("bounded lease");
    expect(help).toContain("Continuation is only supported for single runs");
  });

  test("list output prints available sub agents", () => {
    const list = buildLazySubagentsAgentList();

    expect(list).toContain("Available sub agents:");
    expect(list).toContain("delegate");
    expect(list).toContain("reviewer");
    expect(list).toContain("worker");
  });

  test("list command returns the available sub-agent listing", async () => {
    const message = await executeLazySubagentsCommand("list", {} as any, {} as any);

    expect(message).toBe(buildLazySubagentsAgentList());
  });

  test("run command acknowledgement tells the caller not to block after launch", async () => {
    const controller = {
      launchChild: async (request: { agent: string }) => ({ id: "run-1", agent: request.agent }),
    };

    const message = await executeLazySubagentsCommand('run reviewer "Review the auth diff"', controller as any, {} as any);

    expect(message).toContain("Launched run-1 (reviewer).");
    expect(message).toContain("Signals arrive automatically");
    expect(message).toContain("do not wait or poll right away");
  });

  test("parses run command with --name flag", () => {
    expect(parseLazySubagentsCommand('run reviewer "Review the auth diff" --name diff-reviewer')).toEqual({
      action: "run",
      agent: "reviewer",
      prompt: "Review the auth diff",
      name: "diff-reviewer",
    });

    expect(parseLazySubagentsCommand('run reviewer "Review" --name=my-agent --title "Round 1"')).toEqual({
      action: "run",
      agent: "reviewer",
      prompt: "Review",
      title: "Round 1",
      name: "my-agent",
    });
  });

  test("parses continue command with target and prompt", () => {
    expect(parseLazySubagentsCommand('continue my-agent "Keep going with the review"')).toEqual({
      action: "continue",
      target: "my-agent",
      prompt: "Keep going with the review",
    });

    expect(parseLazySubagentsCommand('continue my-agent "Keep going" --title "Round 2"')).toEqual({
      action: "continue",
      target: "my-agent",
      prompt: "Keep going",
      title: "Round 2",
    });

    expect(parseLazySubagentsCommand("continue")).toEqual({ action: "help" });
    expect(parseLazySubagentsCommand("continue my-agent")).toEqual({ action: "help" });
    expect(parseLazySubagentsCommand('continue my-agent "prompt" --name another-name')).toEqual({ action: "help" });
  });

  test("rejects malformed or missing flag values in slash commands", () => {
    expect(parseLazySubagentsCommand('run reviewer "Review" --name BadName')).toEqual({ action: "help" });
    expect(parseLazySubagentsCommand('run reviewer "Review" --name -bad')).toEqual({ action: "help" });
    expect(parseLazySubagentsCommand('run reviewer "Review" --name')).toEqual({ action: "help" });
    expect(parseLazySubagentsCommand('run reviewer "Review" --name=')).toEqual({ action: "help" });
    expect(parseLazySubagentsCommand('run reviewer "Review" --title --name diff-reviewer')).toEqual({ action: "help" });
    expect(parseLazySubagentsCommand("wait run-1 --timeout-ms")).toEqual({ action: "help" });
    expect(parseLazySubagentsCommand("wait run-1 --timeout-ms=0")).toEqual({ action: "help" });
    expect(parseLazySubagentsCommand(`run reviewer "Review" --name ${"a".repeat(65)}`)).toEqual({ action: "help" });
  });

  test("parses list, run, status, wait, result, pickup, pin, clear, and cancel commands", () => {
    expect(parseLazySubagentsCommand('run reviewer "Review the auth diff" --policy ignored --title "Review auth diff"')).toEqual({
      action: "run",
      agent: "reviewer",
      prompt: "Review the auth diff",
      title: "Review auth diff",
    });

    expect(parseLazySubagentsCommand("list")).toEqual({ action: "list" });
    expect(parseLazySubagentsCommand("status run-1")).toEqual({ action: "status", runId: "run-1" });
    expect(parseLazySubagentsCommand("wait run-1 --timeout-ms 1234")).toEqual({ action: "wait", runId: "run-1", timeoutMs: 1234 });
    expect(parseLazySubagentsCommand("wait run-1")).toEqual({ action: "wait", runId: "run-1" });
    expect(parseLazySubagentsCommand("wait --timeout-ms 5000")).toEqual({ action: "wait", timeoutMs: 5000 });
    expect(parseLazySubagentsCommand("wait")).toEqual({ action: "wait" });
    expect(parseLazySubagentsCommand("result run-1")).toEqual({ action: "result", runId: "run-1" });
    expect(parseLazySubagentsCommand("pickup run-1")).toEqual({ action: "pickup", runId: "run-1" });
    expect(parseLazySubagentsCommand("pin run-1")).toEqual({ action: "pin", runId: "run-1" });
    expect(parseLazySubagentsCommand("clear all")).toEqual({ action: "clear", scope: "all" });
    expect(parseLazySubagentsCommand("cancel run-1")).toEqual({ action: "cancel", runId: "run-1" });
  });

  test("formats wait reports for ready, timeout, and ambiguous waits", () => {
    const completed = createRun({ id: "run-1", status: "completed", resultPreview: "Done" });
    const running = createRun({ id: "run-2", status: "running", completedAt: undefined });

    expect(formatWaitReport({ status: "ready", run: completed }, 60_000)).toContain("Lazy subagent finished: run-1");
    expect(formatWaitReport({ status: "timeout", run: running }, 60_000)).toContain("automatic signal");
    expect(formatWaitReport({ status: "ambiguous", activeRuns: [running] }, 60_000)).toContain("call action=wait with runId");
  });

  test("returns a clear message when a scoped run id is missing", () => {
    const snapshot = createSnapshot([createRun({ id: "run-1" })]);

    expect(formatStatusReport(snapshot, "missing-run", 60_000)).toBe("No run found with id: missing-run");
  });

  test("formats a richer status report for active and recent runs", () => {
    const running = createRun({ id: "run-1", status: "running", startedAt: 50_000, updatedAt: 59_000, completedAt: undefined, model: "(openai-codex) gpt-5.4 • xhigh" });
    (running as any).currentTool = "read";
    (running as any).toolCount = 3;
    running.recentEvents = [{ id: "progress-1", category: "progress", timestamp: 59_000, summary: "Inspecting auth.ts" }];
    const completed = createRun({ id: "run-2", status: "completed", startedAt: 40_000, updatedAt: 58_000, completedAt: 58_000, agent: "reviewer", resultPreview: "Found 3 issues" });
    const snapshot = createSnapshot([running, completed]);

    const report = formatStatusReport(snapshot, undefined, 60_000);

    expect(report).toContain("Active runs: 1");
    expect(report).toContain("elapsed: 10s");
    expect(report).toContain("updated: 1s ago");
    expect(report).toContain("model: (openai-codex) gpt-5.4 • xhigh");
    expect(report).toContain("tool: read");
    expect(report).toContain("tools used: 3");
    expect(report).toContain("last event: Inspecting auth.ts");
    expect(report).toContain("Found 3 issues");
    expect(report).toContain("result available: /lazy-subagents result run-2");
  });
});
