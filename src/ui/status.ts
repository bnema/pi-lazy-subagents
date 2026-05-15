import type { RunRecord, RunRegistrySnapshot } from "../types.js";
import { formatCompactThousands, formatDuration } from "../utils/time.js";

export interface FooterStatusViewModel {
  text?: string;
  snapshot: RunRegistrySnapshot;
}

export interface StatusThemeLike {
  fg(color: string, text: string): string;
}

function pluralize(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function latestFinishedRun(snapshot: RunRegistrySnapshot): RunRecord | undefined {
  return snapshot.recentRuns.find((run) => run.completedAt !== undefined) ?? snapshot.recentRuns[0];
}

function primaryActiveRun(snapshot: RunRegistrySnapshot): RunRecord | undefined {
  return snapshot.activeRuns[0];
}

function colorize(text: string, color: string, theme?: StatusThemeLike): string {
  return theme ? theme.fg(color, text) : text;
}

export function buildFooterStatus(snapshot: RunRegistrySnapshot, now = Date.now(), theme?: StatusThemeLike): string | undefined {
  const parts: string[] = [];
  const { counts } = snapshot;

  if (counts.running > 0) parts.push(colorize(pluralize(counts.running, "running", "running"), "accent", theme));
  if (counts.blocked > 0) parts.push(colorize(pluralize(counts.blocked, "blocked", "blocked"), "warning", theme));
  if (counts.queued > 0) parts.push(colorize(pluralize(counts.queued, "queued", "queued"), "muted", theme));
  if (counts.completed > 0) parts.push(colorize(pluralize(counts.completed, "done"), "success", theme));
  if (counts.failed > 0) parts.push(colorize(pluralize(counts.failed, "failed", "failed"), "error", theme));
  if (counts.paused > 0) parts.push(colorize(pluralize(counts.paused, "paused", "paused"), "warning", theme));

  const active = primaryActiveRun(snapshot);
  if (active?.currentTool) parts.push(colorize(active.currentTool, "text", theme));
  if (active?.totalTokens !== undefined) parts.push(colorize(`${formatCompactThousands(active.totalTokens)} tok`, "muted", theme));
  if (active) parts.push(colorize(`upd ${formatDuration(now - active.updatedAt)}`, "dim", theme));

  const latest = latestFinishedRun(snapshot);
  if (latest?.completedAt && now >= latest.completedAt) {
    parts.push(colorize(`last finish ${formatDuration(now - latest.completedAt)}`, "dim", theme));
  }

  return parts.length > 0 ? `${colorize("●", "accent", theme)} ${parts.join(colorize(" · ", "dim", theme))}` : undefined;
}
