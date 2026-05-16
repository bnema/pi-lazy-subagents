import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { DEFAULT_COMPLETION_POLICY, TOOL_NAME } from "../src/defaults.js";
import { DEFAULT_AGENT_PROFILE_NAME, resolveAgentProfileName } from "../src/launcher/agent-profiles.js";
import { LazySubagentsController } from "../src/orchestration/controller.js";
import { buildLazySubagentsAgentList, buildLazySubagentsHelp, executeLazySubagentsCommand, formatLaunchAcknowledgement, formatStatusReport } from "../src/orchestration/commands.js";
import { registerRunMessageRenderers } from "../src/ui/messages.js";

const CompletionPolicySchema = Type.Union([
  Type.Literal("notify_only"),
  Type.Literal("follow_up_when_idle"),
  Type.Literal("wake_if_idle"),
  Type.Literal("manual_pickup"),
]);

const ToolParamsSchema = Type.Object({
  action: Type.Union([
    Type.Literal("help"),
    Type.Literal("list"),
    Type.Literal("run"),
    Type.Literal("parallel"),
    Type.Literal("status"),
    Type.Literal("result"),
    Type.Literal("pickup"),
    Type.Literal("pin"),
    Type.Literal("clear"),
    Type.Literal("cancel"),
  ], {
    description: "Operation to perform. Use help for usage/examples and list to inspect available sub agents before choosing one.",
  }),
  agent: Type.Optional(Type.String({
    description: `Single-run agent profile. Use action=list to inspect available sub agents. When omitted for action=run, defaults to ${DEFAULT_AGENT_PROFILE_NAME}.`,
  })),
  prompt: Type.Optional(Type.String({
    description: "Task for the child session. For action=run, describe the delegated work clearly and concisely, then let the child report completion or attention back asynchronously.",
  })),
  title: Type.Optional(Type.String({
    description: "Optional short label shown in the widget, status, and message cards.",
  })),
  completionPolicy: Type.Optional(CompletionPolicySchema),
  runId: Type.Optional(Type.String({
    description: "Existing run id for status, result, pickup, clear, or cancel operations. Use this sparingly for later health checks or final-result retrieval, not tight polling loops.",
  })),
  scope: Type.Optional(Type.Union([Type.Literal("completed"), Type.Literal("all")], {
    description: "Clear only completed runs or all tracked runs.",
  })),
  children: Type.Optional(
    Type.Array(
      Type.Object({
        agent: Type.String({ description: "Child profile name for this parallel child. Use action=list to inspect available sub agents." }),
        prompt: Type.String({ description: "Task for this child." }),
        taskSummary: Type.Optional(Type.String({ description: "Optional shorter label for this child in status surfaces." })),
        cwd: Type.Optional(Type.String()),
      }),
    ),
  ),
});

function shortTitle(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length <= 72 ? singleLine : `${singleLine.slice(0, 71).trimEnd()}…`;
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
    description: "Launch or manage background lazy subagent runs that emit completion or attention back into the current session without blocking it.",
    promptSnippet: "Launch background child work and wait for completion/attention signals, or inspect results/help only when needed.",
    promptGuidelines: [
      "Use lazy_subagents action=help when you need exact usage or examples before launching work.",
      "Use lazy_subagents action=list to list the sub agents and pick the appropriate one.",
      "Use lazy_subagents action=run when the human wants parallelism without blocking the main session.",
      "For lazy_subagents action=run, omit agent or use delegate when unsure; delegate is the general-purpose fallback.",
      "After action=run or action=parallel, usually stop polling and wait; launch, completion, and attention messages are emitted back into the same session automatically.",
      "Do not call action=status in a loop. Use it only when the human asks, when about 60 seconds have passed with no signal and you need a health check, or when you suspect a stall.",
      "Use action=result only after a run reaches a terminal state, use action=pickup to inject that final result into chat, and use action=pin when you want durable live progress in chat.",
      "Use lazy_subagents action=status, action=result, action=pickup, action=pin, action=clear, or action=cancel to inspect or manage existing runs.",
    ],
    parameters: ToolParamsSchema,
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
              completionPolicy: params.completionPolicy ?? DEFAULT_COMPLETION_POLICY,
            },
            ctx,
          );

          return { content: [{ type: "text", text: formatLaunchAcknowledgement(`Launched ${run.id} (${run.agent}).`) }], details: { action: params.action, runId: run.id, agent: run.agent } };
        }
        case "parallel": {
          if (!params.children || params.children.length === 0) {
            return { content: [{ type: "text", text: "Provide children[] for action=parallel." }], details: { action: params.action } };
          }

          const title = params.title ?? `Parallel run (${params.children.length})`;
          const run = await controller.launchGroup(
            {
              title,
              taskSummary: title,
              completionPolicy: params.completionPolicy ?? DEFAULT_COMPLETION_POLICY,
              children: params.children.map((child) => ({
                ...child,
                taskSummary: child.taskSummary ?? shortTitle(child.prompt),
              })),
            },
            ctx,
          );

          return { content: [{ type: "text", text: formatLaunchAcknowledgement(`Launched ${run.id} (${params.children.length} children).`) }], details: { action: params.action, runId: run.id } };
        }
        case "status":
          await controller.pollOnce();
          return { content: [{ type: "text", text: formatStatusReport(controller.getSnapshot(), params.runId) }], details: { action: params.action, runId: params.runId } };
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
        case "pin":
          return {
            content: [{ type: "text", text: params.runId && await controller.pinRun(params.runId, ctx) ? `Pinned ${params.runId} into chat.` : `Run not found: ${params.runId ?? "(missing runId)"}` }],
            details: { action: params.action, runId: params.runId },
          };
        case "clear": {
          const cleared = controller.clearRuns(params.scope ?? "completed", params.runId);
          return { content: [{ type: "text", text: cleared > 0 ? `Cleared ${cleared} run(s).` : "Nothing to clear." }], details: { action: params.action, cleared } };
        }
        case "cancel":
          return {
            content: [{ type: "text", text: params.runId && await controller.cancelRun(params.runId, ctx) ? `Cancelled ${params.runId}.` : `Could not cancel ${params.runId ?? "(missing runId)"}.` }],
            details: { action: params.action, runId: params.runId },
          };
      }
    },
  });
}
