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
  openFindingDensity: null,
  worstOpenSeverity: null,
};

describe('computeHealthScore (FR-INSIGHTS-2/3)', () => {
  it('all-good inputs → 100 with a full per-input breakdown', () => {
    const result = computeHealthScore(buildHealthSubScores(perfectInputs));
    expect(result.score).toBeCloseTo(100, 5);
    // Four sub-scores, not five: the security sub-score exists (W6-03) but this
    // repo has no findings data, so it is DROPPED rather than scored 100.
    expect(result.subScores).toHaveLength(4);
    const activity = result.subScores.find((s) => s.key === 'activity')!;
    expect(activity.inputs[0]).toMatchObject({ key: 'commitCountVsMedian', normalized: 100 });
    expect(result.tier1Only).toBe(true);
    // TRUE since W6-03: dropping the absent security sub-score renormalizes the
    // remaining four. Previously false only because no fifth sub-score existed.
    expect(result.renormalized).toBe(true);
    // The four Tier-1 weights keep their RELATIVE proportions after
    // renormalization — activity stays 0.2/1.0 of the Tier-1 total.
    expect(activity.weight).toBeCloseTo(0.2, 5);
  });

  it('scores security once a repo has actually been analysed (W6-03)', () => {
    const analysed = { ...perfectInputs, openFindingDensity: 0, worstOpenSeverity: 1 };
    const result = computeHealthScore(buildHealthSubScores(analysed));
    expect(result.subScores).toHaveLength(5);
    // No longer Tier-1 only: there IS non-Tier-1 evidence in the score now.
    expect(result.tier1Only).toBe(false);
    expect(result.renormalized).toBe(false);
    expect(result.score).toBeCloseTo(100, 5);
  });

  it('a repo with no analysis is NOT scored as secure', () => {
    // The distinction the whole sub-score turns on. If absent findings scored
    // as "clean", every unanalysed repository would outrank an analysed one
    // that honestly reported two issues.
    const unanalysed = computeHealthScore(buildHealthSubScores(perfectInputs));
    const clean = computeHealthScore(
      buildHealthSubScores({ ...perfectInputs, openFindingDensity: 0, worstOpenSeverity: 1 }),
    );
    expect(unanalysed.subScores.some((s) => s.key === 'security')).toBe(false);
    expect(clean.subScores.some((s) => s.key === 'security')).toBe(true);
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
