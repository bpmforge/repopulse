import { describe, expect, it } from 'vitest';
import { computePrSizeDistribution } from './pr-size.js';
import { PR_SIZE_BOUNDARY_FIXTURE } from '../../fixtures/size-stale/pr-size.js';

describe('computePrSizeDistribution (METRICS.md §1 M7 — every boundary)', () => {
  it('buckets every boundary value correctly: 2 XS, 2 S, 2 M, 2 L, 2 XL', () => {
    const result = computePrSizeDistribution(PR_SIZE_BOUNDARY_FIXTURE);
    expect(result.counts).toEqual({ XS: 2, S: 2, M: 2, L: 2, XL: 2 });
  });

  it('computes the median gross size', () => {
    const result = computePrSizeDistribution(PR_SIZE_BOUNDARY_FIXTURE);
    // gross values: 0, 9, 10, 99, 100, 499, 500, 999, 1000, 50000 (already sorted)
    // n=10, nearest-rank p50: rank=ceil(0.5*10)=5 -> 5th smallest = 100
    expect(result.medianGross).toBe(100);
  });

  it('returns a fully zeroed distribution and null median for an empty input', () => {
    const result = computePrSizeDistribution([]);
    expect(result.counts).toEqual({ XS: 0, S: 0, M: 0, L: 0, XL: 0 });
    expect(result.medianGross).toBeNull();
  });
});
