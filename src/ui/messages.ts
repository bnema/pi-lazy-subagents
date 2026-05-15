import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { formatCompactThousands } from "../utils/time.js";
import {
  MESSAGE_TYPE_ATTENTION,
  MESSAGE_TYPE_COMPLETION,
  MESSAGE_TYPE_FAILURE,
  MESSAGE_TYPE_LAUNCH,
  MESSAGE_TYPE_PIN,
} from "../defaults.js";
import type { RunRecord } from "../types.js";

export type RunMessageKind = "launch" | "completion" | "failure" | "attention";

export interface RunMessagePayload {
  kind: RunMessageKind;
  run: RunRecord;
  summary: string;
  preview?: string;
}

export interface PinnedRunMessagePayload {
  runId: string;
}

function messageTitle(kind: RunMessageKind): string {
  switch (kind) {
    case "launch":
      return "Launched";
    case "completion":
      return "Completed";
    case "failure":
      return "Failed";
    case "attention":
      return "Attention needed";
  }
}

function tokenSuffix(run: RunRecord): string {
  return run.totalTokens !== undefined ? ` · ${formatCompactThousands(run.totalTokens)} tokens` : "";
}

function latestAttentionSummary(run: RunRecord): string | undefined {
  return [...run.recentEvents].reverse().find((event) => event.category === "attention")?.summary;
}

function makePayload(kind: RunMessageKind, run: RunRecord, preview?: string): RunMessagePayload {
  const summary = `${messageTitle(kind)} · ${run.agent} · ${run.title || run.taskSummary}`
    + (kind === "completion" ? tokenSuffix(run) : "");
  return {
    kind,
    run,
    summary,
    preview,
  };
}

function completionActions(run: RunRecord): string {
  return `Use /lazy-subagents result ${run.id} or /lazy-subagents pickup ${run.id}`;
}

export function createLaunchMessagePayload(run: RunRecord): RunMessagePayload {
  return makePayload("launch", run, run.taskSummary);
}

export function createCompletionMessagePayload(run: RunRecord): RunMessagePayload {
  const preview = [run.resultPreview, completionActions(run)].filter(Boolean).join("\n");
  return makePayload("completion", run, preview || undefined);
}

export function createFailureMessagePayload(run: RunRecord): RunMessagePayload {
  const preview = [run.errorPreview, completionActions(run)].filter(Boolean).join("\n");
  return makePayload("failure", run, preview || undefined);
}

export function createAttentionMessagePayload(run: RunRecord): RunMessagePayload {
  const preview = [latestAttentionSummary(run), run.errorPreview ?? run.resultPreview, `Use /lazy-subagents status ${run.id}`]
    .filter(Boolean)
    .join("\n");
  return makePayload("attention", run, preview || undefined);
}

export function formatRunMessageBody(payload: RunMessagePayload, expanded: boolean): string {
  if (!payload.preview) return payload.summary;
  if (expanded) return `${payload.summary}\n${payload.preview}`;
  if (payload.kind === "launch") return payload.summary;
  return `${payload.summary}\n${payload.preview.split("\n", 1)[0]}`;
}

function isRunMessagePayload(value: unknown): value is RunMessagePayload {
  return typeof value === "object"
    && value !== null
    && "kind" in value
    && "summary" in value
    && "run" in value;
}

function isPinnedRunMessagePayload(value: unknown): value is PinnedRunMessagePayload {
  return typeof value === "object"
    && value !== null
    && "runId" in value;
}

function renderRunMessage(message: { content: string; details?: unknown }, expanded: boolean): Text {
  const payload = isRunMessagePayload(message.details) ? message.details : undefined;
  if (!payload) return new Text(message.content, 0, 0);
  return new Text(formatRunMessageBody(payload, expanded), 0, 0);
}

export function registerRunMessageRenderers(
  pi: ExtensionAPI,
  options: { getPinnedRunLines?: (runId: string, expanded: boolean) => string[] } = {},
): void {
  const register = (customType: string) => {
    pi.registerMessageRenderer(customType, (message, options) => renderRunMessage(message as { content: string; details?: unknown }, options.expanded));
  };

  register(MESSAGE_TYPE_LAUNCH);
  register(MESSAGE_TYPE_COMPLETION);
  register(MESSAGE_TYPE_FAILURE);
  register(MESSAGE_TYPE_ATTENTION);
  pi.registerMessageRenderer(MESSAGE_TYPE_PIN, (message, optionsArg, theme) => {
    const payload = isPinnedRunMessagePayload(message.details) ? message.details : undefined;
    if (!payload || !options.getPinnedRunLines) {
      return new Text(typeof message.content === "string" ? message.content : "Pinned lazy subagent", 0, 0);
    }

    return {
      render() {
        const lines = options.getPinnedRunLines!(payload.runId, optionsArg.expanded);
        return lines.map((line, index) => index === 0 ? theme.fg("accent", line) : index === 1 ? theme.fg("muted", line) : line);
      },
      invalidate() {},
    } as any;
  });
}
