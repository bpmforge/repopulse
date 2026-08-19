// Security tab wire contracts (W8-10). Source of truth: apps/api/src/routes/security.

export type ScannerState = 'not_enabled' | 'never_run' | 'ok' | 'error' | 'partial';

export interface ScannerStatus {
  key: string;
  display_name: string;
  registered: boolean;
  enabled: boolean;
  state: ScannerState;
  last_run_at: string | null;
  last_run_status: string | null;
  error: string | null;
  scanner_version: string | null;
  open_findings: number;
}

export interface ChainNode {
  finding_id: number;
  title: string;
  severity: number;
}

export interface RepoSecurity {
  repo: { id: number; org: string; name: string };
  open_by_severity: Record<string, number>;
  open_total: number;
  scanners: ScannerStatus[];
  secrets: {
    open: number;
    /** Two clocks: watching new commits vs having looked back. */
    last_stream_scan_at: string | null;
    last_history_scan_at: string | null;
    verified: number;
  };
  cves: { cve_id: string; package: string; severity: number; kev: boolean }[];
  chains: { id: string; severity: number; nodes: ChainNode[] }[];
  /** false = chain analysis has never run, which is not the same as no chains. */
  chains_computed: boolean;
}

export interface OrgSecurity {
  open_by_severity: Record<string, number>;
  open_total: number;
  kev_count: number;
  secrets_open: number;
  verified_secrets: number;
  worst_chain: { id: string; severity: number } | null;
  /** What the numbers are built on, so one scanner does not read as an audit. */
  basis: string;
}

/**
 * What each state SAYS, in words.
 *
 * The whole point of the state enum is that a security screen must never show
 * a bare zero: "no findings" from a scanner nobody enabled, one that has never
 * run, and one that ran clean are three different sentences, and only the last
 * is good news.
 */
export const SCANNER_STATE_LABEL: Record<ScannerState, string> = {
  not_enabled: '○ not enabled — nothing has looked',
  never_run: '· enabled, has never run',
  ok: '✓ ran clean',
  error: '✕ last run failed',
  partial: '! last run was cut short — findings are incomplete',
};
