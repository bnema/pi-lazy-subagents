import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test, vi } from "vitest";

import { DEFAULT_NAMED_RUN_LEASE_MS, MESSAGE_TYPE_ATTENTION, MESSAGE_TYPE_COMPLETION, MESSAGE_TYPE_FAILURE, MESSAGE_TYPE_LAUNCH, MESSAGE_TYPE_PIN, PERSISTED_STATE_ENTRY, STATUS_KEY, WIDGET_KEY } from "../src/defaults.js";
import { LazySubagentsController, __testHooks as controllerTestHooks } from "../src/orchestration/controller.js";
import { createPersistedState } from "../src/state/persistence.js";
import { RunRegistry } from "../src/state/run-registry.js";
import type { ContinueLaunchRequest, LaunchChildRequest, LaunchResult, Launcher, LauncherRuntimeContext, NormalizedRunUpdate } from "../src/launcher/interface.js";
import type { RunRecord } from "../src/types.js";

const __testHooks = controllerTestHooks;
const trackedTempDirs: string[] = [];

async function createTempDir(prefix: string): Promise<string> {
  const tempDir = await fs.mkdtemp(prefix);
  trackedTempDirs.push(tempDir);
  return tempDir;
}

afterEach(async () => {
  await Promise.all(trackedTempDirs.splice(0).map((tempDir) => fs.rm(tempDir, { recursive: true, force: true })));
});

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
    currentTool: overrides.currentTool,
    toolCount: overrides.toolCount,
    model: overrides.model,
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

class FakeLauncher implements Launcher {
  public readonly launches: LaunchChildRequest[] = [];
  public readonly workflowLaunches: Array<{ runId: string; title: string; taskSummary: string; steps: Array<{ id: string; agent: string; prompt: string; taskSummary: string; dependsOn?: string[]; retries?: number; outputMode?: "text" | "json"; outputSchema?: string }>; maxConcurrency?: number }> = [];
  public readonly updates = new Map<string, NormalizedRunUpdate | undefined>();
  public readonly launchResults = new Map<string, Partial<LaunchResult>>();
  public readonly continueLaunches: ContinueLaunchRequest[] = [];
  public launchGroupError: Error | undefined;
  public continueError: Error | undefined;
  public launchChildHook: ((request: LaunchChildRequest) => Promise<void>) | undefined;
  public readUpdateHook: ((launch: LaunchResult) => Promise<NormalizedRunUpdate | undefined>) | undefined;

  async launchChild(request: LaunchChildRequest, _runtime: LauncherRuntimeContext): Promise<LaunchResult> {
    this.launches.push(request);
    await this.launchChildHook?.(request);
    const override = this.launchResults.get(request.runId) ?? {};
    return {
      runId: request.runId,
      asyncId: request.runId,
      asyncDir: override.asyncDir ?? `/tmp/${request.runId}`,
      resultPath: override.resultPath ?? `/tmp/results/${request.runId}.json`,
      sessionFile: override.sessionFile,
      artifactPath: override.artifactPath,
      model: override.model,
    };
  }

  async launchGroup(request: { runId: string }): Promise<LaunchResult> {
    if (this.launchGroupError) throw this.launchGroupError;
    const override = this.launchResults.get(request.runId) ?? {};
    return {
      runId: request.runId,
      asyncId: request.runId,
      asyncDir: override.asyncDir ?? `/tmp/${request.runId}`,
      resultPath: override.resultPath ?? `/tmp/results/${request.runId}.json`,
      sessionFile: override.sessionFile,
      artifactPath: override.artifactPath,
      model: override.model,
    };
  }

