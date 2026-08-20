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
  letter: string | null;
  basis: string;
  top: { finding_id: number; title: string; severity: number; effective_risk: number | null }[];
}

/** Verbs, not adjectives: people act on verbs (RISK_MODEL §3). */
export const RISK_BAND_LABEL: Record<RiskBand, string> = {
  act: '! act',
  schedule: '· schedule',
  track: '· track',
};

export const AXIS_LABEL: Record<string, string> = {
  security: 'Security',
  codeHealth: 'Code Health',
  performance: 'Performance',
};
