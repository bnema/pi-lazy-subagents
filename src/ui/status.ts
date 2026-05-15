import type { RunRegistrySnapshot } from "../types.js";
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

function needsAttention(snapshot: RunRegistrySnapshot): number {
  return snapshot.runs.filter((run) => (
    run.attentionNeeded
      || run.status === "failed"
      || run.status === "blocked"
      || run.status === "paused"
      || (run.status === "completed" && run.completionPolicy === "manual_pickup")
  )).length;
}

function countLiveRuns(snapshot: RunRegistrySnapshot): number {
  return snapshot.activeRuns.filter((run) => run.status !== "blocked" && run.status !== "paused").length;
}

export function buildFooterStatus(snapshot: RunRegistrySnapshot, theme?: StatusThemeLike): string | undefined {
  if (snapshot.runs.length === 0) return undefined;

  const liveCount = countLiveRuns(snapshot);
  const attentionCount = needsAttention(snapshot);
  const inboxCount = snapshot.recentRuns.filter((run) => run.status === "completed" && !run.attentionNeeded && run.completionPolicy !== "manual_pickup").length;

  const parts = [
    `${colorize(GLYPH_LAZY_SUBAGENTS, "accent", theme)} ${bold("lazy", theme)}`,
  ];

  if (liveCount > 0) parts.push(colorize(pluralize(liveCount, "live"), "accent", theme));
  if (attentionCount > 0) parts.push(colorize(pluralize(attentionCount, "attention"), "warning", theme));
  if (inboxCount > 0) parts.push(colorize(pluralize(inboxCount, "inbox"), "success", theme));
  if (parts.length === 1) parts.push(colorize(pluralize(snapshot.runs.length, "run"), "muted", theme));

  return parts.join(colorize(" · ", "dim", theme));
}
