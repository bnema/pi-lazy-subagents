import { describe, expect, test } from "vitest";

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
  GLYPH_INBOX,
  GLYPH_LAZY_SUBAGENTS,
  GLYPH_PINNED,
  GLYPH_RUNNING,
  GLYPH_WAITING,
} from "../src/ui/glyphs.js";
import { buildWidgetLines } from "../src/ui/widget.js";
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
    completionPolicy: overrides.completionPolicy ?? "follow_up_when_idle",
    sessionFile: overrides.sessionFile,
    artifactPath: overrides.artifactPath,
    resultPreview: overrides.resultPreview,
    errorPreview: overrides.errorPreview,
    model: overrides.model,
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

    expect(lines[0]).toContain(`<${GLYPH_LAZY_SUBAGENTS}>`);
    expect(lines[0]).toContain("lazy subagents");
    expect(lines[0]).toContain("1 live");
    expect(lines[0]).not.toContain("2 live");
    expect(lines[0]).toContain("attention");
    expect(lines[0]).toContain("inbox");
    expect(lines[1]).toContain(`<${GLYPH_WAITING}>`);
    expect(lines[1]).toContain("waiting");
    expect(lines[1]).toContain("Needs human input");
    expect(lines[1]).toContain("quiet 8s");
    expect(lines[2]).toContain(`<${GLYPH_RUNNING}>`);
    expect(lines[2]).toContain("live");
    expect(lines[2]).toContain("Research auth flow");
    expect(lines[2]).toContain("read");
    expect(lines[2]).toContain("3 tools");
    expect(lines[2]).toContain("1.2k");
    expect(lines[2]).not.toContain("upd ");
    expect(lines[3]).toContain(`<${GLYPH_INBOX}>`);
    expect(lines[3]).toContain("inbox");
    expect(lines[3]).toContain("Plan done");
    expect(lines[3]).toContain("done 2s ago");
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
});
