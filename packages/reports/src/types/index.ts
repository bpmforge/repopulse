import type { MetricCatalogEntry } from '@repopulse/metrics';

// Report contracts (W5-03) — shapes are docs/design/REPORTS.md §2/§6 verbatim.
// REPORTS.md is law here the way METRICS.md is law for the numbers: if a shape
// needs to change, the doc changes in the same PR.

export type ReportType =
  | 'repo_health'
  | 'org_exec'
  | 'security_posture'
  | 'delivery_dora'
  // W9-06 (FR-REPORTS-8). Renders enriched when the W9 scanners have run and
  // degrades to debt signals when they have not — saying which, rather than
  // letting the reader infer it from empty sections.
  | 'code_health';

export interface ReportParams {
  type: ReportType;
  workspaceId: string;
  repoIds: string[];
  windowDays: 7 | 30 | 90 | 365;
  /** "now", resolved ONCE at generation so a regeneration cannot drift. */
  windowEnd: string;
  /**
   * THE determinism pin (§2): assembly reads only metric_snapshot rows with
   * computed_at <= this. Without it, a report regenerated ten minutes later
   * silently includes a newer snapshot and two "identical" reports disagree.
   */
  snapshotAt: string;
  weightsVersion: string;
  catalogVersion: string;
  /**
   * Optional human context captured AT GENERATION and stored with the params
   * (R-A11) — "this quarter includes the payments migration". Part of params
   * rather than a mutable column on purpose: a report is immutable, so an
   * annotation cannot be edited onto one after the fact. Changing the note
   * means generating a new report, which is exactly the guarantee that makes a
   * report quotable.
   */
  annotation?: string;
}

export interface ScoreBreakdownRow {
  subScore: string;
  input: string;
  rawValue: number | null;
  normalized: number | null;
  weight: number;
  contribution: number;
}

export interface EgressSummary {
  calls: number;
  bytes: number;
  repos: number;
}

export type ReportSection =
  | { kind: 'summary'; id?: string; markdown: string }
  | { kind: 'score_breakdown'; rows: ScoreBreakdownRow[] }
  | { kind: 'table'; id: string; columns: string[]; rows: unknown[][] }
  | { kind: 'chart'; id: string; echartsOption: object }
  /**
   * FR-REPORTS-2: sections NEVER render blank. A missing section reads as a
   * rendering bug; a section that says which data is absent and why is
   * information — and it is the difference between "this repo has no findings"
   * and "nothing has analysed this repo yet".
   */
  | { kind: 'no_data'; id: string; reason: string };

export interface ReportDataQuality {
  repoId: string;
  /**
   * `org/name` (W16-05, F11). The Basis table listed repositories by numeric id
   * while the very next paragraph of the same report called one
   * "**acme/infra**" — one document naming the same thing two ways, and the
   * useless way first.
   *
   * Optional so an already-stored report still renders: report data is
   * persisted and re-read (REPORTS.md §3), so a required field would break
   * every report generated before this change.
   */
  repoName?: string;
  phase: string;
  /** True when the window is not fully covered by ingested history. */
  partial: boolean;
  /** Hours between the newest snapshot used and windowEnd — the Basis box's sync lag (§5.2). */
  syncLagHours: number | null;
}

export interface ReportData {
  params: ReportParams;
  /** Ordered per the §1 outlines. */
  sections: ReportSection[];
  appendix: { definitions: MetricCatalogEntry[]; egressSummary?: EgressSummary };
  dataQuality: ReportDataQuality[];
}

export interface ReportAssembler {
  /** Pure warehouse reads, deterministic for identical params. */
  assemble(params: ReportParams): Promise<ReportData>;
}
