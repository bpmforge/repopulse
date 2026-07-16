import { describe, expect, it } from 'vitest';
import { median, nearestRankPercentile } from './percentiles.js';

describe('nearestRankPercentile (METRICS.md §0 — nearest-rank, not interpolated)', () => {
  it('returns null for an empty sample ("no data", never 0)', () => {
    expect(nearestRankPercentile([], 90)).toBeNull();
  });

  it('computes p90 of a pooled 10-value sample via nearest-rank', () => {
    const values = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
    // rank = ceil(0.9 * 10) = 9 -> 9th smallest value
    expect(nearestRankPercentile(values, 90)).toBe(9);
  });

  it('is order-independent (sorts internally)', () => {
    const shuffled = [7, 2, 9, 1, 5, 10, 3, 8, 4, 6];
    expect(nearestRankPercentile(shuffled, 90)).toBe(9);
  });

  it('p50 of a single-value sample is that value', () => {
    expect(nearestRankPercentile([42], 50)).toBe(42);
  });

  it('rejects an out-of-range percentile', () => {
    expect(() => nearestRankPercentile([1, 2, 3], 101)).toThrow(RangeError);
    expect(() => nearestRankPercentile([1, 2, 3], -1)).toThrow(RangeError);
  });

  it('median() is nearestRankPercentile(values, 50)', () => {
    expect(median([1, 2, 3, 4, 5])).toBe(nearestRankPercentile([1, 2, 3, 4, 5], 50));
  });
});