  async launchWorkflow(request: { runId: string; title: string; taskSummary: string; steps: Array<{ id: string; agent: string; prompt: string; taskSummary: string; dependsOn?: string[]; retries?: number; outputMode?: "text" | "json"; outputSchema?: string }>; maxConcurrency?: number }): Promise<LaunchResult> {
    this.workflowLaunches.push(request);
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

  async continueChild(request: ContinueLaunchRequest, _runtime: LauncherRuntimeContext): Promise<LaunchResult> {
    if (this.continueError) throw this.continueError;
    this.continueLaunches.push(request);
    const override = this.launchResults.get(request.runId) ?? {};
    return {
      runId: request.runId,
      asyncId: request.runId,
      asyncDir: request.asyncDir,
      resultPath: request.resultPath,
      sessionFile: override.sessionFile,
      artifactPath: override.artifactPath,
      model: override.model,
    };
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
  const renderRequests: number[] = [];
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
      requestRender: () => {
        renderRequests.push(Date.now());
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

  return { ctx: ctx as any, statuses, widgets, notifications, renderRequests };
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

function hiddenCompletionMessages(messages: Array<{ message: any; options: any }>): Array<{ message: any; options: any }> {
  return messages.filter((entry) => entry.message.customType === MESSAGE_TYPE_COMPLETION && entry.message.display === false);
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

  test("does not re-send unchanged UI on repeated session tree events", async () => {
    const registry = new RunRegistry();
    registry.upsert(createRun({
      id: "branch-run",
      status: "running",
      updatedAt: 10,
      completedAt: undefined,
    }));

    const persisted = createPersistedState(registry.serialize(), 10);
    const { api } = createPi();
    const controller = new LazySubagentsController(api as any, { launcher: new FakeLauncher(), createRunId: () => "ignored", now: () => 10 });
    const { ctx, statuses, widgets, renderRequests } = createContext({ branchEntries: [{ type: "custom", customType: PERSISTED_STATE_ENTRY, data: persisted }] });

    await controller.handleSessionStart(ctx);
    expect(statuses).toHaveLength(1);
    expect(widgets).toHaveLength(1);
    expect(renderRequests).toHaveLength(1);

    await controller.handleSessionTree(ctx);
    await controller.handleSessionTree(ctx);

    expect(statuses).toHaveLength(1);
    expect(widgets).toHaveLength(1);
    expect(renderRequests).toHaveLength(1);
  });

  test("acknowledged named runs stay out of the UI and are released when their lease expires", async () => {
    vi.useFakeTimers();
    let clock = 1_000;
    const registry = new RunRegistry();
    registry.upsert(createRun({
      id: "named-run",
      name: "reviewer",
      title: "Reusable reviewer",
      taskSummary: "Reusable reviewer",
      status: "completed",
      updatedAt: 900,
      completedAt: 900,
      leaseExpiry: 1_100,
    }));
    registry.acknowledgeRun("named-run");

    const { api } = createPi();
    const launcher = new FakeLauncher();
    const controller = new LazySubagentsController(api as any, {
      launcher,
      createRunId: () => "new-run",
      now: () => clock,
      pollIntervalMs: 50,
    });
    const { ctx, widgets } = createContext({
      branchEntries: [{ type: "custom", customType: PERSISTED_STATE_ENTRY, data: createPersistedState(registry.serialize(), clock) }],
    });

    try {
      await controller.handleSessionStart(ctx);
      expect(widgets.at(-1)).toBeUndefined();

      clock = 1_200;
      await vi.advanceTimersByTimeAsync(60);
      await Promise.resolve();

      expect(widgets.at(-1)).toBeUndefined();

      const relaunched = await controller.launchChild({
        agent: "reviewer",
        title: "Reusable reviewer",
        taskSummary: "Reusable reviewer",
        prompt: "Keep reviewing",
        name: "reviewer",
      }, ctx);
      expect(relaunched.id).toBe("new-run");
      expect(relaunched.name).toBe("reviewer");
      expect(launcher.launches.at(-1)?.cwd).toBe("/repo");
    } finally {
      vi.useRealTimers();
      await controller.handleSessionShutdown(ctx);
    }
  });

  test("pinned named successful runs are unpinned and removed after lease expiry", async () => {
    vi.useFakeTimers();
    let clock = 1_000;
    const registry = new RunRegistry();
    registry.upsert(createRun({
      id: "pinned-named-run",
      name: "reviewer",
      title: "Pinned reviewer",
      taskSummary: "Pinned reviewer",
      status: "completed",
      updatedAt: 900,
      completedAt: 900,
      leaseExpiry: 1_100,
    }));
    registry.pinRun("pinned-named-run");

    const { api } = createPi();
    const controller = new LazySubagentsController(api as any, {
      launcher: new FakeLauncher(),
      now: () => clock,
      pollIntervalMs: 50,
    });
    const { ctx } = createContext({
      branchEntries: [{ type: "custom", customType: PERSISTED_STATE_ENTRY, data: createPersistedState(registry.serialize(), clock) }],
    });

    try {
      await controller.handleSessionStart(ctx);

      clock = 1_200;
      await vi.advanceTimersByTimeAsync(60);
      await Promise.resolve();

      const run = controller.getSnapshot().runs.find((entry: RunRecord) => entry.id === "pinned-named-run");
      expect(run).toBeUndefined();
    } finally {
      vi.useRealTimers();
      await controller.handleSessionShutdown(ctx);
    }
  });

  test("re-sends UI when restored session tree state changes", async () => {
    const firstRegistry = new RunRegistry();
    firstRegistry.upsert(createRun({
      id: "branch-run-1",
      title: "First ready run",
      status: "running",
      updatedAt: 10,
      completedAt: undefined,
    }));

    const secondRegistry = new RunRegistry();
    secondRegistry.upsert(createRun({
      id: "branch-run-2",
      title: "Second ready run",
      status: "running",
      updatedAt: 20,
      completedAt: undefined,
    }));

    const branchEntries = [
      { type: "custom", customType: PERSISTED_STATE_ENTRY, data: createPersistedState(firstRegistry.serialize(), 10) },
    ];
    const { api } = createPi();
    const controller = new LazySubagentsController(api as any, { launcher: new FakeLauncher(), createRunId: () => "ignored", now: () => 30 });
    const { ctx, statuses, widgets, renderRequests } = createContext({ branchEntries });

    await controller.handleSessionStart(ctx);
    expect(widgets.at(-1)?.[1]?.join("\n")).toContain("First ready run");

    branchEntries.push({ type: "custom", customType: PERSISTED_STATE_ENTRY, data: createPersistedState(secondRegistry.serialize(), 20) });
    await controller.handleSessionTree(ctx);

    expect(statuses).toHaveLength(1);
    expect(widgets).toHaveLength(2);
    expect(renderRequests).toHaveLength(2);
    expect(widgets.at(-1)?.[1]?.join("\n")).toContain("Second ready run");
  });

  test("routes restored terminal runs that finished while the main session was absent", async () => {
    const registry = new RunRegistry();
    registry.upsert(createRun({
      id: "restored-run",
      agent: "reviewer",
      title: "Review finished offline",
      taskSummary: "Review finished offline",
      status: "completed",
      updatedAt: 130,
      completedAt: 130,
      resultPreview: "Found 3 issues",
    }));

    const { api, messages, userMessages } = createPi();
    const controller = new LazySubagentsController(api as any, { launcher: new FakeLauncher(), now: () => 200 });
    const { ctx } = createContext({
      isIdle: true,
      hasPendingMessages: false,
      branchEntries: [{ type: "custom", customType: PERSISTED_STATE_ENTRY, data: createPersistedState(registry.serialize(), 130) }],
    });

    await controller.handleSessionStart(ctx);

    expect(userMessages).toHaveLength(0);
    const wakeMessages = hiddenCompletionMessages(messages);
    expect(wakeMessages).toHaveLength(1);
    expect(wakeMessages[0]?.message.content).toContain("[DONE] Review finished offline");
    expect(wakeMessages[0]?.message.content).toContain("Lazy subagent update");
    expect(wakeMessages[0]?.options).toEqual({ triggerTurn: true, deliverAs: "steer" });
  });

  test("launchChild stores normalized run names", async () => {
    const { api } = createPi();
    const launcher = new FakeLauncher();
    const controller = new LazySubagentsController(api as any, { launcher, createRunId: () => "run-1", now: () => 100 });
    const { ctx } = createContext();

    const run = await controller.launchChild({
      agent: "reviewer",
      title: "Named review",
      taskSummary: "Named review",
      prompt: "Review it",
      name: " My-Reviewer ",
    }, ctx);

    expect(run.name).toBe("my-reviewer");
    expect(controller.getSnapshot().runs[0]?.name).toBe("my-reviewer");
  });

  test("launchChild stores the resolved cwd used for continuation", async () => {
    const { api } = createPi();
    const launcher = new FakeLauncher();
    const controller = new LazySubagentsController(api as any, { launcher, createRunId: () => "run-1", now: () => 100 });
    const { ctx } = createContext();

    const run = await controller.launchChild({
      agent: "reviewer",
      title: "Review",
      taskSummary: "Review",
      prompt: "Review it",
    }, ctx);

    expect(run.cwd).toBe("/repo");
    expect(launcher.launches[0]?.cwd).toBe("/repo");
  });

  test("launchChild reserves names while launcher startup is pending", async () => {
    const { api } = createPi();
    const launcher = new FakeLauncher();
    let releaseLaunch: (() => void) | undefined;
    launcher.launchChildHook = async () => new Promise<void>((resolve) => { releaseLaunch = resolve; });
    let nextId = 0;
    const controller = new LazySubagentsController(api as any, { launcher, createRunId: () => `run-${++nextId}`, now: () => 100 });
    const { ctx } = createContext();

    const firstLaunch = controller.launchChild({
      agent: "reviewer",
      title: "First",
      taskSummary: "First",
      prompt: "Review it",
      name: "shared-name",
    }, ctx);
    await Promise.resolve();

    await expect(controller.launchChild({
      agent: "reviewer",
      title: "Second",
      taskSummary: "Second",
      prompt: "Review it too",
      name: "shared-name",
    }, ctx)).rejects.toThrow("already in use");

    releaseLaunch?.();
    await firstLaunch;
  });

  test("defers completion surfacing while the main session context is unavailable", async () => {
    const { api, messages, entries, userMessages } = createPi();
    const launcher = new FakeLauncher();
    let clock = 100;
    const controller = new LazySubagentsController(api as any, { launcher, createRunId: () => "run-1", now: () => clock });
    const { ctx } = createContext({ isIdle: true, hasPendingMessages: false });

    await controller.handleSessionStart(ctx);
    await controller.launchChild({
      agent: "reviewer",
      title: "Review auth diff",
      taskSummary: "Review auth diff",
      prompt: "Review it",
    }, ctx);

    await controller.handleSessionShutdown(ctx);
    clock = 130;
    launcher.updates.set("run-1", {
      runId: "run-1",
      status: "completed",
      updatedAt: 130,
      completedAt: 130,
      resultPreview: "Done",
    });

    await controller.pollOnce();

    expect(messages.filter((entry) => entry.message.display === false && entry.message.content.includes("Lazy subagent update"))).toHaveLength(0);

    const latestPersisted = entries.filter((entry) => entry.customType === PERSISTED_STATE_ENTRY).at(-1);
    const { ctx: restoredCtx } = createContext({
      isIdle: true,
      hasPendingMessages: false,
      branchEntries: latestPersisted ? [{ type: "custom", customType: PERSISTED_STATE_ENTRY, data: latestPersisted.data }] : [],
    });

    await controller.handleSessionStart(restoredCtx);

    expect(userMessages).toHaveLength(0);
    const wakeMessages = hiddenCompletionMessages(messages);
    expect(wakeMessages).toHaveLength(1);
    expect(wakeMessages[0]?.message.content).toContain("[DONE] Review auth diff");
    expect(wakeMessages[0]?.message.content).toContain("Lazy subagent update");
    expect(wakeMessages[0]?.options).toEqual({ triggerTurn: true, deliverAs: "steer" });
  });

  test("launches a child, emits a launch card, persists state, and routes completion once", async () => {
    const { api, messages, entries, userMessages } = createPi();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lazy-subagents-done-"));
    const artifactPath = path.join(tempDir, "run-1-review.md");
    await fs.writeFile(artifactPath, "Full reviewer report\n\n- Finding A\n- Finding B", "utf8");
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
      artifactPath,
      resultPreview: "Found 3 issues in auth.ts",
    });

    await controller.pollOnce();
    await controller.pollOnce();

    expect(controller.getSnapshot().recentRuns[0]?.status).toBe("completed");
    expect(messages.filter((entry) => entry.message.customType === MESSAGE_TYPE_COMPLETION && entry.message.display === true)).toHaveLength(1);
    expect(userMessages).toHaveLength(0);
    const wakeMessages = hiddenCompletionMessages(messages);
    expect(wakeMessages).toHaveLength(1);
    expect(wakeMessages[0]?.message.content).toContain("[DONE] Review auth diff");
    expect(wakeMessages[0]?.message.content).toContain(`Full report: ${artifactPath}`);
    expect(wakeMessages[0]?.message.content).toContain("Result excerpt:\nFull reviewer report");
    expect(wakeMessages[0]?.message.content).not.toContain("Lazy subagent update");
    expect(wakeMessages[0]?.message.content).not.toContain("- Summary: Found 3 issues in auth.ts");
  });

  test("routes named successful completions without leaving inbox entries visible", async () => {
    const { api, messages } = createPi();
    const launcher = new FakeLauncher();
    let clock = 100;
    const controller = new LazySubagentsController(api as any, { launcher, createRunId: () => "run-1", now: () => clock });
    const { ctx, widgets } = createContext({ isIdle: true, hasPendingMessages: false });

    await controller.handleSessionStart(ctx);
    await controller.launchChild(
      {
        agent: "reviewer",
        title: "Tasked wrap-up follow-up",
        taskSummary: "Tasked wrap-up follow-up",
        prompt: "Review the follow-up.",
        name: "tasked-follow-up",
      },
      ctx,
    );

    launcher.updates.set("run-1", {
      runId: "run-1",
      status: "completed",
      updatedAt: 130,
      completedAt: 130,
      resultPreview: "Done",
    });

    await controller.pollOnce();
    clock = 130 + 20 * 60_000;
    await controller.pollOnce();

    const widgetText = widgets.at(-1)?.[1]?.join("\n") ?? "";
    expect(widgetText).not.toContain("Tasked wrap-up follow-up");
    expect(widgetText).not.toContain("inbox");
    expect(messages.filter((entry) => entry.message.customType === MESSAGE_TYPE_COMPLETION && entry.message.display === true)).toHaveLength(0);
    const routedMessages = hiddenCompletionMessages(messages);
    expect(routedMessages).toHaveLength(1);
    expect(routedMessages[0]?.message.content).toContain("[DONE] Tasked wrap-up follow-up");
    const run = controller.getSnapshot().runs.find((entry: RunRecord) => entry.id === "run-1");
    expect(run?.name).toBe("tasked-follow-up");
    expect(run?.leaseExpiry).toBeDefined();
  });

  test("keeps named failures visible", async () => {
    const { api, messages } = createPi();
    const launcher = new FakeLauncher();
    const controller = new LazySubagentsController(api as any, { launcher, createRunId: () => "run-1", now: () => 100 });
    const { ctx, widgets } = createContext({ isIdle: true, hasPendingMessages: false });

    await controller.handleSessionStart(ctx);
    await controller.launchChild(
      {
        agent: "reviewer",
        title: "Tasked wrap-up follow-up",
        taskSummary: "Tasked wrap-up follow-up",
        prompt: "Review the follow-up.",
        name: "tasked-follow-up",
      },
      ctx,
    );

    launcher.updates.set("run-1", {
      runId: "run-1",
      status: "failed",
      updatedAt: 130,
      completedAt: 130,
      errorPreview: "boom",
      attentionNeeded: true,
    });

    await controller.pollOnce();

    expect(messages.filter((entry) => entry.message.customType === MESSAGE_TYPE_FAILURE && entry.message.display === true)).toHaveLength(1);
    expect(widgets.at(-1)?.[1]?.join("\n") ?? "").toContain("Tasked wrap-up follow-up");
  });

  test("routes parallel group completion with all child report links and one aggregate summary", async () => {
    const { api, messages, userMessages } = createPi();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lazy-subagents-group-"));
    const resultPath = path.join(tempDir, "group-1.json");
    const groupReport = path.join(tempDir, "group-report.md");
    const reportA = path.join(tempDir, "output-a.log");
    const reportB = path.join(tempDir, "output-b.log");
    const reportC = path.join(tempDir, "output-c.log");
    await fs.writeFile(groupReport, "Aggregate group report", "utf8");
    await fs.writeFile(reportA, "Scout found auth coupling", "utf8");
    await fs.writeFile(reportB, "Reviewer found race risk", "utf8");
    await fs.writeFile(reportC, "Verifier found missing test", "utf8");
    await fs.writeFile(resultPath, JSON.stringify({
      id: "group-1",
      runId: "group-1",
      state: "complete",
      success: true,
      summary: "Three agents agree: fix auth coupling, race risk, and missing test coverage.",
      timestamp: 130,
      results: [
        { stepId: "scout", taskSummary: "Inspect auth", agent: "scout", output: "Scout found auth coupling", artifactPaths: { outputPath: reportA } },
        { stepId: "review", taskSummary: "Review auth", agent: "reviewer", output: "Reviewer found race risk", artifactPaths: { outputPath: reportB } },
        { stepId: "verify", taskSummary: "Verify auth", agent: "verifier", output: "Verifier found missing test", artifactPaths: { outputPath: reportC } },
      ],
    }), "utf8");

    const launcher = new FakeLauncher();
    launcher.launchResults.set("group-1", { resultPath });
    const controller = new LazySubagentsController(api as any, { launcher, createRunId: () => "group-1", now: () => 100 });
    const { ctx } = createContext({ isIdle: true, hasPendingMessages: false });

    await controller.handleSessionStart(ctx);
    await controller.launchGroup(
      {
        title: "Parallel auth review",
        taskSummary: "Parallel auth review",
        children: [
          { agent: "scout", prompt: "Inspect auth", taskSummary: "Inspect auth" },
          { agent: "reviewer", prompt: "Review auth", taskSummary: "Review auth" },
          { agent: "verifier", prompt: "Verify auth", taskSummary: "Verify auth" },
        ],
      },
      ctx,
    );

    launcher.updates.set("group-1", {
      runId: "group-1",
      status: "completed",
      updatedAt: 130,
      completedAt: 130,
      artifactPath: groupReport,
      resultPreview: "Three agents agree: fix auth coupling, race risk, and missing test coverage.",
    });

    await controller.pollOnce();

    expect(userMessages).toHaveLength(0);
    const wakeMessages = hiddenCompletionMessages(messages);
    expect(wakeMessages).toHaveLength(1);
    expect(wakeMessages[0]?.message.content).toContain("[DONE] Parallel auth review");
    expect(wakeMessages[0]?.message.content).toContain("Reports:");
    expect(wakeMessages[0]?.message.content).toContain(`- Full report: ${groupReport}`);
    expect(wakeMessages[0]?.message.content).toContain(`- Result file: ${resultPath}`);
    expect(wakeMessages[0]?.message.content).toContain(`- scout / Inspect auth: ${reportA}`);
    expect(wakeMessages[0]?.message.content).toContain(`- reviewer / Review auth: ${reportB}`);
    expect(wakeMessages[0]?.message.content).toContain(`- verifier / Verify auth: ${reportC}`);
    expect(wakeMessages[0]?.message.content).toContain("Summary:\nThree agents agree: fix auth coupling, race risk, and missing test coverage.");
    expect(wakeMessages[0]?.message.content).toContain("Result excerpt:");
    expect(wakeMessages[0]?.message.content).toContain("[scout]\nScout found auth coupling");
    expect(wakeMessages[0]?.message.content).toContain("[review]\nReviewer found race risk");
    expect(wakeMessages[0]?.message.content).toContain("[verify]\nVerifier found missing test");
  });

  test("rejects names for group launches at the controller boundary", async () => {
    const { api } = createPi();
    const launcher = new FakeLauncher();
    const launchGroupSpy = vi.spyOn(launcher, "launchGroup");
    const controller = new LazySubagentsController(api as any, { launcher, createRunId: () => "group-1", now: () => 100 });
    const { ctx } = createContext();

    await controller.handleSessionStart(ctx);

    await expect(controller.launchGroup(
      {
        name: "group-name",
        title: "Parallel auth review",
        taskSummary: "Parallel auth review",
        children: [{ agent: "scout", prompt: "Inspect auth", taskSummary: "Inspect auth" }],
      },
      ctx,
    )).rejects.toThrow("Run names are only supported for single runs");
    expect(launchGroupSpy).not.toHaveBeenCalled();
  });

  test("routes group completion parent reports even when child artifact paths are missing", async () => {
    const { api, messages, userMessages } = createPi();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lazy-subagents-group-no-child-reports-"));
    const resultPath = path.join(tempDir, "group-1.json");
    const groupReport = path.join(tempDir, "group-report.md");
    await fs.writeFile(groupReport, "Aggregate group report", "utf8");
    await fs.writeFile(resultPath, JSON.stringify({
      id: "group-1",
      runId: "group-1",
      state: "complete",
      success: true,
      summary: "Aggregate only summary.",
      timestamp: 130,
      results: [
        { stepId: "scout", taskSummary: "Inspect auth", agent: "scout", output: "Scout found auth coupling" },
        { stepId: "review", taskSummary: "Review auth", agent: "reviewer", output: "Reviewer found race risk" },
      ],
    }), "utf8");

    const launcher = new FakeLauncher();
    launcher.launchResults.set("group-1", { resultPath });
    const controller = new LazySubagentsController(api as any, { launcher, createRunId: () => "group-1", now: () => 100 });
    const { ctx } = createContext({ isIdle: true, hasPendingMessages: false });

    await controller.handleSessionStart(ctx);
    await controller.launchGroup(
      {
        title: "Parallel auth review",
        taskSummary: "Parallel auth review",
        children: [
          { agent: "scout", prompt: "Inspect auth", taskSummary: "Inspect auth" },
          { agent: "reviewer", prompt: "Review auth", taskSummary: "Review auth" },
        ],
      },
      ctx,
    );

    launcher.updates.set("group-1", {
      runId: "group-1",
      status: "completed",
      updatedAt: 130,
      completedAt: 130,
      artifactPath: groupReport,
      resultPreview: "Aggregate only summary.",
    });

    await controller.pollOnce();

    expect(userMessages).toHaveLength(0);
    const wakeMessages = hiddenCompletionMessages(messages);
    expect(wakeMessages).toHaveLength(1);
    expect(wakeMessages[0]?.message.content).toContain("Reports:");
    expect(wakeMessages[0]?.message.content).toContain(`- Full report: ${groupReport}`);
    expect(wakeMessages[0]?.message.content).toContain(`- Result file: ${resultPath}`);
    expect(wakeMessages[0]?.message.content).toContain("[scout]\nScout found auth coupling");
    expect(wakeMessages[0]?.message.content).toContain("[review]\nReviewer found race risk");
  });

  test("routes summary-only group completion without duplicating the summary as excerpt", async () => {
    const { api, messages } = createPi();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lazy-subagents-summary-only-"));
    const resultPath = path.join(tempDir, "group-1.json");
    await fs.writeFile(resultPath, JSON.stringify({
      id: "group-1",
      runId: "group-1",
      state: "complete",
      success: true,
      summary: "Only a high-level aggregate summary.",
      timestamp: 130,
    }), "utf8");

    const launcher = new FakeLauncher();
    launcher.launchResults.set("group-1", { resultPath });
    const controller = new LazySubagentsController(api as any, { launcher, createRunId: () => "group-1", now: () => 100 });
    const { ctx } = createContext({ isIdle: true, hasPendingMessages: false });

    await controller.handleSessionStart(ctx);
    await controller.launchGroup(
      {
        title: "Parallel auth review",
        taskSummary: "Parallel auth review",
        children: [{ agent: "scout", prompt: "Inspect auth", taskSummary: "Inspect auth" }],
      },
      ctx,
    );

    launcher.updates.set("group-1", {
      runId: "group-1",
      status: "completed",
      updatedAt: 130,
      completedAt: 130,
      resultPreview: "Only a high-level aggregate summary.",
    });

    await controller.pollOnce();

    const wakeMessages = hiddenCompletionMessages(messages);
    expect(wakeMessages).toHaveLength(1);
    expect(wakeMessages[0]?.message.content).toContain("Reports:");
    expect(wakeMessages[0]?.message.content).toContain(`- Result file: ${resultPath}`);
    expect(wakeMessages[0]?.message.content).toContain("Summary:\nOnly a high-level aggregate summary.");
    expect(wakeMessages[0]?.message.content).not.toContain("Result excerpt:");
  });

  test("routes failed runs back to the main agent even from legacy notify-only state", async () => {
    const legacyPersisted = {
      version: 1,
      updatedAt: 140,
      surfacedCompletionKeys: [],
      acknowledgedRunIds: [],
      pinnedRunIds: [],
      runs: [{
        id: "failed-run",
        kind: "single",
        agent: "reviewer",
        title: "Review failed",
        taskSummary: "Review failed",
        status: "failed",
        startedAt: 100,
        updatedAt: 140,
        completedAt: 140,
        completionPolicy: "notify_only",
        errorPreview: "review process exited 1",
        attentionNeeded: true,
        recentEvents: [],
      }],
    };

    const { api, messages, userMessages } = createPi();
    const controller = new LazySubagentsController(api as any, { launcher: new FakeLauncher(), now: () => 200 });
    const { ctx } = createContext({
      isIdle: true,
      hasPendingMessages: false,
      branchEntries: [{ type: "custom", customType: PERSISTED_STATE_ENTRY, data: legacyPersisted }],
    });

    await controller.handleSessionStart(ctx);

    expect(userMessages).toHaveLength(0);
    const wakeMessages = messages.filter((entry) => entry.message.customType === MESSAGE_TYPE_FAILURE && entry.message.display === false);
    expect(wakeMessages).toHaveLength(1);
    expect(wakeMessages[0]?.message.content).toContain("[FAILED] Review failed");
    expect(wakeMessages[0]?.message.content).toContain("review process exited 1");
    expect(wakeMessages[0]?.options).toEqual({ triggerTurn: true, deliverAs: "steer" });
  });

  test("waitForRunSignal blocks via polling until a run is completed or needs attention", async () => {
    const { api } = createPi();
    const launcher = new FakeLauncher();
    const controller = new LazySubagentsController(api as any, { launcher, createRunId: () => "run-1", pollIntervalMs: 5 });
    const { ctx } = createContext({ isIdle: true, hasPendingMessages: false });

    await controller.handleSessionStart(ctx);
    await controller.launchChild({ agent: "reviewer", title: "Review auth diff", taskSummary: "Review auth diff", prompt: "Review it" }, ctx);

    setTimeout(() => {
      launcher.updates.set("run-1", {
        runId: "run-1",
        status: "completed",
        updatedAt: Date.now(),
        completedAt: Date.now(),
        resultPreview: "Done",
      });
    }, 10);

    const result = await controller.waitForRunSignal("run-1", { timeoutMs: 1_000 });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error(`Expected ready, got ${result.status}`);
    expect(result.run.status).toBe("completed");
  });

  test("waitForRunSignal latches the only active run before it completes during polling", async () => {
    const { api } = createPi();
    const launcher = new FakeLauncher();
    const controller = new LazySubagentsController(api as any, { launcher, createRunId: () => "run-1", now: () => 100 });
    const { ctx } = createContext({ isIdle: true, hasPendingMessages: false });

    await controller.handleSessionStart(ctx);
    await controller.launchChild({ agent: "reviewer", title: "Review auth diff", taskSummary: "Review auth diff", prompt: "Review it" }, ctx);
    launcher.updates.set("run-1", {
      runId: "run-1",
      status: "completed",
      updatedAt: 130,
      completedAt: 130,
      resultPreview: "Done",
    });

    const result = await controller.waitForRunSignal(undefined, { timeoutMs: Number.NaN });

    expect(result.status).toBe("ready");
    if (result.status !== "ready") throw new Error(`Expected ready, got ${result.status}`);
    expect(result.run.id).toBe("run-1");
    expect(result.run.status).toBe("completed");
  });

  test("waitForRunSignal asks for a run id when multiple runs are active", async () => {
    const { api } = createPi();
    const launcher = new FakeLauncher();
    let nextRun = 0;
    const controller = new LazySubagentsController(api as any, { launcher, createRunId: () => `run-${++nextRun}`, now: () => 100 });
    const { ctx } = createContext({ isIdle: true, hasPendingMessages: false });

    await controller.handleSessionStart(ctx);
    await controller.launchChild({ agent: "reviewer", title: "Run one", taskSummary: "Run one", prompt: "one" }, ctx);
    await controller.launchChild({ agent: "reviewer", title: "Run two", taskSummary: "Run two", prompt: "two" }, ctx);

    const result = await controller.waitForRunSignal(undefined, { timeoutMs: 100 });

    expect(result.status).toBe("ambiguous");
    if (result.status !== "ambiguous") throw new Error(`Expected ambiguous, got ${result.status}`);
    expect(result.activeRuns.map((run) => run.id)).toEqual(["run-1", "run-2"]);
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
    expect(statuses.at(-1)?.[1]).toContain("1 live");
    expect(statuses.at(-1)?.[1]).not.toContain("6.1k tok");
    expect(widgets.at(-1)?.[1]?.join("\n") ?? "").toContain("6.1k tok");
  });

  test("routes restored successful runs without leaving them in live UI", async () => {
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

    let clock = 10_000;
    const { api } = createPi();
    const launcher = new FakeLauncher();
    const controller = new LazySubagentsController(api as any, { launcher, now: () => clock });
    const { ctx, widgets } = createContext({
      entries: [{ type: "custom", customType: PERSISTED_STATE_ENTRY, data: createPersistedState(registry.serialize(), 10_000) }],
      branchEntries: [{ type: "custom", customType: PERSISTED_STATE_ENTRY, data: createPersistedState(registry.serialize(), 10_000) }],
    });

    await controller.handleSessionStart(ctx);
    expect(widgets.at(-1)?.[1]?.join("\n") ?? "").not.toContain("Done recent");

    clock = 31_001;
    await controller.pollOnce();

    expect(widgets.at(-1)?.[1]?.join("\n") ?? "").not.toContain("Done recent");
  });

  test("cleans up acknowledged skipped runs after the acknowledged TTL", async () => {
    const registry = new RunRegistry();
    registry.upsert(createRun({ id: "skipped-old", status: "skipped", title: "Skipped old", updatedAt: 100, completedAt: 100, resultPreview: "skipped" }));
    registry.acknowledgeRun("skipped-old");

    const { api } = createPi();
    const launcher = new FakeLauncher();
    const controller = new LazySubagentsController(api as any, { launcher, now: () => 100 + 5 * 60_000 + 1 });
    const persisted = createPersistedState(registry.serialize(), 100);
    const { ctx } = createContext({
      entries: [{ type: "custom", customType: PERSISTED_STATE_ENTRY, data: persisted }],
      branchEntries: [{ type: "custom", customType: PERSISTED_STATE_ENTRY, data: persisted }],
    });

    await controller.handleSessionStart(ctx);
    await controller.pollOnce();

    expect(controller.getSnapshot().runs.map((run) => run.id)).not.toContain("skipped-old");
  });

  test("hides acknowledged successes from live UI but keeps failed runs visible", async () => {
    const registry = new RunRegistry();
    registry.upsert(createRun({ id: "done-hidden", status: "completed", title: "Done hidden", updatedAt: 100, completedAt: 100 }));
    registry.acknowledgeRun("done-hidden");
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
    expect(widgetText).not.toContain("1 pinned");
    expect(widgetText).not.toContain("pinned · Done pinned");
    expect(widgetText).not.toContain("Done pinned");
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

  test("does not surface a loop alert for high token or tool usage alone", async () => {
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

    expect(controller.getSnapshot().activeRuns[0]?.attentionNeeded).toBe(false);
    expect(messages.some((entry) => entry.message.customType === MESSAGE_TYPE_ATTENTION)).toBe(false);
  });

  test("does not surface a loop alert for generic running heartbeat updates", async () => {
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

    for (const updatedAt of [110, 111, 112]) {
      launcher.updates.set("run-1", {
        runId: "run-1",
        status: "running",
        updatedAt,
        toolCount: updatedAt - 110,
        event: {
          id: `run-1:${updatedAt}:progress`,
          category: "progress",
          timestamp: updatedAt,
          summary: "run-1 running",
          status: "running",
        },
      });
      await controller.pollOnce();
    }

    expect(controller.getSnapshot().activeRuns[0]?.attentionNeeded).toBe(false);
    expect(messages.some((entry) => entry.message.customType === MESSAGE_TYPE_ATTENTION)).toBe(false);
  });

  test("does not surface attention when recent activity repeats the same multi-step cycle", async () => {
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

    for (const update of [
      { updatedAt: 110, currentTool: "read", toolCount: 0, summary: "run-1 running · read" },
      { updatedAt: 111, currentTool: undefined, toolCount: 1, summary: "run-1 running · summarize findings" },
      { updatedAt: 112, currentTool: "read", toolCount: 1, summary: "run-1 running · read" },
      { updatedAt: 113, currentTool: undefined, toolCount: 2, summary: "run-1 running · summarize findings" },
      { updatedAt: 114, currentTool: "read", toolCount: 2, summary: "run-1 running · read" },
      { updatedAt: 115, currentTool: undefined, toolCount: 3, summary: "run-1 running · summarize findings" },
    ]) {
      launcher.updates.set("run-1", {
        runId: "run-1",
        status: "running",
        updatedAt: update.updatedAt,
        currentTool: update.currentTool,
        toolCount: update.toolCount,
        event: {
          id: `run-1:${update.updatedAt}:progress`,
          category: "progress",
          timestamp: update.updatedAt,
          summary: update.summary,
          status: "running",
        },
      });
      await controller.pollOnce();
    }

    expect(controller.getSnapshot().activeRuns[0]?.attentionNeeded).toBe(false);
    expect(messages.some((entry) => entry.message.customType === MESSAGE_TYPE_ATTENTION)).toBe(false);
  });

  test("does not surface attention when the same signal repeats many times", async () => {
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

    for (const updatedAt of [110, 111, 112]) {
      launcher.updates.set("run-1", {
        runId: "run-1",
        status: "running",
        updatedAt,
        currentTool: "read",
        toolCount: updatedAt - 110,
        event: {
          id: `run-1:${updatedAt}:progress`,
          category: "progress",
          timestamp: updatedAt,
          summary: "run-1 running · read package.json",
          status: "running",
        },
      });
      await controller.pollOnce();
    }

    expect(controller.getSnapshot().activeRuns[0]?.attentionNeeded).toBe(false);
    expect(messages.some((entry) => entry.message.customType === MESSAGE_TYPE_ATTENTION)).toBe(false);
  });

  test("ignores stale in-flight running updates after cancel", async () => {
    const { api, messages } = createPi();
    const launcher = new FakeLauncher();
    const controller = new LazySubagentsController(api as any, { launcher, createRunId: () => "run-1", now: () => 100 });
    const { ctx } = createContext({ isIdle: true, hasPendingMessages: false });

    let resolveUpdate: ((value: NormalizedRunUpdate | undefined) => void) | undefined;
    launcher.readUpdateHook = async (launch) => {
      if (launch.runId !== "run-1") return undefined;
      return await new Promise<NormalizedRunUpdate | undefined>((resolve) => {
        resolveUpdate = resolve;
      });
    };

    await controller.handleSessionStart(ctx);
    await controller.launchChild(
      {
        agent: "reviewer",
        title: "Scoped workflow review",
        taskSummary: "Scoped workflow review",
        prompt: "Review the workflow changes.",
      },
      ctx,
    );

    const pollPromise = controller.pollOnce();
    await Promise.resolve();

    expect(await controller.cancelRun("run-1", ctx)).toBe(true);

    resolveUpdate?.({
      runId: "run-1",
      status: "running",
      updatedAt: 120,
      currentTool: "read",
      event: {
        id: "run-1:120:progress",
        category: "progress",
        timestamp: 120,
        summary: "run-1 running · read .github/workflows/ci.yml",
        status: "running",
      },
    });
    await pollPromise;

    expect(controller.getSnapshot().runs.find((run) => run.id === "run-1")?.status).toBe("cancelled");
    expect(controller.getSnapshot().activeRuns).toHaveLength(0);
    expect(messages.filter((entry) => entry.message.customType === MESSAGE_TYPE_ATTENTION)).toHaveLength(0);
  });

  test("wait emits live tool updates for the selected run without requiring transcript pin surfacing", async () => {
    const { api, messages } = createPi();
    const launcher = new FakeLauncher();
    const controller = new LazySubagentsController(api as any, { launcher, createRunId: () => "run-1", now: () => 100 });
    const { ctx, widgets } = createContext({ isIdle: true, hasPendingMessages: false });
    const updates: any[] = [];

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
      updatedAt: 120,
      completedAt: 120,
      resultPreview: "Looks good overall.",
      currentTool: "read",
      toolCount: 1,
      totalTokens: 42,
    });

    const result = await controller.waitForRunSignal("run-1", { ctx, onUpdate: (update) => updates.push(update) });

    expect(result.status).toBe("ready");
    expect(messages.some((entry) => entry.message.customType === MESSAGE_TYPE_PIN && entry.message.details?.runId === "run-1")).toBe(false);
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.at(-1)?.details?.kind).toBe("wait-progress");
    expect(updates.at(-1)?.details?.runId).toBe("run-1");
    expect(updates.at(-1)?.details?.lines.join("\n")).toContain("Review auth diff");
    expect(updates.at(-1)?.details?.lines.join("\n")).toContain("read");
    expect(widgets.at(-1)?.[1]?.join("\n") ?? "").not.toContain("1 pinned");

    expect(await controller.pinRun("run-1", ctx)).toBe(true);
    expect(messages.filter((entry) => entry.message.customType === MESSAGE_TYPE_PIN && entry.message.details?.runId === "run-1")).toHaveLength(0);
    expect(await controller.pinRun("run-1", ctx)).toBe(true);
    expect(messages.filter((entry) => entry.message.customType === MESSAGE_TYPE_PIN && entry.message.details?.runId === "run-1")).toHaveLength(0);
  });

  test("wait surfaces progress without leaving completed runs pinned", async () => {
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
      status: "completed",
      updatedAt: 120,
      completedAt: 120,
      resultPreview: "Looks good overall.",
    });

    const result = await controller.waitForRunSignal("run-1", { ctx });

    expect(result.status).toBe("ready");
    expect(messages.some((entry) => entry.message.customType === MESSAGE_TYPE_PIN && entry.message.details?.runId === "run-1")).toBe(false);
    expect(controller.getPinnedRunLines("run-1").join("\n")).toContain("Review auth diff");
  });

  test("wait does not duplicate an already pinned progress view", async () => {
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
    expect(await controller.pinRun("run-1", ctx)).toBe(true);

    launcher.updates.set("run-1", {
      runId: "run-1",
      status: "completed",
      updatedAt: 120,
      completedAt: 120,
      resultPreview: "Looks good overall.",
    });

    const result = await controller.waitForRunSignal("run-1", { ctx });

    expect(result.status).toBe("ready");
    expect(messages.filter((entry) => entry.message.customType === MESSAGE_TYPE_PIN && entry.message.details?.runId === "run-1")).toHaveLength(1);
  });

  test("pins a run into chat and renders detailed progress lines from child events", async () => {
    const { api, messages } = createPi();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lazy-subagents-pin-"));
    const eventsPath = path.join(tempDir, "events.jsonl");
    await fs.writeFile(eventsPath, [
      JSON.stringify({ runId: "run-1", index: 0, raw: JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "/repo/src/auth.ts" } }) }),
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
    launcher.launchResults.set("run-1", { asyncDir: tempDir, resultPath: path.join(tempDir, "result.json"), model: "(openai-codex) gpt-5.4 • xhigh" });
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
    expect(controller.getPinnedRunLines("run-1").join("\n")).toContain("model (openai-codex) gpt-5.4 • xhigh");
    expect(controller.getPinnedRunLines("run-1").join("\n")).toContain("tool start · read · /repo/src/auth.ts");
    expect(controller.getPinnedRunLines("run-1").join("\n")).toContain("Looks good overall.");
  });

  test("does not reread progress logs on every poll and refreshes pinned logs only when updates advance", async () => {
    const { api, entries } = createPi();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lazy-subagents-progress-cache-"));
    const eventsPath = path.join(tempDir, "events.jsonl");
    await fs.writeFile(eventsPath, [
      JSON.stringify({ runId: "run-1", index: 0, raw: JSON.stringify({ type: "tool_execution_start", toolName: "read", args: { path: "/repo/src/auth.ts" } }) }),
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
    await new Promise((resolve) => setTimeout(resolve, 0));

    const readSpy = vi.spyOn(fs, "readFile");
    try {
      launcher.updates.set("run-1", {
        runId: "run-1",
        status: "running",
        updatedAt: 120,
        currentTool: "read",
        toolCount: 1,
        totalTokens: 42,
      });
      await controller.pollOnce();
      expect(readSpy.mock.calls.filter(([filePath]) => String(filePath) === eventsPath)).toHaveLength(0);

      expect(await controller.pinRun("run-1")).toBe(true);
      expect(readSpy.mock.calls.filter(([filePath]) => String(filePath) === eventsPath)).toHaveLength(1);

      launcher.updates.set("run-1", {
        runId: "run-1",
        status: "running",
        updatedAt: 120,
        currentTool: "read",
        toolCount: 1,
        totalTokens: 42,
      });
      await controller.pollOnce();
      expect(readSpy.mock.calls.filter(([filePath]) => String(filePath) === eventsPath)).toHaveLength(1);

      const persistedEntryCount = entries.length;
      await fs.appendFile(
        eventsPath,
        `\n${JSON.stringify({
          runId: "run-1",
          index: 0,
          raw: JSON.stringify({
            type: "message_end",
            message: {
              role: "assistant",
              content: [{ type: "text", text: "Intermediate note." }],
            },
          }),
        })}`,
        "utf8",
      );
      launcher.updates.set("run-1", {
        runId: "run-1",
        status: "running",
        updatedAt: 121,
        currentTool: "read",
        toolCount: 1,
        totalTokens: 42,
      });
      await controller.pollOnce();
      expect(entries.length).toBeGreaterThan(persistedEntryCount);
      expect(readSpy.mock.calls.filter(([filePath]) => String(filePath) === eventsPath)).toHaveLength(2);
      expect(controller.getPinnedRunLines("run-1").join("\n")).toContain("Intermediate note.");

      await fs.appendFile(
        eventsPath,
        `\n${JSON.stringify({ runId: "run-1", index: 0, raw: JSON.stringify({ type: "tool_execution_end", toolName: "read" }) })}`,
        "utf8",
      );
      launcher.updates.set("run-1", {
        runId: "run-1",
        status: "running",
        updatedAt: 121,
        currentTool: "read",
        toolCount: 1,
        totalTokens: 42,
        event: {
          id: "run-1:121:tool-end",
          category: "progress",
          timestamp: 121,
          summary: "run-1 running · read",
          status: "running",
        },
      });
      await controller.pollOnce();
      expect(entries.length).toBeGreaterThan(persistedEntryCount);
      expect(readSpy.mock.calls.filter(([filePath]) => String(filePath) === eventsPath)).toHaveLength(3);
      expect(controller.getPinnedRunLines("run-1").join("\n")).toContain("tool end · read");
    } finally {
      readSpy.mockRestore();
    }
  });

  test("launches a workflow run through the workflow launcher path", async () => {
    const { api, messages } = createPi();
    const launcher = new FakeLauncher();
    const controller = new LazySubagentsController(api as any, { launcher: launcher as any, createRunId: () => "workflow-1", now: () => 140 });
    const { ctx } = createContext({ isIdle: true, hasPendingMessages: false });

    await controller.handleSessionStart(ctx);
    const run = await controller.launchWorkflow(
      {
        title: "Refactor workflow",
        taskSummary: "Refactor workflow",
        maxConcurrency: 2,
        steps: [
          { id: "research", agent: "scout", prompt: "Inspect the codebase", taskSummary: "Inspect the codebase", outputMode: "json", outputSchema: "{ summary: string }" },
          { id: "plan", agent: "reviewer", prompt: "Draft the plan", taskSummary: "Draft the plan", dependsOn: ["research"], retries: 2 },
        ],
      },
      ctx,
    );

    expect(launcher.workflowLaunches).toHaveLength(1);
    expect(launcher.workflowLaunches[0]).toMatchObject({
      runId: "workflow-1",
      maxConcurrency: 2,
      steps: [
        expect.objectContaining({ id: "research", agent: "scout", outputMode: "json", outputSchema: "{ summary: string }" }),
        expect.objectContaining({ id: "plan", agent: "reviewer", dependsOn: ["research"], retries: 2 }),
      ],
    });
    expect(run.kind).toBe("workflow");
    expect(messages[0]?.message.customType).toBe(MESSAGE_TYPE_LAUNCH);
  });

  test("rejects invalid workflow definitions before launch", async () => {
    const { api } = createPi();
    const launcher = new FakeLauncher();
    const launchWorkflowSpy = vi.spyOn(launcher, "launchWorkflow");
    const controller = new LazySubagentsController(api as any, { launcher, createRunId: () => "workflow-2", now: () => 145 });
    const { ctx } = createContext({ isIdle: true, hasPendingMessages: false });

    await controller.handleSessionStart(ctx);

    await expect(controller.launchWorkflow(
      {
        name: "workflow-name",
        title: "Named workflow",
        taskSummary: "Named workflow",
        steps: [{ id: "research", agent: "scout", prompt: "Inspect", taskSummary: "Inspect" }],
      },
      ctx,
    )).rejects.toThrow("Run names are only supported for single runs");

    await expect(controller.launchWorkflow(
      {
        title: "Invalid workflow",
        taskSummary: "Invalid workflow",
        maxConcurrency: 1.5,
        steps: [{ id: "research", agent: "scout", prompt: "Inspect the codebase", taskSummary: "Inspect the codebase" }],
      },
      ctx,
    )).rejects.toThrow("maxConcurrency must be an integer");

    await expect(controller.launchWorkflow(
      {
        title: "Empty workflow",
        taskSummary: "Empty workflow",
        steps: [],
      },
      ctx,
    )).rejects.toThrow("at least one step");

    await expect(controller.launchWorkflow(
      {
        title: "Blank id",
        taskSummary: "Blank id",
        steps: [{ id: "   ", agent: "scout", prompt: "Inspect", taskSummary: "Inspect" }],
      },
      ctx,
    )).rejects.toThrow("non-empty strings");

    await expect(controller.launchWorkflow(
      {
        title: "Duplicate ids",
        taskSummary: "Duplicate ids",
        steps: [
          { id: "research", agent: "scout", prompt: "Inspect", taskSummary: "Inspect" },
          { id: " research ", agent: "reviewer", prompt: "Plan", taskSummary: "Plan" },
        ],
      },
      ctx,
    )).rejects.toThrow("Duplicate workflow step id: research");

    await expect(controller.launchWorkflow(
      {
        title: "Missing dependency",
        taskSummary: "Missing dependency",
        steps: [{ id: "plan", agent: "reviewer", prompt: "Plan", taskSummary: "Plan", dependsOn: [" research "] }],
      },
      ctx,
    )).rejects.toThrow("depends on unknown step research");

    await expect(controller.launchWorkflow(
      {
        title: "Blank dependency",
        taskSummary: "Blank dependency",
        steps: [{ id: "plan", agent: "reviewer", prompt: "Plan", taskSummary: "Plan", dependsOn: ["   "] }],
      },
      ctx,
    )).rejects.toThrow("empty dependency id");

    await expect(controller.launchWorkflow(
      {
        title: "Self dependency",
        taskSummary: "Self dependency",
        steps: [{ id: "plan", agent: "reviewer", prompt: "Plan", taskSummary: "Plan", dependsOn: [" plan "] }],
      },
      ctx,
    )).rejects.toThrow("cannot depend on itself");

    await expect(controller.launchWorkflow(
      {
        title: "Cycle",
        taskSummary: "Cycle",
        steps: [
          { id: " research ", agent: "scout", prompt: "Inspect", taskSummary: "Inspect", dependsOn: [" plan "] },
          { id: "plan", agent: "reviewer", prompt: "Plan", taskSummary: "Plan", dependsOn: ["research"] },
        ],
      },
      ctx,
    )).rejects.toThrow("Workflow dependency cycle detected");

    await expect(controller.launchWorkflow(
      {
        title: "Invalid retries",
        taskSummary: "Invalid retries",
        steps: [{ id: "research", agent: "scout", prompt: "Inspect", taskSummary: "Inspect", retries: -1 }],
      },
      ctx,
    )).rejects.toThrow("invalid retries value");

    await expect(controller.launchWorkflow(
      {
        title: "Invalid when",
        taskSummary: "Invalid when",
        steps: [
          { id: "triage", agent: "scout", prompt: "Inspect", taskSummary: "Inspect", outputMode: "json" },
          { id: "security", agent: "reviewer", prompt: "Review", taskSummary: "Review", dependsOn: ["triage"], when: "{{missing.structured.runSecurity}}" },
        ],
      },
      ctx,
    )).rejects.toThrow("when references unknown step missing");

    await expect(controller.launchWorkflow(
      {
        title: "Invalid fanout source",
        taskSummary: "Invalid fanout source",
        steps: [
          { id: "triage", agent: "scout", prompt: "Inspect", taskSummary: "Inspect", outputMode: "json" },
          { id: "review", agent: "{{item.agent}}", prompt: "Review", taskSummary: "Review", dependsOn: ["triage"], fanOutFrom: { step: "missing", path: "structured.reviewers" } },
        ],
      },
      ctx,
    )).rejects.toThrow("fanOutFrom references unknown step missing");

    await expect(controller.launchWorkflow(
      {
        title: "When without dependency",
        taskSummary: "When without dependency",
        steps: [
          { id: "triage", agent: "scout", prompt: "Inspect", taskSummary: "Inspect", outputMode: "json" },
          { id: "security", agent: "reviewer", prompt: "Review", taskSummary: "Review", when: "{{triage.structured.runSecurity}}" },
        ],
      },
      ctx,
    )).rejects.toThrow("when reference triage must be listed in dependsOn");

    await expect(controller.launchWorkflow(
      {
        title: "Fanout without dependency",
        taskSummary: "Fanout without dependency",
        steps: [
          { id: "triage", agent: "scout", prompt: "Inspect", taskSummary: "Inspect", outputMode: "json" },
          { id: "review", agent: "{{item.agent}}", prompt: "Review", taskSummary: "Review", fanOutFrom: { step: "triage", path: "structured.reviewers" } },
        ],
      },
      ctx,
    )).rejects.toThrow("fanOutFrom source triage must be listed in dependsOn");

    await expect(controller.launchWorkflow(
      {
        title: "Fanout from text source",
        taskSummary: "Fanout from text source",
        steps: [
          { id: "triage", agent: "scout", prompt: "Inspect", taskSummary: "Inspect" },
          { id: "review", agent: "{{item.agent}}", prompt: "Review", taskSummary: "Review", dependsOn: ["triage"], fanOutFrom: { step: "triage", path: "structured.reviewers" } },
        ],
      },
      ctx,
    )).rejects.toThrow("fanOutFrom source triage must use outputMode=json");

    await expect(controller.launchWorkflow(
      {
        title: "Compound when",
        taskSummary: "Compound when",
        steps: [
          { id: "triage", agent: "scout", prompt: "Inspect", taskSummary: "Inspect", outputMode: "json" },
          { id: "security", agent: "reviewer", prompt: "Review", taskSummary: "Review", dependsOn: ["triage"], when: "{{triage.structured.runSecurity}} && {{triage.structured.runBackend}}" },
        ],
      },
      ctx,
    )).rejects.toThrow("when must be a single workflow reference");

    expect(launchWorkflowSpy).not.toHaveBeenCalled();
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

  test("ignores malformed array result files and falls back to artifact text", async () => {
    const { api } = createPi();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lazy-subagents-controller-"));
    const resultPath = path.join(tempDir, "run-array.json");
    const artifactPath = path.join(tempDir, "run-array.log");
    await fs.writeFile(resultPath, "[]", "utf8");
    await fs.writeFile(artifactPath, "Artifact fallback", "utf8");

    const controller = new LazySubagentsController(api as any, { launcher: new FakeLauncher(), createRunId: () => "ignored", now: () => 210 });
    const { ctx } = createContext({ isIdle: true, hasPendingMessages: false });

    await controller.handleSessionStart(ctx);
    (controller as any).registry.upsert(createRun({
      id: "run-array",
      kind: "workflow",
      status: "completed",
      artifactPath,
      launchRef: { runId: "run-array", asyncId: "run-array", resultPath },
      recentEvents: [],
    }));

    await expect(controller.getRunResult("run-array")).resolves.toBe("Artifact fallback");
  });

  test("prefers aggregate result text over first child artifact for group runs", async () => {
    const { api } = createPi();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lazy-subagents-controller-"));
    const firstArtifactPath = path.join(tempDir, "output-0.log");
    const resultPath = path.join(tempDir, "group-result.json");
    await fs.writeFile(firstArtifactPath, "Only present in first child artifact", "utf8");
    await fs.writeFile(resultPath, JSON.stringify({
      id: "group-1",
      runId: "group-1",
      results: [
        { stepId: "reuse", output: "Reuse review only" },
        { stepId: "quality", output: "Quality review complete" },
        { stepId: "efficiency", output: "Efficiency review complete" },
      ],
    }), "utf8");

    const controller = new LazySubagentsController(api as any, { launcher: new FakeLauncher(), createRunId: () => "ignored", now: () => 210 });
    const { ctx } = createContext({ isIdle: true, hasPendingMessages: false });

    await controller.handleSessionStart(ctx);
    (controller as any).registry.upsert(createRun({
      id: "group-1",
      kind: "group",
      status: "completed",
      artifactPath: firstArtifactPath,
      launchRef: { runId: "group-1", asyncId: "group-1", resultPath },
      recentEvents: [],
    }));

    const result = await controller.getRunResult("group-1");
    expect(result).toContain("[reuse]\nReuse review only");
    expect(result).toContain("[quality]\nQuality review complete");
    expect(result).toContain("[efficiency]\nEfficiency review complete");
    expect(result).not.toContain("Only present in first child artifact");
  });

  test("prefers step errors when a step output is blank", async () => {
    const { api } = createPi();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lazy-subagents-controller-"));
    const resultPath = path.join(tempDir, "run-blank.json");
    await fs.writeFile(resultPath, JSON.stringify({
      id: "run-blank",
      runId: "run-blank",
      results: [{ stepId: "plan", output: "   ", error: "plan step failed" }],
    }), "utf8");

    const controller = new LazySubagentsController(api as any, { launcher: new FakeLauncher(), createRunId: () => "ignored", now: () => 210 });
    const { ctx } = createContext({ isIdle: true, hasPendingMessages: false });

    await controller.handleSessionStart(ctx);
    (controller as any).registry.upsert(createRun({
      id: "run-blank",
      kind: "workflow",
      status: "failed",
      launchRef: { runId: "run-blank", asyncId: "run-blank", resultPath },
      recentEvents: [],
    }));

    await expect(controller.getRunResult("run-blank")).resolves.toBe("[plan]\nplan step failed");
  });

  test("supports result retrieval, pickup injection, cancel, and clear control actions", async () => {
    const { api, messages, userMessages } = createPi();
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lazy-subagents-controller-"));
    const artifactPath = path.join(tempDir, "run-1-output.log");
    const resultPath = path.join(tempDir, "run-1-result.json");
    await fs.writeFile(artifactPath, "Full reviewer result", "utf8");
    await fs.writeFile(resultPath, JSON.stringify({
      id: "run-1",
      runId: "run-1",
      results: [{ stepId: "review", output: "Structured reviewer result" }],
    }), "utf8");
    const launcher = new FakeLauncher();
    launcher.launchResults.set("run-1", { resultPath });
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
    const pickupMessage = userMessages.find((entry) => typeof entry.content === "string" && entry.content.includes("Lazy subagent result"));
    expect(pickupMessage?.content).toContain("Full reviewer result");
    const completionWake = hiddenCompletionMessages(messages).find((entry) => typeof entry.message.content === "string" && entry.message.content.includes("[DONE] Review auth diff"));
    expect(completionWake?.message.content).toContain("Full reviewer result");
    expect(completionWake?.message.content).not.toContain("Structured reviewer result");

    expect(await controller.cancelRun("run-1")).toBe(false);

    expect(controller.clearRuns()).toBe(1);
    expect(controller.getSnapshot().runs).toHaveLength(0);
  });
});

describe("continueChild", () => {
  test("rejects missing target", async () => {
    const { api } = createPi();
    const launcher = new FakeLauncher();
    const controller = new LazySubagentsController(api as any, { launcher, createRunId: () => "run-1", now: () => 100 });
    const { ctx } = createContext();

    await controller.handleSessionStart(ctx);

    await expect(controller.continueChild("nonexistent", "Continue prompt", "title", ctx))
      .rejects.toThrow("No run found for target");
  });

  test("rejects group and workflow targets", async () => {
    const { api } = createPi();
    const launcher = new FakeLauncher();
    const controller = new LazySubagentsController(api as any, { launcher, createRunId: () => "ignored", now: () => 100 });
    const { ctx } = createContext();

    const registry = new RunRegistry();
    registry.upsert(createRun({ id: "grp-1", kind: "group", status: "completed", completedAt: 50, launchRef: { runId: "grp-1", asyncId: "grp-1", asyncDir: "/tmp/grp-1" } }));
    registry.upsert(createRun({ id: "wf-1", kind: "workflow", status: "completed", completedAt: 50, launchRef: { runId: "wf-1", asyncId: "wf-1", asyncDir: "/tmp/wf-1" } }));
    const persisted = createPersistedState(registry.serialize(), 10);
    await controller.handleSessionStart({ ...ctx, sessionManager: { ...ctx.sessionManager, getBranch: () => [{ type: "custom", customType: PERSISTED_STATE_ENTRY, data: persisted }] } });

    await expect(controller.continueChild("grp-1", "p", "t", ctx))
      .rejects.toThrow("Cannot continue group runs");
    await expect(controller.continueChild("wf-1", "p", "t", ctx))
      .rejects.toThrow("Cannot continue workflow runs");
  });

  test("rejects active runs", async () => {
    const { api } = createPi();
    const launcher = new FakeLauncher();
    const controller = new LazySubagentsController(api as any, { launcher, createRunId: () => "run-1", now: () => 100 });
    const { ctx } = createContext();

    await controller.handleSessionStart(ctx);
    await controller.launchChild({ agent: "reviewer", title: "t", taskSummary: "t", prompt: "p" }, ctx);

    // Run is queued, so continue should be rejected
    await expect(controller.continueChild("run-1", "Continue", "title", ctx))
      .rejects.toThrow("Cannot continue active run");
  });

  test("continues paused single runs", async () => {
    const tempDir = await createTempDir(path.join(os.tmpdir(), "pi-lazy-subagents-cont-"));
    const asyncDir = path.join(tempDir, "async");
    await fs.mkdir(asyncDir, { recursive: true });
    const sessionFile = path.join(asyncDir, "session-0", "session.jsonl");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, "{}", "utf8");

    const { api } = createPi();
    const launcher = new FakeLauncher();
    const controller = new LazySubagentsController(api as any, { launcher, createRunId: () => "ignored", now: () => 200 });
    const { ctx } = createContext();

    const registry = new RunRegistry();
    registry.upsert(createRun({
      id: "paused-1",
      status: "paused",
      completedAt: 50,
      sessionFile,
      launchRef: { runId: "paused-1", asyncId: "paused-1", asyncDir },
    }));

    const persisted = createPersistedState(registry.serialize(), 100);
    await controller.handleSessionStart({ ...ctx, sessionManager: { ...ctx.sessionManager, getBranch: () => [{ type: "custom", customType: PERSISTED_STATE_ENTRY, data: persisted }] } });

    const run = await controller.continueChild("paused-1", "Keep going", "title", ctx);

    expect(run.status).toBe("queued");
    expect(launcher.continueLaunches).toHaveLength(1);
    expect(launcher.continueLaunches[0]?.sessionFile).toBe(sessionFile);
  });

  test("rejects archived runs", async () => {
    const { api } = createPi();
    const launcher = new FakeLauncher();
    const controller = new LazySubagentsController(api as any, { launcher, createRunId: () => "ignored", now: () => 200 });
    const { ctx } = createContext();

    const registry = new RunRegistry();
    const run = createRun({ id: "arc-1", status: "completed", completedAt: 50, archived: true, launchRef: { runId: "arc-1", asyncId: "arc-1", asyncDir: "/tmp/arc-1" } });
    registry.upsert(run);

    const persisted = createPersistedState(registry.serialize(), 10);
    await controller.handleSessionStart({ ...ctx, sessionManager: { ...ctx.sessionManager, getBranch: () => [{ type: "custom", customType: PERSISTED_STATE_ENTRY, data: persisted }] } });

    await expect(controller.continueChild("arc-1", "p", "t", ctx))
      .rejects.toThrow("Cannot continue archived run");
  });

  test("rejects cancelled and failed runs", async () => {
    const { api } = createPi();
    const launcher = new FakeLauncher();
    const controller = new LazySubagentsController(api as any, { launcher, createRunId: () => "ignored", now: () => 200 });
    const { ctx } = createContext();

    const registry = new RunRegistry();
    registry.upsert(createRun({ id: "can-1", status: "cancelled", completedAt: 50, launchRef: { runId: "can-1", asyncId: "can-1", asyncDir: "/tmp/can-1" } }));
    registry.upsert(createRun({ id: "fail-1", status: "failed", completedAt: 50, launchRef: { runId: "fail-1", asyncId: "fail-1", asyncDir: "/tmp/fail-1" } }));

    const persisted = createPersistedState(registry.serialize(), 10);
    await controller.handleSessionStart({ ...ctx, sessionManager: { ...ctx.sessionManager, getBranch: () => [{ type: "custom", customType: PERSISTED_STATE_ENTRY, data: persisted }] } });

    await expect(controller.continueChild("can-1", "p", "t", ctx))
      .rejects.toThrow("Cannot continue cancelled run");
    await expect(controller.continueChild("fail-1", "p", "t", ctx))
      .rejects.toThrow("Cannot continue failed run");
  });

  test("drops named runs after lease expiry so they cannot be continued", async () => {
    const { api } = createPi();
    const launcher = new FakeLauncher();
    const controller = new LazySubagentsController(api as any, { launcher, createRunId: () => "ignored", now: () => 5000 });
    const { ctx } = createContext();

    const registry = new RunRegistry();
    registry.upsert(createRun({
      id: "named-1",
      name: "my-agent",
      status: "completed",
      completedAt: 100,
      leaseExpiry: 1000,
      launchRef: { runId: "named-1", asyncId: "named-1", asyncDir: "/tmp/named-1" },
      sessionFile: "/tmp/named-1/session.jsonl",
    }));

    const persisted = createPersistedState(registry.serialize(), 100);
    await controller.handleSessionStart({ ...ctx, sessionManager: { ...ctx.sessionManager, getBranch: () => [{ type: "custom", customType: PERSISTED_STATE_ENTRY, data: persisted }] } });

    // Lease expired at 1000, now is 5000.
    await expect(controller.continueChild("my-agent", "p", "t", ctx))
      .rejects.toThrow("No run found for target: my-agent");
    await expect(controller.continueChild("named-1", "p", "t", ctx))
      .rejects.toThrow("No run found for target: named-1");
  });

  test("continues a completed single run by id", async () => {
    const tempDir = await createTempDir(path.join(os.tmpdir(), "pi-lazy-subagents-cont-"));
    const asyncDir = path.join(tempDir, "async");
    await fs.mkdir(asyncDir, { recursive: true });
    const sessionFile = path.join(asyncDir, "session-0", "session.jsonl");
    const artifactPath = path.join(asyncDir, "artifact.md");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, "{}", "utf8");
    await fs.writeFile(artifactPath, "Previous artifact", "utf8");

    const { api } = createPi();
    const launcher = new FakeLauncher();
    const controller = new LazySubagentsController(api as any, { launcher, createRunId: () => "ignored", now: () => 200 });
    const { ctx } = createContext();

    const registry = new RunRegistry();
    registry.upsert(createRun({
      id: "run-cont-1",
      status: "completed",
      completedAt: 50,
      toolCount: 12,
      sessionFile,
      artifactPath,
      launchRef: { runId: "run-cont-1", asyncId: "run-cont-1", asyncDir },
    }));

    const persisted = createPersistedState(registry.serialize(), 100);
    await controller.handleSessionStart({ ...ctx, sessionManager: { ...ctx.sessionManager, getBranch: () => [{ type: "custom", customType: PERSISTED_STATE_ENTRY, data: persisted }] } });

    const run = await controller.continueChild("run-cont-1", "Keep going", "title", ctx);

    expect(run.status).toBe("queued");
    expect(run.title).toBe("title");
    expect(run.taskSummary).toBe("title");
    expect(run.completedAt).toBeUndefined();
    expect(run.toolCount).toBeUndefined();
    expect(run.sessionFile).toBe(sessionFile);
    expect(run.artifactPath).toBe(artifactPath);
    expect(run.launchRef?.sessionFile).toBe(sessionFile);
    expect(run.launchRef?.artifactPath).toBe(artifactPath);
    expect(launcher.continueLaunches).toHaveLength(1);
    expect(launcher.continueLaunches[0]?.prompt).toBe("Keep going");
    expect(launcher.continueLaunches[0]?.sessionFile).toBe(sessionFile);
  });

  test("continues a named run by name", async () => {
    const tempDir = await createTempDir(path.join(os.tmpdir(), "pi-lazy-subagents-cont-"));
    const asyncDir = path.join(tempDir, "async");
    await fs.mkdir(asyncDir, { recursive: true });
    const sessionFile = path.join(asyncDir, "session-0", "session.jsonl");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, "{}", "utf8");

    const { api } = createPi();
    const launcher = new FakeLauncher();
    const controller = new LazySubagentsController(api as any, { launcher, createRunId: () => "ignored", now: () => 200 });
    const { ctx } = createContext();

    const registry = new RunRegistry();
    registry.upsert(createRun({
      id: "run-cont-2",
      name: "my-reviewer",
      status: "completed",
      completedAt: 50,
      leaseExpiry: 10000,
      sessionFile,
      launchRef: { runId: "run-cont-2", asyncId: "run-cont-2", asyncDir },
    }));

    const persisted = createPersistedState(registry.serialize(), 100);
    await controller.handleSessionStart({ ...ctx, sessionManager: { ...ctx.sessionManager, getBranch: () => [{ type: "custom", customType: PERSISTED_STATE_ENTRY, data: persisted }] } });

    const run = await controller.continueChild("my-reviewer", "Keep going", "title", ctx);

    expect(run.status).toBe("queued");
    expect(launcher.continueLaunches).toHaveLength(1);
    expect(launcher.continueLaunches[0]?.sessionFile).toBe(sessionFile);
  });

  test("renews lease on continue", async () => {
    const tempDir = await createTempDir(path.join(os.tmpdir(), "pi-lazy-subagents-cont-"));
    const asyncDir = path.join(tempDir, "async");
    await fs.mkdir(asyncDir, { recursive: true });
    const sessionFile = path.join(asyncDir, "session-0", "session.jsonl");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, "{}", "utf8");

    const { api } = createPi();
    const launcher = new FakeLauncher();
    const now = 200;
    const controller = new LazySubagentsController(api as any, { launcher, createRunId: () => "ignored", now: () => now });
    const { ctx } = createContext();

    const oldLeaseExpiry = 1000;
    const registry = new RunRegistry();
    registry.upsert(createRun({
      id: "run-cont-lease",
      name: "leased-agent",
      status: "completed",
      completedAt: 50,
      leaseExpiry: oldLeaseExpiry,
      sessionFile,
      launchRef: { runId: "run-cont-lease", asyncId: "run-cont-lease", asyncDir },
    }));

    const persisted = createPersistedState(registry.serialize(), 100);
    await controller.handleSessionStart({ ...ctx, sessionManager: { ...ctx.sessionManager, getBranch: () => [{ type: "custom", customType: PERSISTED_STATE_ENTRY, data: persisted }] } });

    const run = await controller.continueChild("leased-agent", "Keep going", "title", ctx);

    // New lease should be based on the now timestamp + DEFAULT_NAMED_RUN_LEASE_MS
    expect(run.leaseExpiry).toBeGreaterThan(oldLeaseExpiry);
    expect(run.leaseExpiry).toBe(now + DEFAULT_NAMED_RUN_LEASE_MS);
  });

  test("emits launch message and persists state on continue", async () => {
    const tempDir = await createTempDir(path.join(os.tmpdir(), "pi-lazy-subagents-cont-"));
    const asyncDir = path.join(tempDir, "async");
    await fs.mkdir(asyncDir, { recursive: true });
    const sessionFile = path.join(asyncDir, "session-0", "session.jsonl");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, "{}", "utf8");

    const { api, messages, entries } = createPi();
    const launcher = new FakeLauncher();
    const controller = new LazySubagentsController(api as any, { launcher, createRunId: () => "ignored", now: () => 200 });
    const { ctx } = createContext();

    const registry = new RunRegistry();
    registry.upsert(createRun({
      id: "run-cont-emit",
      status: "completed",
      completedAt: 50,
      sessionFile,
      launchRef: { runId: "run-cont-emit", asyncId: "run-cont-emit", asyncDir },
    }));

    const persisted = createPersistedState(registry.serialize(), 100);
    await controller.handleSessionStart({ ...ctx, sessionManager: { ...ctx.sessionManager, getBranch: () => [{ type: "custom", customType: PERSISTED_STATE_ENTRY, data: persisted }] } });

    // Clear messages from session start
    const messageCountBefore = messages.length;
    const entryCountBefore = entries.length;

    await controller.continueChild("run-cont-emit", "Keep going", "title", ctx);

    expect(messages.length).toBeGreaterThan(messageCountBefore);
    expect(messages[messageCountBefore]?.message.customType).toBe(MESSAGE_TYPE_LAUNCH);
    expect(entries.length).toBeGreaterThan(entryCountBefore);
    expect(entries.some((entry) => entry.customType === PERSISTED_STATE_ENTRY)).toBe(true);
  });

  test("logs but does not roll back a continued run when post-launch UI rendering fails", async () => {
    const tempDir = await createTempDir(path.join(os.tmpdir(), "pi-lazy-subagents-cont-"));
    const asyncDir = path.join(tempDir, "async");
    await fs.mkdir(asyncDir, { recursive: true });
    const sessionFile = path.join(asyncDir, "session-0", "session.jsonl");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, "{}", "utf8");

    const { api, entries } = createPi();
    const launcher = new FakeLauncher();
    const controller = new LazySubagentsController(api as any, { launcher, createRunId: () => "ignored", now: () => 200 });
    const { ctx } = createContext();

    const registry = new RunRegistry();
    registry.upsert(createRun({
      id: "run-cont-ui-fail",
      status: "completed",
      completedAt: 50,
      sessionFile,
      launchRef: { runId: "run-cont-ui-fail", asyncId: "run-cont-ui-fail", asyncDir },
    }));

    const persisted = createPersistedState(registry.serialize(), 100);
    await controller.handleSessionStart({ ...ctx, sessionManager: { ...ctx.sessionManager, getBranch: () => [{ type: "custom", customType: PERSISTED_STATE_ENTRY, data: persisted }] } });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let shouldThrow = true;
    ctx.ui.setStatus = () => {
      if (!shouldThrow) return;
      shouldThrow = false;
      throw new Error("ui boom");
    };

    try {
      const run = await controller.continueChild("run-cont-ui-fail", "Keep going", "title", ctx);

      expect(run.status).toBe("queued");
      expect(entries.some((entry) => entry.customType === PERSISTED_STATE_ENTRY)).toBe(true);
      expect(warnSpy).toHaveBeenCalledWith("[pi-lazy-subagents] failed to emit continuation launch UI state:", expect.any(Error));
    } finally {
      warnSpy.mockRestore();
    }

    const run = controller.getSnapshot().runs.find((r: RunRecord) => r.id === "run-cont-ui-fail");
    expect(run?.status).toBe("queued");
    expect(run?.title).toBe("title");
    expect(run?.sessionFile).toBe(sessionFile);
    expect(run?.launchRef?.sessionFile).toBe(sessionFile);
  });

  test("reverts run to previous state on launcher failure", async () => {
    const tempDir = await createTempDir(path.join(os.tmpdir(), "pi-lazy-subagents-cont-"));
    const asyncDir = path.join(tempDir, "async");
    await fs.mkdir(asyncDir, { recursive: true });
    const sessionFile = path.join(asyncDir, "session-0", "session.jsonl");
    const artifactPath = path.join(asyncDir, "artifact.md");
    await fs.mkdir(path.dirname(sessionFile), { recursive: true });
    await fs.writeFile(sessionFile, "{}", "utf8");
    await fs.writeFile(artifactPath, "Previous artifact", "utf8");

    const { api } = createPi();
    const launcher = new FakeLauncher();
    launcher.continueError = new Error("launcher boom");
    const controller = new LazySubagentsController(api as any, { launcher, createRunId: () => "ignored", now: () => 200 });
    const { ctx } = createContext();

    const registry = new RunRegistry();
    registry.upsert(createRun({
      id: "run-cont-revert",
      title: "Old title",
      taskSummary: "Old task",
      status: "completed",
      completedAt: 50,
      resultPreview: "Old result",
      sessionFile,
      artifactPath,
      launchRef: { runId: "run-cont-revert", asyncId: "run-cont-revert", asyncDir, sessionFile, artifactPath },
    }));

    const persisted = createPersistedState(registry.serialize(), 100);
    await controller.handleSessionStart({ ...ctx, sessionManager: { ...ctx.sessionManager, getBranch: () => [{ type: "custom", customType: PERSISTED_STATE_ENTRY, data: persisted }] } });

    await expect(controller.continueChild("run-cont-revert", "Keep going", "title", ctx))
      .rejects.toThrow("launcher boom");

    // Run should be back to completed state
    const run = controller.getSnapshot().runs.find((r: RunRecord) => r.id === "run-cont-revert");
    expect(run?.title).toBe("Old title");
    expect(run?.taskSummary).toBe("Old task");
    expect(run?.status).toBe("completed");
    expect(run?.resultPreview).toBe("Old result");
    expect(run?.sessionFile).toBe(sessionFile);
    expect(run?.artifactPath).toBe(artifactPath);
    expect(run?.launchRef?.sessionFile).toBe(sessionFile);
    expect(run?.launchRef?.artifactPath).toBe(artifactPath);
  });
});

