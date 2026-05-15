import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test, vi } from "vitest";

import { MESSAGE_TYPE_ATTENTION, MESSAGE_TYPE_COMPLETION, MESSAGE_TYPE_FAILURE, MESSAGE_TYPE_LAUNCH, MESSAGE_TYPE_PIN, PERSISTED_STATE_ENTRY, STATUS_KEY, WIDGET_KEY } from "../src/defaults.js";
import { LazySubagentsController } from "../src/orchestration/controller.js";
import { createPersistedState } from "../src/state/persistence.js";
import { RunRegistry } from "../src/state/run-registry.js";
import type { LaunchChildRequest, LaunchResult, Launcher, LauncherRuntimeContext, NormalizedRunUpdate } from "../src/launcher/interface.js";
import type { CompletionPolicy, RunRecord } from "../src/types.js";

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
    currentTool: overrides.currentTool,
    toolCount: overrides.toolCount,
    attentionNeeded: overrides.attentionNeeded ?? false,
    groupId: overrides.groupId,
    children: overrides.children,
    launchRef: overrides.launchRef,
    recentEvents: overrides.recentEvents ?? [],
  };
}

class FakeLauncher implements Launcher {
  public readonly launches: LaunchChildRequest[] = [];
  public readonly updates = new Map<string, NormalizedRunUpdate | undefined>();
  public readonly launchResults = new Map<string, Partial<LaunchResult>>();
  public launchGroupError: Error | undefined;
  public readUpdateHook: ((launch: LaunchResult) => Promise<NormalizedRunUpdate | undefined>) | undefined;

  async launchChild(request: LaunchChildRequest, _runtime: LauncherRuntimeContext): Promise<LaunchResult> {
    this.launches.push(request);
    const override = this.launchResults.get(request.runId) ?? {};
    return {
      runId: request.runId,
      asyncId: request.runId,
      asyncDir: override.asyncDir ?? `/tmp/${request.runId}`,
      resultPath: override.resultPath ?? `/tmp/results/${request.runId}.json`,
      sessionFile: override.sessionFile,
      artifactPath: override.artifactPath,
    };
  }

  async launchGroup(request: { runId: string }): Promise<LaunchResult> {
    if (this.launchGroupError) throw this.launchGroupError;
    return {
      runId: request.runId,
      asyncId: request.runId,
      asyncDir: `/tmp/${request.runId}`,
      resultPath: `/tmp/results/${request.runId}.json`,
    };
  }

  async readUpdate(launch: LaunchResult): Promise<NormalizedRunUpdate | undefined> {
    if (this.readUpdateHook) return await this.readUpdateHook(launch);
    return this.updates.get(launch.runId);
  }

  async cancel(): Promise<boolean> {
    return true;
  }
}

function createContext(options: {
  isIdle?: boolean;
  hasPendingMessages?: boolean;
  entries?: unknown[];
  branchEntries?: unknown[];
} = {}) {
  const statuses: Array<[string, string | undefined]> = [];
  const widgets: Array<[string, string[] | undefined]> = [];
  const notifications: Array<[string, string | undefined]> = [];
  const theme = {
    fg: (_color: string, text: string) => text,
    dim: (text: string) => text,
    muted: (text: string) => text,
    bold: (text: string) => text,
    bg: (_color: string, text: string) => text,
  };

  const ctx = {
    hasUI: true,
    cwd: "/repo",
    ui: {
      theme,
      setStatus: (key: string, value: string | undefined) => {
        statuses.push([key, value]);
      },
      setWidget: (key: string, value: string[] | ((tui: unknown, themeArg: typeof theme) => { render(width: number): string[] }) | undefined) => {
        if (typeof value === "function") {
          widgets.push([key, value({}, theme).render(160)]);
          return;
        }
        widgets.push([key, value]);
      },
      notify: (message: string, level?: string) => {
        notifications.push([message, level]);
      },
    },
    sessionManager: {
      getEntries: () => options.entries ?? [],
      getBranch: () => options.branchEntries ?? options.entries ?? [],
      getSessionId: () => "session-1",
      getSessionFile: () => "/repo/.pi/session.jsonl",
    },
    model: undefined,
    isIdle: () => options.isIdle ?? true,
    hasPendingMessages: () => options.hasPendingMessages ?? false,
  };

  return { ctx: ctx as any, statuses, widgets, notifications };
}

