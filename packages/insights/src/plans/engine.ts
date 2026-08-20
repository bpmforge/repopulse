import { CATALOG_V1, type CatalogEntry, type MetricSet, type VerifyCriterion } from './catalog.v1.js';

// Plan generation and verification (W5-06, IMPROVEMENT_PLANS.md §2/§3).
//
// Both directions are pure functions over already-read snapshot values, which
// is what lets the nightly verifier and the on-demand generator agree: they
// evaluate the SAME criteria against the same shapes, so an item cannot be
// proposed by one set of rules and verified by another.

export interface ProposedItem {
  catalogId: string;
  rank: number;
  source: CatalogEntry['source'];
  effort: CatalogEntry['effort'];
  recommendation: string;
  evidence: Record<string, unknown>;
  verifyCriterion: VerifyCriterion;
}

export interface GenerateParams {
  metrics: MetricSet;
  /** catalog ids already dismissed for this scope — suppressed, not re-proposed. */
  dismissedCatalogIds?: readonly string[];
  catalog?: readonly CatalogEntry[];
}

/**
 * The rank input for one entry (W9-10, FR-RISK-5, IMPROVEMENT_PLANS §2).
 *
 * `rankWeight × effective_risk of the breaching findings`, when the entry is
 * about findings. Raw severity used to decide this order, and raw severity is
 * exactly the input the risk engine exists to replace: a critical finding in a
 * file nobody touches outranked a high one in the hot path, which is not how
 * anyone actually chooses what to fix.
 *
 * METRIC-ONLY entries keep rankWeight alone. There are no findings to price —
 * multiplying by a risk that does not exist would either zero the entry or
 * require inventing a number for it.
 */
export function rankInputFor(entry: CatalogEntry, metrics: MetricSet): number {
  // A pin outranks arithmetic. See CatalogEntry.pinned.
  if (entry.pinned) return entry.rankWeight;
  if (entry.source === 'metric') return entry.rankWeight;

  const risk = riskOfBreachingSet(entry, metrics);
  // No priced findings behind a finding-sourced entry: fall back to rankWeight
  // rather than to zero. A finding set nobody has priced yet is not a finding
  // set that does not matter.
  if (risk === null) return entry.rankWeight;
  // Normalised by 100 so a rankWeight stays comparable in magnitude: an entry
  // whose findings price at the top of the scale keeps its weight, and one
  // whose findings price low is pushed down rather than annihilated.
  return entry.rankWeight * (risk / 100);
}

/**
 * Summed effective_risk of the findings an entry is about, or null.
 *
 * SUMMED rather than maxed for the cluster entries: three act-band findings in
 * one module is a bigger job than one, and the plan is a list of jobs.
 */
export function riskOfBreachingSet(entry: CatalogEntry, metrics: MetricSet): number | null {
  const dims = metrics.FINDINGS?.dims as Record<string, unknown> | undefined;
  if (!dims) return null;

  const byEntry: Record<string, string> = {
    'act-band-cluster': 'actBandRiskSum',
    'sev-findings-cluster': 'clusterRiskSum',
    'slop-density-high': 'slopRiskSum',
    'logging-hygiene-adoption': 'loggingRiskSum',
  };
  const key = byEntry[entry.id];
  const value = key ? dims[key] : dims.riskSum;
  return typeof value === 'number' ? value : null;
}

/**
 * Evaluates the catalog over one scope and returns ranked items.
 *
 * Ranking is by rank INPUT descending, then catalog id — a total order with no
 * ties, so two generations from the same warehouse produce the same list in the
 * same sequence. A plan whose order wobbles is a plan people stop trusting.
 */
export function generatePlanItems(params: GenerateParams): ProposedItem[] {
  const catalog = params.catalog ?? CATALOG_V1;
  const dismissed = new Set(params.dismissedCatalogIds ?? []);

  return catalog
    .filter((entry) => !dismissed.has(entry.id))
    .filter((entry) => entry.condition(params.metrics))
    .sort(
      (a, b) =>
        rankInputFor(b, params.metrics) - rankInputFor(a, params.metrics) ||
        a.id.localeCompare(b.id),
    )
    .map((entry, index) => ({
      catalogId: entry.id,
      rank: index + 1,
      source: entry.source,
      effort: entry.effort,
      recommendation: entry.title,
      evidence: entry.evidence(params.metrics),
      verifyCriterion: entry.verifyCriterion,
    }));
}

function readCriterionValue(metrics: MetricSet, criterion: VerifyCriterion): number | null {
  const metric = metrics[criterion.metricKey];
  if (!metric) return null;
  if (!criterion.dimPath) return typeof metric.value === 'number' ? metric.value : null;
  let cur: unknown = metric.dims;
  for (const p of criterion.dimPath) {
    if (cur && typeof cur === 'object' && p in cur) cur = (cur as Record<string, unknown>)[p];
    else return null;
  }
  return typeof cur === 'number' ? cur : null;
}

export type VerifyOutcome = 'holds' | 'broken' | 'unknown';

/**
 * Does the criterion hold right now?
 *
 * `unknown` is a distinct answer from `broken`, and the distinction is the
 * whole point: a metric that stopped being computed must NOT flip an item to
 * regressed. That would tell a team their fix came undone when in truth we
 * stopped measuring — the most expensive kind of wrong this product can be.
 */
export function evaluateCriterion(metrics: MetricSet, criterion: VerifyCriterion): VerifyOutcome {
  const value = readCriterionValue(metrics, criterion);
  if (value === null) return 'unknown';
  const holds = criterion.op === 'gte' ? value >= criterion.target : value <= criterion.target;
  return holds ? 'holds' : 'broken';
}

export type ItemStatus =
  | 'proposed'
  | 'accepted'
  | 'in_progress'
  | 'done'
  | 'regressed'
  | 'dismissed';

export interface VerifyDecision {
  next: ItemStatus;
  reason: string;
}

/**
 * The nightly transition for one item (IMPROVEMENT_PLANS.md §3).
 *
 * Returns null when nothing should change — the caller writes an audit row only
 * for real transitions, so the event log stays a history of changes rather than
 * a nightly heartbeat nobody can read.
 */
export function verifyTransition(
  current: ItemStatus,
  outcome: VerifyOutcome,
  criterion: VerifyCriterion,
): VerifyDecision | null {
  if (outcome === 'unknown') return null;

  // Accepted or in-progress work that now meets its criterion is done.
  if ((current === 'accepted' || current === 'in_progress') && outcome === 'holds') {
    return {
      next: 'done',
      reason: `${criterion.metricKey} ${criterion.op === 'gte' ? '≥' : '≤'} ${criterion.target} held for ${criterion.windowDays}d`,
    };
  }

  // Something that was done and is no longer. Reopened rather than silently
  // re-proposed, so the history shows it came back.
  if (current === 'done' && outcome === 'broken') {
    return {
      next: 'regressed',
      reason: `${criterion.metricKey} no longer meets ${criterion.op === 'gte' ? '≥' : '≤'} ${criterion.target}`,
    };
  }

  // A regression that has recovered goes back to done.
  if (current === 'regressed' && outcome === 'holds') {
    return { next: 'done', reason: `${criterion.metricKey} meets ${criterion.target} again` };
  }

  // proposed/dismissed are human states: the verifier never accepts work on
  // someone's behalf, and never un-dismisses something a person dismissed.
  return null;
}

export { CATALOG_V1, CATALOG_VERSION, findCatalogEntry } from './catalog.v1.js';
export type { CatalogEntry, Effort, MetricSet, MetricValue, PlanSource, VerifyCriterion } from './catalog.v1.js';