describe("visibility helpers (shouldKeepRunVisibleInUi)", () => {
  const { shouldKeepRunVisibleInUi } = __testHooks;

  const defaultOpts = { isPinned: false, isAcknowledged: false, now: 1000 };

  test("non-terminal runs are always visible", () => {
    expect(shouldKeepRunVisibleInUi(createRun({ id: "r1", status: "running" }), defaultOpts)).toBe(true);
    expect(shouldKeepRunVisibleInUi(createRun({ id: "r2", status: "queued" }), defaultOpts)).toBe(true);
    expect(shouldKeepRunVisibleInUi(createRun({ id: "r3", status: "blocked" }), defaultOpts)).toBe(true);
    expect(shouldKeepRunVisibleInUi(createRun({ id: "r4", status: "paused" }), defaultOpts)).toBe(true);
  });

  test("pinned runs are visible until they complete successfully", () => {
    expect(shouldKeepRunVisibleInUi(
      createRun({ id: "r1", status: "running", completedAt: undefined }),
      { isPinned: true, isAcknowledged: true, now: 100_000 },
    )).toBe(true);
    expect(shouldKeepRunVisibleInUi(
      createRun({ id: "r2", status: "completed", completedAt: 500 }),
      { isPinned: true, isAcknowledged: true, now: 100_000 },
    )).toBe(false);
  });

  test("failed and paused runs are visible even when acknowledged", () => {
    expect(shouldKeepRunVisibleInUi(
      createRun({ id: "r1", status: "failed", completedAt: 500 }),
      { ...defaultOpts, isAcknowledged: true },
    )).toBe(true);
    expect(shouldKeepRunVisibleInUi(
      createRun({ id: "r2", status: "paused", completedAt: 500 }),
      { ...defaultOpts, isAcknowledged: true },
    )).toBe(true);
  });

  test("archived terminal runs are never visible", () => {
    for (const run of [
      createRun({ id: "r1", status: "completed", completedAt: 500, archived: true }),
      createRun({ id: "r2", status: "completed", completedAt: 500, archived: true, attentionNeeded: true }),
      createRun({ id: "r3", status: "failed", completedAt: 500, archived: true }),
    ]) {
      expect(shouldKeepRunVisibleInUi(run, { ...defaultOpts, isPinned: true, now: 600 })).toBe(false);
    }
  });

  test("unnamed completed runs are hidden when acknowledged", () => {
    expect(shouldKeepRunVisibleInUi(
      createRun({ id: "r1", status: "completed", completedAt: 500 }),
      { ...defaultOpts, isAcknowledged: true, now: 600 },
    )).toBe(false);
  });

  test("unnamed completed runs are visible during grace period", () => {
    expect(shouldKeepRunVisibleInUi(
      createRun({ id: "r1", status: "completed", completedAt: 1000 }),
      { ...defaultOpts, now: 1001 },
    )).toBe(true);
    // Just past the 30s grace window.
    expect(shouldKeepRunVisibleInUi(
      createRun({ id: "r2", status: "completed", completedAt: 1000 }),
      { ...defaultOpts, now: 1000 + 30_001 },
    )).toBe(false);
  });

  test("named completed runs follow normal completion UI visibility while their lease remains resumable", () => {
    const run = createRun({
      id: "r1",
      status: "completed",
      completedAt: 500,
      name: "my-agent",
      leaseExpiry: 2000,
    });
    expect(shouldKeepRunVisibleInUi(run, { isPinned: false, isAcknowledged: true, now: 1500 })).toBe(false);
    expect(shouldKeepRunVisibleInUi(run, { isPinned: false, isAcknowledged: false, now: 1500 })).toBe(true);
    expect(shouldKeepRunVisibleInUi(run, { isPinned: false, isAcknowledged: false, now: 30_501 })).toBe(false);
  });

  test("named completed runs are hidden immediately after lease expiry", () => {
    const run = createRun({
      id: "r1",
      status: "completed",
      completedAt: 500,
      name: "my-agent",
      leaseExpiry: 1000,
    });
    expect(shouldKeepRunVisibleInUi(run, { isPinned: false, isAcknowledged: false, now: 31_000 })).toBe(false);
  });

  test("named completed runs with derived leases still hide when acknowledged", () => {
    const run = createRun({
      id: "r1",
      status: "completed",
      completedAt: 500,
      name: "my-agent",
      leaseExpiry: undefined,
    });
    expect(shouldKeepRunVisibleInUi(run, { isPinned: false, isAcknowledged: true, now: 500 + DEFAULT_NAMED_RUN_LEASE_MS })).toBe(false);
  });

  test("named completed runs past lease expiry are hidden when acknowledged", () => {
    const run = createRun({
      id: "r1",
      status: "completed",
      completedAt: 500,
      name: "my-agent",
      leaseExpiry: 1000,
    });
    expect(shouldKeepRunVisibleInUi(run, { isPinned: false, isAcknowledged: true, now: 1500 })).toBe(false);
  });

  test("attention-needed terminal runs are always visible", () => {
    expect(shouldKeepRunVisibleInUi(
      createRun({ id: "r1", status: "completed", completedAt: 500, attentionNeeded: true }),
      { ...defaultOpts, isAcknowledged: true, now: 100_000 },
    )).toBe(true);
  });

  test("named skipped runs behave same as completed for visibility", () => {
    const run = createRun({
      id: "r1",
      status: "skipped",
      completedAt: 500,
      name: "my-agent",
      leaseExpiry: 2000,
    });
    expect(shouldKeepRunVisibleInUi(run, { isPinned: false, isAcknowledged: true, now: 1500 })).toBe(false);
    expect(shouldKeepRunVisibleInUi(run, { isPinned: false, isAcknowledged: false, now: 1500 })).toBe(true);
    expect(shouldKeepRunVisibleInUi(run, { isPinned: false, isAcknowledged: false, now: 30_501 })).toBe(false);
  });
});
