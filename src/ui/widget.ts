import { truncateToWidth } from "@earendil-works/pi-tui";

import type { RunRecord, RunRegistrySnapshot } from "../types.js";
import { formatAge, formatCompactThousands, formatDuration } from "../utils/time.js";
import {
  GLYPH_FAILED,
  GLYPH_INBOX,
  GLYPH_LAZY_SUBAGENTS,
  GLYPH_PAUSED,
  GLYPH_PINNED,
  GLYPH_QUEUED,
  GLYPH_RUNNING,
  GLYPH_WAITING,
} from "./glyphs.js";

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

export interface WidgetBuildOptions {
  isPinned?: (runId: string) => boolean;
}

interface WidgetLabel {
  icon: string;
  label: string;
  color: string;
}

function needsAttention(run: RunRecord): boolean {
  return run.attentionNeeded
    || run.status === "failed"
    || run.status === "blocked"
    || run.status === "paused";
}

function isSuccessfulInboxRun(run: RunRecord, isPinned: boolean): boolean {
  return run.status === "completed"
    && !run.attentionNeeded
    && !isPinned;
}

function runSortKey(run: RunRecord): number {
  return run.completedAt ?? run.updatedAt ?? run.startedAt;
}

function sortByRecencyDesc(a: RunRecord, b: RunRecord): number {
  return runSortKey(b) - runSortKey(a);
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

function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function shortTitle(run: RunRecord): string {
  return run.title || run.taskSummary;
}

function latestMeta(run: RunRecord, now: number): string | undefined {
  if (run.status === "completed" && run.completedAt) return `done ${formatAge({ now, timestamp: run.completedAt })}`;
  if (run.status === "failed" && run.completedAt) return `failed ${formatAge({ now, timestamp: run.completedAt })}`;
  if (run.status === "cancelled" && run.completedAt) return `cancelled ${formatAge({ now, timestamp: run.completedAt })}`;
  if (run.status === "paused") return `paused ${formatDuration(now - run.updatedAt)}`;
  if (run.status === "blocked") return `quiet ${formatDuration(now - run.updatedAt)}`;
  if (run.status === "queued") return `queued ${formatDuration(now - run.startedAt)}`;
  return undefined;
}

function metadataParts(run: RunRecord, now: number): string[] {
  return [
    run.agent,
    latestMeta(run, now),
    run.currentTool,
    run.toolCount !== undefined && run.toolCount > 0 ? `${run.toolCount} tools` : undefined,
    run.totalTokens !== undefined && run.totalTokens > 0 ? `${formatCompactThousands(run.totalTokens)} tok` : undefined,
  ].filter((value): value is string => Boolean(value));
}

function labelForRun(run: RunRecord, isPinned: boolean): WidgetLabel {
  if (needsAttention(run)) {
    if (run.status === "failed") return { icon: GLYPH_FAILED, label: "failed", color: "error" };
    if (run.status === "paused") return { icon: GLYPH_PAUSED, label: "paused", color: "warning" };
    return { icon: GLYPH_WAITING, label: "waiting", color: "warning" };
  }

  if (isPinned) return { icon: GLYPH_PINNED, label: "pinned", color: "accent" };
  if (run.status === "queued") return { icon: GLYPH_QUEUED, label: "queued", color: "muted" };
  return { icon: GLYPH_RUNNING, label: "live", color: "accent" };
}

function formatRunLine(run: RunRecord, now: number, theme?: WidgetThemeLike, isPinned = false): string {
  const label = labelForRun(run, isPinned);
  const prefix = `${color(label.icon, label.color, theme)} ${color(label.label, label.color, theme)}`;
  const title = bold(shortTitle(run), theme);
  const meta = muted(metadataParts(run, now).join(dim(" · ", theme)), theme);
  return `${prefix}${dim(" · ", theme)}${title}${dim(" · ", theme)}${meta}`;
}

function formatInboxLine(runs: RunRecord[], now: number, theme?: WidgetThemeLike): string {
  const latest = [...runs].sort(sortByRecencyDesc)[0];
  if (!latest) return "";

  const prefix = `${color(GLYPH_INBOX, "success", theme)} ${color("inbox", "success", theme)}`;
  const summary = runs.length === 1
    ? bold(shortTitle(latest), theme)
    : bold(`${formatCount(runs.length, "completed")}`, theme);

  const metaParts = runs.length === 1
    ? metadataParts(latest, now)
    : [
      `latest ${shortTitle(latest)}`,
      latest.agent,
      latestMeta(latest, now),
      latest.totalTokens && latest.totalTokens > 0 ? `${formatCompactThousands(latest.totalTokens)} tok` : undefined,
    ].filter((value): value is string => Boolean(value));

  return `${prefix}${dim(" · ", theme)}${summary}${dim(" · ", theme)}${muted(metaParts.join(dim(" · ", theme)), theme)}`;
}

function formatMoreLine(hiddenCount: number, theme?: WidgetThemeLike): string {
  return `${muted("…", theme)} ${muted(`${hiddenCount} more run${hiddenCount === 1 ? "" : "s"}`, theme)}`;
}

function buildSummaryLine(snapshot: RunRegistrySnapshot, theme?: WidgetThemeLike, options: WidgetBuildOptions = {}): string {
  const isPinned = options.isPinned ?? (() => false);
  const liveCount = snapshot.activeRuns.filter((run) => run.status !== "blocked" && run.status !== "paused").length;
  const attentionCount = snapshot.runs.filter((run) => needsAttention(run)).length;
  const pinnedCount = snapshot.runs.filter((run) => isPinned(run.id) && !needsAttention(run)).length;
  const inboxCount = snapshot.recentRuns.filter((run) => isSuccessfulInboxRun(run, isPinned(run.id))).length;

  const parts = [
    `${color(GLYPH_LAZY_SUBAGENTS, "accent", theme)} ${bold("lazy subagents", theme)}`,
  ];

  if (liveCount > 0) parts.push(color(formatCount(liveCount, "live"), "accent", theme));
  if (attentionCount > 0) parts.push(color(formatCount(attentionCount, "attention"), "warning", theme));
  if (pinnedCount > 0) parts.push(color(formatCount(pinnedCount, "pinned"), "accent", theme));
  if (inboxCount > 0) parts.push(color(formatCount(inboxCount, "inbox"), "success", theme));

  return parts.join(dim(" · ", theme));
}

export function buildWidgetLines(
  snapshot: RunRegistrySnapshot,
  now = Date.now(),
  limit = 6,
  theme?: WidgetThemeLike,
  options: WidgetBuildOptions = {},
): string[] {
  if (snapshot.runs.length === 0 || limit <= 0) return [];

  const isPinned = options.isPinned ?? (() => false);
  const header = buildSummaryLine(snapshot, theme, options);

  const attentionRuns = snapshot.runs
    .filter((run) => needsAttention(run))
    .sort(sortByRecencyDesc);

  const pinnedRuns = snapshot.runs
    .filter((run) => !needsAttention(run) && isPinned(run.id))
    .sort(sortByRecencyDesc);

  const hiddenIds = new Set([...attentionRuns, ...pinnedRuns].map((run) => run.id));
  const liveRuns = snapshot.activeRuns
    .filter((run) => !hiddenIds.has(run.id))
    .sort(sortByRecencyDesc);

  const inboxRuns = snapshot.recentRuns
    .filter((run) => isSuccessfulInboxRun(run, isPinned(run.id)))
    .sort(sortByRecencyDesc);

  const featuredRuns = [...attentionRuns, ...pinnedRuns, ...liveRuns];
  const lines = [header];
  const reserveForInbox = inboxRuns.length > 0 ? 1 : 0;
  const reserveForMore = featuredRuns.length > 0 ? 1 : 0;
  const featuredBudget = Math.max(0, limit - lines.length - reserveForInbox - reserveForMore);
  const visibleFeatured = featuredRuns.slice(0, featuredBudget);

  for (const run of visibleFeatured) {
    lines.push(formatRunLine(run, now, theme, isPinned(run.id)));
  }

  if (inboxRuns.length > 0 && lines.length < limit) {
    lines.push(formatInboxLine(inboxRuns, now, theme));
  }

  const hiddenFeatured = Math.max(0, featuredRuns.length - visibleFeatured.length);
  if (hiddenFeatured > 0 && lines.length < limit) {
    lines.push(formatMoreLine(hiddenFeatured, theme));
  }

  return lines.slice(0, limit);
}

export function createWidgetContent(
  snapshot: RunRegistrySnapshot,
  now = Date.now(),
  limit = 6,
  options: WidgetBuildOptions = {},
) {
  if (snapshot.runs.length === 0) return undefined;

  return (_tui: unknown, theme: WidgetThemeLike) => {
    const lines = buildWidgetLines(snapshot, now, limit, theme, options);
    return {
      render(width: number) {
        return lines.map((line) => truncateToWidth(line, Math.max(1, width), "…"));
      },
      invalidate() {},
    };
  };
}
