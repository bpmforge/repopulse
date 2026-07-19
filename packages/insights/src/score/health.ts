import { ramp } from './ramp.js';

// Health score (METRICS.md §3, FR-INSIGHTS-2/3). `health = Σ w_i × sub_i`,
// each sub-score 0–100 = equal-weight mean of its inputs' ramps. Weights come
// from workspace config (NOT code — DEFAULT_WEIGHTS is only the fallback). A
// sub-score with no available inputs is dropped and the remaining weights are
// renormalized; when the v1.x security/supply-chain sub-scores are absent (the
// v1 case), the result is labeled "Tier-1 only" (FR-INSIGHTS-3).

export interface RampInput {
  key: string;
  /** null = input unavailable → excluded from the sub-score mean. */
  raw: number | null;
  good: number;
  bad: number;
}

export interface SubScoreDef {
  key: string;
  weight: number;
  inputs: RampInput[];
}

export interface InputBreakdown {
  key: string;
  raw: number;
  good: number;
  bad: number;
  normalized: number;
}

export interface SubScoreBreakdown {
  key: string;
  normalized: number;
  weight: number; // renormalized weight actually applied
  contribution: number; // normalized × renormalized weight
  inputs: InputBreakdown[];
}

export interface HealthScore {
  score: number; // 0–100
  subScores: SubScoreBreakdown[];
  /** true when weights were renormalized (a sub-score was absent). */
  renormalized: boolean;
  /** true while security/supply-chain sub-scores are absent (v1). */
  tier1Only: boolean;
}

// METRICS.md §3 default weights (workspace config overrides these).
export const DEFAULT_WEIGHTS: Record<string, number> = {
  activity: 0.2,
  reviewHygiene: 0.3,
  ciHealth: 0.25,
  delivery: 0.25,
};

interface EvaluatedSub {
  key: string;
  weight: number;
  normalized: number | null; // null = absent (no available inputs)
  inputs: InputBreakdown[];
}

function evaluateSub(def: SubScoreDef): EvaluatedSub {
  const available = def.inputs.filter((i) => i.raw !== null);
  const inputs: InputBreakdown[] = available.map((i) => ({
    key: i.key,
    raw: i.raw as number,
    good: i.good,
    bad: i.bad,
    normalized: ramp(i.raw as number, i.good, i.bad),
  }));
  const normalized =
    inputs.length === 0 ? null : inputs.reduce((s, i) => s + i.normalized, 0) / inputs.length;
  return { key: def.key, weight: def.weight, normalized, inputs };
}

/**
 * Compute the weighted health score with full breakdown. Absent sub-scores are
 * dropped and their weight redistributed proportionally across the present ones.
 */
export function computeHealthScore(defs: SubScoreDef[]): HealthScore {
  const evaluated = defs.map(evaluateSub);
  const present = evaluated.filter((e) => e.normalized !== null);
  const totalWeight = present.reduce((s, e) => s + e.weight, 0);
  const renormalized = present.length !== evaluated.length;

  const subScores: SubScoreBreakdown[] = present.map((e) => {
    const weight = totalWeight > 0 ? e.weight / totalWeight : 0;
    const normalized = e.normalized as number;
    return {
      key: e.key,
      normalized,
      weight,
      contribution: normalized * weight,
      inputs: e.inputs,
    };
  });

  const score = subScores.reduce((s, e) => s + e.contribution, 0);
  // security + supply_chain are the non-Tier-1 sub-scores (v1.x / W10).
  const tier1Only = !defs.some((d) => d.key === 'security' || d.key === 'supplyChain');

  return { score, subScores, renormalized, tier1Only };
}

// The standard Tier-1 sub-score definitions (METRICS.md §3 table). Ramp params
// are the documented catalog defaults; a null input is dropped from its
// sub-score's mean (and drops the whole sub-score if it's the only input).
export interface HealthMetricInputs {
  /** commit count ÷ the repo's own 365d weekly median (≥1 = at/above median). */
  commitCountVsMedian: number | null;
  daysSinceLastPush: number | null;
  m5ReviewCoverage: number | null; // M5 ratio 0–1
  medianFirstReviewHours: number | null;
  stalePrCount: number | null;
  m9PassRate: number | null; // M9 default-branch pass rate 0–1
  topFlakiness: number | null;
  e2eCycleP50Hours: number | null;
  m11DaysSinceRelease: number | null;
  m12Cfr: number | null; // change-failure rate 0–1, when present
}

export function buildHealthSubScores(
  inputs: HealthMetricInputs,
  weights: Record<string, number> = DEFAULT_WEIGHTS,
): SubScoreDef[] {
  return [
    {
      key: 'activity',
      weight: weights.activity ?? DEFAULT_WEIGHTS.activity!,
      inputs: [
        { key: 'commitCountVsMedian', raw: inputs.commitCountVsMedian, good: 1, bad: 0 },
        { key: 'daysSinceLastPush', raw: inputs.daysSinceLastPush, good: 2, bad: 30 },
      ],
    },
    {
      key: 'reviewHygiene',
      weight: weights.reviewHygiene ?? DEFAULT_WEIGHTS.reviewHygiene!,
      inputs: [
        { key: 'm5', raw: inputs.m5ReviewCoverage, good: 0.9, bad: 0.4 },
        { key: 'medianFirstReviewHours', raw: inputs.medianFirstReviewHours, good: 4, bad: 72 },
        { key: 'stalePrCount', raw: inputs.stalePrCount, good: 0, bad: 10 },
      ],
    },
    {
      key: 'ciHealth',
      weight: weights.ciHealth ?? DEFAULT_WEIGHTS.ciHealth!,
      inputs: [
        { key: 'm9PassRate', raw: inputs.m9PassRate, good: 0.95, bad: 0.6 },
        { key: 'topFlakiness', raw: inputs.topFlakiness, good: 0, bad: 0.3 },
      ],
    },
    {
      key: 'delivery',
      weight: weights.delivery ?? DEFAULT_WEIGHTS.delivery!,
      inputs: [
        { key: 'e2eCycleP50Hours', raw: inputs.e2eCycleP50Hours, good: 24, bad: 240 },
        { key: 'm11DaysSinceRelease', raw: inputs.m11DaysSinceRelease, good: 14, bad: 120 },
        { key: 'm12Cfr', raw: inputs.m12Cfr, good: 0.05, bad: 0.4 },
      ],
    },
  ];
}

// --- letter bands (D12 presentation, RISK_MODEL §4) — pure over the score ---
export type ScoreLetter = 'A' | 'B' | 'C' | 'D' | 'E';

export function scoreLetter(normalized: number): ScoreLetter {
  if (normalized >= 85) return 'A';
  if (normalized >= 70) return 'B';
  if (normalized >= 50) return 'C';
  if (normalized >= 30) return 'D';
  return 'E';
}
