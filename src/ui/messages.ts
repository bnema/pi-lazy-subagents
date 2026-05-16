import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Box, Text } from "@earendil-works/pi-tui";

import { GLYPH_PINNED } from "./glyphs.js";
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

function normalizePreviewText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function distinctPreview(title: string, preview?: string): string | undefined {
  if (!preview) return undefined;
  return normalizePreviewText(title) === normalizePreviewText(preview) ? undefined : preview;
}

function completionActions(run: RunRecord): string {
  return `Use /lazy-subagents result ${run.id} or /lazy-subagents pickup ${run.id}`;
}

export function createLaunchMessagePayload(run: RunRecord): RunMessagePayload {
  const title = run.title || run.taskSummary;
  return makePayload("launch", run, distinctPreview(title, run.taskSummary) ?? `Use /lazy-subagents status ${run.id}`);
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

function coerceMessageText(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return String(value);
}

function firstPreviewLine(preview: unknown): string | undefined {
  if (typeof preview !== "string") return undefined;
  return preview.split("\n", 1)[0] ?? preview;
}

export function formatRunMessageBody(payload: RunMessagePayload, expanded: boolean): string {
  const summary = coerceMessageText(payload.summary);
  const preview = typeof payload.preview === "string" ? payload.preview : undefined;

  if (!preview) return summary;
  if (expanded) return `${summary}\n${preview}`;
  return `${summary}\n${firstPreviewLine(preview) ?? ""}`.trimEnd();
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

function messageKindColor(kind: RunMessageKind): "accent" | "success" | "error" | "warning" {
  switch (kind) {
    case "launch":
      return "accent";
    case "completion":
      return "success";
    case "failure":
      return "error";
    case "attention":
      return "warning";
  }
}

function messageKindLabel(payload: Pick<RunMessagePayload, "kind" | "run">): string {
  switch (payload.kind) {
    case "launch":
      return payload.run.status === "queued" ? "QUEUED" : "LIVE";
    case "completion":
      return "DONE";
    case "failure":
      return "FAIL";
    case "attention":
      return "ATTN";
  }
}

export function renderRunMessageText(payload: RunMessagePayload, expanded: boolean, theme?: {
  fg(color: string, text: string): string;
  bold(text: string): string;
}): string {
  const title = payload.run.title || payload.run.taskSummary;
  const kindLabel = messageKindLabel(payload);
  const label = theme
    ? theme.fg(messageKindColor(payload.kind), `[${kindLabel}]`)
    : `[${kindLabel}]`;
  const header = `${label} ${theme ? theme.bold(title) : title}`;
  const metaParts = [`agent ${payload.run.agent}`, payload.run.status];
  if (payload.kind === "launch") metaParts.push(`run ${payload.run.id}`);
  if (payload.run.totalTokens !== undefined && payload.run.totalTokens > 0) {
    metaParts.push(`${formatCompactThousands(payload.run.totalTokens)} tok`);
  }

  const lines = [header, theme ? theme.fg("muted", metaParts.join(" · ")) : metaParts.join(" · ")];
  if (payload.run.model) {
    lines.push(theme ? theme.fg("muted", `model ${payload.run.model}`) : `model ${payload.run.model}`);
  }
  const preview = typeof payload.preview === "string" ? payload.preview : undefined;
  if (preview) {
    lines.push(expanded ? preview : firstPreviewLine(preview) ?? "");
  }

  return lines.join("\n");
}

function renderRunMessage(
  message: { content: string; details?: unknown },
  expanded: boolean,
  theme?: {
    fg(color: string, text: string): string;
    bg(color: string, text: string): string;
    bold(text: string): string;
  },
) {
  const payload = isRunMessagePayload(message.details) ? message.details : undefined;
  if (!payload || !theme) return new Text(payload ? formatRunMessageBody(payload, expanded) : message.content, 0, 0);

  const box = new Box(1, 0, (text) => theme.bg("customMessageBg", text));
  box.addChild(new Text(renderRunMessageText(payload, expanded, theme), 0, 0));
  return box;
}

type PinnedThemeLike = {
  bg(color: string, text: string): string;
  fg?(color: string, text: string): string;
  bold?(text: string): string;
};

function pinnedColor(theme: PinnedThemeLike | undefined, color: string, text: string): string {
  return theme?.fg ? theme.fg(color, text) : text;
}

function pinnedBold(theme: PinnedThemeLike | undefined, text: string): string {
  return theme?.bold ? theme.bold(text) : text;
}

function pinnedStatusColor(status: string): "accent" | "success" | "warning" | "error" | "muted" {
  switch (status) {
    case "running":
      return "accent";
    case "completed":
      return "success";
    case "blocked":
    case "paused":
    case "queued":
      return "warning";
    case "failed":
      return "error";
    default:
      return "muted";
  }
}

function stylePinnedMetaLine(line: string, theme: PinnedThemeLike): string {
  const parts = line.split(" · ").map((part) => part.trim()).filter(Boolean);
  if (parts.length === 0) return line;

  const [agent, status, ...rest] = parts;
  const sep = pinnedColor(theme, "dim", " · ");
  const styled = [
    `${pinnedColor(theme, "dim", "agent")} ${pinnedBold(theme, agent)}`,
  ];

  if (status) styled.push(pinnedColor(theme, pinnedStatusColor(status), status.toUpperCase()));
  if (rest.length > 0) styled.push(pinnedColor(theme, "muted", rest.join(" · ")));
  return styled.join(sep);
}

function stylePinnedAuxLine(line: string, label: "model" | "run", theme: PinnedThemeLike): string {
  const value = line.slice(label.length).trim();
  return `${pinnedColor(theme, "dim", `${label} `)}${pinnedColor(theme, label === "model" ? "muted" : "dim", value)}`;
}

function stylePinnedToolLine(
  head: string,
  parts: string[],
  prefixText: string,
  sep: string,
  theme: PinnedThemeLike,
): string {
  const color = head === "tool end" ? "success" : "accent";
  const icon = pinnedColor(theme, color, head === "tool end" ? "✓" : "↗");
  const [tool, ...detailParts] = parts;
  const detail = detailParts.join(" · ");
  return `${prefixText}${icon} ${pinnedColor(theme, color, head)}${tool ? `${sep}${pinnedBold(theme, tool)}` : ""}${detail ? `${sep}${pinnedColor(theme, "muted", detail)}` : ""}`;
}

function stylePinnedAssistantLine(parts: string[], prefixText: string, sep: string, theme: PinnedThemeLike): string {
  const icon = pinnedColor(theme, "success", "✦");
  const detail = parts.join(" · ");
  return `${prefixText}${icon} ${pinnedColor(theme, "muted", "assistant")}${detail ? `${sep}${detail}` : ""}`;
}

function stylePinnedTurnEndLine(parts: string[], prefixText: string, sep: string, theme: PinnedThemeLike): string {
  const detail = parts.join(" · ");
  return `${prefixText}${pinnedColor(theme, "muted", "•")} ${pinnedColor(theme, "muted", "turn end")}${detail ? `${sep}${pinnedColor(theme, "muted", detail)}` : ""}`;
}

function stylePinnedErrorLine(body: string, prefixText: string, theme: PinnedThemeLike): string {
  return `${prefixText}${pinnedColor(theme, "error", "!")}${body ? ` ${pinnedColor(theme, "error", body)}` : ""}`;
}

function stylePinnedDefaultLine(body: string, prefixText: string, theme: PinnedThemeLike): string {
  return `${prefixText}${pinnedColor(theme, "muted", "•")}${body ? ` ${pinnedColor(theme, "muted", body)}` : ""}`;
}

function stylePinnedDetailLine(line: string, theme: PinnedThemeLike): string {
  const trimmed = line.trim();
  if (!trimmed) return "";

  const parts = trimmed.split(" · ").map((part) => part.trim()).filter(Boolean);
  const prefix = parts.length > 1 && /^#\d+/.test(parts[0] ?? "") ? parts.shift() : undefined;
  const head = parts.shift() ?? trimmed;
  const body = [head, ...parts].filter(Boolean).join(" · ");
  const sep = pinnedColor(theme, "dim", " · ");
  const prefixText = prefix ? `${pinnedColor(theme, "dim", prefix)}${sep}` : "";

  if (head === "tool start" || head === "tool end") {
    return stylePinnedToolLine(head, parts, prefixText, sep, theme);
  }

  if (head === "assistant") {
    return stylePinnedAssistantLine(parts, prefixText, sep, theme);
  }

  if (head === "turn end") {
    return stylePinnedTurnEndLine(parts, prefixText, sep, theme);
  }

  if (head.includes("fail") || head.includes("error")) {
    return stylePinnedErrorLine(body, prefixText, theme);
  }

  return stylePinnedDefaultLine(body, prefixText, theme);
}

function stylePinnedRunLines(lines: string[], theme: PinnedThemeLike | undefined): string[] {
  if (!theme?.fg || !theme.bold) return lines;
  if (lines.length === 0) return lines;

  const [headerLine, metaLine, ...rest] = lines;
  const title = headerLine.startsWith(`${GLYPH_PINNED} `) ? headerLine.slice(GLYPH_PINNED.length + 1) : headerLine;
  const styled = [
    `${pinnedColor(theme, "accent", "[PINNED]")} ${pinnedBold(theme, title)}`,
  ];

  if (metaLine) styled.push(stylePinnedMetaLine(metaLine, theme));

  const auxLines: string[] = [];
  const detailLines: string[] = [];
  for (const line of rest) {
    if (line.startsWith("model ")) {
      auxLines.push(stylePinnedAuxLine(line, "model", theme));
      continue;
    }
    if (line.startsWith("run ")) {
      auxLines.push(stylePinnedAuxLine(line, "run", theme));
      continue;
    }
    detailLines.push(stylePinnedDetailLine(line, theme));
  }

  styled.push(...auxLines);
  if (detailLines.length > 0) {
    styled.push(pinnedColor(theme, "dim", "progress"));
    styled.push(...detailLines.filter(Boolean));
  }

  return styled;
}

function createPinnedRunMessageComponent(
  runId: string,
  expanded: boolean,
  theme: PinnedThemeLike | undefined,
  getPinnedRunLines: (runId: string, expanded: boolean) => string[],
) {
  return {
    render(width: number) {
      const lines = stylePinnedRunLines(getPinnedRunLines(runId, expanded), theme);
      const text = new Text(lines.join("\n"), 0, 0);
      if (!theme) return text.render(width);
      const box = new Box(1, 0, (value) => theme.bg("customMessageBg", value));
      box.addChild(text);
      return box.render(width);
    },
    invalidate() {},
  };
}

export function registerRunMessageRenderers(
  pi: ExtensionAPI,
  options: { getPinnedRunLines?: (runId: string, expanded: boolean) => string[] } = {},
): void {
  const register = (customType: string) => {
    pi.registerMessageRenderer(customType, (message, options, theme) => renderRunMessage(message as { content: string; details?: unknown }, options.expanded, theme as any));
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

    return createPinnedRunMessageComponent(payload.runId, optionsArg.expanded, theme as any, options.getPinnedRunLines);
  });
}
