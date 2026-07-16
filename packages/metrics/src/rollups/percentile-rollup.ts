import { median, nearestRankPercentile } from '../engine/percentiles.js';

export interface PerRepoSamples {
  repoId: number;
  samples: readonly number[];
}

export interface PercentileRollupResult {
  medianValue: number | null;
  p90Value: number | null;
}

/**
 * METRICS.md §2 / FR-METRICS-14: percentile metrics pool RAW samples across
 * repos - pooled p90 != mean of repo p90s (a single repo with one large
 * outlier sample skews the pooled percentile far less than it would skew a
 * naive average of every repo's own p90). `activeRepoIds`, when given,
 * scopes the rollup to the active view's repo filter (FR-API-6) - repos
 * outside it contribute no samples at all.
 */
export function rollupPercentileMetric(
  perRepo: readonly PerRepoSamples[],
  activeRepoIds?: readonly number[],
): PercentileRollupResult {
  const scoped = activeRepoIds ? perRepo.filter((r) => activeRepoIds.includes(r.repoId)) : perRepo;
  const pooled = scoped.flatMap((r) => r.samples);
  return { medianValue: median(pooled), p90Value: nearestRankPercentile(pooled, 90) };
}
