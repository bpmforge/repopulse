import { describe, expect, it } from 'vitest';
import { ratio } from './ratio.js';

describe('ratio (METRICS.md §0 — retain numerator/denominator, null on empty)', () => {
  it('computes the fraction and keeps both inputs', () => {
    expect(ratio(6, 9)).toEqual({ numerator: 6, denominator: 9, value: 6 / 9 });
  });

  it('is null, never 0, on an empty denominator', () => {
    const result = ratio(0, 0);
    expect(result.value).toBeNull();
    expect(result.numerator).toBe(0);
    expect(result.denominator).toBe(0);
  });

  it('matches METRICS.md §4 E3 exactly: M5 = 6/9 = 0.667', () => {
    const m5 = ratio(6, 9);
    expect(m5.value).toBeCloseTo(0.667, 3);
  });
});
