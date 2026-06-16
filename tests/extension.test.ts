import { describe, expect, test } from "vitest";

import lazySubagentsExtension, { buildDefaultParallelTitle } from "../extensions/index.js";
import {
  MESSAGE_TYPE_ATTENTION,
  MESSAGE_TYPE_COMPLETION,
  MESSAGE_TYPE_FAILURE,
  MESSAGE_TYPE_LAUNCH,
  STATUS_KEY,
  TOOL_NAME,
  WIDGET_KEY,
} from "../src/defaults.js";

function createPi() {
  const commands: Array<{ name: string; options: any }> = [];
  const tools: Array<any> = [];
  const events = new Map<string, Array<Function>>();
  const renderers: Array<string> = [];

  return {
    commands,
    tools,
    renderers,
    events,
    api: {
      on: (event: string, handler: Function) => {
        const handlers = events.get(event) ?? [];
        handlers.push(handler);
        events.set(event, handlers);
      },
      registerCommand: (name: string, options: any) => {
        commands.push({ name, options });
      },
      registerTool: (tool: any) => {
        tools.push(tool);
      },
      registerMessageRenderer: (customType: string, _renderer: any) => {
        renderers.push(customType);
      },
      sendMessage: () => {},
      appendEntry: () => {},
    },
  };
}

