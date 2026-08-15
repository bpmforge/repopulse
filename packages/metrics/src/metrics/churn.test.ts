import { describe, expect, it } from 'vitest';
import {
  attributeRework,
  computeChurn,
  computeFileChurn,
  computePersonChurn,
  type ChurnFileTouch,
} from './churn.js';
import {
  CHURN_FIXTURE_EXPECTED,
  CHURN_FIXTURE_EXPECTED_CHAIN_B,
  CHURN_FIXTURE_TOUCHES,
} from '../../fixtures/churn/basic.js';

describe('computeChurn (METRICS.md §1 M1 — fixture repro "to the line")', () => {
  it('reproduces gross/net/rework exactly across both touch chains', () => {
    expect(computeChurn(CHURN_FIXTURE_TOUCHES)).toEqual(CHURN_FIXTURE_EXPECTED);
  });

  it('excludes bot, merge-commit, and superseded touches entirely', () => {
    // c4 (bot, +100/-100), c5 (merge, +200/-200), c6 (superseded, +300/-300)
    // would each dominate gross/net if not excluded - the exact-match
    // assertion above already proves this, this test names why.
    const { gross } = computeChurn(CHURN_FIXTURE_TOUCHES);
    expect(gross).toBeLessThan(100 + 200 + 300);
  });

  it('does not count a touch as rework once the prior touch is >=21 days old', () => {
    // c3 is 25 days after c2 on the same file - if rework mistakenly
    // included it, rework would be 30 (c2) + 10 (c3) = 40 for chain A alone,
    // pushing the combined total to 50, not 40.
    expect(computeChurn(CHURN_FIXTURE_TOUCHES).rework).toBe(CHURN_FIXTURE_EXPECTED.rework);
  });
});

describe('computeFileChurn (rename-chain aware)', () => {
  it('groups a renamed file with its pre-rename history under either path name', () => {
    expect(computeFileChurn(CHURN_FIXTURE_TOUCHES, 'new.ts')).toEqual(
      CHURN_FIXTURE_EXPECTED_CHAIN_B,
    );
    expect(computeFileChurn(CHURN_FIXTURE_TOUCHES, 'old.ts')).toEqual(
      CHURN_FIXTURE_EXPECTED_CHAIN_B,
    );
  });
});

describe('computePersonChurn', () => {
  it('scopes churn to a single author', () => {
    // bob only authored c3 (+5/-5, eligible, not rework since it's the
    // first (and only) touch attributed to bob in isolation).
    expect(computePersonChurn(CHURN_FIXTURE_TOUCHES, 'bob')).toEqual({
      gross: 10,
      net: 0,
      rework: 0,
    });
  });
});

describe('attributeRework (W4-17: rework per week needs per-touch attribution)', () => {
  const touch = (over: Partial<ChurnFileTouch>): ChurnFileTouch => ({
    sha: 'a',
    authorLogin: 'alice',
    parentShaCount: 1,
    superseded: false,
    path: 'src/a.ts',
    additions: 10,
    deletions: 0,
    touchedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  });

  it('attributes rework to the LATER touch, and sums to computeChurn', () => {
    const touches = [
      touch({ sha: '1', touchedAt: '2026-01-01T00:00:00.000Z' }),
      // 5 days later — inside the 21-day lookback, so this one is rework.
      touch({ sha: '2', touchedAt: '2026-01-06T00:00:00.000Z', additions: 7, deletions: 3 }),
    ];
    const attributed = attributeRework(touches);
    expect(attributed[0]!.rework).toBe(0);
    expect(attributed[1]!.rework).toBe(10);
    // The aggregate is the sum of the parts, by construction — computeChurn now
    // reduces this very function, so the two can never disagree.
    expect(attributed.reduce((s, r) => s + r.rework, 0)).toBe(computeChurn(touches).rework);
  });

  // THE BUG THIS EXISTS TO PREVENT. Bucketing touches by week and calling
  // computeChurn per bucket loses the cross-bucket lookback: a touch whose
  // previous touch was in the PREVIOUS week is rework, and per-bucket
  // computation scores it zero. That error is worst at exactly the cadence a
  // 52-week bar chart displays.
  it('sees rework across a week boundary that per-bucket computation would miss', () => {
    const touches = [
      touch({ sha: '1', touchedAt: '2026-01-04T00:00:00.000Z' }), // Sunday
      touch({ sha: '2', touchedAt: '2026-01-06T00:00:00.000Z', additions: 4, deletions: 1 }), // next week
    ];
    expect(attributeRework(touches)[1]!.rework).toBe(5);
    // What the naive approach would have produced: each week alone has one
    // touch, so neither is rework and the chart shows a flat zero band.
    expect(computeChurn([touches[0]!]).rework).toBe(0);
    expect(computeChurn([touches[1]!]).rework).toBe(0);
  });

  it('follows the rename chain, like computeChurn does', () => {
    const touches = [
      touch({ sha: '1', path: 'old.ts', touchedAt: '2026-01-01T00:00:00.000Z' }),
      touch({
        sha: '2',
        path: 'new.ts',
        previousPath: 'old.ts',
        touchedAt: '2026-01-03T00:00:00.000Z',
        additions: 2,
        deletions: 1,
      }),
    ];
    // A rename is not a fresh file: the touch after it still has a prior touch.
    expect(attributeRework(touches)[1]!.rework).toBe(3);
  });
});
