import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import { __testHooks, PiSubagentsAdapter } from "../src/launcher/pi-subagents-adapter.js";

const {
  buildRunnerChildren,
  mapAsyncStateToRunStatus,
  normalizeAsyncLaunchResult,
  normalizeAsyncStatus,
  normalizeAsyncResult,
  resolveEffectiveModel,
  resolveEffectiveThinking,
  summarizeResolvedModels,
  resolveTempScopeId,
} = __testHooks;

describe("PiSubagentsAdapter helpers", () => {
  test("maps pi-subagents async states into local run statuses", () => {
    expect(mapAsyncStateToRunStatus("queued")).toBe("queued");
    expect(mapAsyncStateToRunStatus("running")).toBe("running");
    expect(mapAsyncStateToRunStatus("complete")).toBe("completed");
    expect(mapAsyncStateToRunStatus("failed")).toBe("failed");
    expect(mapAsyncStateToRunStatus("paused")).toBe("paused");
    expect(mapAsyncStateToRunStatus("cancelled")).toBe("cancelled");
  });

  test("resolves effective models from builtin overrides, defaults, and grouped launches", () => {
    const builtinProfile = { source: "builtin", model: undefined, thinking: undefined } as const;
    const fileProfile = { source: "file", model: "openai/gpt-5", thinking: "high" } as const;

    expect(resolveEffectiveModel(builtinProfile as any, "reviewer", {
      userSettings: { defaultProvider: "openai-codex", defaultModel: "gpt-5.4", subagents: { agentOverrides: { reviewer: { model: "deepseek/deepseek-v4-pro" } } } },
    })).toBe("deepseek/deepseek-v4-pro");

    expect(resolveEffectiveModel(builtinProfile as any, "reviewer", {
      userSettings: { defaultProvider: "openai-codex", defaultModel: "gpt-5.4", subagents: { agentOverrides: { reviewer: { model: "deepseek/deepseek-v4-pro" } } } },
      projectSettings: { defaultProvider: "anthropic", defaultModel: "claude-sonnet-4-5", subagents: { agentOverrides: { reviewer: { model: "openai/gpt-5-mini" } } } },
    })).toBe("openai/gpt-5-mini");

    expect(resolveEffectiveModel(builtinProfile as any, "reviewer", {
      userSettings: { defaultProvider: "openai-codex", defaultModel: "gpt-5.4", subagents: { agentOverrides: { reviewer: { model: false as any } } } },
    })).toBe("openai-codex/gpt-5.4");

    expect(resolveEffectiveModel(fileProfile as any, "reviewer", {
      userSettings: { defaultProvider: "openai-codex", defaultModel: "gpt-5.4", subagents: { agentOverrides: { reviewer: { model: "deepseek/deepseek-v4-pro" } } } },
    })).toBe("openai/gpt-5");

    expect(resolveEffectiveThinking(builtinProfile as any, "reviewer", {
      userSettings: { defaultThinkingLevel: "xhigh", subagents: { agentOverrides: { reviewer: { thinking: "medium" } } } },
      projectSettings: { subagents: { agentOverrides: { reviewer: { thinking: "high" } } } },
    })).toBe("high");

    expect(resolveEffectiveThinking(fileProfile as any, "reviewer", {
      userSettings: { defaultThinkingLevel: "xhigh" },
    })).toBe("high");

    expect(summarizeResolvedModels([
      { agent: "reviewer", resolvedModel: "openai/gpt-5.4", resolvedThinking: "xhigh" },
      { agent: "planner", resolvedModel: "openai/gpt-5.4", resolvedThinking: "xhigh" },
    ] as any)).toBe("(openai) gpt-5.4 • xhigh");

    expect(summarizeResolvedModels([
      { agent: "reviewer", resolvedThinking: "xhigh" },
    ] as any)).toBe("(default) • xhigh");

    expect(summarizeResolvedModels([
      { agent: "reviewer", resolvedModel: "openai/gpt-5.4", resolvedThinking: "xhigh" },
      { agent: "planner", resolvedModel: "anthropic/claude-sonnet-4-5", resolvedThinking: "high" },
    ] as any)).toBe("reviewer: (openai) gpt-5.4 • xhigh, planner: (anthropic) claude-sonnet-4-5 • high");
  });

  test("builds group children using each child cwd for project-scoped overrides", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lazy-subagents-"));
    const asyncDir = path.join(tempDir, "async");
    const repoA = path.join(tempDir, "repo-a");
    const repoB = path.join(tempDir, "repo-b");
    await fs.mkdir(path.join(repoA, ".pi"), { recursive: true });
    await fs.mkdir(path.join(repoB, ".pi"), { recursive: true });
    await fs.writeFile(path.join(repoA, ".pi", "settings.json"), JSON.stringify({
      subagents: { agentOverrides: { reviewer: { model: "openai/gpt-5.4", thinking: "xhigh" } } },
    }), "utf8");
    await fs.writeFile(path.join(repoB, ".pi", "settings.json"), JSON.stringify({
      subagents: { agentOverrides: { reviewer: { model: "anthropic/claude-sonnet-4-5", thinking: "high" } } },
    }), "utf8");

    const children = await buildRunnerChildren([
      { agent: "reviewer", taskSummary: "review a", prompt: "review a", cwd: repoA },
      { agent: "reviewer", taskSummary: "review b", prompt: "review b", cwd: repoB },
    ], tempDir, asyncDir);

    expect(children.map((child: any) => child.cwd)).toEqual([repoA, repoB]);
    expect(children.map((child: any) => child.resolvedModel)).toEqual(["openai/gpt-5.4", "anthropic/claude-sonnet-4-5"]);
    expect(children.map((child: any) => child.resolvedThinking)).toEqual(["xhigh", "high"]);
  });

  test("carries profile resolution data for templated fan-out agents", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lazy-subagents-"));
    const asyncDir = path.join(tempDir, "async");
    await fs.mkdir(path.join(tempDir, ".pi"), { recursive: true });
    await fs.writeFile(path.join(tempDir, ".pi", "settings.json"), JSON.stringify({
      subagents: { agentOverrides: { reviewer: { model: "anthropic/claude-opus-4", thinking: "high" } } },
    }), "utf8");

    const children = await buildRunnerChildren([
      { id: "review", agent: "{{item.agent}}", taskSummary: "{{item.summary}}", prompt: "{{item.prompt}}", fanOutFrom: { step: "triage", path: "structured.reviewers" }, cwd: tempDir },
    ], tempDir, asyncDir);

    expect(children[0].agent).toBe("{{item.agent}}");
    expect((children[0] as any).profileByAgent.reviewer.name).toBe("reviewer");
    expect((children[0] as any).resolvedByAgent.reviewer.resolvedModel).toBe("anthropic/claude-opus-4");
    expect((children[0] as any).resolvedByAgent.reviewer.resolvedThinking).toBe("high");
  });

  test("normalizes launch metadata and temp scoping", () => {
    expect(resolveTempScopeId({ env: { USER: "bnema" }, getuid: undefined })).toBe("user-bnema");

    const result = normalizeAsyncLaunchResult("run-1", "run-1", "/tmp/async/run-1", "/tmp/results", "openai-codex/gpt-5.4");

    expect(result).toEqual({
      runId: "run-1",
      asyncId: "run-1",
      asyncDir: "/tmp/async/run-1",
      resultPath: path.join("/tmp/results", "run-1.json"),
      model: "openai-codex/gpt-5.4",
    });
  });

  test("normalizes live step status into richer local update fields", () => {
    const update = normalizeAsyncStatus("run-1", "/tmp/async/run-1", {
      runId: "run-1",
      mode: "single",
      state: "running",
      activityState: "needs_attention",
      startedAt: 10,
      lastUpdate: 20,
      sessionFile: "/tmp/child.jsonl",
      outputFile: "output-0.log",
      steps: [{
        agent: "reviewer",
        status: "running",
        currentTool: "bash",
        toolCount: 4,
        totalTokens: 6520,
        promptTokens: 1000,
        cacheReadTokens: 750,
        cacheHitRate: 75,
        outputFile: "output-0.log",
      }],
    } as any);

    expect(update.status).toBe("blocked");
    expect(update.updatedAt).toBe(20);
    expect(update.attentionNeeded).toBe(true);
    expect(update.sessionFile).toBe("/tmp/child.jsonl");
    expect(update.artifactPath).toBe(path.join("/tmp/async/run-1", "output-0.log"));
    expect(update.event?.category).toBe("attention");
    expect((update as any).currentTool).toBe("bash");
    expect((update as any).toolCount).toBe(4);
    expect((update as any).totalTokens).toBe(6520);
    expect((update as any).promptTokens).toBe(1000);
    expect((update as any).cacheReadTokens).toBe(750);
    expect((update as any).cacheHitRate).toBe(75);
  });

  test("normalizes terminal result files into completion and failure updates", () => {
    const completed = normalizeAsyncResult("run-1", {
      id: "run-1",
      state: "complete",
      success: true,
      summary: "research complete",
      timestamp: 42,
      sessionFile: "/tmp/completed.jsonl",
      totalTokens: 122_967,
      promptTokens: 40_000,
      cacheReadTokens: 30_000,
      cacheHitRate: 75,
      toolCount: 62,
      results: [{ artifactPaths: { outputPath: "/tmp/artifact.md" } }],
    });

    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBe(42);
    expect(completed.resultPreview).toBe("research complete");
    expect(completed.artifactPath).toBe("/tmp/artifact.md");
    expect((completed as any).totalTokens).toBe(122_967);
    expect((completed as any).promptTokens).toBe(40_000);
    expect((completed as any).cacheReadTokens).toBe(30_000);
    expect((completed as any).cacheHitRate).toBe(75);
    expect((completed as any).toolCount).toBe(62);
    expect(completed.event?.category).toBe("completion");

    const fallbackAggregate = normalizeAsyncResult("run-fallback", {
      id: "run-fallback",
      state: "complete",
      success: true,
      timestamp: 99,
      results: [
        { stepId: "review[security]", totalTokens: 100, promptTokens: 80, cacheReadTokens: 40, toolCount: 2 },
        { stepId: "review[tests]", totalTokens: 50, promptTokens: 20, cacheReadTokens: 10, toolCount: 1 },
        {
          stepId: "review",
          totalTokens: 150,
          promptTokens: 100,
          cacheReadTokens: 50,
          toolCount: 3,
          structuredOutput: { children: [] },
        },
      ],
    });

    expect((fallbackAggregate as any).totalTokens).toBe(150);
    expect((fallbackAggregate as any).promptTokens).toBe(100);
    expect((fallbackAggregate as any).cacheReadTokens).toBe(50);
    expect((fallbackAggregate as any).cacheHitRate).toBe(50);
    expect((fallbackAggregate as any).toolCount).toBe(3);

    const failed = normalizeAsyncResult("run-2", {
      id: "run-2",
      state: "failed",
      success: false,
      summary: "worker failed",
      timestamp: 77,
      sessionFile: "/tmp/failed.jsonl",
      results: [{ error: "boom" }],
    });

    expect(failed.status).toBe("failed");
    expect(failed.completedAt).toBe(77);
    expect(failed.errorPreview).toBe("worker failed");
    expect(failed.event?.category).toBe("failure");

    const cancelled = normalizeAsyncResult("run-3", {
      id: "run-3",
      state: "cancelled",
      success: false,
      summary: "cancelled by user",
      timestamp: 88,
    });

    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.completedAt).toBe(88);
  });

  test("cancel writes cancelled status and result markers while preserving workflow metadata", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lazy-subagents-"));
    const asyncDirRoot = path.join(tempDir, "async");
    const resultsDir = path.join(tempDir, "results");
    const asyncDir = path.join(asyncDirRoot, "run-1");
    await fs.mkdir(asyncDir, { recursive: true });
    await fs.mkdir(resultsDir, { recursive: true });
    await fs.writeFile(
      path.join(asyncDir, "status.json"),
      JSON.stringify({
        runId: "persisted-run-1",
        mode: "workflow",
        state: "running",
        pid: 123,
        steps: [{ id: "plan", taskSummary: "Draft the plan", dependsOn: ["research"], agent: "scout", pid: 456, outputFile: "output-0.log" }],
      }),
      "utf8",
    );

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true as never);
    const adapter = new PiSubagentsAdapter({ asyncDirRoot, resultsDir });

    try {
      await expect(adapter.cancel({ runId: "run-1", asyncId: "run-1", asyncDir })).resolves.toBe(true);

      const status = JSON.parse(await fs.readFile(path.join(asyncDir, "status.json"), "utf8")) as { state: string; runId: string; steps: Array<{ id?: string; taskSummary?: string; dependsOn?: string[]; agent?: string }> };
      const result = JSON.parse(await fs.readFile(path.join(resultsDir, "run-1.json"), "utf8")) as { state: string; id: string; runId: string; results: Array<{ stepId?: string; taskSummary?: string; dependsOn?: string[]; agent?: string }> };
      expect(status.state).toBe("cancelled");
      expect(status.runId).toBe("persisted-run-1");
      expect(status.steps[0]).toMatchObject({ id: "plan", taskSummary: "Draft the plan", dependsOn: ["research"], agent: "scout" });
      expect(result.state).toBe("cancelled");
      expect(result.id).toBe("persisted-run-1");
      expect(result.runId).toBe("persisted-run-1");
      expect(result.results[0]).toMatchObject({ stepId: "plan", taskSummary: "Draft the plan", dependsOn: ["research"], agent: "scout" });
    } finally {
      killSpy.mockRestore();
    }
  });

  test("readUpdate tolerates malformed result files", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lazy-subagents-"));
    const resultPath = path.join(tempDir, "run-1.json");
    await fs.writeFile(resultPath, "{not-json", "utf8");

    const adapter = new PiSubagentsAdapter({
      asyncDirRoot: path.join(tempDir, "async"),
      resultsDir: tempDir,
    });

    await expect(
      adapter.readUpdate({ runId: "run-1", asyncId: "run-1", resultPath }),
    ).resolves.toBeUndefined();
  });
});
