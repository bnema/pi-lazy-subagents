import { describe, expect, test } from "vitest";

import lazySubagentsExtension from "../extensions/index.js";
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
    expect(guidance).toContain("Use action=workflow for dependent pipelines");
    expect(guidance).toContain("Do not use notify_only for review subagents");
    expect(guidance).toContain("wake_if_idle");
    expect(guidance).toContain("pin");
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
