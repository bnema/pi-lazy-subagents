import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { listAvailableAgentProfiles, resolveAgentProfileName } from "../launcher/agent-profiles.js";
import type { CompletionPolicy, RunEvent, RunRecord, RunRegistrySnapshot } from "../types.js";
import { formatAge, formatCompactThousands, formatDuration } from "../utils/time.js";
import type { LazySubagentsController } from "./controller.js";

export const LAZY_SUBAGENTS_COMMANDS = [
  "lazy-subagents",
  "lazy-subagents-pickup",
  "lazy-subagents-clear",
  "lazy-subagents-cancel",
] as const;

export type ParsedLazySubagentsCommand =
  | { action: "help" }
  | { action: "status"; runId?: string }
  | { action: "result"; runId: string }
  | { action: "pickup"; runId: string }
  | { action: "pin"; runId: string }
  | { action: "cancel"; runId: string }
  | { action: "clear"; scope: "completed" | "all"; runId?: string }
  | { action: "run"; agent: string; prompt: string; completionPolicy?: CompletionPolicy; title?: string };

const COMPLETION_POLICIES = new Set<CompletionPolicy>([
  "notify_only",
  "follow_up_when_idle",
  "wake_if_idle",
  "manual_pickup",
]);

function splitCliArgs(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaping = false;

  for (const char of input.trim()) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/u.test(char)) {
      if (current) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) current += "\\";
  if (current) args.push(current);
  return args;
}

function shortTitle(text: string): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length <= 72 ? singleLine : `${singleLine.slice(0, 71).trimEnd()}…`;
}

function findRun(snapshot: RunRegistrySnapshot, runId: string | undefined): RunRecord | undefined {
  if (!runId) return undefined;
  return snapshot.runs.find((run) => run.id === runId);
}

function latestEvent(run: RunRecord): RunEvent | undefined {
  return run.recentEvents[run.recentEvents.length - 1];
}

function cleanSummary(run: RunRecord, summary: string | undefined): string | undefined {
  if (!summary) return undefined;
  return summary.startsWith(`${run.id} `) ? summary.slice(run.id.length + 1) : summary;
}

export function parseLazySubagentsCommand(input: string): ParsedLazySubagentsCommand {
  const tokens = splitCliArgs(input);
  const action = tokens.shift();
  if (!action || action === "help") return { action: "help" };

  if (action === "status") {
    return { action, runId: tokens[0] };
  }

  if (action === "result" || action === "pickup" || action === "pin" || action === "cancel") {
    const runId = tokens[0];
    return runId ? { action, runId } : { action: "help" };
  }

  if (action === "clear") {
    const target = tokens[0];
    if (!target) return { action, scope: "completed" };
    if (target === "all") return { action, scope: "all" };
    return { action, scope: "completed", runId: target };
  }

  if (action === "run") {
    const agent = tokens.shift();
    if (!agent) return { action: "help" };

    let completionPolicy: CompletionPolicy | undefined;
    let title: string | undefined;
    const promptParts: string[] = [];

    while (tokens.length > 0) {
      const token = tokens.shift()!;
      if (token === "--policy") {
        const value = tokens.shift();
        if (value && COMPLETION_POLICIES.has(value as CompletionPolicy)) completionPolicy = value as CompletionPolicy;
        continue;
      }
      if (token.startsWith("--policy=")) {
        const value = token.slice("--policy=".length);
        if (COMPLETION_POLICIES.has(value as CompletionPolicy)) completionPolicy = value as CompletionPolicy;
        continue;
      }
      if (token === "--title") {
        title = tokens.shift();
        continue;
      }
      if (token.startsWith("--title=")) {
        title = token.slice("--title=".length);
        continue;
      }
      promptParts.push(token);
    }

    const prompt = promptParts.join(" ").trim();
    if (!prompt) return { action: "help" };
    return { action, agent, prompt, completionPolicy, title };
  }

  return { action: "help" };
}

