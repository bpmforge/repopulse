// Risk surface contracts (W9-11). Source: apps/api/src/routes/risk.

export type RiskBand = 'act' | 'schedule' | 'track';

export interface RiskFactors {
  H: number;
  L: number;
  X: number;
  inputs: Record<string, unknown>;
  model_version: string;
}

export interface TopRisk {
  finding_id: number;
  repo: { id: number; org: string; name: string };
  dimension: string;
  severity: number;
  title: string;
  file: string | null;
  effective_risk: number | null;
  risk_band: RiskBand | null;
  risk_factors: RiskFactors | null;
}

export interface TopRisksResponse {
  items: TopRisk[];
  counts: { open: number; act: number; schedule: number; track: number; unpriced: number };
}

export interface RiskAxis {
  axis: string;
  dimensions: string[];
  /**
   * The 0–100 sub-score, rounded; null when absent — an axis nobody measured
   * (W10-05). For a set of repositories, their median (W20-09, DSH-72).
   */
  score: number | null;
  /**
   * The health badge's 3-band word for `score` (W20-09, UX_TODO DSH-11) —
   * never a letter grade (UX_SPEC principle 4, N-9).
   */
  band: 'good' | 'watch' | 'attend' | null;
  /** How many repositories had this sub-score (org-wide axes). */
  measured_repos?: number;
  /** The lowest-scoring repository, for a set (DSH-72). */
  worst?: { repo_id: number; name: string; score: number } | null;
  basis: string;
  top: { finding_id: number; title: string; severity: number; effective_risk: number | null }[];
}

export interface RiskAxesResponse {
  axes: RiskAxis[];
  /** Repositories the scope covered; 0 means nothing is tracked yet. */
  repos_in_scope?: number;
}

/**
 * Measured ⇔ a numeric score. Nothing validates the response body, so a
 * missing or non-numeric score falls on the unmeasured side — "Security
 * undefined" beside a repository is worse than a dash.
 */
export function isMeasuredAxis(axis: RiskAxis): boolean {
  return typeof axis.score === 'number' && Number.isFinite(axis.score);
}

const AXIS_NAMES: Record<string, string> = {
  security: 'Security',
  codeHealth: 'Code Health',
  supplyChain: 'Supply Chain',
};

export const axisLabel = (axis: string): string => AXIS_NAMES[axis] ?? axis;

/** Verbs, not adjectives: people act on verbs (RISK_MODEL §3). */
export const RISK_BAND_LABEL: Record<RiskBand, string> = {
  act: '! act',
  schedule: '· schedule',
  track: '· track',
};