describe("extension entrypoint", () => {
  test("registers session hooks, renderers, the tool, and the slash command", () => {
    const { api, commands, tools, renderers, events } = createPi();

    lazySubagentsExtension(api as any);

    expect(commands.map((entry) => entry.name)).toContain("lazy-subagents");
    expect(tools.map((entry) => entry.name)).toContain(TOOL_NAME);
    expect(renderers).toEqual(expect.arrayContaining([
      MESSAGE_TYPE_LAUNCH,
      MESSAGE_TYPE_COMPLETION,
      MESSAGE_TYPE_FAILURE,
      MESSAGE_TYPE_ATTENTION,
    ]));
    expect(events.has("session_start")).toBe(true);
    expect(events.has("session_tree")).toBe(true);
    expect(events.has("session_shutdown")).toBe(true);
    expect(events.has("turn_start")).toBe(true);
    expect(events.has("turn_end")).toBe(true);
  });

  test("tool guidance exposes help, list guidance, automatic completion signaling, and anti-polling guidance", () => {
    const { api, tools } = createPi();
    lazySubagentsExtension(api as any);

    const tool = tools.find((entry) => entry.name === TOOL_NAME);

    const guidance = tool?.promptGuidelines.join("\n") ?? "";

    expect(tool?.description).toContain("completion/attention signals");
    expect(tool?.promptSnippet).toContain("asynchronously");
    expect(guidance).toContain("action=list");
    expect(guidance).toContain("action=run defaults to delegate");
    expect(guidance).toContain("action=parallel");
    expect(guidance).toContain("action=workflow");
    expect(guidance).toContain("do not call wait or status right away");
    expect(guidance).toContain("Use action=wait only");
    expect(guidance).toContain("Do not poll");
    expect(guidance).toContain("60s");
    expect(guidance).toContain("action=result");
    expect(guidance).toContain("action=stop");
    expect(guidance).toContain("resumable");
    expect(guidance).toContain("Use action=workflow for dependent pipelines");
    expect(guidance).toContain("Subagents always report terminal results back to the main agent");
    expect(guidance).not.toContain("notify_only");
    expect(guidance).toContain("pin");
  });

  test("tool schema exposes name parameter for named run addressing and continue", () => {
    const { api, tools } = createPi();
    lazySubagentsExtension(api as any);

    const tool = tools.find((entry) => entry.name === TOOL_NAME);
    expect(tool).toBeDefined();

    // Verify the tool params schema exposes the name field
    expect(tool.parameters.properties).toHaveProperty("name");

    // Verify the prompt guidelines mention named runs and continue
    const guidance = tool?.promptGuidelines.join("\n") ?? "";
    expect(guidance).toContain("action=run name=<name>");
    expect(guidance).toContain("follow-up via action=continue");
    expect(guidance).toContain("action=continue target=<name|runId>");
  });

  test("builds default parallel titles from child task summaries", () => {
    expect(buildDefaultParallelTitle([
      { prompt: "Inspect the package layout", taskSummary: "Inspect layout" },
      { prompt: "Review the auth diff", taskSummary: "Review auth" },
      { prompt: "Run focused tests", taskSummary: "Verify tests" },
    ])).toBe("Inspect layout + Review auth + 1 more");
    expect(buildDefaultParallelTitle([
      { prompt: "Inspect the package layout" },
      { prompt: "Review the auth diff" },
    ])).toBe("Inspect the package layout + Review the auth diff");
  });

  test("tool stop action returns error when run not found", async () => {
    const { api, tools } = createPi();
    lazySubagentsExtension(api as any);

    const tool = tools.find((entry) => entry.name === TOOL_NAME);
    const ctx = { cwd: process.cwd(), hasUI: false };

    const result = await tool.execute("tool-stop", {
      action: "stop",
      runId: "run-1",
    }, new AbortController().signal, () => undefined, ctx);

    expect(result.content[0].text).toContain("Could not stop run-1.");
  });

  test("tool rejects names on group and workflow runs", async () => {
    const { api, tools } = createPi();
    lazySubagentsExtension(api as any);

    const tool = tools.find((entry) => entry.name === TOOL_NAME);
    const ctx = { cwd: process.cwd(), hasUI: false };

    const parallelResult = await tool.execute("tool-1", {
      action: "parallel",
      name: "review-group",
      children: [{ agent: "reviewer", prompt: "Review it" }],
    }, new AbortController().signal, () => undefined, ctx);
    expect(parallelResult.content[0].text).toContain("name is only supported for action=run");

    const workflowResult = await tool.execute("tool-2", {
      action: "workflow",
      name: "review-workflow",
      steps: [{ id: "review", agent: "reviewer", prompt: "Review it" }],
    }, new AbortController().signal, () => undefined, ctx);
    expect(workflowResult.content[0].text).toContain("workflow runs cannot be continued by name");
  });

  test("tool renderer shows wait progress details in the active tool row", () => {
    const { api, tools } = createPi();
    lazySubagentsExtension(api as any);

    const tool = tools.find((entry) => entry.name === TOOL_NAME);
    const theme = {
      fg: (color: string, text: string) => `<${color}:${text}>`,
      bold: (text: string) => `*${text}*`,
    };

    const call = tool.renderCall({ action: "wait", runId: "abcdef12-3456" }, theme).render(160).join("\n");
    expect(call).toContain("lazy_subagents");
    expect(call).toContain("wait");
    expect(call).toContain("abcdef12");

    const rendered = tool.renderResult({
      content: [{ type: "text", text: "fallback" }],
      details: {
        kind: "wait-progress",
        runId: "run-1",
        status: "running",
        lines: [" Review auth diff", "reviewer · running", "  tool start · read · /repo/src/auth.ts"],
      },
    }, { expanded: false }, theme).render(160).join("\n");

    expect(rendered).toContain("Review auth diff");
    expect(rendered).toContain("reviewer · running");
    expect(rendered).toContain("tool start");
  });

  test("tool renderer keeps recent compact progress lines and ignores malformed progress details", () => {
    const { api, tools } = createPi();
    lazySubagentsExtension(api as any);

    const tool = tools.find((entry) => entry.name === TOOL_NAME);
    const theme = {
      fg: (color: string, text: string) => `<${color}:${text}>`,
      bold: (text: string) => `*${text}*`,
    };
    const lines = [
      " Review auth diff",
      "reviewer · running",
      ...Array.from({ length: 10 }, (_, index) => `detail-${index}`),
      "detail-newest",
    ];

    const rendered = tool.renderResult({
      content: [{ type: "text", text: "fallback" }],
      details: { kind: "wait-progress", lines },
    }, { expanded: false }, theme).render(160).join("\n");

    expect(rendered).toContain("Review auth diff");
    expect(rendered).toContain("reviewer · running");
    expect(rendered).not.toContain("detail-0");
    expect(rendered).toContain("detail-newest");

    const malformed = tool.renderResult({
      content: [{ type: "text", text: "fallback" }],
      details: { kind: "wait-progress", lines: [42] },
    }, { expanded: false }, theme).render(160).join("\n");

    expect(malformed).toContain("fallback");
  });

  test("clears footer and widget state on shutdown", async () => {
    const { api, events } = createPi();
    lazySubagentsExtension(api as any);

    const statuses: Array<[string, string | undefined]> = [];
    const widgets: Array<[string, string[] | undefined]> = [];
    const theme = {
      fg: (_color: string, text: string) => text,
      dim: (text: string) => text,
      muted: (text: string) => text,
      bold: (text: string) => text,
      bg: (_color: string, text: string) => text,
    };
    const ctx = {
      hasUI: true,
      ui: {
        theme,
        setStatus: (key: string, value: string | undefined) => statuses.push([key, value]),
        setWidget: (key: string, value: string[] | ((tui: unknown, themeArg: typeof theme) => { render(width: number): string[] }) | undefined) => {
          if (typeof value === "function") {
            widgets.push([key, value({}, theme).render(160)]);
            return;
          }
          widgets.push([key, value]);
        },
      },
    };

    const shutdownHandlers = events.get("session_shutdown") ?? [];
    await Promise.all(shutdownHandlers.map((handler) => handler({}, ctx)));

    expect(statuses).toContainEqual([STATUS_KEY, undefined]);
    expect(widgets).toContainEqual([WIDGET_KEY, undefined]);
  });
});
