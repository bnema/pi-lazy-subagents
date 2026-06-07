import { truncateToWidth } from "@earendil-works/pi-tui";

import type { RunRecord, RunRegistrySnapshot } from "../types.js";
import { formatCompactThousands } from "../utils/time.js";
import { GLYPH_LAZY_SUBAGENTS } from "./glyphs.js";

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
  getPinnedProgressLines?: (runId: string) => string[];
  runningDots?: string;
  suppressFocusIdentity?: boolean;
}

const SEPARATOR = " │ ";
const RAIL = "│";
const RUNNING_DOT_FRAMES = ["   ", ".  ", ".. ", "..."];
const RUNNING_DOT_INTERVAL_MS = 450;
const PINNED_DETAIL_LIMIT = 5;

function needsAttention(run: RunRecord): boolean {
  return run.attentionNeeded
    || run.status === "failed"
    || run.status === "blocked"
    || run.status === "paused";
}

function isSuccessfulInboxRun(run: RunRecord, isPinned: boolean): boolean {
  return (run.status === "completed" || run.status === "skipped")
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

function compactTokenCount(tokens: number | undefined, suffix = "tok"): string | undefined {
  return tokens !== undefined && tokens > 0 ? `${formatCompactThousands(tokens)} ${suffix}` : undefined;
}

function joinParts(parts: string[], theme?: WidgetThemeLike): string {
  return parts.filter(Boolean).join(dim(SEPARATOR, theme));
}

function isPinnedPanelEligible(run: RunRecord): boolean {
  return run.status === "queued" || run.status === "running" || run.status === "blocked" || run.status === "paused";
}

function runningRuns(snapshot: RunRegistrySnapshot): RunRecord[] {
  return snapshot.activeRuns.filter((run) => run.status === "running");
}

function queuedRuns(snapshot: RunRegistrySnapshot): RunRecord[] {
  return snapshot.activeRuns.filter((run) => run.status === "queued");
}

function pinnedRuns(snapshot: RunRegistrySnapshot, isPinned: (runId: string) => boolean): RunRecord[] {
  return snapshot.runs
    .filter((run) => isPinned(run.id) && isPinnedPanelEligible(run))
    .sort(sortByRecencyDesc);
}

function lazyFocusRun(snapshot: RunRegistrySnapshot, isPinned: (runId: string) => boolean): RunRecord | undefined {
  return [
    ...snapshot.runs.filter((run) => needsAttention(run)).sort(sortByRecencyDesc),
    ...pinnedRuns(snapshot, isPinned),
    ...runningRuns(snapshot).sort(sortByRecencyDesc),
    ...queuedRuns(snapshot).sort(sortByRecencyDesc),
    ...[...snapshot.recentRuns].sort(sortByRecencyDesc),
  ][0];
}

function buildLazyLine(snapshot: RunRegistrySnapshot, theme?: WidgetThemeLike, options: WidgetBuildOptions = {}): string {
  const isPinned = options.isPinned ?? (() => false);
  const activeRuns = runningRuns(snapshot);
  const attentionCount = snapshot.runs.filter((run) => needsAttention(run)).length;
  const inboxCount = snapshot.recentRuns.filter((run) => isSuccessfulInboxRun(run, isPinned(run.id))).length;
  const focusRun = lazyFocusRun(snapshot, isPinned);

  const parts = [
    `${color(GLYPH_LAZY_SUBAGENTS, "accent", theme)} ${bold("Lazy", theme)}`,
  ];

  if (activeRuns.length > 0) {
    const runningLabel = activeRuns.length === 1 ? "running" : formatCount(activeRuns.length, "running", "running");
    parts.push(color(`${runningLabel}${options.runningDots ?? ""}`, "accent", theme));
  }
  if (attentionCount > 0) parts.push(color(formatCount(attentionCount, "attention"), "warning", theme));
  if (inboxCount > 0) parts.push(color(formatCount(inboxCount, "inbox"), "success", theme));
  if (focusRun) {
    if (!options.suppressFocusIdentity) {
      parts.push(bold(shortTitle(focusRun), theme));
      if (focusRun.currentTool) parts.push(muted(focusRun.currentTool, theme));
    }
    if (focusRun.toolCount !== undefined && focusRun.toolCount > 0) parts.push(muted(`${focusRun.toolCount} tools`, theme));
    const tokens = compactTokenCount(focusRun.totalTokens);
    if (tokens) parts.push(muted(tokens, theme));
  }
  if (parts.length === 1) parts.push(color(formatCount(snapshot.runs.length, "run"), "muted", theme));

  return joinParts(parts, theme);
}

function fallbackProgressLines(run: RunRecord): string[] {
  return run.recentEvents
    .map((event) => event.summary.trim())
    .filter(Boolean);
}

function progressLinesForRun(run: RunRecord, options: WidgetBuildOptions): string[] {
  const detailLines = (options.getPinnedProgressLines?.(run.id) ?? fallbackProgressLines(run))
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  return detailLines.slice(Math.max(0, detailLines.length - PINNED_DETAIL_LIMIT));
}

function formatKnownProgressLine(line: string, theme?: WidgetThemeLike): string {
  const parts = line.split(" · ").map((part) => part.trim()).filter(Boolean);
  const prefix = parts.length > 1 && /^#\d+/.test(parts[0] ?? "") ? parts.shift() : undefined;
  const head = parts.shift();
  if (!head) return line;

  const sep = dim(SEPARATOR, theme);
  const prefixText = prefix ? `${dim(prefix, theme)}${sep}` : "";
  const [firstDetail, ...restDetails] = parts;
  const detail = [firstDetail ? bold(firstDetail, theme) : undefined, ...restDetails.map((part) => muted(part, theme))]
    .filter((part): part is string => Boolean(part))
    .join(sep);

  if (head === "tool start" || head === "tool end") {
    const icon = head === "tool end" ? color("✓", "success", theme) : color("↗", "accent", theme);
    const label = color(head, head === "tool end" ? "success" : "accent", theme);
    return `${prefixText}${icon} ${label}${detail ? `${sep}${detail}` : ""}`;
  }

  if (head === "assistant") {
    return `${prefixText}${color("✦", "success", theme)} ${muted("assistant", theme)}${detail ? `${sep}${detail}` : ""}`;
  }

  if (head === "turn end") {
    return `${prefixText}${muted("•", theme)} ${muted("turn end", theme)}${detail ? `${sep}${detail}` : ""}`;
  }

  if (head.includes("fail") || head.includes("error")) {
    const body = [head, ...parts].join(" · ");
    return `${prefixText}${color("!", "error", theme)} ${color(body, "error", theme)}`;
  }

  return line;
}

function buildPinnedDetailLine(line: string, theme?: WidgetThemeLike): string {
  return `${dim(RAIL, theme)} ${formatKnownProgressLine(line, theme)}`;
}

function buildPinnedPanelLines(runs: RunRecord[], theme: WidgetThemeLike | undefined, options: WidgetBuildOptions): string[] {
  const [primary, ...moreRuns] = runs;
  if (!primary) return [];

  const lines = progressLinesForRun(primary, options).map((line) => buildPinnedDetailLine(line, theme));

  if (moreRuns.length > 0) {
    lines.push(`${dim(RAIL, theme)} ${muted(`… ${formatCount(moreRuns.length, "more", "more")}`, theme)}`);
  }

  return lines;
}

function keepFinalLineVisible(lines: string[], limit: number): string[] {
  if (lines.length <= limit) return lines;
  const finalLine = lines[lines.length - 1]!;
  return [...lines.slice(0, Math.max(0, limit - 1)), finalLine];
}

export function buildWidgetLines(
  snapshot: RunRegistrySnapshot,
  now = Date.now(),
  limit = 6,
  theme?: WidgetThemeLike,
  options: WidgetBuildOptions = {},
): string[] {
  void now;
  if (snapshot.runs.length === 0 || limit <= 0) return [];

  const isPinned = options.isPinned ?? (() => false);
  const pinnedPanelLines = buildPinnedPanelLines(pinnedRuns(snapshot, isPinned), theme, options);
  const lazyLine = buildLazyLine(snapshot, theme, { ...options, suppressFocusIdentity: pinnedPanelLines.length > 0 });

  return keepFinalLineVisible([...pinnedPanelLines, lazyLine], limit);
}

function hasRunningAnimation(snapshot: RunRegistrySnapshot): boolean {
  return runningRuns(snapshot).length > 0;
}

export function createWidgetContent(
  snapshot: RunRegistrySnapshot,
  now = Date.now(),
  limit = 6,
  options: WidgetBuildOptions = {},
) {
  if (snapshot.runs.length === 0) return undefined;

  return (tui: { requestRender?: () => void }, theme: WidgetThemeLike) => {
    let frameIndex = 0;
    const shouldAnimate = hasRunningAnimation(snapshot) && typeof tui.requestRender === "function";
    const interval = shouldAnimate
      ? setInterval(() => {
        frameIndex = (frameIndex + 1) % RUNNING_DOT_FRAMES.length;
        tui.requestRender?.();
      }, RUNNING_DOT_INTERVAL_MS)
      : undefined;
    interval?.unref?.();

    return {
      render(width: number) {
        const runningDots = shouldAnimate ? RUNNING_DOT_FRAMES[frameIndex] : undefined;
        const lines = buildWidgetLines(snapshot, now, limit, theme, { ...options, runningDots });
        return lines.map((line) => truncateToWidth(line, Math.max(1, width), "…"));
      },
      invalidate() {},
      dispose() {
        if (interval) clearInterval(interval);
      },
    };
  };
}
