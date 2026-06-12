export function clampCacheHitRate(rate: number | undefined): number | undefined {
  return rate !== undefined && Number.isFinite(rate) ? Math.max(0, Math.min(100, rate)) : undefined;
}

export function formatCacheHitRate(rate: number | undefined): string | undefined {
  const clamped = clampCacheHitRate(rate);
  return clamped !== undefined ? `CH${clamped.toFixed(1)}%` : undefined;
}
