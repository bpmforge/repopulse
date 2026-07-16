// METRICS.md §0: percentiles use nearest-rank on the pooled sample (NOT
// linear interpolation) - org rollups pool raw samples across repos, so
// pooled p90 != mean of repo p90s (FR-METRICS-14, tested at the rollup
// ticket that actually pools across repos).
export function nearestRankPercentile(values: readonly number[], p: number): number | null {
  if (p < 0 || p > 100) throw new RangeError(`percentile must be in [0,100], got ${p}`);
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1] as number;
}

export function median(values: readonly number[]): number | null {
  return nearestRankPercentile(values, 50);
}
