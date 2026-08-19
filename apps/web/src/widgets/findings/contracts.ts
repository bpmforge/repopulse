// Findings wire contracts (W6-04). Source of truth: apps/api/src/routes/findings.

export interface Finding {
  id: number;
  repo: { id: number; org: string; name: string };
  dimension: string;
  severity: number;
  confidence: number;
  title: string;
  file: string;
  line_range: [number, number];
  evidence: string;
  recommendation: string;
  status: string;
  dismiss_reason: string | null;
  occurrence_count: number;
  first_seen_at: string;
  last_seen_at: string;
  tier: number;
}

export interface FindingStats {
  by_dimension: { dimension: string; status: string; n: number }[];
  /** null = nothing triaged yet. NOT 0 — that would read as a flawless model. */
  false_positive_rate: number | null;
  false_positive_count: number;
  total: number;
}

export interface FindingEvent {
  from_status: string | null;
  to_status: string;
  actor: number | null;
  automatic: boolean;
  reason: string | null;
  at: string;
}

/** Paired word + glyph so severity never depends on colour (UX_SPEC §7). */
export const SEVERITY_LABEL: Record<number, string> = {
  5: '● critical',
  4: '● high',
  3: '● medium',
  2: '○ low',
  1: '○ info',
};
