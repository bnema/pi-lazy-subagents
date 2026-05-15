import type { RunRecord, RunRegistrySnapshot } from "../types.js";

export interface HiddenSummary {
  text: string;
  snapshot: RunRegistrySnapshot;
}

function linesForRun(run: RunRecord): string[] {
  const lines = [
    "Lazy subagent update",
    `- Run: ${run.id}`,
    `- Agent: ${run.agent}`,
    `- Title: ${run.title || run.taskSummary}`,
    `- Status: ${run.status}`,
    `- Completion policy: ${run.completionPolicy}`,
  ];

  const preview = run.resultPreview ?? run.errorPreview;
  if (preview) lines.push(`- Summary: ${preview}`);
  if (run.sessionFile) lines.push(`- Session: ${run.sessionFile}`);
  if (run.artifactPath) lines.push(`- Artifact: ${run.artifactPath}`);

  return lines;
}

export function buildHiddenSummary(run: RunRecord, snapshot: RunRegistrySnapshot): HiddenSummary {
  const lines = linesForRun(run);
  lines.push(`- Active runs: ${snapshot.activeRuns.length}`);
  lines.push(`- Recent runs: ${snapshot.recentRuns.length}`);

  return {
    text: lines.join("\n"),
    snapshot,
  };
}
