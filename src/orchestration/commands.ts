import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { listAvailableAgentProfiles, resolveAgentProfileName } from "../launcher/agent-profiles.js";
import { DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS, RUN_NAME_PATTERN } from "../defaults.js";
import type { RunEvent, RunRecord, RunRegistrySnapshot } from "../types.js";
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
  | { action: "list" }
  | { action: "status"; runId?: string }
  | { action: "wait"; runId?: string; timeoutMs?: number }
  | { action: "result"; runId: string }
  | { action: "pickup"; runId: string }
  | { action: "pin"; runId: string }
  | { action: "cancel"; runId: string }
  | { action: "clear"; scope: "completed" | "all"; runId?: string }
  | { action: "continue"; target: string; prompt: string; title?: string }
  | { action: "run"; agent: string; prompt: string; title?: string; name?: string };

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

export const WAIT_FOR_SIGNAL_GUIDANCE = "Return to the user or continue other work. Signals arrive automatically; do not wait or poll right away.";

function takeFlagValue(tokens: string[]): string | undefined {
  const value = tokens[0];
  if (!value || value.startsWith("--")) return undefined;
  return tokens.shift();
}

function normalizeWaitTimeoutMs(value: unknown): number | undefined {
  if (typeof value !== "string") return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.min(Math.floor(parsed), MAX_WAIT_TIMEOUT_MS);
}

