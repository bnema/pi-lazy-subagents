import { describe, expect, test } from "vitest";

import {
  createSerialLineProcessor,
  shouldPersistEvent,
  shouldWriteStatusForUsageTotal,
} from "../src/launcher/direct-runner.mjs";

describe("direct runner stdout processing", () => {
  test("processes stdout lines serially in arrival order", async () => {
    const seen: string[] = [];
    const processor = createSerialLineProcessor(async (line: string) => {
      if (line === "message_end") {
        await new Promise((resolve) => setTimeout(resolve, 15));
      }
      seen.push(line);
    });

    processor.enqueue(["message_end", "turn_end"]);
    await processor.flush();

    expect(seen).toEqual(["message_end", "turn_end"]);
  });

  test("continues processing later lines after a per-line failure", async () => {
    const seen: string[] = [];
    const errors: Array<{ message: string; line?: string }> = [];
    const processor = createSerialLineProcessor(
      async (line: string) => {
        if (line === "bad") throw new Error("boom");
        seen.push(line);
      },
      (error: unknown, context?: { line?: string }) => {
        errors.push({
          message: error instanceof Error ? error.message : String(error),
          line: context?.line,
        });
      },
    );

    processor.enqueue(["first", "bad", "turn_end"]);
    await processor.flush();

    expect(seen).toEqual(["first", "turn_end"]);
    expect(errors).toEqual([{ message: "boom", line: "bad" }]);
  });

  test("drops streaming message updates from persisted event logs", () => {
    expect(shouldPersistEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta" } })).toBe(false);
    expect(shouldPersistEvent({ type: "tool_execution_start", toolName: "bash" })).toBe(true);
    expect(shouldPersistEvent({ type: "message_end", message: { role: "assistant" } })).toBe(true);
  });

  test("skips status writes for zero or unchanged token totals", () => {
    expect(shouldWriteStatusForUsageTotal(undefined, 0)).toBe(false);
    expect(shouldWriteStatusForUsageTotal(31_316, 31_316)).toBe(false);
    expect(shouldWriteStatusForUsageTotal(31_316, 31_317)).toBe(true);
  });
});
