// Risk section types (W9-12, RISK_MODEL.md §5).
//
// Shapes only — the assembler builds ReportSections, and these describe what it
// reads. They live apart from the assembler so a renderer can depend on the
// shape without pulling a database client in with it.

export interface TopRiskRow {
  findingId: number;
  repo: string;
  dimension: string;
  /** Raw severity, carried everywhere the composite goes (§2 honesty rules). */
  severity: number;
  title: string;
  file: string | null;
  /** null when the nightly job has not priced it yet — never 0. */
  effectiveRisk: number | null;
  riskBand: 'act' | 'schedule' | 'track' | null;
}

export interface RiskCounts {
  open: number;
  act: number;
  schedule: number;
  track: number;
  /** Reported separately: unpriced is not the same as judged low-risk. */
  unpriced: number;
}

export interface RiskMovement {
  intoAct: number;
  outOfAct: number;
  newFindings: number;
}

export interface AxisLetterRow {
  axis: string;
  /** null when the sub-score is absent — an absent axis, never a fake grade. */
  letter: string | null;
  score: number | null;
  basis: string;
}
