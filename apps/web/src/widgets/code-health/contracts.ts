// Code Health wire contracts (W9-06). Source: apps/api/src/routes/code-health.

export type ChScannerState = 'never_run' | 'ok' | 'error' | 'partial';

export interface ChScannerStatus {
  key: string;
  state: ChScannerState;
  last_run_at: string | null;
  error: string | null;
  tool_versions: Record<string, string> | null;
  /** null = nothing has looked. NOT 0 — that would be a claim. */
  open_findings: number | null;
}

export interface ChPoint {
  value: number;
  at: string;
}

export interface RepoCodeHealth {
  repo: { id: number; org: string; name: string };
  /** Oldest-first, reversed once by the API rather than by each consumer. */
  series: Record<string, ChPoint[]>;
  scanners: ChScannerStatus[];
  worst_complexity: {
    finding_id: number;
    rule_id: string | null;
    file: string | null;
    line: number | null;
    severity: number;
    title: string;
    evidence: string;
  }[];
  slop_by_rule: { rule: string; count: number }[];
  logging_by_rule: { rule: string; count: number }[];
  open_total: number;
}

export interface OrgCodeHealth {
  open_findings: number;
  repos_with_findings: number;
  repos_scanned: number;
  repos_total: number;
  /** Why the numbers mean what they mean — never omitted. */
  basis: string;
}

export const CH_SCANNER_STATE_LABEL: Record<ChScannerState, string> = {
  never_run: '· has never run',
  ok: '✓ ran clean',
  error: '✕ last run failed',
  partial: '! last run was cut short — findings are incomplete',
};

/** Human names for the ch_* series. */
export const CH_SERIES_LABEL: Record<string, string> = {
  ch_duplication_pct: 'Duplication %',
  ch_complexity_p90: 'Complexity p90',
  ch_worst_fn_count: 'Functions over the critical threshold',
  M13: 'Rework (14 day)',
  M14: 'Revert rate',
};
