import { describe, expect, it } from 'vitest';
import { thresholdProblem } from './index.js';

// W20-17 (UX_TODO ADM-65): thresholds are range-checked before they are saved.

describe('thresholdProblem', () => {
  it('accepts an empty threshold (the documented default)', () => {
    expect(thresholdProblem('pr_size_max', {})).toBeNull();
  });

  it('accepts sensible values for each kind', () => {
    expect(thresholdProblem('pr_size_max', { lines: 400 })).toBeNull();
    expect(thresholdProblem('review_within_hours', { hours: 0.5 })).toBeNull();
    expect(thresholdProblem('no_unreviewed_merge', { minReviews: 2 })).toBeNull();
    expect(thresholdProblem('stale_ceiling', { count: 0 })).toBeNull();
    expect(thresholdProblem('ci_pass_floor', { rate: 0.9 })).toBeNull();
  });

  it('refuses out-of-range values', () => {
    expect(thresholdProblem('pr_size_max', { lines: -5 })).toMatch(/whole number/);
    expect(thresholdProblem('pr_size_max', { lines: 1.5 })).toMatch(/whole number/);
    expect(thresholdProblem('review_within_hours', { hours: 0 })).toMatch(/more than 0/);
    expect(thresholdProblem('ci_pass_floor', { rate: 90 })).toMatch(/fraction/);
    expect(thresholdProblem('stale_ceiling', { count: -1 })).toMatch(/whole number/);
  });

  it('refuses the wrong key or a non-number', () => {
    expect(thresholdProblem('pr_size_max', { hours: 4 })).toMatch(/one key: lines/);
    expect(thresholdProblem('pr_size_max', { lines: '400' })).toMatch(/must be a number/);
  });
});
