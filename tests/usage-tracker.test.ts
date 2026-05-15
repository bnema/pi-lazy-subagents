import { describe, expect, test } from "vitest";

import {
  commitUsageTurn,
  createUsageTracker,
  finalizeUsageTracker,
  recordUsageSample,
} from "../src/launcher/usage-tracker.js";

describe("usage tracker", () => {
  test("accumulates multi-turn token usage without double-counting turn_end echoes", () => {
    const tracker = createUsageTracker();

    recordUsageSample(tracker, 6_079);
    expect(tracker.totalTokens).toBe(6_079);
    commitUsageTurn(tracker);
    expect(tracker.totalTokens).toBe(6_079);

    recordUsageSample(tracker, 6_307);
    expect(tracker.totalTokens).toBe(12_386);
    commitUsageTurn(tracker);
    expect(tracker.totalTokens).toBe(12_386);

    recordUsageSample(tracker, 0);
    expect(finalizeUsageTracker(tracker)).toBe(12_386);
  });
});
