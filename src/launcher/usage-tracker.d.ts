export interface UsageTracker {
  committedTokens: number;
  currentTurnTokens: number;
  totalTokens: number;
}

export function createUsageTracker(): UsageTracker;
export function recordUsageSample(tracker: UsageTracker, totalTokens: number): number;
export function commitUsageTurn(tracker: UsageTracker): number;
export function finalizeUsageTracker(tracker: UsageTracker): number;
