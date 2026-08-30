import { describe, expect, it } from 'vitest';
import { deltaPctOf } from './contracts.js';

// W16-56. The KPI tiles were handed `trend.delta` — an ABSOLUTE change — for a
// prop called `deltaPct`. Commit churn falling by 373 lines rendered as
// "▼373%": a drop of nearly four times everything there was, on the landing
// screen's headline row. Every non-ratio tile was wrong the same way, and the
// two ratio tiles looked plausible only by coincidence, because a ratio's
// absolute change and its change in points are close enough to pass a glance.

describe('the KPI delta is a percentage (W16-56)', () => {
  it('divides by the BASELINE, not by the current value', () => {
    // 9200 → 1946 is a fall of 79%, not of 373%. Dividing by the current value
    // instead is what produces a number greater than 100.
    expect(deltaPctOf(1946 - 9200, 9200)).toBeCloseTo(-78.8, 1);
  });

  it('reads as a small change when the change is small', () => {
    expect(deltaPctOf(2, 100)).toBeCloseTo(2, 6);
    expect(deltaPctOf(-2, 100)).toBeCloseTo(-2, 6);
  });

  it('keeps the SIGN meaningful when the baseline is negative', () => {
    // Dividing by a negative baseline would flip an increase into a fall, so
    // the magnitude is what divides and the delta keeps its own sign.
    expect(deltaPctOf(5, -50)).toBeCloseTo(10, 6);
  });

  it('has no answer when there is nothing to divide by', () => {
    // Null rather than Infinity or a fabricated 100%: going from nothing to
    // something is not a percentage, and the tile already has honest words for
    // an absent delta ("not compared to an earlier window").
    expect(deltaPctOf(5, 0)).toBeNull();
    expect(deltaPctOf(5, null)).toBeNull();
    expect(deltaPctOf(null, 100)).toBeNull();
  });
});
