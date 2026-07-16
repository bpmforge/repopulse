import { ratio, type RatioResult } from '../engine/ratio.js';

export interface PerRepoRatio {
  repoId: number;
  numerator: number;
  denominator: number;
}

/**
 * METRICS.md §2 / FR-METRICS-14: ratio metrics SUM numerators/denominators
 * across repos, then take one ratio of the sums - never average
 * pre-computed per-repo ratios (that would weight every repo equally
 * regardless of its actual volume). `activeRepoIds` scopes to the active
 * view's repo filter (FR-API-6), same as the percentile rollup.
 */
export function rollupRatioMetric(
  perRepo: readonly PerRepoRatio[],
  activeRepoIds?: readonly number[],
): RatioResult {
  const scoped = activeRepoIds ? perRepo.filter((r) => activeRepoIds.includes(r.repoId)) : perRepo;
  const numerator = scoped.reduce((sum, r) => sum + r.numerator, 0);
  const denominator = scoped.reduce((sum, r) => sum + r.denominator, 0);
  return ratio(numerator, denominator);
}
