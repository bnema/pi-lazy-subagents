import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import { DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS, RUN_NAME_PATTERN, TOOL_NAME } from "../src/defaults.js";
import { DEFAULT_AGENT_PROFILE_NAME, resolveAgentProfileName } from "../src/launcher/agent-profiles.js";
import { LazySubagentsController } from "../src/orchestration/controller.js";
import { buildLazySubagentsAgentList, buildLazySubagentsHelp, executeLazySubagentsCommand, formatLaunchAcknowledgement, formatStatusReport, formatWaitReport } from "../src/orchestration/commands.js";
import { registerRunMessageRenderers } from "../src/ui/messages.js";

const WorkflowFanOutFromSchema = Type.Object({
  step: Type.String({ description: "Upstream JSON workflow step id that provides the array to fan out from." }),
  path: Type.String({ description: "Structured output path for the array, for example structured.reviewers or reviewers." }),
  idField: Type.Optional(Type.String({ description: "Optional field on each item used to build generated ids like review[security]. Defaults to the item index." })),
  maxItems: Type.Optional(Type.Integer({ minimum: 0, description: "Optional cap for generated fan-out steps." })),
});

const WorkflowStepSchema = Type.Object({
  id: Type.String({ description: "Stable step id used for dependency wiring and prompt templates such as {{research.summary}} or {{research.output}}." }),
  agent: Type.String({ description: "Child profile name for this workflow step. fanOutFrom steps may use {{item.agent}}." }),
  prompt: Type.String({ description: "Task for this workflow step. You can reference earlier step results with {{stepId.summary}}, {{stepId.output}}, {{stepId.json}}, structured fields such as {{stepId.structured.title}}, and {{item.field}} inside fanOutFrom templates." }),
  taskSummary: Type.Optional(Type.String({ description: "Optional shorter label for this workflow step in status surfaces." })),
  dependsOn: Type.Optional(Type.Array(Type.String(), { description: "Optional list of earlier workflow step ids that must complete before this step starts. Direct dependencies referenced with {{stepId...}} in prompt/when or fanOutFrom.step are inferred automatically." })),
  retries: Type.Optional(Type.Integer({ minimum: 0, description: "How many extra attempts to allow after the first failed attempt for this workflow step." })),
  outputMode: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("json")], { description: "How this workflow step should shape its final answer. Use json to require a JSON object result." })),
  outputSchema: Type.Optional(Type.String({ description: "Optional schema guidance for json workflow output. This text is appended to the worker prompt so the final response matches the expected object shape." })),
  when: Type.Optional(Type.String({ description: "Optional condition evaluated after dependencies complete. Use references such as {{triage.structured.runSecurity}}; falsey values skip the step without launching a child." })),
  fanOutFrom: Type.Optional(WorkflowFanOutFromSchema),
  cwd: Type.Optional(Type.String()),
});

export const ToolParamsSchema = Type.Object({
  action: Type.Union([
    Type.Literal("help"),
    Type.Literal("list"),
    Type.Literal("run"),
    Type.Literal("parallel"),
    Type.Literal("workflow"),
    Type.Literal("status"),
    Type.Literal("wait"),
    Type.Literal("result"),
    Type.Literal("pickup"),
    Type.Literal("pin"),
    Type.Literal("stop"),
    Type.Literal("continue"),
    Type.Literal("clear"),
    Type.Literal("cancel"),
  ], {
    description: "Operation to perform. Use action=parallel for independent children and action=workflow for dependency-aware background pipelines; use help for examples and list to inspect available sub agents before choosing one.",
  }),
  agent: Type.Optional(Type.String({
    description: `Single-run agent profile. Use action=list to inspect available sub agents. When omitted for action=run, defaults to ${DEFAULT_AGENT_PROFILE_NAME}.`,
  })),
  prompt: Type.Optional(Type.String({
    description: "Task for the child session. For action=run, describe the delegated work clearly and concisely, then let the child report completion or attention back asynchronously.",
  })),
  name: Type.Optional(Type.String({
    description: `Stable named run addressing name for action=run single runs, kept visible after completion for follow-up via action=continue. Group and workflow runs cannot be continued by name. Must match /${RUN_NAME_PATTERN.source}/. Use for long-lived review/rework agents.`,
    pattern: RUN_NAME_PATTERN.source,
  })),
  title: Type.Optional(Type.String({
    description: "Optional short label shown in the widget, status, and message cards.",
  })),
  target: Type.Optional(Type.String({
    description: "Run id or name to continue. Use action=continue with a new prompt to resume a completed named or single subagent in the same child session.",
  })),
  runId: Type.Optional(Type.String({
    description: "Existing run id for wait, status, result, pickup, pin, stop, clear, or cancel operations. Use this sparingly for later health checks or final-result retrieval, not tight polling loops.",
  })),
  timeoutMs: Type.Optional(Type.Number({
    minimum: 1,
    maximum: MAX_WAIT_TIMEOUT_MS,
    description: `action=wait timeout. Defaults to ${DEFAULT_WAIT_TIMEOUT_MS}ms. Wait is blocking; use it only when explicitly needed.`,
  })),
  scope: Type.Optional(Type.Union([Type.Literal("completed"), Type.Literal("all")], {
    description: "Clear only completed runs or all tracked runs.",
  })),
  children: Type.Optional(
    Type.Array(
      Type.Object({
        agent: Type.String({ description: "Child profile name for this parallel child. Use action=list to inspect available sub agents." }),
        prompt: Type.String({ description: "Independent task for this child. With action=parallel, all children are launched at the same time." }),
        taskSummary: Type.Optional(Type.String({ description: "Optional shorter label for this child in status surfaces." })),
        cwd: Type.Optional(Type.String()),
      }),
    ),
  ),
  steps: Type.Optional(Type.Array(WorkflowStepSchema, {
    description: "Workflow steps for action=workflow. The runner executes them in the background with dependency-aware scheduling and direct step-to-step result passing.",
  })),
  maxConcurrency: Type.Optional(Type.Integer({
    minimum: 1,
    description: "Maximum number of workflow steps that may run at the same time for action=workflow. Defaults to the number of steps.",
  })),
});

