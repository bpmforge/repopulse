// Security Posture scanner types (W8-11, SECURITY_SUITE.md §5).
//
// These describe what the ASSEMBLER computed, not what a scanner is. The
// report deliberately knows nothing about the scanner registry: everything
// below is derived from warehouse rows (scan_runs, repo_scanner_config,
// findings) as of snapshotAt, because a report whose content depended on which
// code happened to be loaded at render time could not be regenerated
// identically six months later (FR-REPORTS-6).

export interface ScannerPosture {
  scannerKey: string;
  /** From repo_scanner_config; a scanner with no row is neither on nor off. */
  enabled: boolean | null;
  /** Latest run at or before snapshotAt. Null = has never run in this window. */
  lastRunAt: Date | null;
  lastRunStatus: string | null;
  /** The rulepack/tool version that produced the findings below. */
  scannerVersion: string | null;
  /** Open findings by severity (1–5). */
  bySeverity: Record<number, number>;
  openTotal: number;
  /** Findings first seen after the PREVIOUS run of this scanner. */
  newSincePreviousRun: number | null;
  topFindings: { severity: number; title: string; file: string | null; ruleId: string | null }[];
}

export interface ChainAppendixEntry {
  chainId: string;
  /** The chain's worst step — never an average (see the assembler). */
  severity: number;
  steps: { findingId: number; title: string; severity: number }[];
}
