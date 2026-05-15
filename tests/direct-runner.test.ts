import { describe, expect, test } from "vitest";

// @ts-expect-error direct-runner is a plain .mjs script and exports this helper for runtime tests.
import { createSerialLineProcessor } from "../src/launcher/direct-runner.mjs";

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
});
