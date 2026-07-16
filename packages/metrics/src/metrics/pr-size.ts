import { median } from '../engine/percentiles.js';
import { prSizeBucket, type PrSizeBucket } from './review-coverage.js';

// METRICS.md §1 M7 - bucket thresholds live in review-coverage.ts (needed
// there first, W3-05, for the M6 drill-down's sizeBucket field); reused
// here rather than redefined, per that ticket's own note.
export interface PrSizeInput {
  additions: number;
  deletions: number;
}

export interface PrSizeDistribution {
  counts: Record<PrSizeBucket, number>;
  /** Median-size trend (METRICS.md §1 M7) - read from snapshots in production, computed directly here. */
  medianGross: number | null;
}

export function computePrSizeDistribution(prs: readonly PrSizeInput[]): PrSizeDistribution {
  const counts: Record<PrSizeBucket, number> = { XS: 0, S: 0, M: 0, L: 0, XL: 0 };
  const grossValues: number[] = [];
  for (const pr of prs) {
    const gross = pr.additions + pr.deletions;
    grossValues.push(gross);
    counts[prSizeBucket(gross)]++;
  }
  return { counts, medianGross: median(grossValues) };
}