function createPi() {
  const messages: Array<{ message: any; options: any }> = [];
  const userMessages: Array<{ content: any; options: any }> = [];
  const entries: Array<{ customType: string; data: unknown }> = [];
  return {
    messages,
    userMessages,
    entries,
    api: {
      sendMessage: (message: any, options?: any) => {
        messages.push({ message, options });
      },
      sendUserMessage: (content: any, options?: any) => {
        userMessages.push({ content, options });
      },
      appendEntry: (customType: string, data: unknown) => {
        entries.push({ customType, data });
      },
    },
  };
}

describe("LazySubagentsController", () => {
  test("restores persisted state from the current branch instead of stale session-global entries", async () => {
    const branchRegistry = new RunRegistry();
    branchRegistry.upsert(
      createRun({
        id: "branch-run",
        status: "running",
        updatedAt: 10,
        launchRef: { runId: "branch-run", asyncId: "branch-run", asyncDir: "/tmp/branch-run" },
      }),
    );

    const staleRegistry = new RunRegistry();
    staleRegistry.upsert(
      createRun({
        id: "stale-run",
        status: "running",
        updatedAt: 20,
        launchRef: { runId: "stale-run", asyncId: "stale-run", asyncDir: "/tmp/stale-run" },
      }),
    );

    const branchPersisted = createPersistedState(branchRegistry.serialize(), 10);
    const stalePersisted = createPersistedState(staleRegistry.serialize(), 20);
    const { api } = createPi();
    const launcher = new FakeLauncher();
    const controller = new LazySubagentsController(api as any, { launcher, createRunId: () => "ignored", now: () => 10 });
    const { ctx, statuses, widgets } = createContext({
      entries: [
        { type: "custom", customType: PERSISTED_STATE_ENTRY, data: branchPersisted },
        { type: "custom", customType: PERSISTED_STATE_ENTRY, data: stalePersisted },
      ],
      branchEntries: [{ type: "custom", customType: PERSISTED_STATE_ENTRY, data: branchPersisted }],
    });

    await controller.handleSessionStart(ctx);

    expect(controller.getSnapshot().activeRuns.map((run: RunRecord) => run.id)).toEqual(["branch-run"]);
    expect(statuses.at(-1)).toEqual([STATUS_KEY, expect.stringContaining("1 live")]);
    expect(widgets.at(-1)?.[0]).toBe(WIDGET_KEY);
  });

  test("launches a child, emits a launch card, persists state, and routes completion once", async () => {
    const { api, messages, entries } = createPi();
    const launcher = new FakeLauncher();
    const controller = new LazySubagentsController(api as any, { launcher, createRunId: () => "run-1", now: () => 100 });
    const { ctx, statuses, widgets } = createContext({ isIdle: true, hasPendingMessages: false });

    await controller.handleSessionStart(ctx);
    await controller.launchChild(
      {
        agent: "reviewer",
        title: "Review auth diff",
        taskSummary: "Review auth diff",
        prompt: "Review the auth diff and summarize the issues.",
        completionPolicy: "follow_up_when_idle" satisfies CompletionPolicy,
      },
      ctx,
    );

    expect(launcher.launches).toHaveLength(1);
    expect(controller.getSnapshot().activeRuns[0]?.id).toBe("run-1");
    expect(messages[0]?.message.customType).toBe(MESSAGE_TYPE_LAUNCH);
    expect(entries.some((entry) => entry.customType === PERSISTED_STATE_ENTRY)).toBe(true);
    expect(statuses.at(-1)?.[0]).toBe(STATUS_KEY);
    expect(widgets.at(-1)?.[0]).toBe(WIDGET_KEY);

    launcher.updates.set("run-1", {
      runId: "run-1",
      status: "completed",
      updatedAt: 130,
      completedAt: 130,
      resultPreview: "Found 3 issues in auth.ts",
    });

    await controller.pollOnce();
    await controller.pollOnce();

    expect(controller.getSnapshot().recentRuns[0]?.status).toBe("completed");
    expect(messages.filter((entry) => entry.message.customType === MESSAGE_TYPE_COMPLETION)).toHaveLength(1);
    expect(
      messages.some(
        (entry) =>
          entry.message.display === false
          && typeof entry.message.content === "string"
          && entry.message.content.includes("Lazy subagent update"),
      ),
    ).toBe(true);
  });

  test("skips timed-out launcher reads and continues polling other tracked runs", async () => {
    const { api } = createPi();
    const launcher = new FakeLauncher();
    let nextRun = 0;
    const controller = new LazySubagentsController(api as any, {
      launcher,
      createRunId: () => `run-${++nextRun}`,
      now: () => 100,
      readUpdateTimeoutMs: 1,
    });
    const { ctx } = createContext({ isIdle: true, hasPendingMessages: false });
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      await controller.handleSessionStart(ctx);
      await controller.launchChild({ agent: "reviewer", title: "Run one", taskSummary: "Run one", prompt: "one" }, ctx);
      await controller.launchChild({ agent: "reviewer", title: "Run two", taskSummary: "Run two", prompt: "two" }, ctx);

      launcher.readUpdateHook = async (launch) => {
        if (launch.runId === "run-1") {
          return await new Promise<NormalizedRunUpdate | undefined>(() => {});
        }
        return {
          runId: "run-2",
          status: "running",
          updatedAt: 101,
          currentTool: "read",
        };
      };

      await controller.pollOnce();

      expect(controller.getSnapshot().activeRuns.find((run) => run.id === "run-1")?.status).toBe("queued");
      expect(controller.getSnapshot().activeRuns.find((run) => run.id === "run-2")?.currentTool).toBe("read");
    } finally {
      launcher.readUpdateHook = async () => undefined;
      controller.clearRuns("all");
      await controller.handleSessionShutdown(ctx);
      warnSpy.mockRestore();
    }
  });

  test("keeps the last nonzero token total when later live updates report zero", async () => {
    const { api } = createPi();
    const launcher = new FakeLauncher();
    const controller = new LazySubagentsController(api as any, { launcher, createRunId: () => "run-1", now: () => 100 });
    const { ctx, statuses, widgets } = createContext({ isIdle: true, hasPendingMessages: false });

    await controller.handleSessionStart(ctx);
    await controller.launchChild(
      {
        agent: "reviewer",
        title: "Review auth diff",
        taskSummary: "Review auth diff",
        prompt: "Review the auth diff and summarize the issues.",
      },
      ctx,
    );

    launcher.updates.set("run-1", {
      runId: "run-1",
      status: "running",
      updatedAt: 105,
      currentTool: "bash",
      toolCount: 50,
      totalTokens: 6079,
    });
    await controller.pollOnce();

    launcher.updates.set("run-1", {
      runId: "run-1",
      status: "running",
      updatedAt: 110,
      currentTool: "read",
      toolCount: 51,
      totalTokens: 0,
    });
    await controller.pollOnce();

    expect(controller.getSnapshot().activeRuns[0]?.totalTokens).toBe(6079);
    expect(statuses.at(-1)?.[1]).toContain("6.1k tok");
    expect(widgets.at(-1)?.[1]?.join("\n") ?? "").toContain("6.1k tok");
  });

  test("keeps recent successful runs visible briefly, then hides them from live UI after the grace window", async () => {
    const registry = new RunRegistry();
    registry.upsert(
      createRun({
        id: "done-recent",
        status: "completed",
        title: "Done recent",
        updatedAt: 100,
        completedAt: 100,
        resultPreview: "recent result",
      }),
    );

    let clock = 20_000;
    const { api } = createPi();
    const launcher = new FakeLauncher();
    const controller = new LazySubagentsController(api as any, { launcher, now: () => clock });
    const { ctx, widgets } = createContext({
      entries: [{ type: "custom", customType: PERSISTED_STATE_ENTRY, data: createPersistedState(registry.serialize(), 20_000) }],
      branchEntries: [{ type: "custom", customType: PERSISTED_STATE_ENTRY, data: createPersistedState(registry.serialize(), 20_000) }],
    });

    await controller.handleSessionStart(ctx);
    expect(widgets.at(-1)?.[1]?.join("\n")).toContain("Done recent");

    clock = 31_001;
    await controller.pollOnce();

    expect(widgets.at(-1)?.[1]?.join("\n") ?? "").not.toContain("Done recent");
  });

  test("hides acknowledged successes from live UI but keeps manual-pickup, pinned, and failed runs visible", async () => {
    const registry = new RunRegistry();
    registry.upsert(createRun({ id: "done-hidden", status: "completed", title: "Done hidden", updatedAt: 100, completedAt: 100 }));
    registry.acknowledgeRun("done-hidden");
    registry.upsert(createRun({ id: "done-manual", status: "completed", title: "Done manual", updatedAt: 100, completedAt: 100, completionPolicy: "manual_pickup" }));
    registry.upsert(createRun({ id: "done-pinned", status: "completed", title: "Done pinned", updatedAt: 100, completedAt: 100 }));
    registry.pinRun("done-pinned");
    registry.upsert(createRun({ id: "failed-visible", status: "failed", title: "Failed visible", updatedAt: 100, completedAt: 100, errorPreview: "boom", attentionNeeded: true }));

    const persisted = createPersistedState(registry.serialize(), 200);
    const { api } = createPi();
    const launcher = new FakeLauncher();
    const controller = new LazySubagentsController(api as any, { launcher, now: () => 200 });
    const { ctx, widgets } = createContext({
      entries: [{ type: "custom", customType: PERSISTED_STATE_ENTRY, data: persisted }],
      branchEntries: [{ type: "custom", customType: PERSISTED_STATE_ENTRY, data: persisted }],
    });

    await controller.handleSessionStart(ctx);

    const widgetText = widgets.at(-1)?.[1]?.join("\n") ?? "";
    expect(widgetText).not.toContain("Done hidden");
    expect(widgetText).toContain("Done manual");
    expect(widgetText).toContain("Done pinned");
    expect(widgetText).toContain("Failed visible");
  });

  test("surfaces a stuck-run attention signal after 5 minutes without progress", async () => {
    const { api, messages } = createPi();
    const launcher = new FakeLauncher();
    let clock = 100;
    const controller = new LazySubagentsController(api as any, { launcher, createRunId: () => "run-1", now: () => clock });
    const { ctx } = createContext({ isIdle: true, hasPendingMessages: false });

    await controller.handleSessionStart(ctx);
    await controller.launchChild(
      {
        agent: "reviewer",
        title: "Review auth diff",
        taskSummary: "Review auth diff",
        prompt: "Review the auth diff and summarize the issues.",
      },
      ctx,
    );

    clock = 100 + (5 * 60_000) + 1;
    await controller.pollOnce();

    expect(controller.getSnapshot().activeRuns[0]?.attentionNeeded).toBe(true);
    expect(messages.at(-1)?.message.customType).toBe(MESSAGE_TYPE_ATTENTION);
    expect(messages.at(-1)?.options?.triggerTurn).toBe(true);
    expect(messages.at(-1)?.message.content).toContain("No progress");
  });

  test("can re-alert when a run resumes and later goes stale again", async () => {
    const { api, messages } = createPi();
    const launcher = new FakeLauncher();
    let clock = 100;
    const controller = new LazySubagentsController(api as any, { launcher, createRunId: () => "run-1", now: () => clock });
    const { ctx } = createContext({ isIdle: true, hasPendingMessages: false });

    await controller.handleSessionStart(ctx);
    await controller.launchChild(
      {
        agent: "reviewer",
        title: "Review auth diff",
        taskSummary: "Review auth diff",
        prompt: "Review the auth diff and summarize the issues.",
      },
      ctx,
    );

    clock = 100 + (5 * 60_000) + 1;
    await controller.pollOnce();

    launcher.updates.set("run-1", {
      runId: "run-1",
      status: "running",
      updatedAt: clock + 10,
      currentTool: "read",
      toolCount: 1,
      totalTokens: 1000,
    });
    await controller.pollOnce();

    clock = clock + 10 + (5 * 60_000) + 1;
    await controller.pollOnce();

    expect(messages.filter((entry) => entry.message.customType === MESSAGE_TYPE_ATTENTION)).toHaveLength(2);
  });

  test("surfaces a runaway attention signal when a live run burns excessive tokens", async () => {
    const { api, messages } = createPi();
    const launcher = new FakeLauncher();
    const controller = new LazySubagentsController(api as any, { launcher, createRunId: () => "run-1", now: () => 100 });
    const { ctx } = createContext({ isIdle: true, hasPendingMessages: false });

    await controller.handleSessionStart(ctx);
    await controller.launchChild(
      {
        agent: "reviewer",
        title: "Review auth diff",
        taskSummary: "Review auth diff",
        prompt: "Review the auth diff and summarize the issues.",
      },
      ctx,
    );

    launcher.updates.set("run-1", {
      runId: "run-1",
      status: "running",
      updatedAt: 120,
      toolCount: 101,
      totalTokens: 247_000,
    });
    await controller.pollOnce();

    expect(controller.getSnapshot().activeRuns[0]?.attentionNeeded).toBe(true);
    expect(messages.at(-1)?.message.customType).toBe(MESSAGE_TYPE_ATTENTION);
    expect(messages.at(-1)?.options?.triggerTurn).toBe(true);
    expect(messages.at(-1)?.message.content).toContain("247k");
  });

  test("pins a run into chat and renders detailed progress lines from child events", async () => {
    const { api, messages } = createPi();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lazy-subagents-pin-"));
    const eventsPath = path.join(tempDir, "events.jsonl");
    await fs.writeFile(eventsPath, [
      JSON.stringify({ runId: "run-1", index: 0, raw: JSON.stringify({ type: "tool_execution_start", toolName: "read" }) }),
      JSON.stringify({ runId: "run-1", index: 0, raw: JSON.stringify({ type: "tool_execution_end", toolName: "read" }) }),
      JSON.stringify({
        runId: "run-1",
        index: 0,
        raw: JSON.stringify({
          type: "message_end",
          message: {
            role: "assistant",
            usage: { totalTokens: 6079 },
            content: [{ type: "text", text: "Looks good overall." }],
          },
        }),
      }),
    ].join("\n"), "utf8");

    const launcher = new FakeLauncher();
    launcher.launchResults.set("run-1", { asyncDir: tempDir, resultPath: path.join(tempDir, "result.json") });
    const controller = new LazySubagentsController(api as any, { launcher, createRunId: () => "run-1", now: () => 100 });
    const { ctx } = createContext({ isIdle: true, hasPendingMessages: false });

    await controller.handleSessionStart(ctx);
    await controller.launchChild(
      {
        agent: "reviewer",
        title: "Review auth diff",
        taskSummary: "Review auth diff",
        prompt: "Review the auth diff and summarize the issues.",
      },
      ctx,
    );

    launcher.updates.set("run-1", {
      runId: "run-1",
      status: "running",
      updatedAt: 120,
      currentTool: "read",
      toolCount: 1,
      totalTokens: 6079,
    });
    await controller.pollOnce();

    expect(await controller.pinRun("run-1")).toBe(true);
    expect(messages.at(-1)?.message.customType).toBe(MESSAGE_TYPE_PIN);
    expect(controller.getPinnedRunLines("run-1").join("\n")).toContain("tool start · read");
    expect(controller.getPinnedRunLines("run-1").join("\n")).toContain("Looks good overall.");
  });

  test("records a failed group launch instead of throwing away state", async () => {
    const { api, messages } = createPi();
    const launcher = new FakeLauncher();
    launcher.launchGroupError = new Error("group launcher unavailable");
    const controller = new LazySubagentsController(api as any, { launcher, createRunId: () => "group-1", now: () => 150 });
    const { ctx } = createContext({ isIdle: true, hasPendingMessages: false });

    await controller.handleSessionStart(ctx);
    await controller.launchGroup(
      {
        title: "Parallel review",
        taskSummary: "Parallel review",
        children: [{ agent: "reviewer", prompt: "Review auth", taskSummary: "Review auth" }],
      },
      ctx,
    );

    expect(controller.getSnapshot().recentRuns[0]?.status).toBe("failed");
    expect(messages.at(-1)?.message.customType).toBe(MESSAGE_TYPE_FAILURE);
  });

  test("supports result retrieval, pickup injection, cancel, and clear control actions", async () => {
    const { api, messages, userMessages } = createPi();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lazy-subagents-controller-"));
    const artifactPath = path.join(tempDir, "run-1-output.log");
    await fs.writeFile(artifactPath, "Full reviewer result", "utf8");
    const launcher = new FakeLauncher();
    const controller = new LazySubagentsController(api as any, { launcher, createRunId: () => "run-1", now: () => 200 });
    const { ctx } = createContext({ isIdle: true, hasPendingMessages: false });

    await controller.handleSessionStart(ctx);
    await controller.launchChild(
      {
        agent: "reviewer",
        title: "Review auth diff",
        taskSummary: "Review auth diff",
        prompt: "Review the auth diff and summarize the issues.",
      },
      ctx,
    );

    launcher.updates.set("run-1", {
      runId: "run-1",
      status: "completed",
      updatedAt: 230,
      completedAt: 230,
      artifactPath,
      resultPreview: "Found 3 issues in auth.ts",
    });
    await controller.pollOnce();

    expect(await controller.getRunResult("run-1")).toBe("Full reviewer result");
    expect(await controller.pickupRun("run-1")).toBe(true);
    expect(userMessages[0]?.content).toContain("Lazy subagent result");
    expect(userMessages[0]?.content).toContain("Full reviewer result");
    expect(messages.filter((entry) => entry.message.display === false)).toHaveLength(1);

    expect(await controller.cancelRun("run-1")).toBe(false);

    expect(controller.clearRuns()).toBe(1);
    expect(controller.getSnapshot().runs).toHaveLength(0);
  });
});
