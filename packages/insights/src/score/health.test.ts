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
  // W9-06: null by default, exactly like the findings inputs above — the
  // fixture describes a repo nobody has scanned, which is the common case.
  duplicationPct: null,
  complexityP90: null,
  slopDensity: null,
  rework14d: null,
  // W10-05: absent, like every other findings-based input in this fixture —
  // the point of "perfect" here is the Tier-1 metrics, and an unmeasured
  // supply chain must drop its sub-score rather than score full marks.
  supplyChainRisk: null,
  eolRuntimeCount: null,
};

/** All four W9 code-health inputs at their "good" ends. */
const perfectCodeHealth = {
  duplicationPct: 0,
  complexityP90: 5,
  slopDensity: 0,
  rework14d: 0.05,
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
    // Five: the four Tier-1 subs plus security. codeHealth is still absent
    // here because this fixture has never been scanned by the W9 scanners.
    expect(result.subScores).toHaveLength(5);
    // No longer Tier-1 only: there IS non-Tier-1 evidence in the score now.
    expect(result.tier1Only).toBe(false);
    // TRUE since W9-06: the codeHealth sub-score is offered but absent for this
    // fixture, so the remaining weights renormalize. That is the flag doing its
    // job — it means "this score is not the full weight set", which is exactly
    // what a repo with security data and no code-health data deserves.
    expect(result.renormalized).toBe(true);
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

describe('the code-health sub-score (W9-06, FR-CH-6)', () => {
  it('is ABSENT until the scanners have run', () => {
    // The same rule as `security`, and the reason is the same: if unmeasured
    // scored as clean, a repository nobody has scanned would outrank one that
    // honestly reported its duplication.
    const unscanned = computeHealthScore(buildHealthSubScores(perfectInputs));
    expect(unscanned.subScores.some((s) => s.key === 'codeHealth')).toBe(false);
    expect(unscanned.tier1Only).toBe(true);
  });

  it('appears and scores once the ch_* numbers exist', () => {
    const scanned = computeHealthScore(
      buildHealthSubScores({ ...perfectInputs, ...perfectCodeHealth }),
    );
    const sub = scanned.subScores.find((s) => s.key === 'codeHealth');
    expect(sub?.normalized).toBeCloseTo(100, 5);
    // Non-Tier-1 evidence is in the score now, so the label must drop.
    expect(scanned.tier1Only).toBe(false);
  });

  it('reproduces its documented formula by hand', () => {
    // duplication 7.5% of a 0..15 ramp = 50; complexity 12.5 of 5..20 = 50;
    // slop 2.5 of 0..5 = 50; rework 0.225 of 0.05..0.4 = 50. Equal-weight mean
    // of four inputs = 50.
    const half = computeHealthScore(
      buildHealthSubScores({
        ...perfectInputs,
        duplicationPct: 7.5,
        complexityP90: 12.5,
        slopDensity: 2.5,
        rework14d: 0.225,
      }),
    );
    expect(half.subScores.find((s) => s.key === 'codeHealth')?.normalized).toBeCloseTo(50, 5);
  });

  it('scores on the inputs it HAS when only some scanners have run', () => {
    // Duplication measured, complexity not: the sub-score exists on the one
    // real number rather than being dropped or padded with a zero.
    const partial = computeHealthScore(
      buildHealthSubScores({ ...perfectInputs, duplicationPct: 0 }),
    );
    const sub = partial.subScores.find((s) => s.key === 'codeHealth');
    expect(sub?.inputs).toHaveLength(1);
    expect(sub?.normalized).toBeCloseTo(100, 5);
  });
});
