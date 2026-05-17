import { describe, expect, test } from "vitest";

import {
  commitUsageTurn,
  createUsageTracker,
  finalizeUsageTracker,
  recordUsageSample,
} from "../src/launcher/usage-tracker.js";

describe("usage tracker", () => {
  test("accumulates only positive deltas from cumulative multi-turn usage samples", () => {
    const tracker = createUsageTracker();

    recordUsageSample(tracker, 6_079);
    expect(tracker.totalTokens).toBe(6_079);
    commitUsageTurn(tracker);
    expect(tracker.totalTokens).toBe(6_079);

    recordUsageSample(tracker, 6_307);
    expect(tracker.totalTokens).toBe(6_307);
    commitUsageTurn(tracker);
    expect(tracker.totalTokens).toBe(6_307);

    recordUsageSample(tracker, 0);
    expect(finalizeUsageTracker(tracker)).toBe(6_307);
  });

  test("does not double-count repeated message_end and turn_end echoes for one turn", () => {
    const tracker = createUsageTracker();

    expect(recordUsageSample(tracker, 10_000)).toBe(10_000);
    expect(recordUsageSample(tracker, 10_000)).toBe(10_000);
    expect(commitUsageTurn(tracker)).toBe(10_000);
    expect(commitUsageTurn(tracker)).toBe(10_000);
  });

  test("treats a lower post-compaction sample as a new baseline without subtracting tokens", () => {
    const tracker = createUsageTracker();

    recordUsageSample(tracker, 80_000);
    commitUsageTurn(tracker);

    recordUsageSample(tracker, 12_000);
    expect(tracker.totalTokens).toBe(80_000);
    commitUsageTurn(tracker);

    recordUsageSample(tracker, 13_500);
    expect(tracker.totalTokens).toBe(81_500);
  });
});
