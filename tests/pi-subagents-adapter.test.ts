import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import { __testHooks, PiSubagentsAdapter } from "../src/launcher/pi-subagents-adapter.js";

const { mapAsyncStateToRunStatus, normalizeAsyncLaunchResult, normalizeAsyncStatus, normalizeAsyncResult, resolveTempScopeId } = __testHooks;

describe("PiSubagentsAdapter helpers", () => {
  test("maps pi-subagents async states into local run statuses", () => {
    expect(mapAsyncStateToRunStatus("queued")).toBe("queued");
    expect(mapAsyncStateToRunStatus("running")).toBe("running");
    expect(mapAsyncStateToRunStatus("complete")).toBe("completed");
    expect(mapAsyncStateToRunStatus("failed")).toBe("failed");
    expect(mapAsyncStateToRunStatus("paused")).toBe("paused");
    expect(mapAsyncStateToRunStatus("cancelled")).toBe("cancelled");
  });

  test("normalizes launch metadata and temp scoping", () => {
    expect(resolveTempScopeId({ env: { USER: "bnema" }, getuid: undefined })).toBe("user-bnema");

    const result = normalizeAsyncLaunchResult("run-1", "run-1", "/tmp/async/run-1", "/tmp/results");

    expect(result).toEqual({
      runId: "run-1",
      asyncId: "run-1",
      asyncDir: "/tmp/async/run-1",
      resultPath: path.join("/tmp/results", "run-1.json"),
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
      toolCount: 62,
      results: [{ artifactPaths: { outputPath: "/tmp/artifact.md" } }],
    });

    expect(completed.status).toBe("completed");
    expect(completed.completedAt).toBe(42);
    expect(completed.resultPreview).toBe("research complete");
    expect(completed.artifactPath).toBe("/tmp/artifact.md");
    expect((completed as any).totalTokens).toBe(122_967);
    expect((completed as any).toolCount).toBe(62);
    expect(completed.event?.category).toBe("completion");

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

  test("cancel writes cancelled status and result markers", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lazy-subagents-"));
    const asyncDirRoot = path.join(tempDir, "async");
    const resultsDir = path.join(tempDir, "results");
    const asyncDir = path.join(asyncDirRoot, "run-1");
    await fs.mkdir(asyncDir, { recursive: true });
    await fs.mkdir(resultsDir, { recursive: true });
    await fs.writeFile(
      path.join(asyncDir, "status.json"),
      JSON.stringify({
        runId: "run-1",
        state: "running",
        pid: 123,
        steps: [{ agent: "scout", pid: 456, outputFile: "output-0.log" }],
      }),
      "utf8",
    );

    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true as never);
    const adapter = new PiSubagentsAdapter({ asyncDirRoot, resultsDir });

    try {
      await expect(adapter.cancel({ runId: "run-1", asyncId: "run-1", asyncDir })).resolves.toBe(true);

      const status = JSON.parse(await fs.readFile(path.join(asyncDir, "status.json"), "utf8")) as { state: string };
      const result = JSON.parse(await fs.readFile(path.join(resultsDir, "run-1.json"), "utf8")) as { state: string };
      expect(status.state).toBe("cancelled");
      expect(result.state).toBe("cancelled");
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
