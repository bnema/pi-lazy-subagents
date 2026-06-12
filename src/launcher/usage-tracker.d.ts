export interface UsageTracker {
  committedTokens: number;
  currentTurnTokens: number;
  totalTokens: number;
  lastCommittedSample?: number;
  currentTurnLatestSample?: number;
  currentTurnMaxDelta: number;
  committedPromptTokens: number;
  currentTurnPromptTokens: number;
  totalPromptTokens: number;
  committedCacheReadTokens: number;
  currentTurnCacheReadTokens: number;
  totalCacheReadTokens: number;
  cacheHitRate?: number;
}

export interface UsageSample {
  totalTokens?: number;
  input?: number;
  cacheRead?: number;
  cacheWrite?: number;
}

export function createUsageTracker(): UsageTracker;
export function recordUsageSample(tracker: UsageTracker, usage: number | UsageSample): number;
export function commitUsageTurn(tracker: UsageTracker): number;
export function finalizeUsageTracker(tracker: UsageTracker): number;
