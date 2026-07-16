import { describe, expect, it } from 'vitest';
import { rollupRatioMetric } from './ratio-rollup.js';

describe('rollupRatioMetric (FR-METRICS-14 — sum then ratio, not average of ratios)', () => {
  it('sums numerators/denominators across repos rather than averaging pre-computed ratios', () => {
    const perRepo = [
      { repoId: 1, numerator: 9, denominator: 10 }, // repo ratio 0.9, tiny volume
      { repoId: 2, numerator: 10, denominator: 1000 }, // repo ratio 0.01, huge volume
    ];
    // naive (WRONG) average-of-ratios: (0.9 + 0.01) / 2 = 0.455
    const naiveAverageOfRatios = (9 / 10 + 10 / 1000) / 2;

    const result = rollupRatioMetric(perRepo);
    expect(result.numerator).toBe(19);
    expect(result.denominator).toBe(1010);
    expect(result.value).toBeCloseTo(19 / 1010, 6);
    expect(result.value).not.toBeCloseTo(naiveAverageOfRatios, 2);
  });

  it('honors the active repo-set filter', () => {
    const perRepo = [
      { repoId: 1, numerator: 5, denominator: 10 },
      { repoId: 2, numerator: 100, denominator: 100 },
    ];
    const result = rollupRatioMetric(perRepo, [1]);
    expect(result).toEqual({ numerator: 5, denominator: 10, value: 0.5 });
  });

  it('returns null value (never 0) on zero total denominator', () => {
    expect(rollupRatioMetric([])).toEqual({ numerator: 0, denominator: 0, value: null });
  });
});