function shortTitle(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length <= 72 ? singleLine : `${singleLine.slice(0, 71).trimEnd()}…`;
}

export function buildDefaultParallelTitle(children: Array<{ prompt: string; taskSummary?: string }>): string {
  const labels = children
    .map((child) => shortTitle(child.taskSummary ?? child.prompt))
    .filter(Boolean);
  if (labels.length === 0) return "Parallel tasks";
  if (labels.length <= 2) return labels.join(" + ");
  return `${labels.slice(0, 2).join(" + ")} + ${labels.length - 2} more`;
}

function isWaitProgressDetails(value: unknown): value is { kind: "wait-progress"; lines: string[] } {
  const lines = typeof value === "object" && value !== null
    ? (value as { lines?: unknown }).lines
    : undefined;
  return typeof value === "object"
    && value !== null
    && (value as { kind?: unknown }).kind === "wait-progress"
    && Array.isArray(lines)
    && lines.every((line) => typeof line === "string");
}

function renderLazySubagentsToolResult(result: { content?: Array<{ type?: string; text?: string }>; details?: unknown }, options: { expanded?: boolean }, theme: { fg(color: string, text: string): string; bold(text: string): string }) {
  if (isWaitProgressDetails(result.details)) {
    const lines = options.expanded
      ? result.details.lines
      : result.details.lines.length <= 11
        ? result.details.lines
        : [
            ...result.details.lines.slice(0, 2),
            ...result.details.lines.slice(Math.max(2, result.details.lines.length - 9)),
          ];
    const text = lines.map((line, index) => {
      if (index === 0) return theme.fg("toolTitle", theme.bold(line));
      if (index === 1) return theme.fg("muted", line);
      if (line.startsWith("  ")) return theme.fg("dim", line);
      return line;
    }).join("\n");
    return new Text(text, 0, 0);
  }

  const fallback = result.content?.find((part) => part.type === "text")?.text ?? "";
  return new Text(fallback, 0, 0);
}

