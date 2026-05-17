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

    expect(tool?.description).toContain("completion or attention");
    expect(tool?.promptSnippet).toContain("wait for completion/attention signals");
    expect(guidance).toContain("action=help");
    expect(guidance).toContain("action=list");
    expect(guidance).toContain("list the sub agents and pick the appropriate one");
    expect(guidance).toContain("action=parallel with children=[...]");
    expect(guidance).toContain("two or more independent tasks");
    expect(guidance).toContain("action=run for a single background child");
    expect(guidance).toContain("delegate");
    expect(guidance).toContain("emitted back into the same session automatically");
    expect(guidance).toContain("call action=wait once");
    expect(guidance).toContain("Do not call action=status in a loop");
    expect(guidance).toContain("60 seconds");
    expect(guidance).toContain("action=pin");
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
