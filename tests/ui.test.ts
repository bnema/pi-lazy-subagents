import { describe, expect, test, vi } from "vitest";

import { __testHooks } from "../src/orchestration/controller.js";
import { buildFooterStatus } from "../src/ui/status.js";
import {
  createCompletionMessagePayload,
  createFailureMessagePayload,
  createLaunchMessagePayload,
  formatRunMessageBody,
  registerRunMessageRenderers,
  renderRunMessageText,
} from "../src/ui/messages.js";
import {
  GLYPH_LAZY_SUBAGENTS,
  GLYPH_PINNED,
} from "../src/ui/glyphs.js";
import { buildLiveRunViewModel } from "../src/ui/live-run-view-model.js";
import { buildWidgetLines, createWidgetContent } from "../src/ui/widget.js";
import { MESSAGE_TYPE_PIN } from "../src/defaults.js";
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
    completionPolicy: overrides.completionPolicy ?? "wake_if_idle",
    sessionFile: overrides.sessionFile,
    artifactPath: overrides.artifactPath,
    resultPreview: overrides.resultPreview,
    errorPreview: overrides.errorPreview,
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

describe("visibility helpers", () => {
  test("builds a compact footer summary without duplicating live run details", () => {
    const running = createRun({ id: "run-1", status: "running", startedAt: 30_000, updatedAt: 59_000, title: "Research auth flow" });
    (running as any).currentTool = "bash";
    (running as any).totalTokens = 126_400;
    const blocked = createRun({ id: "run-2", status: "blocked", updatedAt: 58_000, title: "Needs human input", attentionNeeded: true });
    const paused = createRun({ id: "run-4", status: "paused", updatedAt: 58_500, title: "Paused by user", attentionNeeded: true });
    const completed = createRun({ id: "run-3", status: "completed", updatedAt: 57_000, completedAt: 57_000, agent: "planner" });
    const snapshot = createSnapshot([running, blocked, paused, completed]);

    const status = buildFooterStatus(snapshot, {
      fg: (_color: string, text: string) => `<${text}>`,
      bold: (text: string) => `*${text}*`,
    } as any);

    expect(status).toContain(`<${GLYPH_LAZY_SUBAGENTS}>`);
    expect(status).toContain("lazy");
    expect(status).toContain("1 live");
    expect(status).not.toContain("2 live");
    expect(status).not.toContain("3 live");
    expect(status).toContain("attention");
    expect(status).toContain("inbox");
    expect(status).not.toContain("Needs human input");
    expect(status).not.toContain("quiet 2s");
    expect(status).not.toContain("126k");
  });

  test("builds grouped widget lines with summary, actionable rows, and inbox compression", () => {
    const running = createRun({ id: "run-1", status: "running", startedAt: 50_000, updatedAt: 59_000, title: "Research auth flow" });
    (running as any).currentTool = "read";
    (running as any).toolCount = 3;
    (running as any).totalTokens = 1_240;
    const blocked = createRun({ id: "run-2", status: "blocked", startedAt: 45_000, updatedAt: 52_000, title: "Needs human input", attentionNeeded: true });
    const completed = createRun({ id: "run-3", status: "completed", updatedAt: 58_000, completedAt: 58_000, title: "Plan done", agent: "planner", resultPreview: "Found 3 files" });
    const snapshot = createSnapshot([running, blocked, completed]);

    const lines = buildWidgetLines(snapshot, 60_000, 6, {
      fg: (_color: string, text: string) => `<${text}>`,
      dim: (text: string) => `(${text})`,
      muted: (text: string) => `{${text}}`,
      bold: (text: string) => `*${text}*`,
    } as any);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain(`<${GLYPH_LAZY_SUBAGENTS}>`);
    expect(lines[0]).toContain("Lazy");
    expect(lines[0]).toContain("running");
    expect(lines[0]).not.toContain("1 running");
    expect(lines[0]).not.toContain("2 running");
    expect(lines[0]).toContain("attention");
    expect(lines[0]).toContain("inbox");
    expect(lines[0]).toContain("Needs human input");
  });

  test("renders persistent Lazy widget as one compact running row", () => {
    const running = createRun({
      id: "run-1",
      status: "running",
      startedAt: 50_000,
      updatedAt: 59_000,
      title: "Research auth flow",
    });
    const snapshot = createSnapshot([running]);

    const lines = buildWidgetLines(snapshot, 60_000, 6, {
      fg: (_color: string, text: string) => `<${text}>`,
      dim: (text: string) => `(${text})`,
      muted: (text: string) => `{${text}}`,
      bold: (text: string) => `*${text}*`,
    } as any);
    const content = createWidgetContent(snapshot, 60_000, 6);
    const rendered = content?.({} as any, {
      fg: (_color: string, text: string) => `<${text}>`,
      dim: (text: string) => `(${text})`,
      muted: (text: string) => `{${text}}`,
      bold: (text: string) => `*${text}*`,
    } as any).render(160) ?? [];

    expect(lines).toHaveLength(1);
    expect(rendered).toHaveLength(1);
    expect(lines[0]).toContain(`<${GLYPH_LAZY_SUBAGENTS}>`);
    expect(lines[0]).toContain("Lazy");
    expect(lines[0]).toContain("│");
    expect(lines[0]).toContain("running");
    expect(lines[0]).not.toContain("1 running");
    expect(lines[0]).toContain("Research auth flow");
    expect(lines[0]).not.toContain("lazy subagents");
    expect(lines[0]).not.toContain("live");
  });

  test("includes a running count only when multiple runs are running", () => {
    const first = createRun({ id: "run-1", status: "running", title: "Review auth diff" });
    const second = createRun({ id: "run-2", status: "running", title: "Trace login bug", updatedAt: 2 });
    const snapshot = createSnapshot([first, second]);

    const lines = buildWidgetLines(snapshot, 60_000, 6);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("2 running");
  });

  test("keeps queued runs as focus text without counting them as running", () => {
    const queued = createRun({
      id: "run-queued",
      status: "queued",
      startedAt: 50_000,
      updatedAt: 59_000,
      title: "Queued review",
    });
    const snapshot = createSnapshot([queued]);

    const lines = buildWidgetLines(snapshot, 60_000, 6);

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Lazy");
    expect(lines[0]).toContain("Queued review");
    expect(lines[0]).not.toContain("running");
  });

  test("animates running dots and disposes the widget timer", () => {
    vi.useFakeTimers();
    try {
      const running = createRun({
        id: "run-1",
        status: "running",
        startedAt: 50_000,
        updatedAt: 59_000,
        title: "Research auth flow",
      });
      const snapshot = createSnapshot([running]);
      const requestRender = vi.fn();
      const component = createWidgetContent(snapshot, 60_000, 6)?.({ requestRender }, {
        fg: (_color: string, text: string) => text,
        dim: (text: string) => text,
        muted: (text: string) => text,
        bold: (text: string) => text,
      } as any);

      expect(component).toBeDefined();
      const firstRender = component!.render(160).join("\n");
      vi.advanceTimersByTime(450);
      expect(requestRender).toHaveBeenCalledTimes(1);
      const secondRender = component!.render(160).join("\n");
      expect(secondRender).not.toBe(firstRender);
      expect(secondRender).toContain("running.");

      component!.dispose?.();
      requestRender.mockClear();
      vi.advanceTimersByTime(900);
      expect(requestRender).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  test("renders a pinned panel above the compact Lazy row with five latest rail-prefixed progress lines", () => {
    const pinned = createRun({
      id: "run-pin",
      status: "running",
      startedAt: 50_000,
      updatedAt: 59_000,
      title: "Review auth diff",
      recentEvents: [
        { id: "event-1", category: "progress", timestamp: 1, summary: "oldest progress", status: "running" },
        { id: "event-2", category: "progress", timestamp: 2, summary: "scan auth routes", status: "running" },
        { id: "event-3", category: "progress", timestamp: 3, summary: "inspect token flow", status: "running" },
        { id: "event-4", category: "progress", timestamp: 4, summary: "compare session handling", status: "running" },
        { id: "event-5", category: "progress", timestamp: 5, summary: "write review notes", status: "running" },
      ],
    });
    (pinned as any).toolCount = 7;
    (pinned as any).totalTokens = 12_400;
    const snapshot = createSnapshot([pinned]);

    const lines = buildWidgetLines(snapshot, 60_000, 8, undefined, { isPinned: (runId) => runId === "run-pin" });

    expect(lines[0]).toBe("│ oldest progress");
    expect(lines[1]).toBe("│ scan auth routes");
    expect(lines[2]).toBe("│ inspect token flow");
    expect(lines[3]).toBe("│ compare session handling");
    expect(lines[4]).toBe("│ write review notes");
    expect(lines.filter((line) => line.startsWith("│ "))).toHaveLength(5);
    expect(lines.join("\n")).not.toContain("Review auth diff");
    expect(lines[5]).toContain(GLYPH_LAZY_SUBAGENTS);
    expect(lines[5]).toContain("Lazy");
    expect(lines[5]).toContain("running");
    expect(lines[5]).toContain("7 tools");
    expect(lines[5]).toContain("12k tok");
    expect(lines[5]).not.toContain("Review auth diff");
    expect(lines[5]).not.toContain("1 running");
  });

  test("renders one detailed pinned panel plus a compact more pinned indicator for multiple pinned runs", () => {
    const firstPinned = createRun({
      id: "run-pin-1",
      status: "running",
      startedAt: 50_000,
      updatedAt: 59_000,
      title: "Review auth diff",
      recentEvents: [
        { id: "event-1", category: "progress", timestamp: 1, summary: "inspect diff", status: "running" },
        { id: "event-2", category: "progress", timestamp: 2, summary: "draft findings", status: "running" },
      ],
    });
    const secondPinned = createRun({
      id: "run-pin-2",
      status: "running",
      startedAt: 51_000,
      updatedAt: 58_000,
      title: "Trace login bug",
    });
    const thirdPinned = createRun({
      id: "run-pin-3",
      status: "running",
      startedAt: 52_000,
      updatedAt: 57_000,
      title: "Audit settings copy",
    });
    const snapshot = createSnapshot([firstPinned, secondPinned, thirdPinned]);

    const lines = buildWidgetLines(snapshot, 60_000, 8, undefined, { isPinned: (runId) => runId.startsWith("run-pin-") });
    const text = lines.join("\n");

    expect(lines[0]).toBe("│ inspect diff");
    expect(lines[1]).toBe("│ draft findings");
    expect(text).not.toContain("Review auth diff");
    expect(text).toContain("2 more");
    expect(text).not.toContain("2 more pinned");
    expect(text).not.toContain("Trace login bug");
    expect(text).not.toContain("Audit settings copy");
    expect(lines.at(-1)).toContain(GLYPH_LAZY_SUBAGENTS);
  });

  test("formats launch, completion, and failure message payloads", () => {
    const running = createRun({ id: "run-1", status: "queued", title: "Research auth flow", taskSummary: "Research auth flow" });
    const completed = createRun({ id: "run-2", status: "completed", title: "Plan auth flow", resultPreview: "Found 3 files", completedAt: 90 });
    (completed as any).totalTokens = 247_000;
    const failed = createRun({ id: "run-3", status: "failed", title: "Implement auth flow", errorPreview: "worker failed" });

    const launch = createLaunchMessagePayload(running);
    const completion = createCompletionMessagePayload(completed);
    const failure = createFailureMessagePayload(failed);

    expect(formatRunMessageBody(launch, false)).toContain("Launched");
    expect(formatRunMessageBody(launch, false)).toContain("/lazy-subagents status run-1");
    expect(formatRunMessageBody(completion, false)).toContain("247k tokens");
    expect(formatRunMessageBody(completion, false)).toContain("Found 3 files");
    expect(formatRunMessageBody(completion, true)).toContain("/lazy-subagents result run-2");
    expect(formatRunMessageBody(failure, true)).toContain("worker failed");
  });

  test("renders launch cards without duplicate copy and with clearer queued context", () => {
    const launch = createLaunchMessagePayload(createRun({
      id: "run-9",
      status: "queued",
      agent: "reviewer",
      model: "(openai-codex) gpt-5.4 • xhigh",
      title: "Narrow dumber audio-shutdown review",
      taskSummary: "Narrow dumber audio-shutdown review",
    }));

    const text = renderRunMessageText(launch, false);

    expect(text).toContain("[QUEUED]");
    expect(text).toContain("agent reviewer");
    expect(text).toContain("run run-9");
    expect(text).toContain("model (openai-codex) gpt-5.4 • xhigh");
    expect(text).toContain("/lazy-subagents status run-9");
    expect(text.match(/Narrow dumber audio-shutdown review/g)?.length).toBe(1);
  });

  test("builds compact and expanded live run view model lines", () => {
    const run = createRun({
      id: "run-42",
      agent: "reviewer",
      title: "Review auth diff",
      status: "running",
      currentTool: "read",
      toolCount: 2,
      model: "(openai-codex) gpt-5.4 • xhigh",
    });
    run.currentTool = "read";
    run.toolCount = 2;
    run.totalTokens = 6_079;

    const compact = buildLiveRunViewModel(run, {
      progressLines: [
        "tool start · read · /repo/src/auth.ts",
        "assistant · first progress line",
        "assistant · latest progress line",
      ],
      progressStats: { turnCount: 2, lastTurnTokens: 4_321 },
      expanded: false,
    });

    expect(compact.lines.join("\n")).toContain(`${GLYPH_PINNED} Review auth diff`);
    expect(compact.lines.join("\n")).toContain("reviewer · running · 2 turns · last 4.3k tok · read · 2 tools · 6.1k tokens");
    expect(compact.lines.join("\n")).toContain("model (openai-codex) gpt-5.4 • xhigh");
    expect(compact.lines.join("\n")).not.toContain("run run-42");
    expect(compact.lines.join("\n")).toContain("assistant · latest progress line");

    const expanded = buildLiveRunViewModel(run, {
      progressLines: compact.detailLines,
      progressStats: { turnCount: 2, lastTurnTokens: 4_321 },
      expanded: true,
    });

    expect(expanded.lines.join("\n")).toContain("run run-42");
  });

  test("builds live run view model fallback detail lines from recent events", () => {
    const run = createRun({
      id: "run-events",
      title: "Review auth diff",
      status: "blocked",
      recentEvents: [
        { id: "event-1", category: "progress", timestamp: 10, summary: "\n  Working on auth diff  ", status: "running" },
      ],
    });

    const view = buildLiveRunViewModel(run, { expanded: false });

    expect(view.lines.join("\n")).toContain("Working on auth diff");
  });

  test("renders pinned run messages from the latest getter output instead of freezing a snapshot", () => {
    const renderers = new Map<string, Function>();
    let lines = [
      `${GLYPH_PINNED} Review auth diff`,
      "reviewer · running · read · 2 tools · 6.1k tokens",
      "model (openai-codex) gpt-5.4 • xhigh",
      "  tool start · read · /repo/src/auth.ts",
      "  assistant · first progress line",
    ];

    registerRunMessageRenderers({
      registerMessageRenderer: (customType: string, renderer: Function) => {
        renderers.set(customType, renderer);
      },
    } as any, {
      getPinnedRunLines: () => lines,
    });

    const renderer = renderers.get(MESSAGE_TYPE_PIN)!;
    const component = renderer({ content: "Pinned lazy subagent", details: { runId: "run-1" } }, { expanded: false }, {
      fg: (color: string, text: string) => `<${color}:${text}>`,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => `*${text}*`,
    });

    const firstRender = component.render(160).join("\n");
    expect(firstRender).toContain("<accent:[PINNED]>");
    expect(firstRender).toContain("*Review auth diff*");
    expect(firstRender).toContain("<accent:RUNNING>");
    expect(firstRender).toContain("<dim:progress>");
    expect(firstRender).toContain("first progress line");

    lines = [
      `${GLYPH_PINNED} Review auth diff`,
      "reviewer · running · read · 2 tools · 6.1k tokens",
      "model (openai-codex) gpt-5.4 • xhigh",
      "  tool start · read · /repo/src/auth.ts",
      "  assistant · updated progress line",
    ];
    expect(component.render(160).join("\n")).toContain("updated progress line");
  });

  test("renders pinned messages without a theme using the live pinned content", () => {
    const renderers = new Map<string, Function>();
    let lines = [`${GLYPH_PINNED} Review auth diff`, "reviewer · running", "  live detail"];

    registerRunMessageRenderers({
      registerMessageRenderer: (customType: string, renderer: Function) => {
        renderers.set(customType, renderer);
      },
    } as any, {
      getPinnedRunLines: () => lines,
    });

    const renderer = renderers.get(MESSAGE_TYPE_PIN)!;
    const component = renderer({ content: "Pinned lazy subagent", details: { runId: "run-1" } }, { expanded: false }, undefined);

    expect(component.render(160).join("\n")).toContain("live detail");
    lines = [`${GLYPH_PINNED} Review auth diff`, "reviewer · running", "  updated detail"];
    expect(component.render(160).join("\n")).toContain("updated detail");
  });

  test("renders prefixed pinned detail lines without duplicating the step marker", () => {
    const renderers = new Map<string, Function>();
    const lines = [
      `${GLYPH_PINNED} Review auth diff`,
      "reviewer · failed",
      "  #2 · error · repeated step",
      "  #3 · still waiting",
    ];

    registerRunMessageRenderers({
      registerMessageRenderer: (customType: string, renderer: Function) => {
        renderers.set(customType, renderer);
      },
    } as any, {
      getPinnedRunLines: () => lines,
    });

    const renderer = renderers.get(MESSAGE_TYPE_PIN)!;
    const component = renderer({ content: "Pinned lazy subagent", details: { runId: "run-1" } }, { expanded: false }, {
      fg: (color: string, text: string) => `<${color}:${text}>`,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => `*${text}*`,
    });

    const rendered = component.render(160).join("\n");
    expect(rendered.match(/#2/g)?.length).toBe(1);
    expect(rendered.match(/#3/g)?.length).toBe(1);
  });

  test("renders pinned meta lines safely when status is missing", () => {
    const renderers = new Map<string, Function>();
    const lines = [`${GLYPH_PINNED} Review auth diff`, "reviewer"];

    registerRunMessageRenderers({
      registerMessageRenderer: (customType: string, renderer: Function) => {
        renderers.set(customType, renderer);
      },
    } as any, {
      getPinnedRunLines: () => lines,
    });

    const renderer = renderers.get(MESSAGE_TYPE_PIN)!;
    const component = renderer({ content: "Pinned lazy subagent", details: { runId: "run-1" } }, { expanded: false }, {
      fg: (color: string, text: string) => `<${color}:${text}>`,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => `*${text}*`,
    });

    const rendered = component.render(160).join("\n");
    expect(rendered).toContain("<dim:agent>");
    expect(rendered).toContain("*reviewer*");
  });

  test("does not treat non-step hash headings as pinned step prefixes", () => {
    const renderers = new Map<string, Function>();
    const lines = [`${GLYPH_PINNED} Review auth diff`, "reviewer · running", "  # Overview"];

    registerRunMessageRenderers({
      registerMessageRenderer: (customType: string, renderer: Function) => {
        renderers.set(customType, renderer);
      },
    } as any, {
      getPinnedRunLines: () => lines,
    });

    const renderer = renderers.get(MESSAGE_TYPE_PIN)!;
    const component = renderer({ content: "Pinned lazy subagent", details: { runId: "run-1" } }, { expanded: false }, {
      fg: (color: string, text: string) => `<${color}:${text}>`,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => `*${text}*`,
    });

    const rendered = component.render(160).join("\n");
    expect(rendered.match(/# Overview/g)?.length).toBe(1);
  });

  test("tolerates malformed runtime message previews", () => {
    const malformed = {
      kind: "completion",
      run: createRun({ id: "run-9", status: "completed" }),
      summary: 42 as unknown as string,
      preview: { nope: true } as unknown as string,
    };

    expect(formatRunMessageBody(malformed as any, false)).toBe("42");
    expect(formatRunMessageBody(malformed as any, true)).toBe("42");
  });

  test("named completed run uses completion visibility instead of lease visibility", () => {
    const namedCompleted = createRun({
      id: "named-1",
      status: "completed",
      name: "diff-reviewer",
      leaseExpiry: 100_000,
      completedAt: 50_000,
    });

    expect(__testHooks.shouldKeepRunVisibleInUi(namedCompleted, {
      isPinned: false,
      isAcknowledged: true,
      now: 60_000,
    })).toBe(false);

    expect(__testHooks.shouldKeepRunVisibleInUi(namedCompleted, {
      isPinned: false,
      isAcknowledged: false,
      now: 60_000,
    })).toBe(true);

    expect(__testHooks.shouldKeepRunVisibleInUi(namedCompleted, {
      isPinned: false,
      isAcknowledged: false,
      now: 90_001,
    })).toBe(false);
  });

  test("named completed run hides immediately after lease expiry", () => {
    const namedCompleted = createRun({
      id: "named-2",
      status: "completed",
      name: "old-reviewer",
      leaseExpiry: 100_000,
      completedAt: 95_000,
    });

    // At time 130_000 (after lease expiry, acknowledged)
    expect(__testHooks.shouldKeepRunVisibleInUi(namedCompleted, {
      isPinned: false,
      isAcknowledged: true,
      now: 130_000,
    })).toBe(false);

    // At time 130_000 (after lease expiry, unacknowledged, past grace window)
    expect(__testHooks.shouldKeepRunVisibleInUi(namedCompleted, {
      isPinned: false,
      isAcknowledged: false,
      now: 130_000,
    })).toBe(false);

    // Past the normal completion grace window, named runs are no longer visible.
    expect(__testHooks.shouldKeepRunVisibleInUi(namedCompleted, {
      isPinned: false,
      isAcknowledged: false,
      now: 130_000,
    })).toBe(false);
  });

  test("archived terminal runs are never visible", () => {
    const archived = createRun({
      id: "archived-1",
      status: "completed",
      name: "old-reviewer",
      archived: true,
      completedAt: 50_000,
    });

    // Non-pinned archived runs are hidden
    expect(__testHooks.shouldKeepRunVisibleInUi(archived, {
      isPinned: false,
      isAcknowledged: false,
      now: 60_000,
    })).toBe(false);

    // Archive wins over pinned terminal visibility.
    expect(__testHooks.shouldKeepRunVisibleInUi(archived, {
      isPinned: true,
      isAcknowledged: false,
      now: 60_000,
    })).toBe(false);
  });

  test("active runs are always visible regardless of name or lease", () => {
    const active = createRun({
      id: "active-1",
      status: "running",
      name: "busy-reviewer",
      leaseExpiry: 100,
    });

    expect(__testHooks.shouldKeepRunVisibleInUi(active, {
      isPinned: false,
      isAcknowledged: true,
      now: 200,
    })).toBe(true);
  });

  test("failed, paused, and attention-needed runs are always visible", () => {
    const failed = createRun({ id: "fail-1", status: "failed", completedAt: 10 });
    const paused = createRun({ id: "paused-1", status: "paused" });
    const attention = createRun({ id: "attn-1", status: "completed", attentionNeeded: true, completedAt: 10 });

    for (const run of [failed, paused, attention]) {
      expect(__testHooks.shouldKeepRunVisibleInUi(run, {
        isPinned: false,
        isAcknowledged: true,
        now: 100_000,
      })).toBe(true);
    }
  });

  test("footer status renders a raw snapshot with archived and expired runs present", () => {
    // createSnapshot does not apply controller visibility filtering; this test
    // only verifies the footer renderer handles a mixed raw snapshot.
    const running = createRun({ id: "run-1", status: "running", startedAt: 30_000, updatedAt: 59_000 });
    (running as any).currentTool = "bash";
    const archived = createRun({ id: "arch-1", status: "completed", name: "old", archived: true, completedAt: 50_000 });
    const expiredNamed = createRun({ id: "named-1", status: "completed", name: "stale", leaseExpiry: 60_000, completedAt: 40_000 });
    const completedUnnamed = createRun({ id: "comp-1", status: "completed", completedAt: 58_000 });

    const snapshot = createSnapshot([running, archived, expiredNamed, completedUnnamed]);

    const status = buildFooterStatus(snapshot, {
      fg: (_color: string, text: string) => `<${text}>`,
      bold: (text: string) => `*${text}*`,
    } as any);

    // The archived and expired named runs are still in the raw snapshot
    // because createSnapshot doesn't filter. But buildFooterStatus uses
    // the full snapshot. In practice, getLiveUiSnapshot filters first.
    // We test the shouldKeepRunVisibleInUi filtering directly above.
    // Here we just verify the footer renders with all runs.
    expect(status).toContain("lazy");
    expect(status).toContain("1 live");
    expect(status).toContain("3 inbox");
  });

  test("widget builds without archived and expired named runs via filtered snapshot", () => {
    const now = 100_000;
    const active = createRun({ id: "run-1", status: "running", startedAt: 80_000, updatedAt: 99_000 });
    (active as any).currentTool = "read";
    (active as any).toolCount = 1;
    const namedWithinLease = createRun({
      id: "named-1",
      status: "completed",
      agent: "reviewer",
      name: "diff-reviewer",
      leaseExpiry: 150_000,
      completedAt: 60_000,
      title: "Review auth diff",
    });
    const expiredNamed = createRun({
      id: "named-2",
      status: "completed",
      name: "stale-reviewer",
      leaseExpiry: 50_000,
      completedAt: 30_000,
      title: "Old review",
    });
    const archived = createRun({
      id: "arch-1",
      status: "completed",
      name: "deleted",
      archived: true,
      completedAt: 10_000,
      title: "Deleted",
    });

    // Simulate getLiveUiSnapshot filtering: keep only visible runs
    const allRuns = [active, namedWithinLease, expiredNamed, archived];
    const visibleRuns = allRuns.filter((run) => __testHooks.shouldKeepRunVisibleInUi(run, {
      isPinned: false,
      isAcknowledged: run.id === "named-2" || run.id === "arch-1",
      now,
    }));

    const snapshot = createSnapshot(visibleRuns);

    // Should only show active runs; named completed leases preserve resumability, not inbox visibility.
    expect(visibleRuns.map((r) => r.id)).toEqual(["run-1"]);

    // Widget should still build
    const lines = buildWidgetLines(snapshot, now, 6, {
      fg: (_color: string, text: string) => `<${text}>`,
      dim: (text: string) => `(${text})`,
      muted: (text: string) => `{${text}}`,
      bold: (text: string) => `*${text}*`,
    } as any);

    expect(lines[0]).toContain("Lazy");
    expect(lines[0]).toContain("running");
    expect(lines[0]).not.toContain("1 running");
    // expiredNamed and archived should NOT appear
    expect(lines.join("\n")).not.toContain("stale-reviewer");
    expect(lines.join("\n")).not.toContain("Old review");
    expect(lines.join("\n")).not.toContain("Deleted");
  });
});
