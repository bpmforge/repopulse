// Performance review contracts (W17-21).
//
// The Performance tab reviews performance FINDINGS: shapes in the code that a
// deterministic rule pack (scanner key `performance`, rulepacks/code-health/
// perf) or the Tier-2 review checklist flagged as worth a look. Nothing on the
// page is a measurement of how the code RUNS. RepoPulse never executes a
// customer's repository (CONSTRAINTS.md C1), so it has no latency, CPU,
// throughput or memory figure to show, and the page must not manufacture one.
//
// What it CAN say honestly is whether anything has looked, which comes from
// the canonical capability producer (W17-10, GET /repos/:id/capabilities).
// "No provider has looked" and "a run finished and found nothing" are
// different facts, and this module is where that difference is worked out so
// the widget only has to print it.

/** The wire shape of one row from GET /repos/:id/capabilities. */
export interface CapabilityRow {
  id: string;
  label: string;
  kind: 'metadata' | 'ai_review' | 'scanner';
  state: 'not_configured' | 'not_supported' | 'queued' | 'running' | 'succeeded' | 'failed';
  last_success_at: string | null;
  latest_run_id: number | null;
  last_success_ref: string | null;
  stale: boolean;
  detail: string;
}

export interface RepoCapabilities {
  repo_id: number;
  checked_at: string;
  freshness_hours: number;
  capabilities: CapabilityRow[];
}

/** The scanner key the deterministic perf pack files its runs under. */
export const PERF_SCANNER_ID = 'performance';
/** The grouped Tier-2/3 capability; its checklist includes performance.v2. */
export const AI_REVIEW_ID = 'ai_review';

/** The dimension every performance finding, from either producer, carries. */
export const PERFORMANCE_DIMENSION = 'performance';

/**
 * The sentence at the top of the page. Every word of it is load-bearing: a
 * reader arriving at a tab called "Performance" expects numbers, and the
 * first thing the page has to do is say why there are none.
 */
export const PERFORMANCE_REVIEW_DISCLAIMER =
  'These are code-review suggestions from pattern rules and model review, not measured latency, CPU, throughput or memory. RepoPulse never runs this repository, so it has nothing to time. Release cadence and CI turnaround are measured, and live on the Activity tab.';

export type PerformanceReviewKind =
  /** Nothing is set up that could raise a performance finding here. */
  | 'no_provider'
  /** A producer is enabled but has not finished a run for this repository. */
  | 'not_run'
  /** A run is queued or in progress right now. */
  | 'in_progress'
  /** The latest attempt failed and nothing earlier succeeded. */
  | 'failed'
  /** At least one producer has completed a run here; findings are a result. */
  | 'measured';

export interface PerformanceReviewState {
  kind: PerformanceReviewKind;
  /** Producers with a completed run, by label — the ones that earned a zero. */
  measuredBy: string[];
  /** Newest successful run across producers; null when none has succeeded. */
  lastSuccessAt: string | null;
  /** The commit the newest successful SCANNER run measured, when recorded. */
  lastSuccessRef: string | null;
  /** True when the newest success is older than the API's freshness hint. */
  stale: boolean;
  /** True when a later attempt failed after an earlier success. */
  latestFailed: boolean;
}

/**
 * Which producers count as "looking for performance findings".
 *
 * Exactly two, named rather than inferred: the perf pack scanner and AI review
 * (whose checklist includes the performance dimension). A future producer is a
 * deliberate edit here, not something a label match picks up by accident.
 */
function producersOf(caps: readonly CapabilityRow[]): CapabilityRow[] {
  return caps.filter((c) => c.id === PERF_SCANNER_ID || c.id === AI_REVIEW_ID);
}

/**
 * Fold the capability matrix into one state for the page.
 *
 * Precedence: a completed run anywhere wins (`measured`) because findings from
 * it are real regardless of what happened since — the W17-10 rule that a new
 * failure never erases old evidence. Then in-flight, then failed, then the two
 * kinds of nothing: a producer that exists but has not run, and no producer
 * at all. The scanner never having run is REPRESENTED BY ABSENCE in the
 * capability list (rows exist only for keys that have ever run), so "no row
 * and AI review not configured" is the no-provider case.
 */
export function performanceReviewState(
  caps: readonly CapabilityRow[] | undefined,
): PerformanceReviewState {
  const producers = producersOf(caps ?? []);
  const succeeded = producers.filter((c) => c.last_success_at !== null);
  const scanner = producers.find((c) => c.id === PERF_SCANNER_ID);

  const lastSuccessAt =
    succeeded
      .map((c) => c.last_success_at as string)
      .sort()
      .at(-1) ?? null;

  const base = {
    measuredBy: succeeded.map((c) => c.label),
    lastSuccessAt,
    lastSuccessRef: scanner?.last_success_at ? scanner.last_success_ref : null,
    stale: succeeded.length > 0 && succeeded.every((c) => c.stale),
    latestFailed: succeeded.length > 0 && producers.some((c) => c.state === 'failed'),
  };

  if (succeeded.length > 0) return { kind: 'measured', ...base };
  if (producers.some((c) => c.state === 'running' || c.state === 'queued'))
    return { kind: 'in_progress', ...base };
  if (producers.some((c) => c.state === 'failed')) return { kind: 'failed', ...base };
  // AI review reports `not_configured` both when no model is enabled and when
  // a model is enabled but has not reviewed this repository. The detail text
  // is the API's, but the DISTINCTION is carried by the id being present with
  // a scanner row absent: with no perf-scanner row and AI review not
  // configured, nothing here has a switch turned on.
  const ai = producers.find((c) => c.id === AI_REVIEW_ID);
  if (ai && ai.detail.startsWith('A model is configured')) return { kind: 'not_run', ...base };
  return { kind: 'no_provider', ...base };
}

/**
 * The words for an empty findings list, per state. Each is a different
 * sentence on purpose — the acceptance test pins that no two are alike — and
 * none of them contains a number, because none of them is a measurement.
 */
export function performanceEmptyCopy(state: PerformanceReviewState): string {
  switch (state.kind) {
    case 'measured': {
      const who = state.measuredBy.join(' and ');
      return `No open performance findings. ${who} ${state.measuredBy.length === 1 ? 'has' : 'have'} completed a review of this repository, so this is a result, not an absence of measurement.${state.latestFailed ? ' The most recent attempt failed; this reflects the last run that finished.' : ''}`;
    }
    case 'in_progress':
      return 'A performance review is running now. Nothing is known until it finishes; an empty list at this moment says nothing.';
    case 'failed':
      return 'The latest performance review failed and no earlier one finished. Nothing has been measured here — this is not a clean result.';
    case 'not_run':
      return 'A reviewer is configured but has not looked at this repository yet. No performance findings exist because nothing has looked, not because the code is clean.';
    case 'no_provider':
      return 'No performance reviewer is set up for this repository: the perf rule pack has never run here and no model is enabled. Nothing has looked, so an empty list is not a clean bill of health.';
  }
}
