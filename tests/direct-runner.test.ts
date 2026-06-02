import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "vitest";

import {
  aggregateFanOutGroupResult,
  buildPiArgs,
  buildResultSummary,
  createSerialLineProcessor,
  evaluateWorkflowCondition,
  expandFanOutWorkflowStep,
  getDependencyBlockedSkip,
  getReadyWorkflowStepIds,
  parseStructuredStepOutput,
  renderWorkflowPrompt,
  renderWorkflowTemplate,
  resolveCompletedSessionFile,
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

  test("falls back to the continued session file when no newer child session file is discovered", async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lazy-subagents-session-file-"));
    const continuedSessionFile = path.join(sessionDir, "continued.jsonl");

    expect(await resolveCompletedSessionFile(sessionDir, continuedSessionFile)).toBe(continuedSessionFile);
  });

  test("prefers the latest child session file over the provided continuation file", async () => {
    const sessionDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-lazy-subagents-session-file-"));
    const oldSessionFile = path.join(sessionDir, "old.jsonl");
    const latestSessionFile = path.join(sessionDir, "latest.jsonl");
    const continuedSessionFile = path.join(sessionDir, "continued.jsonl");
    await fs.writeFile(oldSessionFile, "old", "utf8");
    await fs.writeFile(latestSessionFile, "latest", "utf8");
    await fs.utimes(oldSessionFile, new Date(1_000), new Date(1_000));
    await fs.utimes(latestSessionFile, new Date(2_000), new Date(2_000));

    expect(await resolveCompletedSessionFile(sessionDir, continuedSessionFile)).toBe(latestSessionFile);
  });

  test("continuation pi args preserve profile flags", () => {
    const args = buildPiArgs({
      sessionDir: "/tmp/session-dir",
      prompt: "Continue review",
      resolvedModel: "openai/gpt-5.4",
      resolvedThinking: "xhigh",
      profile: {
        tools: ["read", "bash"],
        inheritProjectContext: false,
        inheritSkills: false,
        systemPrompt: "Review carefully.",
        systemPromptMode: "append",
      },
    }, undefined, "/tmp/session.jsonl");

    expect(args).toEqual([
      "--mode", "json",
      "--session", "/tmp/session.jsonl",
      "--model", "openai/gpt-5.4",
      "--thinking", "xhigh",
      "--tools", "read,bash",
      "--no-context-files",
      "--no-skills",
      "--append-system-prompt", "Review carefully.",
      "Continue review",
    ]);
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

  test("parses fenced JSON object outputs when json mode is requested", () => {
    expect(parseStructuredStepOutput('Analysis complete.\n\n```json\n{"summary":"done","next":"implement"}\n```', "json")).toEqual({
      summary: "done",
      next: "implement",
    });
  });

  test("parses embedded JSON object outputs when json mode is requested", () => {
    expect(parseStructuredStepOutput('Here is the result:\n{"summary":"done","nested":{"ok":true}}\nUse it downstream.', "json")).toEqual({
      summary: "done",
      nested: { ok: true },
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

  test("treats skipped workflow steps as terminal but not dependency-complete", () => {
    const ready = getReadyWorkflowStepIds([
      { id: "triage", status: "completed" },
      { id: "security", status: "skipped", dependsOn: ["triage"] },
      { id: "aggregate", status: "pending", dependsOn: ["security"] },
      { id: "docs", status: "pending", dependsOn: ["triage"] },
    ], 2);

    expect(ready).toEqual(["docs"]);
  });

  test("keeps dependency-blocked skips successful when the blocker was also skipped", () => {
    expect(getDependencyBlockedSkip(
      { dependsOn: ["review"] },
      new Set(),
      new Set(["review"]),
    )).toEqual({
      reason: "Skipped because a dependency was skipped.",
      success: true,
    });
  });

  test("marks dependency-blocked skips failed when the blocker failed", () => {
    expect(getDependencyBlockedSkip(
      { dependsOn: ["review"] },
      new Set(["review"]),
      new Set(),
    )).toEqual({
      reason: "Skipped because a dependency did not complete.",
      success: false,
    });
  });

  test("evaluates workflow when expressions from structured upstream results", () => {
    const results = {
      triage: {
        summary: "Review only security",
        output: "",
        structuredOutput: {
          runSecurity: true,
          runFrontend: false,
          selected: ["security"],
        },
      },
    };

    expect(evaluateWorkflowCondition("{{triage.structured.runSecurity}}", results)).toBe(true);
    expect(evaluateWorkflowCondition("{{triage.structured.runFrontend}}", results)).toBe(false);
    expect(evaluateWorkflowCondition("{{triage.structured.selected}}", results)).toBe(true);
  });

  test("renders item templates for dynamic fan-out steps", () => {
    const rendered = renderWorkflowTemplate(
      "Agent {{item.agent}} handles {{item.scope}} after {{triage.summary}}",
      {
        triage: { summary: "triaged", output: "", structuredOutput: {} },
      },
      { agent: "reviewer", scope: "security" },
    );

    expect(rendered).toBe("Agent reviewer handles security after triaged");
  });

  test("expands fanOutFrom workflow steps from upstream structured arrays", () => {
    const expansions = expandFanOutWorkflowStep(
      {
        id: "review",
        agent: "{{item.agent}}",
        taskSummary: "{{item.summary}}",
        prompt: "Review {{item.scope}} using {{triage.json}}",
        dependsOn: ["triage"],
        fanOutFrom: { step: "triage", path: "structured.reviewers", idField: "id", maxItems: 3 },
      },
      {
        triage: {
          summary: "triaged",
          output: "",
          structuredOutput: {
            reviewers: [
              { id: "security", agent: "reviewer", summary: "Security review", scope: "security" },
              { id: "tests", agent: "reviewer", summary: "Test review", scope: "tests" },
            ],
          },
        },
      },
    );

    expect(expansions).toEqual([
      expect.objectContaining({ id: "review[security]", agent: "reviewer", taskSummary: "Security review" }),
      expect.objectContaining({ id: "review[tests]", agent: "reviewer", taskSummary: "Test review" }),
    ]);
    expect(expansions[0].prompt).toContain("Review security using");
  });

  test("returns no fan-out expansions when maxItems is zero", () => {
    const expansions = expandFanOutWorkflowStep(
      {
        id: "review",
        agent: "reviewer",
        taskSummary: "Review",
        prompt: "Review",
        fanOutFrom: { step: "triage", path: "structured.reviewers", maxItems: 0 },
      },
      { triage: { structuredOutput: { reviewers: [{ agent: "reviewer" }] } } },
    );

    expect(expansions).toEqual([]);
  });

  test("rejects duplicate generated fan-out step ids before scheduling children", () => {
    expect(() => expandFanOutWorkflowStep(
      {
        id: "review",
        agent: "reviewer",
        taskSummary: "Review",
        prompt: "Review",
        fanOutFrom: { step: "triage", path: "structured.reviewers", idField: "id" },
      },
      {
        triage: {
          structuredOutput: {
            reviewers: [{ id: "security" }, { id: "security" }],
          },
        },
      },
    )).toThrow("Duplicate generated workflow step id: review[security]");
  });

  test("aggregates fan-out child results into a logical group result for downstream templates", () => {
    const aggregate = aggregateFanOutGroupResult(
      { id: "review", taskSummary: "Run reviews", agent: "{{item.agent}}", prompt: "Review" },
      [
        { stepId: "review[security]", taskSummary: "Security", status: "completed", success: true, summary: "No auth gaps", output: "security output", structuredOutput: { severity: "low" }, totalTokens: 100, toolCount: 3 },
        { stepId: "review[tests]", taskSummary: "Tests", status: "completed", success: true, summary: "Add edge tests", output: "tests output", totalTokens: 50, toolCount: 2 },
      ],
    );

    expect(aggregate).toMatchObject({
      stepId: "review",
      taskSummary: "Run reviews",
      status: "completed",
      success: true,
      summary: "Fan-out group review completed: 2 completed.",
      totalTokens: 150,
      toolCount: 5,
    });
    expect(aggregate.structuredOutput.children).toEqual([
      expect.objectContaining({ id: "review[security]", taskSummary: "Security", success: true, structuredOutput: { severity: "low" } }),
      expect.objectContaining({ id: "review[tests]", taskSummary: "Tests", success: true }),
    ]);

    const workflowResults = {
      review: {
        summary: aggregate.summary,
        output: aggregate.output,
        structuredOutput: aggregate.structuredOutput,
      },
    };
    expect(renderWorkflowTemplate("Synthesize {{review.summary}} / {{review.json}}", workflowResults)).toContain("Fan-out group review completed");
    expect(renderWorkflowTemplate("{{review.structured.children.0.summary}}", workflowResults)).toBe("No auth gaps");
  });

  test("aggregates failed and skipped fan-out children into a failed logical group", () => {
    const aggregate = aggregateFanOutGroupResult(
      { id: "review", taskSummary: "Run reviews", agent: "reviewer", prompt: "Review" },
      [
        { stepId: "review[security]", taskSummary: "Security", status: "failed", success: false, error: "security failed", totalTokens: 10, toolCount: 1 },
        { stepId: "review[docs]", taskSummary: "Docs", status: "skipped", success: true, skipped: true, summary: "Skipped by condition", totalTokens: 0, toolCount: 0 },
      ],
    );

    expect(aggregate).toMatchObject({
      stepId: "review",
      status: "failed",
      success: false,
      summary: "Fan-out group review failed: 1 failed, 1 skipped.",
      error: "security failed",
      totalTokens: 10,
      toolCount: 1,
    });
    expect(aggregate.structuredOutput.children).toEqual([
      expect.objectContaining({ id: "review[security]", status: "failed", success: false, error: "security failed" }),
      expect.objectContaining({ id: "review[docs]", status: "skipped", success: true, skipped: true }),
    ]);
  });

  test("treats completed fan-out group as the dependency barrier for downstream steps", () => {
    expect(getReadyWorkflowStepIds([
      { id: "triage", status: "completed" },
      { id: "review", status: "running", dependsOn: ["triage"] },
      { id: "review[security]", status: "completed", dependsOn: ["triage"] },
      { id: "review[tests]", status: "completed", dependsOn: ["triage"] },
      { id: "synth", status: "pending", dependsOn: ["review"] },
    ], 4)).toEqual([]);

    expect(getReadyWorkflowStepIds([
      { id: "triage", status: "completed" },
      { id: "review", status: "completed", dependsOn: ["triage"] },
      { id: "review[security]", status: "completed", dependsOn: ["triage"] },
      { id: "review[tests]", status: "completed", dependsOn: ["triage"] },
      { id: "synth", status: "pending", dependsOn: ["review"] },
    ], 4)).toEqual(["synth"]);
  });
});
