import { describe, expect, it } from 'vitest';
import { ramp } from './ramp.js';
import {
  buildHealthSubScores,
  computeHealthScore,
  scoreLetter,
  type HealthMetricInputs,
} from './health.js';

describe('ramp (METRICS.md §3/§4)', () => {
  it('reproduces the E3 worked example: ramp(0.667, 0.9, 0.4) = 53.4', () => {
    expect(ramp(0.667, 0.9, 0.4)).toBeCloseTo(53.4, 1);
  });

  it('clamps to [0,100] and handles the lower-is-better direction', () => {
    expect(ramp(0.95, 0.9, 0.4)).toBe(100); // above good
    expect(ramp(0.2, 0.9, 0.4)).toBe(0); // below bad
    expect(ramp(2, 2, 30)).toBe(100); // days-since-push: good<bad, at good
    expect(ramp(30, 2, 30)).toBe(0);
    expect(ramp(16, 2, 30)).toBe(50);
  });
});

const perfectInputs: HealthMetricInputs = {
  commitCountVsMedian: 1,
  daysSinceLastPush: 2,
  m5ReviewCoverage: 0.9,
  medianFirstReviewHours: 4,
  stalePrCount: 0,
  m9PassRate: 0.95,
  topFlakiness: 0,
  e2eCycleP50Hours: 24,
  m11DaysSinceRelease: 14,
  m12Cfr: 0.05,
};

describe('computeHealthScore (FR-INSIGHTS-2/3)', () => {
  it('all-good inputs → 100 with a full per-input breakdown', () => {
    const result = computeHealthScore(buildHealthSubScores(perfectInputs));
    expect(result.score).toBeCloseTo(100, 5);
    expect(result.subScores).toHaveLength(4);
    const activity = result.subScores.find((s) => s.key === 'activity')!;
    expect(activity.weight).toBeCloseTo(0.2, 5);
    expect(activity.inputs[0]).toMatchObject({ key: 'commitCountVsMedian', normalized: 100 });
    expect(result.tier1Only).toBe(true); // no security sub-score in v1
    expect(result.renormalized).toBe(false);
  });

  it('review hygiene reflects the E3 M5 ramp (53.4) when it is the only available input', () => {
    const inputs = {
      ...perfectInputs,
      m5ReviewCoverage: 0.667,
      medianFirstReviewHours: null,
      stalePrCount: null,
    };
    const result = computeHealthScore(buildHealthSubScores(inputs));
    const review = result.subScores.find((s) => s.key === 'reviewHygiene')!;
    expect(review.normalized).toBeCloseTo(53.4, 1);
  });

  it('drops an absent sub-score and renormalizes the remaining weights', () => {
    // ciHealth fully absent (both inputs null) → dropped; weights renormalize
    // across activity(.2)+reviewHygiene(.3)+delivery(.25) = .75.
    const inputs = { ...perfectInputs, m9PassRate: null, topFlakiness: null };
    const result = computeHealthScore(buildHealthSubScores(inputs));
    expect(result.subScores).toHaveLength(3);
    expect(result.renormalized).toBe(true);
    const totalWeight = result.subScores.reduce((s, x) => s + x.weight, 0);
    expect(totalWeight).toBeCloseTo(1, 5); // renormalized to sum 1
    expect(result.score).toBeCloseTo(100, 5); // remaining subs still all-good
  });

  it('a null input inside a sub-score is excluded from the mean, not scored 0', () => {
    // delivery with only e2e present (good) → sub = 100, not dragged down.
    const inputs = { ...perfectInputs, m11DaysSinceRelease: null, m12Cfr: null };
    const result = computeHealthScore(buildHealthSubScores(inputs));
    const delivery = result.subScores.find((s) => s.key === 'delivery')!;
    expect(delivery.inputs).toHaveLength(1);
    expect(delivery.normalized).toBe(100);
  });

  it('scoreLetter bands (85/70/50/30)', () => {
    expect(scoreLetter(90)).toBe('A');
    expect(scoreLetter(70)).toBe('B');
    expect(scoreLetter(53.4)).toBe('C');
    expect(scoreLetter(30)).toBe('D');
    expect(scoreLetter(10)).toBe('E');
  });
});