function formatRunStatus(run: RunRecord, now: number): string[] {
  const lines = [`${run.id} · ${run.status} · ${run.agent}`];
  lines.push(`  task: ${run.title || run.taskSummary}`);
  lines.push(`  elapsed: ${formatDuration(now - run.startedAt)}`);
  lines.push(`  updated: ${formatAge({ now, timestamp: run.updatedAt })}`);
  if (run.currentTool) lines.push(`  tool: ${run.currentTool}`);
  if (run.toolCount !== undefined) lines.push(`  tools used: ${run.toolCount}`);
  if (run.totalTokens !== undefined) lines.push(`  tokens: ${formatCompactThousands(run.totalTokens)}`);

  const eventSummary = cleanSummary(run, latestEvent(run)?.summary);
  if (eventSummary) lines.push(`  last event: ${eventSummary}`);

  const preview = run.resultPreview ?? run.errorPreview;
  if (preview) lines.push(`  preview: ${preview}`);
  if (run.status !== "running" && run.status !== "queued") {
    lines.push(`  result available: /lazy-subagents result ${run.id}`);
  }

  return lines;
}

export function formatStatusReport(snapshot: RunRegistrySnapshot, runId?: string, now = Date.now()): string {
  if (snapshot.runs.length === 0) return "No tracked lazy subagent runs.";

  const focusedRun = findRun(snapshot, runId);
  const runs = focusedRun ? [focusedRun] : snapshot.runs;
  const lines = [
    `Active runs: ${snapshot.activeRuns.length}`,
    `Recent runs: ${snapshot.recentRuns.length}`,
    "",
  ];

  for (const run of runs) {
    lines.push(...formatRunStatus(run, now));
  }

  return lines.join("\n");
}

function formatAgentHelpLines(): string[] {
  return listAvailableAgentProfiles().map((profile) => {
    const source = profile.source === "file" && profile.sourcePath ? ` [${profile.sourcePath}]` : "";
    return `  - ${profile.name}: ${profile.description}${source}`;
  });
}

export function buildLazySubagentsHelp(): string {
  return [
    "Usage:",
    "  /lazy-subagents run <agent> <prompt> [--policy POLICY] [--title TITLE]",
    "  /lazy-subagents status [runId]",
    "  /lazy-subagents result <runId>",
    "  /lazy-subagents pickup <runId>",
    "  /lazy-subagents pin <runId>",
    "  /lazy-subagents cancel <runId>",
    "  /lazy-subagents clear [all|runId]",
    "",
    "Available agent profiles:",
    ...formatAgentHelpLines(),
    "",
    "Examples:",
    "  /lazy-subagents run reviewer \"Review the auth diff\"",
    "  /lazy-subagents run scout \"Inspect the package layout\"",
    "  /lazy-subagents run worker \"Implement the requested fix\"",
    "",
    "Tool note: lazy_subagents action=run defaults agent to delegate when omitted.",
  ].join("\n");
}

export async function executeLazySubagentsCommand(
  input: string,
  controller: LazySubagentsController,
  ctx: ExtensionContext,
): Promise<string> {
  const parsed = parseLazySubagentsCommand(input);

  switch (parsed.action) {
    case "help":
      return buildLazySubagentsHelp();
    case "status":
      await controller.pollOnce();
      return formatStatusReport(controller.getSnapshot(), parsed.runId);
    case "result": {
      const result = await controller.getRunResult(parsed.runId);
      if (result) controller.acknowledgeRun(parsed.runId);
      return result ?? `Result not available for ${parsed.runId}.`;
    }
    case "pickup":
      return (await controller.pickupRun(parsed.runId, ctx))
        ? `Injected result from ${parsed.runId} into chat.`
        : `Run not found: ${parsed.runId}`;
    case "pin":
      return (await controller.pinRun(parsed.runId, ctx))
        ? `Pinned ${parsed.runId} into chat.`
        : `Run not found: ${parsed.runId}`;
    case "cancel":
      return (await controller.cancelRun(parsed.runId, ctx))
        ? `Cancelled ${parsed.runId}.`
        : `Could not cancel ${parsed.runId}.`;
    case "clear": {
      const cleared = controller.clearRuns(parsed.scope, parsed.runId);
      return cleared > 0 ? `Cleared ${cleared} run(s).` : "Nothing to clear.";
    }
    case "run": {
      const title = parsed.title ?? shortTitle(parsed.prompt);
      const run = await controller.launchChild(
        {
          agent: resolveAgentProfileName(parsed.agent),
          prompt: parsed.prompt,
          title,
          taskSummary: title,
          completionPolicy: parsed.completionPolicy,
        },
        ctx,
      );
      return `Launched ${run.id} (${run.agent}).`;
    }
  }
}
