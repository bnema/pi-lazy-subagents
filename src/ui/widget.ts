import type { RunEvent, RunRecord, RunRegistrySnapshot } from "../types.js";
import { formatAge, formatCompactThousands, formatDuration } from "../utils/time.js";

export interface WidgetViewModel {
  lines: string[];
  snapshot: RunRegistrySnapshot;
}

export interface WidgetThemeLike {
  fg(color: string, text: string): string;
  dim?(text: string): string;
  muted?(text: string): string;
  bold?(text: string): string;
}

function iconForRun(run: RunRecord): string {
  switch (run.status) {
    case "queued":
      return "○";
    case "running":
      return "↻";
    case "blocked":
      return "!";
    case "completed":
      return "✓";
    case "failed":
      return "✕";
    case "cancelled":
      return "∅";
    case "paused":
      return "⏸";
  }
}

function iconColor(run: RunRecord): string {
  switch (run.status) {
    case "queued":
      return "muted";
    case "running":
      return "accent";
    case "blocked":
    case "paused":
      return "warning";
    case "completed":
      return "success";
    case "failed":
    case "cancelled":
      return "error";
  }
}

function latestEvent(run: RunRecord): RunEvent | undefined {
  return run.recentEvents[run.recentEvents.length - 1];
}

function cleanSummary(run: RunRecord, summary: string | undefined): string | undefined {
  if (!summary) return undefined;
  return summary.startsWith(`${run.id} `) ? summary.slice(run.id.length + 1) : summary;
}

function timingSummary(run: RunRecord, now: number): string {
  if (run.completedAt) {
    if (run.status === "completed") return `done ${formatAge({ now, timestamp: run.completedAt })}`;
    if (run.status === "failed") return `failed ${formatAge({ now, timestamp: run.completedAt })}`;
    if (run.status === "cancelled") return `cancelled ${formatAge({ now, timestamp: run.completedAt })}`;
    return `done ${formatAge({ now, timestamp: run.completedAt })}`;
  }

  if (run.status === "blocked") {
    return `quiet ${formatDuration(now - run.updatedAt)}`;
  }

  return `elapsed ${formatDuration(now - run.startedAt)} · upd ${formatDuration(now - run.updatedAt)}`;
}

function dim(text: string, theme?: WidgetThemeLike): string {
  return theme?.dim ? theme.dim(text) : text;
}

function muted(text: string, theme?: WidgetThemeLike): string {
  return theme?.muted ? theme.muted(text) : text;
}

function bold(text: string, theme?: WidgetThemeLike): string {
  return theme?.bold ? theme.bold(text) : text;
}

function color(text: string, colorName: string, theme?: WidgetThemeLike): string {
  return theme ? theme.fg(colorName, text) : text;
}

function headerLine(run: RunRecord, now: number, theme?: WidgetThemeLike): string {
  const parts = [color(iconForRun(run), iconColor(run), theme), color(run.agent, "text", theme), dim(timingSummary(run, now), theme)];
  if (run.currentTool) parts.push(color(run.currentTool, "text", theme));
  if (run.toolCount !== undefined) parts.push(muted(`${run.toolCount} tools`, theme));
  if (run.totalTokens !== undefined) parts.push(muted(`${formatCompactThousands(run.totalTokens)} tok`, theme));
  return parts.join(dim(" · ", theme));
}

function detailLine(run: RunRecord, theme?: WidgetThemeLike): string {
  const title = bold(run.title || run.taskSummary, theme);
  const detail = cleanSummary(run, latestEvent(run)?.summary)
    ?? run.resultPreview
    ?? run.errorPreview;
  return detail ? `  ${title}${dim(" · ", theme)}${muted(detail, theme)}` : `  ${title}`;
}

export function buildWidgetLines(snapshot: RunRegistrySnapshot, now = Date.now(), limit = 6, theme?: WidgetThemeLike): string[] {
  const runs = [...snapshot.activeRuns, ...snapshot.recentRuns];
  const lines = runs.flatMap((run) => [headerLine(run, now, theme), detailLine(run, theme)]);
  return lines.slice(0, limit);
}
