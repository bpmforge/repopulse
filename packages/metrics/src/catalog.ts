// FR-METRICS-15: machine-readable catalog for M1-M12. Formula text is a
// human-readable summary of docs/design/METRICS.md §1's exact definitions -
// that doc is LAW; this catalog must not drift from it. UI renders tooltips
// from this catalog, never hardcoded strings (SRS §2.3 acceptance).
export type MetricDirection = 'higher_better' | 'lower_better' | 'neutral';

export interface MetricCatalogEntry {
  id: string; // 'M1'..'M12'
  frId: string; // 'FR-METRICS-1'..'FR-METRICS-12'
  name: string;
  formula: string;
  unit: string;
  direction: MetricDirection;
  heuristicNotes: string;
}

export const METRIC_CATALOG: readonly MetricCatalogEntry[] = [
  {
    id: 'M1',
    frId: 'FR-METRICS-1',
    name: 'Commit churn',
    formula:
      'gross = Σ(additions+deletions); net = Σ(additions−deletions); rework = Σ touches on a file with a prior non-bot touch <21d earlier',
    unit: 'lines',
    direction: 'neutral',
    heuristicNotes:
      'Excludes bot, merge-commit, and superseded commits (§0). Grains: repo, file (rename-aware via previousPath), person.',
  },
  {
    id: 'M2',
    frId: 'FR-METRICS-2',
    name: 'File hotspots',
    formula:
      'hotspot(f) = normChurn(f) × decay(f); normChurn(f) = gross(f,W) / max gross in repo; decay(f) = 2^(−daysSinceLastTouch(f)/30)',
    unit: 'score 0-1',
    direction: 'higher_better',
    heuristicNotes:
      '30-day half-life exponential decay. max gross = 0 ⇒ all scores 0. v1.x complexity-proxy extension is config-flagged, not MVP.',
  },
  {
    id: 'M3',
    frId: 'FR-METRICS-3',
    name: 'Ownership / bus factor',
    formula:
      'topShare = max author linesChanged / total; busFactor = smallest author set summing to ≥50% of total linesChanged',
    unit: 'count (busFactor) / ratio (topShare)',
    direction: 'higher_better',
    heuristicNotes:
      'Fixed trailing 365d, per file and directory (recursive sum). single_owner flag at topShare ≥ 0.80.',
  },
  {
    id: 'M4',
    frId: 'FR-METRICS-4',
    name: 'PR cycle-time stages',
    formula:
      'open→firstReview, firstReview→approved (after the last re-request), approved→merged, e2e = merged_at − created_at',
    unit: 'hours',
    direction: 'lower_better',
    heuristicNotes:
      'Merged non-bot PRs only. Dismissed approvals do not count. Zero-review PRs contribute only to e2e. Median + p90 pooled across PRs.',
  },
  {
    id: 'M5',
    frId: 'FR-METRICS-5',
    name: 'Review coverage %',
    formula:
      'covered / merged, where covered = ≥1 completed non-author review (APPROVED, CHANGES_REQUESTED, or COMMENTED with content)',
    unit: 'percent',
    direction: 'higher_better',
    heuristicNotes:
      'Self-review never counts as covered. Bot-authored PRs excluded from both numerator and denominator.',
  },
  {
    id: 'M6',
    frId: 'FR-METRICS-6',
    name: 'Merged-without-review rate',
    formula: '1 − M5',
    unit: 'percent',
    direction: 'lower_better',
    heuristicNotes:
      'Drill-down list {pr, author, merger, sizeBucket, mergedAt} reconciles exactly to the rate.',
  },
  {
    id: 'M7',
    frId: 'FR-METRICS-7',
    name: 'PR size distribution',
    formula:
      'gross = additions + deletions (PR-level forge numbers), bucketed XS[0,10) S[10,100) M[100,500) L[500,1000) XL[1000,∞)',
    unit: 'lines (bucketed)',
    direction: 'neutral',
    heuristicNotes:
      'Buckets inclusive-lower/exclusive-upper. Median-size trend read from snapshots.',
  },
  {
    id: 'M8',
    frId: 'FR-METRICS-8',
    name: 'Stale PRs',
    formula: 'open PRs where daysSince(lastActivityAt) > N (default 7, workspace-configurable)',
    unit: 'count',
    direction: 'lower_better',
    heuristicNotes:
      'Any tracked activity kind (push, review, review-comment, issue-comment) resets the clock. Drafts counted separately (stale_drafts).',
  },
  {
    id: 'M9',
    frId: 'FR-METRICS-9',
    name: 'CI pass rate, duration, flakiness',
    formula:
      'passRate = success / (completed − cancelled − skipped); duration = median+p90(run_started_at→updated_at); flakiness = fail→pass reruns of the same head SHA ÷ rerun groups',
    unit: 'percent (passRate) / minutes (duration) / ratio (flakiness)',
    direction: 'higher_better',
    heuristicNotes:
      'Default-branch vs PR runs reported separately. In-progress runs never in denominators.',
  },
  {
    id: 'M10',
    frId: 'FR-METRICS-10',
    name: 'Issue throughput',
    formula:
      'opened = count(created_at ∈ W); closed = count(closed_at ∈ W, each close event counted); medianTimeToClose over issues closed in W',
    unit: 'count / hours',
    direction: 'neutral',
    heuristicNotes:
      'isPullRequest=false only. Reopen+reclose counts as 2 closes. Open-issue age distribution (p50/p90 + histogram) at snapshot time.',
  },
  {
    id: 'M11',
    frId: 'FR-METRICS-11',
    name: 'Release cadence',
    formula: 'releases per W; median gap between consecutive publishedAt; days since last release',
    unit: 'count / days',
    direction: 'higher_better',
    heuristicNotes:
      'Published non-draft releases (prereleases config-optional, default off). Zero-release repos fall back to annotated tags (basis=tags).',
  },
  {
    id: 'M12',
    frId: 'FR-METRICS-12',
    name: 'DORA approximations',
    formula:
      'Deployment frequency, lead time for changes, change-failure rate, MTTR (not computed in v1)',
    unit: 'mixed (see per-sub-metric basis label)',
    direction: 'higher_better',
    heuristicNotes:
      'Every tile/report carries a basis label and honesty caveat (§1 table) — Gitea always falls back to releases (no deployments API).',
  },
];

export function findMetricByFrId(frId: string): MetricCatalogEntry | undefined {
  return METRIC_CATALOG.find((m) => m.frId === frId);
}
