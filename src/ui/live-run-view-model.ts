import type { RunRecord } from "../types.js";
import { formatCompactThousands } from "../utils/time.js";
import { summarizeSingleLine } from "../utils/text.js";
import { GLYPH_PINNED } from "./glyphs.js";

interface LiveRunProgressStats {
  turnCount: number;
  lastTurnTokens?: number;
}

interface LiveRunViewModelOptions {
  expanded?: boolean;
  progressLines?: string[];
  progressStats?: LiveRunProgressStats;
  maxCompactDetails?: number;
  maxExpandedDetails?: number;
}

interface LiveRunViewModel {
  runId: string;
  title: string;
  metaLine: string;
  detailLines: string[];
  lines: string[];
}

function buildLiveRunDetailLines(run: RunRecord, progressLines?: string[]): string[] {
  return progressLines
    ?? run.recentEvents.map((event) => summarizeSingleLine(event.summary)).filter((line): line is string => Boolean(line));
}

export function buildLiveRunViewModel(run: RunRecord, options: LiveRunViewModelOptions = {}): LiveRunViewModel {
  const expanded = options.expanded ?? false;
  const title = run.title || run.taskSummary;
  const stats = options.progressStats;
  const metaParts = [run.agent, run.status];
  if (stats?.turnCount) metaParts.push(`${stats.turnCount} turns`);
  if (stats?.lastTurnTokens) metaParts.push(`last ${formatCompactThousands(stats.lastTurnTokens)} tok`);
  if (run.currentTool) metaParts.push(run.currentTool);
  if (run.toolCount !== undefined && run.toolCount > 0) metaParts.push(`${run.toolCount} tools`);
  if (run.totalTokens !== undefined && run.totalTokens > 0) metaParts.push(`${formatCompactThousands(run.totalTokens)} tokens`);

  const detailLines = buildLiveRunDetailLines(run, options.progressLines);
  const maxDetails = expanded ? options.maxExpandedDetails ?? 20 : options.maxCompactDetails ?? 8;
  const visibleLines = detailLines.slice(Math.max(0, detailLines.length - maxDetails));

  const lines = [
    `${GLYPH_PINNED} ${title}`,
    metaParts.join(" · "),
    ...(run.model ? [`model ${run.model}`] : []),
    ...(expanded ? [`run ${run.id}`] : []),
    ...visibleLines.map((line) => `  ${line}`),
  ];

  return {
    runId: run.id,
    title,
    metaLine: metaParts.join(" · "),
    detailLines,
    lines,
  };
}
