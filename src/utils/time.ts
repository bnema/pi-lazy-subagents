export interface RelativeTimeParts {
  now: number;
  timestamp: number;
}

export function formatDuration(ms: number): string {
  const safeMs = Math.max(0, Math.floor(ms));
  if (safeMs < 1_000) return `${safeMs}ms`;

  const totalSeconds = Math.floor(safeMs / 1_000);
  if (totalSeconds < 60) return `${totalSeconds}s`;

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) return seconds > 0 ? `${totalMinutes}m ${seconds}s` : `${totalMinutes}m`;

  const totalHours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${totalHours}h ${minutes}m` : `${totalHours}h`;
}

export function formatAge(parts: RelativeTimeParts): string {
  return `${formatDuration(parts.now - parts.timestamp)} ago`;
}

export function formatCompactThousands(value: number): string {
  const safeValue = Math.max(0, Math.floor(value));
  if (safeValue < 1_000) return `${safeValue}`;
  if (safeValue < 10_000) {
    const compact = Math.round(safeValue / 100) / 10;
    return Number.isInteger(compact) ? `${compact.toFixed(0)}k` : `${compact.toFixed(1)}k`;
  }
  return `${Math.round(safeValue / 1_000)}k`;
}
