export function createUsageTracker() {
  return {
    committedTokens: 0,
    currentTurnTokens: 0,
    totalTokens: 0,
    lastCommittedSample: undefined,
    currentTurnLatestSample: undefined,
    currentTurnMaxDelta: 0,
    committedPromptTokens: 0,
    currentTurnPromptTokens: 0,
    totalPromptTokens: 0,
    committedCacheReadTokens: 0,
    currentTurnCacheReadTokens: 0,
    totalCacheReadTokens: 0,
    cacheHitRate: undefined,
  };
}

function normalizePositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function normalizeUsageSample(usage) {
  if (typeof usage === "number") {
    return { totalTokens: normalizePositiveNumber(usage) };
  }
  if (!usage || typeof usage !== "object") return {};

  const input = normalizePositiveNumber(usage.input) ?? 0;
  const cacheRead = normalizePositiveNumber(usage.cacheRead) ?? 0;
  const cacheWrite = normalizePositiveNumber(usage.cacheWrite) ?? 0;
  const promptTokens = input + cacheRead + cacheWrite;

  return {
    totalTokens: normalizePositiveNumber(usage.totalTokens),
    promptTokens: promptTokens > 0 ? promptTokens : undefined,
    cacheReadTokens: cacheRead > 0 ? cacheRead : undefined,
  };
}

function calculateSampleDelta(tracker, sampleTotal) {
  if (tracker.lastCommittedSample === undefined) return sampleTotal;
  return Math.max(0, sampleTotal - tracker.lastCommittedSample);
}

function updateCacheHitRate(tracker) {
  tracker.totalPromptTokens = tracker.committedPromptTokens + tracker.currentTurnPromptTokens;
  tracker.totalCacheReadTokens = tracker.committedCacheReadTokens + tracker.currentTurnCacheReadTokens;
  tracker.cacheHitRate = tracker.totalPromptTokens > 0
    ? (tracker.totalCacheReadTokens / tracker.totalPromptTokens) * 100
    : undefined;
}

export function recordUsageSample(tracker, usage) {
  const sample = normalizeUsageSample(usage);
  let sampleDelta;
  if (sample.totalTokens !== undefined) {
    tracker.currentTurnLatestSample = sample.totalTokens;
    sampleDelta = calculateSampleDelta(tracker, sample.totalTokens);
    tracker.currentTurnMaxDelta = Math.max(tracker.currentTurnMaxDelta ?? 0, sampleDelta);
    tracker.currentTurnTokens = tracker.currentTurnMaxDelta;
  }
  if (sample.promptTokens !== undefined && sample.totalTokens !== undefined && (sampleDelta ?? 0) > 0) {
    tracker.currentTurnPromptTokens = sample.promptTokens;
    tracker.currentTurnCacheReadTokens = sample.cacheReadTokens ?? 0;
  }

  tracker.totalTokens = tracker.committedTokens + tracker.currentTurnTokens;
  updateCacheHitRate(tracker);
  return tracker.totalTokens;
}

export function commitUsageTurn(tracker) {
  tracker.committedTokens += tracker.currentTurnTokens;
  tracker.committedPromptTokens += tracker.currentTurnPromptTokens;
  tracker.committedCacheReadTokens += tracker.currentTurnCacheReadTokens;
  if (tracker.currentTurnLatestSample !== undefined) {
    tracker.lastCommittedSample = tracker.currentTurnLatestSample;
  }
  tracker.currentTurnTokens = 0;
  tracker.currentTurnLatestSample = undefined;
  tracker.currentTurnMaxDelta = 0;
  tracker.currentTurnPromptTokens = 0;
  tracker.currentTurnCacheReadTokens = 0;
  tracker.totalTokens = tracker.committedTokens;
  updateCacheHitRate(tracker);
  return tracker.totalTokens;
}

export function finalizeUsageTracker(tracker) {
  tracker.totalTokens = tracker.committedTokens + tracker.currentTurnTokens;
  updateCacheHitRate(tracker);
  return tracker.totalTokens;
}
