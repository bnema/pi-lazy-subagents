import type { RunRecord, RunRegistrySnapshot } from "../types.js";
import { formatCompactThousands, formatDuration } from "../utils/time.js";
import { GLYPH_LAZY_SUBAGENTS } from "./glyphs.js";

export interface FooterStatusViewModel {
  text?: string;
  snapshot: RunRegistrySnapshot;
}

export interface StatusThemeLike {
  fg(color: string, text: string): string;
  bold?(text: string): string;
}

function colorize(text: string, color: string, theme?: StatusThemeLike): string {
  return theme ? theme.fg(color, text) : text;
}

function bold(text: string, theme?: StatusThemeLike): string {
  return theme?.bold ? theme.bold(text) : text;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function shorten(text: string, max = 24): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length <= max ? singleLine : `${singleLine.slice(0, max - 1).trimEnd()}…`;
}

function needsAttention(run: RunRecord): boolean {
  return run.attentionNeeded
    || run.status === "failed"
    || run.status === "blocked"
    || run.status === "paused"
    || (run.status === "completed" && run.completionPolicy === "manual_pickup");
}

function latestInboxRun(snapshot: RunRegistrySnapshot): RunRecord | undefined {
  return snapshot.recentRuns.find((run) => run.status === "completed") ?? snapshot.recentRuns[0];
}

function primaryRun(snapshot: RunRegistrySnapshot): RunRecord | undefined {
  return snapshot.runs.find((run) => needsAttention(run))
    ?? snapshot.activeRuns[0]
    ?? latestInboxRun(snapshot);
}

function primaryTiming(run: RunRecord, now: number): string {
  if (run.status === "completed" && run.completedAt) return `done ${formatDuration(now - run.completedAt)}`;
  if (run.status === "failed" && run.completedAt) return `failed ${formatDuration(now - run.completedAt)}`;
  if (run.status === "blocked") return `quiet ${formatDuration(now - run.updatedAt)}`;
  if (run.status === "paused") return `paused ${formatDuration(now - run.updatedAt)}`;
  if (run.status === "queued") return `queued ${formatDuration(now - run.startedAt)}`;
  return `upd ${formatDuration(now - run.updatedAt)}`;
}

export function buildFooterStatus(snapshot: RunRegistrySnapshot, now = Date.now(), theme?: StatusThemeLike): string | undefined {
  if (snapshot.runs.length === 0) return undefined;

  const liveCount = snapshot.activeRuns.length;
  const attentionCount = snapshot.runs.filter((run) => needsAttention(run)).length;
  const inboxCount = snapshot.recentRuns.filter((run) => run.status === "completed" && !needsAttention(run)).length;
  const primary = primaryRun(snapshot);

  const parts = [
    `${colorize(GLYPH_LAZY_SUBAGENTS, "accent", theme)} ${bold("lazy", theme)}`,
  ];

  if (liveCount > 0) parts.push(colorize(pluralize(liveCount, "live"), "accent", theme));
  if (attentionCount > 0) parts.push(colorize(pluralize(attentionCount, "attention"), "warning", theme));
  if (inboxCount > 0) parts.push(colorize(pluralize(inboxCount, "inbox"), "success", theme));

  if (primary) {
    parts.push(colorize(shorten(primary.title || primary.taskSummary), needsAttention(primary) ? "warning" : primary.status === "completed" ? "success" : "text", theme));
    if (primary.currentTool) parts.push(colorize(primary.currentTool, "text", theme));
    if (primary.totalTokens !== undefined && primary.totalTokens > 0) parts.push(colorize(`${formatCompactThousands(primary.totalTokens)} tok`, "muted", theme));
    parts.push(colorize(primaryTiming(primary, now), "dim", theme));
  }

  return parts.join(colorize(" · ", "dim", theme));
}