export default function lazySubagentsExtension(pi: ExtensionAPI): void {
  const controller = new LazySubagentsController(pi);

  registerRunMessageRenderers(pi, {
    getPinnedRunLines: (runId, expanded) => controller.getPinnedRunLines(runId, expanded),
  });

  pi.on("session_start", async (_event, ctx) => {
    await controller.handleSessionStart(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    await controller.handleSessionTree(ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    await controller.handleSessionShutdown(ctx);
  });

  pi.on("turn_start", async (_event, ctx) => {
    controller.captureContext(ctx);
  });

  pi.on("turn_end", async (_event, ctx) => {
    controller.captureContext(ctx);
  });

  pi.registerCommand("lazy-subagents", {
    description: "Launch and manage lazy background subagents.",
    handler: async (args, ctx) => {
      const message = await executeLazySubagentsCommand(args, controller, ctx);
      ctx.ui.notify(message || buildLazySubagentsHelp(), "info");
    },
  });

  pi.registerTool({
    name: TOOL_NAME,
    label: "Lazy Subagents",
    description: "Launch background subagents; completion/attention signals return to this session automatically.",
    promptSnippet: "Launch child work asynchronously. Do not wait or poll unless explicitly needed.",
    promptGuidelines: [
      "Use action=list to choose an agent; action=run defaults to delegate.",
      "Use action=run name=<name> for review or rework agents that should stay visible after completion for follow-up via action=continue.",
      "Use action=run for one child and action=parallel for independent children.",
      "Use action=workflow for dependent pipelines that should stay off the main session context and pass step results directly in the background.",
      "Workflow steps support retries=<n>, outputMode=json, outputSchema, when conditions, and fanOutFrom groups with downstream fan-in aggregation.",
      "Workflow steps can reference earlier results with {{stepId.summary}}, {{stepId.output}}, {{stepId.json}}, structured fields such as {{stepId.structured.title}}, and {{item.field}} inside fanOutFrom templates.",
      "dependsOn may be omitted for dependencies directly inferable from {{stepId...}} references in prompt/when or from fanOutFrom.step; the runner adds them automatically while preserving explicit dependencies first.",
      "A step depending on a fanOutFrom step waits for all expanded children and can consume the group aggregate with {{group.summary}}, {{group.output}}, {{group.json}}, or {{group.structured.children}}.",
      "For outputMode=json, raw JSON is preferred, but fenced json blocks and embedded JSON objects are accepted.",
      "After run/parallel/workflow, do not call wait or status right away. Return to the user or continue other work.",
      "Subagents always report terminal results back to the main agent; completed, failed, paused, and attention states all return as follow-up input automatically.",
      "Use action=wait only for explicit blocking requests or non-interactive scripts.",
      "Use action=status only for human-requested health checks, suspected stalls, or after about 60s with no signal. Do not poll.",
      "Use action=result after terminal completion, pickup to inject the result, pin off/on to hide or restore the persistent progress panel, and clear/cancel to manage runs.",
      "Use action=stop runId=<runId> for a resumable pause of a stuck active single run; cancel is final and cannot be continued.",
      "Use action=continue target=<name|runId> prompt=<new prompt> to resume a completed named or stopped single subagent. The run reuses its existing session.",
    ],
    parameters: ToolParamsSchema,
    renderCall(args, theme) {
      const action = typeof args.action === "string" ? args.action : "";
      const target = typeof args.runId === "string" ? ` ${theme.fg("accent", args.runId.slice(0, 8))}` : "";
      return new Text(`${theme.fg("toolTitle", theme.bold("lazy_subagents "))}${action}${target}`, 0, 0);
    },
    renderResult(result, options, theme) {
      return renderLazySubagentsToolResult(result, options, theme);
    },
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      switch (params.action) {
        case "help":
          return { content: [{ type: "text", text: buildLazySubagentsHelp() }], details: { action: params.action } };
        case "list":
          return { content: [{ type: "text", text: buildLazySubagentsAgentList() }], details: { action: params.action } };
        case "run": {
          if (!params.prompt) {
            return { content: [{ type: "text", text: buildLazySubagentsHelp() }], details: { action: params.action } };
          }

          const agent = resolveAgentProfileName(params.agent);
          const title = params.title ?? shortTitle(params.prompt);
          const run = await controller.launchChild(
            {
              agent,
              prompt: params.prompt,
              title,
              taskSummary: title,
              name: params.name,
            },
            ctx,
          );

          return { content: [{ type: "text", text: formatLaunchAcknowledgement(`Launched ${run.id} (${run.agent}).`) }], details: { action: params.action, runId: run.id, agent: run.agent } };
        }
        case "parallel": {
          if (!params.children || params.children.length === 0) {
            return { content: [{ type: "text", text: "Provide children[] for action=parallel." }], details: { action: params.action } };
          }
          if (params.name) {
            return { content: [{ type: "text", text: "name is only supported for action=run single runs; group runs cannot be continued by name." }], details: { action: params.action, name: params.name } };
          }

          const children = params.children.map((child) => ({
            ...child,
            taskSummary: child.taskSummary ?? shortTitle(child.prompt),
          }));
          const title = params.title ?? buildDefaultParallelTitle(children);
          const run = await controller.launchGroup(
            {
              title,
              taskSummary: title,
              children,
            },
            ctx,
          );

          return { content: [{ type: "text", text: formatLaunchAcknowledgement(`Launched ${run.id} (${params.children.length} children).`) }], details: { action: params.action, runId: run.id } };
        }
        case "workflow": {
          if (!params.steps || params.steps.length === 0) {
            return { content: [{ type: "text", text: "Provide steps[] for action=workflow." }], details: { action: params.action } };
          }
          if (params.name) {
            return { content: [{ type: "text", text: "name is only supported for action=run single runs; workflow runs cannot be continued by name." }], details: { action: params.action, name: params.name } };
          }

          const title = params.title ?? `Workflow run (${params.steps.length} steps)`;
          const run = await controller.launchWorkflow(
            {
              title,
              taskSummary: title,
              maxConcurrency: params.maxConcurrency,
              steps: params.steps.map((step) => ({
                ...step,
                taskSummary: step.taskSummary ?? shortTitle(step.prompt),
              })),
            },
            ctx,
          );

          return { content: [{ type: "text", text: formatLaunchAcknowledgement(`Launched ${run.id} workflow (${params.steps.length} steps).`) }], details: { action: params.action, runId: run.id } };
        }
        case "status":
          await controller.pollOnce();
          return { content: [{ type: "text", text: formatStatusReport(controller.getSnapshot(), params.runId) }], details: { action: params.action, runId: params.runId } };
        case "wait":
          return {
            content: [{ type: "text", text: formatWaitReport(await controller.waitForRunSignal(params.runId, { timeoutMs: params.timeoutMs, signal: _signal, ctx })) }],
            details: { action: params.action, runId: params.runId, timeoutMs: params.timeoutMs },
          };
        case "result": {
          const text = params.runId ? await controller.getRunResult(params.runId) : undefined;
          if (text && params.runId) controller.acknowledgeRun(params.runId);
          return {
            content: [{ type: "text", text: text ?? `Result not available for ${params.runId ?? "(missing runId)"}.` }],
            details: { action: params.action, runId: params.runId },
          };
        }
        case "pickup":
          return {
            content: [{ type: "text", text: params.runId && await controller.pickupRun(params.runId, ctx) ? `Injected result from ${params.runId} into chat.` : `Run not found: ${params.runId ?? "(missing runId)"}` }],
            details: { action: params.action, runId: params.runId },
          };
        case "pin": {
          if (params.runId === "off") {
            await controller.setPinnedWidgetVisible(false, ctx);
            return { content: [{ type: "text", text: "Pinned widget hidden." }], details: { action: params.action, runId: params.runId } };
          }
          if (params.runId === "on") {
            await controller.setPinnedWidgetVisible(true, ctx);
            return { content: [{ type: "text", text: "Pinned widget visible." }], details: { action: params.action, runId: params.runId } };
          }
          const outcome = params.runId ? await controller.pinRunWithOutcome(params.runId, ctx) : "not_found";
          const text = outcome === "pinned"
            ? `Pinned ${params.runId} in widget.`
            : outcome === "not_pinnable"
              ? `Run already complete: ${params.runId} is not pinned in widget.`
              : `Run not found: ${params.runId ?? "(missing runId)"}`;
          return {
            content: [{ type: "text", text }],
            details: { action: params.action, runId: params.runId },
          };
        }
        case "clear": {
          const cleared = controller.clearRuns(params.scope ?? "completed", params.runId);
          return { content: [{ type: "text", text: cleared > 0 ? `Cleared ${cleared} run(s).` : "Nothing to clear." }], details: { action: params.action, cleared } };
        }
        case "stop":
          return {
            content: [{ type: "text", text: params.runId && await controller.stopRun(params.runId, ctx) ? `Stopped ${params.runId}. Use action=continue target=${params.runId} prompt=<message> to resume.` : `Could not stop ${params.runId ?? "(missing runId)"}.` }],
            details: { action: params.action, runId: params.runId },
          };
        case "cancel":
          return {
            content: [{ type: "text", text: params.runId && await controller.cancelRun(params.runId, ctx) ? `Cancelled ${params.runId}.` : `Could not cancel ${params.runId ?? "(missing runId)"}.` }],
            details: { action: params.action, runId: params.runId },
          };
        case "continue": {
          if (!params.target || !params.prompt) {
            return { content: [{ type: "text", text: "Provide target and prompt for action=continue." }], details: { action: params.action } };
          }
          const title = params.title ?? shortTitle(params.prompt);
          try {
            const run = await controller.continueChild(params.target, params.prompt, title, ctx);
            return { content: [{ type: "text", text: formatLaunchAcknowledgement(`Continued ${run.id} (${run.agent}).`) }], details: { action: params.action, runId: run.id, agent: run.agent } };
          } catch (error) {
            return { content: [{ type: "text", text: `Could not continue ${params.target}: ${error instanceof Error ? error.message : String(error)}` }], details: { action: params.action, target: params.target } };
          }
        }
      }
    },
  });
}
