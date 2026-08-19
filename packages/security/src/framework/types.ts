import type { AnalysisGateway } from '@repopulse/analysis';

// Scanner framework contracts (W8-01, SECURITY_SUITE.md §1, FR-SEC-1).
//
// The extensibility claim this file has to earn: adding a scanner is one module
// plus one registry line, and touches ZERO framework files. That only holds if
// the framework never branches on a scanner key — every decision (what to
// provision, when to enqueue, which budget applies, how findings are labelled)
// reads registry METADATA instead. Anywhere a `switch (scanner.key)` appears,
// the claim is already false.

export type ScannerInput = 'diff' | 'manifests' | 'snapshot' | 'findings';
export type ScanTrigger = 'pr_synced' | 'push' | 'schedule' | 'manual';

export interface ForgeDiffFile {
  path: string;
  patch: string | null;
  binary?: boolean;
}

export interface ForgeFileContent {
  path: string;
  content: string;
}

export interface SnapshotHandle {
  /** Ephemeral scratch directory (C1a) — deleted when the scan ends. */
  dir: string;
  commitSha: string;
}

export interface ScannerFinding {
  scannerKey: string;
  /** Scanner + rulepack version, stamped on every finding (§1). */
  scannerVersion: string;
  dimension: string;
  severity: number;
  confidence: number;
  file: string;
  lineStart: number;
  lineEnd: number;
  title: string;
  evidence: string;
  recommendation: string;
  /** Set when the scan was cut short — the finding is real, the SET is partial. */
  partial?: boolean;
}

export interface FindingFilter {
  scannerKey?: string;
  minSeverity?: number;
}

/**
 * Budget for one scanner run (§1.2).
 *
 * Every limit is a number the framework enforces, not a suggestion the scanner
 * is trusted to respect: a scanner is third-party code by design, and NFR-15
 * says a crashing or runaway one must never touch ingestion or Tier-1.
 */
export interface ScanBudget {
  wallClockMs: number;
  /** Targeted forge fetches, drawn from the low-priority `scan` lane. */
  forgeCalls: number;
  /** Tokens through the analysis gateway, accounted as scanner:{key}. */
  llmTokens: number;
  cpuMillis?: number;
  memoryMb?: number;
}

export interface ScannerContext {
  repoId: string;
  workspaceId: string;
  /** Hash pin — every result is reproducible for this SHA (§1). */
  commitSha: string;
  trigger: ScanTrigger;
  prNumber?: number;
  diff(): AsyncIterable<ForgeDiffFile>;
  getFileContent(path: string): Promise<ForgeFileContent>;
  /** inputs:'snapshot' only — throws otherwise (C1a is not a suggestion). */
  snapshot(): Promise<SnapshotHandle>;
  priorFindings(filter: FindingFilter): Promise<ScannerFinding[]>;
  gateway: AnalysisGateway;
  budget: ScanBudget;
  signal: AbortSignal;
  log: { info: (o: Record<string, unknown>, m: string) => void };
}

export interface Scanner {
  key: string;
  displayName: string;
  version: string;
  inputs: ScannerInput;
  triggers: ScanTrigger[];
  /** Container tool deps, e.g. ['semgrep@1']. Absent = pure TypeScript. */
  requiredTools?: string[];
  run(ctx: ScannerContext): Promise<ScannerFinding[]>;
}

export type ScanRunStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'budget_exceeded';

export interface ScanRunResult {
  scannerKey: string;
  status: ScanRunStatus;
  findings: ScannerFinding[];
  /** True when findings are a partial set because a budget was hit. */
  partial: boolean;
  durationMs: number;
  error?: string;
}
