import { describe, expect, test } from "vitest";

import {
  buildResultSummary,
  createSerialLineProcessor,
  getReadyWorkflowStepIds,
  parseStructuredStepOutput,
  renderWorkflowPrompt,
  runWorkflowStepWithRetries,
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

  test("renders workflow prompts from prior step summaries, outputs, and structured fields", () => {
    const rendered = renderWorkflowPrompt(
      "Research summary: {{research.summary}}\n\nResearch output:\n{{research.output}}\n\nJSON:\n{{research.json}}\n\nTitle: {{research.structured.title}}",
      {
        research: {
          summary: "Found the best extension seam in controller.ts",
          output: "Detailed workflow findings go here.",
          structuredOutput: { title: "Controller refactor", severity: "high" },
        },
      },
    );

    expect(rendered).toBe(
      "Research summary: Found the best extension seam in controller.ts\n\nResearch output:\nDetailed workflow findings go here.\n\nJSON:\n{\"title\":\"Controller refactor\",\"severity\":\"high\"}\n\nTitle: Controller refactor",
    );
  });

  test("parses structured JSON step outputs when json mode is requested", () => {
    expect(parseStructuredStepOutput('{"summary":"done","next":"implement"}', "json")).toEqual({
      summary: "done",
      next: "implement",
    });
  });

  test("rejects invalid structured JSON outputs", () => {
    expect(() => parseStructuredStepOutput("", "json")).toThrow("Expected a JSON object response");
    expect(() => parseStructuredStepOutput("[]", "json")).toThrow("Expected a JSON object response");
  });

  test("retries a workflow step until an attempt succeeds", async () => {
    let attempts = 0;

    const result = await runWorkflowStepWithRetries({
      maxAttempts: 3,
      executeAttempt: async () => {
        attempts += 1;
        if (attempts < 2) {
          throw new Error("transient failure");
        }
        return { success: true, output: "DONE" };
      },
    });

    expect(attempts).toBe(2);
    expect(result).toMatchObject({
      attemptCount: 2,
      finalResult: { success: true, output: "DONE" },
    });
  });

  test("stops retrying on non-retryable workflow failures", async () => {
    let attempts = 0;

    await expect(runWorkflowStepWithRetries({
      maxAttempts: 3,
      executeAttempt: async () => {
        attempts += 1;
        throw Object.assign(new Error("prompt resolution failed"), { nonRetryable: true });
      },
    })).rejects.toThrow("prompt resolution failed");

    expect(attempts).toBe(1);
  });

  test("throws when a workflow prompt references an unknown step id", () => {
    expect(() => renderWorkflowPrompt("{{missing.summary}}", {})).toThrow("Unknown workflow step reference: missing");
  });

  test("builds per-child result summaries instead of truncating the combined first output", () => {
    const summary = buildResultSummary([
      { stepId: "reuse", output: "Reuse finding ".repeat(80), success: true },
      { stepId: "quality", output: "Quality finding about duplicated assertions", success: true },
      { stepId: "efficiency", error: "Efficiency reviewer failed", success: false },
    ]);

    expect(summary).toContain("reuse: Reuse finding");
    expect(summary).toContain("quality: Quality finding about duplicated assertions");
    expect(summary).toContain("efficiency: Efficiency reviewer failed");
    expect(summary.indexOf("reuse:")).toBeLessThan(summary.indexOf("quality:"));
    expect(summary.indexOf("quality:")).toBeLessThan(summary.indexOf("efficiency:"));
  });

  test("selects ready workflow steps from dependency-complete pending work", () => {
    const ready = getReadyWorkflowStepIds([
      { id: "research", status: "completed" },
      { id: "plan", status: "pending", dependsOn: ["research"] },
      { id: "docs", status: "pending", dependsOn: ["research"] },
      { id: "review", status: "pending", dependsOn: ["plan"] },
      { id: "verify", status: "running" },
    ], 3);

    expect(ready).toEqual(["plan", "docs"]);
  });
});
