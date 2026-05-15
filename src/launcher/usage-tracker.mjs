export function createUsageTracker() {
  return {
    committedTokens: 0,
    currentTurnTokens: 0,
    totalTokens: 0,
  };
}

export function recordUsageSample(tracker, totalTokens) {
  if (typeof totalTokens !== "number" || !Number.isFinite(totalTokens) || totalTokens <= 0) {
    tracker.totalTokens = tracker.committedTokens + tracker.currentTurnTokens;
    return tracker.totalTokens;
  }

  tracker.currentTurnTokens = Math.max(tracker.currentTurnTokens, totalTokens);
  tracker.totalTokens = tracker.committedTokens + tracker.currentTurnTokens;
  return tracker.totalTokens;
}

export function commitUsageTurn(tracker) {
  tracker.committedTokens += tracker.currentTurnTokens;
  tracker.currentTurnTokens = 0;
  tracker.totalTokens = tracker.committedTokens;
  return tracker.totalTokens;
}

export function finalizeUsageTracker(tracker) {
  tracker.totalTokens = tracker.committedTokens + tracker.currentTurnTokens;
  return tracker.totalTokens;
}
