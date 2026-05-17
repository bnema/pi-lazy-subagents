export function createUsageTracker() {
  return {
    committedTokens: 0,
    currentTurnTokens: 0,
    totalTokens: 0,
    lastCommittedSample: undefined,
    currentTurnLatestSample: undefined,
    currentTurnMaxDelta: 0,
  };
}

function normalizeUsageTotal(totalTokens) {
  return typeof totalTokens === "number" && Number.isFinite(totalTokens) && totalTokens > 0 ? totalTokens : undefined;
}

function calculateSampleDelta(tracker, sampleTotal) {
  if (tracker.lastCommittedSample === undefined) return sampleTotal;
  return Math.max(0, sampleTotal - tracker.lastCommittedSample);
}

export function recordUsageSample(tracker, totalTokens) {
  const sampleTotal = normalizeUsageTotal(totalTokens);
  if (sampleTotal === undefined) {
    tracker.totalTokens = tracker.committedTokens + tracker.currentTurnTokens;
    return tracker.totalTokens;
  }

  tracker.currentTurnLatestSample = sampleTotal;
  tracker.currentTurnMaxDelta = Math.max(tracker.currentTurnMaxDelta ?? 0, calculateSampleDelta(tracker, sampleTotal));
  tracker.currentTurnTokens = tracker.currentTurnMaxDelta;
  tracker.totalTokens = tracker.committedTokens + tracker.currentTurnTokens;
  return tracker.totalTokens;
}

export function commitUsageTurn(tracker) {
  tracker.committedTokens += tracker.currentTurnTokens;
  if (tracker.currentTurnLatestSample !== undefined) {
    tracker.lastCommittedSample = tracker.currentTurnLatestSample;
  }
  tracker.currentTurnTokens = 0;
  tracker.currentTurnLatestSample = undefined;
  tracker.currentTurnMaxDelta = 0;
  tracker.totalTokens = tracker.committedTokens;
  return tracker.totalTokens;
}

export function finalizeUsageTracker(tracker) {
  tracker.totalTokens = tracker.committedTokens + tracker.currentTurnTokens;
  return tracker.totalTokens;
}