export function formatLaunchAcknowledgement(summary: string): string {
  return `${summary} ${WAIT_FOR_SIGNAL_GUIDANCE}`;
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

  if (action === "list") {
    return { action };
  }

  if (action === "status") {
    return { action, runId: tokens[0] };
  }

  if (action === "wait") {
    let runId: string | undefined;
    let timeoutMs: number | undefined;

    while (tokens.length > 0) {
      const token = tokens.shift()!;
      if (token === "--timeout-ms") {
        const value = takeFlagValue(tokens);
        if (!value) return { action: "help" };
        timeoutMs = normalizeWaitTimeoutMs(value);
        if (timeoutMs === undefined) return { action: "help" };
        continue;
      }
      if (token.startsWith("--timeout-ms=")) {
        const value = token.slice("--timeout-ms=".length);
        if (!value) return { action: "help" };
        timeoutMs = normalizeWaitTimeoutMs(value);
        if (timeoutMs === undefined) return { action: "help" };
        continue;
      }
      runId ??= token;
    }

    return { action, runId, timeoutMs };
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

  if (action === "continue") {
    const target = tokens.shift();
    if (!target) return { action: "help" };

    let title: string | undefined;
    const promptParts: string[] = [];

    while (tokens.length > 0) {
      const token = tokens.shift()!;
      if (token === "--title") {
        title = takeFlagValue(tokens);
        if (!title) return { action: "help" };
        continue;
      }
      if (token.startsWith("--title=")) {
        title = token.slice("--title=".length);
        if (!title) return { action: "help" };
        continue;
      }
      if (token === "--name" || token.startsWith("--name=")) {
        return { action: "help" };
      }
      promptParts.push(token);
    }

    const prompt = promptParts.join(" ").trim();
    if (!prompt) return { action: "help" };
    return { action: "continue", target, prompt, title };
  }

  if (action === "run") {
    const agent = tokens.shift();
    if (!agent) return { action: "help" };

    let title: string | undefined;
    let name: string | undefined;
    const promptParts: string[] = [];

    while (tokens.length > 0) {
      const token = tokens.shift()!;
      if (token === "--policy") {
        if (!takeFlagValue(tokens)) return { action: "help" };
        continue;
      }
      if (token.startsWith("--policy=")) {
        if (!token.slice("--policy=".length)) return { action: "help" };
        continue;
      }
      if (token === "--title") {
        title = takeFlagValue(tokens);
        if (!title) return { action: "help" };
        continue;
      }
      if (token.startsWith("--title=")) {
        title = token.slice("--title=".length);
        if (!title) return { action: "help" };
        continue;
      }
      if (token === "--name") {
        name = takeFlagValue(tokens);
        if (!name) return { action: "help" };
        continue;
      }
      if (token.startsWith("--name=")) {
        name = token.slice("--name=".length);
        if (!name) return { action: "help" };
        continue;
      }
      promptParts.push(token);
    }

    const prompt = promptParts.join(" ").trim();
    if (!prompt) return { action: "help" };
    if (name !== undefined && !RUN_NAME_PATTERN.test(name)) return { action: "help" };
    return { action, agent, prompt, title, name };
  }

  return { action: "help" };
}

function formatRunStatus(run: RunRecord, now: number): string[] {
  const lines = [`${run.id} · ${run.status} · ${run.agent}`];
  lines.push(`  task: ${run.title || run.taskSummary}`);
  lines.push(`  elapsed: ${formatDuration(now - run.startedAt)}`);
  lines.push(`  updated: ${formatAge({ now, timestamp: run.updatedAt })}`);
  if (run.model) lines.push(`  model: ${run.model}`);
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

export function formatWaitReport(result: Awaited<ReturnType<LazySubagentsController["waitForRunSignal"]>>, now = Date.now()): string {
  switch (result.status) {
    case "ready":
      // Defensive guard: the ready discriminant should carry a run today, but keep the formatter robust if future orchestration paths decouple those states.
      if (!result.run) return "Lazy subagent wait ended, but no run was selected.";
      return [
        result.run.attentionNeeded || result.run.status === "blocked" || result.run.status === "paused"
          ? `Lazy subagent needs attention: ${result.run.id}`
          : `Lazy subagent finished: ${result.run.id}`,
        ...formatRunStatus(result.run, now),
        result.run.status === "completed" || result.run.status === "skipped" ? `Use action=result runId=${result.run.id} to read the result.` : undefined,
      ].filter((line): line is string => Boolean(line)).join("\n");
    case "timeout":
      return result.run
        ? `Still waiting for ${result.run.id}. Return to the user, continue other work, or wait for the automatic signal.`
        : "Timed out waiting for a lazy subagent signal.";
    case "not_found":
      return "No run found for that id.";
    case "ambiguous":
      return [
        "Multiple active lazy subagent runs; call action=wait with runId for one of:",
        ...(result.activeRuns ?? []).map((run) => `  ${run.id} · ${run.agent} · ${run.title || run.taskSummary}`),
      ].join("\n");
    case "no_active_runs":
      return "No active lazy subagent runs to wait for.";
    case "aborted":
      return "Stopped waiting for lazy subagent signal because the tool call was aborted.";
    default: {
      const _exhaustive: never = result;
      throw new Error(`Unhandled waitForRunSignal status: ${JSON.stringify(_exhaustive)}`);
    }
  }
}

export function formatStatusReport(snapshot: RunRegistrySnapshot, runId?: string, now = Date.now()): string {
  if (snapshot.runs.length === 0) return "No tracked lazy subagent runs.";

  const focusedRun = findRun(snapshot, runId);
  if (runId && !focusedRun) return `No run found with id: ${runId}`;

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

export function buildLazySubagentsAgentList(): string {
  return ["Available sub agents:", ...formatAgentHelpLines()].join("\n");
}

export function buildLazySubagentsHelp(): string {
  return [
    "Slash command usage:",
    "  /lazy-subagents help",
    "  /lazy-subagents list",
    "  /lazy-subagents run <agent> <prompt> [--title TITLE] [--name NAME]",
    "  (parallel/workflow launches are available through lazy_subagents tool actions)",
    "  /lazy-subagents continue <target> <prompt> [--title TITLE]",
    "  /lazy-subagents status [runId]",
    "  /lazy-subagents wait [runId] [--timeout-ms MS]",
    "  /lazy-subagents result <runId>",
    "  /lazy-subagents pickup <runId>",
    "  /lazy-subagents pin <runId|on|off>",
    "  /lazy-subagents cancel <runId>",
    "  /lazy-subagents clear [all|runId]",
    "",
    "Tool usage:",
    "  lazy_subagents action=help",
    "  lazy_subagents action=list",
    "  lazy_subagents action=run agent=<agent> prompt=<prompt> [title=<title>] [name=<name>]",
    "  lazy_subagents action=parallel children=[{agent,prompt,taskSummary?,cwd?}, ...] [title=<title>]",
    "  lazy_subagents action=workflow steps=[{id,agent,prompt,taskSummary?,dependsOn?,retries?,outputMode?,outputSchema?,when?,fanOutFrom?,cwd?}, ...] [maxConcurrency=<n>] [title=<title>]",
    "  lazy_subagents action=continue target=<name|runId> prompt=<new prompt> [title=<title>]",
    "  lazy_subagents action=status [runId=<runId>]",
    `  lazy_subagents action=wait [runId=<runId>] [timeoutMs=${DEFAULT_WAIT_TIMEOUT_MS}]`,
    "  lazy_subagents action=result runId=<runId>",
    "  lazy_subagents action=pickup runId=<runId>",
    "  lazy_subagents action=pin runId=<runId|on|off>",
    "  lazy_subagents action=cancel runId=<runId>",
    "  lazy_subagents action=clear [scope=completed|all] [runId=<runId>]",
    "",
    "Run lifecycle:",
    "  - Unnamed completed runs auto-hide after a short grace window. No manual clear needed.",
    "  - Names are only supported for action=run single runs; group and workflow runs cannot be continued by name.",
    "  - Named completed single runs stay visible and followup-able for a bounded lease (default 30 min).",
    "  - When the lease expires, named successes are hidden and can no longer be resumed.",
    "  - Failed, attention-needed, and pinned runs always stay visible until resolved or cleared.",
    "  - Use action=continue target=<name> prompt=<new prompt> to send a follow-up task to a completed named agent.",
    "    The agent resumes in its existing session directory and runs another turn.",
    "  - Continuation is only supported for single runs, not group or workflow runs.",
    "",
    "Use /lazy-subagents list or lazy_subagents action=list to inspect available sub agents before choosing one.",
    "Use lazy_subagents action=parallel with children=[...] for two or more independent tasks that should run at the same time.",
    "workflow is for dependent pipelines that should pass step results directly in the background.",
    "Workflow steps can retry transient failures, require JSON object results, skip unnecessary work with when, and create fan-out groups with fanOutFrom.",
    "Workflow steps can reference earlier results with {{stepId.summary}}, {{stepId.output}}, {{stepId.json}}, structured fields such as {{stepId.structured.title}}, and {{item.field}} in fanOutFrom templates.",
    "dependsOn may be omitted for dependencies directly inferable from {{stepId...}} references in prompt/when or from fanOutFrom.step; the runner adds them automatically while preserving explicit dependencies first.",
    "A step depending on a fanOutFrom step waits for all expanded children and can consume the aggregate with {{group.summary}}, {{group.output}}, {{group.json}}, or {{group.structured.children}}.",
    "For outputMode=json, raw JSON is preferred, but fenced json blocks and embedded JSON objects are accepted.",
    "",
    "Examples:",
    "  /lazy-subagents list",
    "  /lazy-subagents run reviewer \"Review the auth diff\"",
    "  /lazy-subagents run reviewer \"Review the auth diff\" --name diff-reviewer",
    "  /lazy-subagents continue diff-reviewer \"I applied your fixes; validate\"",
    "  /lazy-subagents run scout \"Inspect the package layout\"",
    "  lazy_subagents action=list",
    "  lazy_subagents action=run agent=reviewer prompt=\"Review the auth diff\" name=diff-reviewer",
    "  lazy_subagents action=continue target=diff-reviewer prompt=\"I applied your fixes; validate\"",
    "  lazy_subagents action=run agent=worker prompt=\"Implement the requested fix\"",
    "  lazy_subagents action=parallel children=[{agent:\"scout\",prompt:\"Inspect the package layout\"},{agent:\"reviewer\",prompt:\"Review the auth diff\"}]",
    "  lazy_subagents action=parallel children=[{agent:\"reviewer\",prompt:\"Review the diff\"},{agent:\"scout\",prompt:\"Find related docs\"},{agent:\"worker\",prompt:\"Prototype the isolated parser change\"}]",
    "  lazy_subagents action=workflow steps=[{id:\"triage\",agent:\"scout\",outputMode:\"json\",outputSchema:\"{ summary: string, runSecurity: boolean, reviewers: Array<{ id: string, agent: string, prompt: string }> }\",prompt:\"Decide which reviewers are needed\"},{id:\"security\",agent:\"reviewer\",dependsOn:[\"triage\"],when:\"{{triage.structured.runSecurity}}\",prompt:\"Review security risks using {{triage.json}}\"},{id:\"review\",agent:\"{{item.agent}}\",dependsOn:[\"triage\"],fanOutFrom:{step:\"triage\",path:\"structured.reviewers\",idField:\"id\",maxItems:3},prompt:\"{{item.prompt}}\"},{id:\"synth\",agent:\"delegate\",dependsOn:[\"review\"],prompt:\"Synthesize fan-out results: {{review.json}}\"}] maxConcurrency=2",
    "",
    "Tool note: action=run defaults agent to delegate.",
    "Default flow: launch, then return to the user or continue work. Signals arrive automatically.",
    "wait blocks the main turn. Use it only for explicit blocking requests or scripts.",
    "status is for human-requested health checks, suspected stalls, or after about 60s with no signal. Do not poll.",
    "Use result after completion, pickup to inject the result, and pin off/on to hide or restore the durable widget progress panel.",
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
    case "list":
      return buildLazySubagentsAgentList();
    case "status":
      await controller.pollOnce();
      return formatStatusReport(controller.getSnapshot(), parsed.runId);
    case "wait":
      return formatWaitReport(await controller.waitForRunSignal(parsed.runId, { timeoutMs: parsed.timeoutMs, ctx }));
    case "result": {
      const result = await controller.getRunResult(parsed.runId);
      if (result) controller.acknowledgeRun(parsed.runId);
      return result ?? `Result not available for ${parsed.runId}.`;
    }
    case "pickup":
      return (await controller.pickupRun(parsed.runId, ctx))
        ? `Injected result from ${parsed.runId} into chat.`
        : `Run not found: ${parsed.runId}`;
    case "pin": {
      if (parsed.runId === "off") {
        await controller.setPinnedWidgetVisible(false, ctx);
        return "Pinned widget hidden.";
      }
      if (parsed.runId === "on") {
        await controller.setPinnedWidgetVisible(true, ctx);
        return "Pinned widget visible.";
      }
      const outcome = await controller.pinRunWithOutcome(parsed.runId, ctx);
      if (outcome === "pinned") return `Pinned ${parsed.runId} in widget.`;
      if (outcome === "not_pinnable") return `Run already complete: ${parsed.runId} is not pinned in widget.`;
      return `Run not found: ${parsed.runId}`;
    }
    case "cancel":
      return (await controller.cancelRun(parsed.runId, ctx))
        ? `Cancelled ${parsed.runId}.`
        : `Could not cancel ${parsed.runId}.`;
    case "continue": {
      try {
        const run = await controller.continueChild(
          parsed.target,
          parsed.prompt,
          parsed.title ?? shortTitle(parsed.prompt),
          ctx,
        );
        return formatLaunchAcknowledgement(`Continued ${run.id} (${run.agent}).`);
      } catch (error) {
        return `Could not continue ${parsed.target}: ${error instanceof Error ? error.message : String(error)}`;
      }
    }
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
          name: parsed.name,
        },
        ctx,
      );
      return formatLaunchAcknowledgement(`Launched ${run.id} (${run.agent}).`);
    }
  }
}
