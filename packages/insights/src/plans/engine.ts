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
 * Evaluates the catalog over one scope and returns ranked items.
 *
 * Ranking is by rankWeight descending, then catalog id — a total order with no
 * ties, so two generations from the same warehouse produce the same list in the
 * same sequence. A plan whose order wobbles is a plan people stop trusting.
 */
export function generatePlanItems(params: GenerateParams): ProposedItem[] {
  const catalog = params.catalog ?? CATALOG_V1;
  const dismissed = new Set(params.dismissedCatalogIds ?? []);

  return catalog
    .filter((entry) => !dismissed.has(entry.id))
    .filter((entry) => entry.condition(params.metrics))
    .sort((a, b) => b.rankWeight - a.rankWeight || a.id.localeCompare(b.id))
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
