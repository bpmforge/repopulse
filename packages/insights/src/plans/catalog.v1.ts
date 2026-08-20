// Recommendation catalog v1 (W5-06, IMPROVEMENT_PLANS.md §1, FR-PLANS-1).
//
// Machine-readable and versioned like the metric catalog: the UI, the reports
// and the nightly verifier all read THIS, never a hardcoded string. A plan item
// exists only for a catalog id — there are no free-form items, because an item
// nobody can verify is advice, not a plan.
//
// Every condition is a pure function of already-read snapshot values. Pure
// because the same inputs must produce the same plan: a recommendation that
// appears and disappears between runs teaches people to ignore the screen.

// v3 since W9-10: no entry was added or removed, but the RANK INPUT changed
// from raw rankWeight to rankWeight × the effective_risk of the breaching
// findings (FR-RISK-5). That reorders plans generated from identical data,
// which is exactly the kind of change a version exists to record — a plan
// created under v2 was ranked by a different rule and still says what it said.
//
// (v2 was W9-06, which added the four code-health entries.)
//
// v4 (W10-01) adds the knowledge-concentration entry.
export const CATALOG_VERSION = 'v6';

export type Effort = 'S' | 'M' | 'L';
export type PlanSource = 'metric' | 'finding' | 'chain' | 'compound' | 'agreement';

/** The snapshot values a condition may look at, keyed M1..M12. */
export interface MetricValue {
  value: number | null;
  dims: Record<string, unknown>;
}
export type MetricSet = Partial<Record<string, MetricValue>>;

export interface VerifyCriterion {
  metricKey: string;
  op: 'gte' | 'lte';
  target: number;
  /** Days the criterion must hold before the item flips to done. */
  windowDays: number;
  /** Reads a dim instead of the snapshot value, e.g. ['duration','p90']. */
  dimPath?: string[];
}

export interface CatalogEntry {
  id: string;
  /**
   * Pinned entries rank on rankWeight ALONE (W9-10).
   *
   * A known-exploited or chained finding goes first regardless of what the
   * pricing arithmetic says — the same reasoning as the risk model's `act`
   * overrides. Multiplying a pin by a risk score would let a low-priced KEV
   * finding slide below a tidy-up item, which is the one ordering nobody would
   * accept.
   */
  pinned?: boolean;
  title: string;
  effort: Effort;
  source: PlanSource;
  /** Deterministic base ordering (IMPROVEMENT_PLANS.md §2). Higher ranks first. */
  rankWeight: number;
  /** True when this recommendation applies to the scope. */
  condition: (metrics: MetricSet) => boolean;
  /** What the UI links to. Keys only — never a copy of the data. */
  evidence: (metrics: MetricSet) => Record<string, unknown>;
  verifyCriterion: VerifyCriterion;
}

function num(m: MetricSet, key: string): number | null {
  const v = m[key];
  return v && typeof v.value === 'number' ? v.value : null;
}
function dim(m: MetricSet, key: string, path: string[]): number | null {
  let cur: unknown = m[key]?.dims;
  for (const p of path) {
    if (cur && typeof cur === 'object' && p in cur) cur = (cur as Record<string, unknown>)[p];
    else return null;
  }
  return typeof cur === 'number' ? cur : null;
}

// A condition on a metric we do not have must be FALSE, never true. Proposing
// work because a number is missing is how a plan fills with items nobody can
// act on — and it is the null-vs-zero trap this project keeps meeting.
const below = (v: number | null, t: number) => v !== null && v < t;
const above = (v: number | null, t: number) => v !== null && v > t;

export const CATALOG_V1: readonly CatalogEntry[] = [
  {
    id: 'review-coverage-low',
    title: 'Adopt a review SLA and rebalance reviewers',
    effort: 'M',
    source: 'metric',
    rankWeight: 70,
    condition: (m) => below(num(m, 'M5'), 0.8),
    evidence: (m) => ({ metricKeys: ['M5'], value: num(m, 'M5') }),
    verifyCriterion: { metricKey: 'M5', op: 'gte', target: 0.8, windowDays: 30 },
  },
  {
    id: 'first-review-slow',
    title: 'Agree a review window and cap work in progress',
    effort: 'M',
    source: 'metric',
    rankWeight: 60,
    condition: (m) => above(dim(m, 'M4', ['stages', 'openToFirstReview', 'p90']), 24),
    evidence: (m) => ({
      metricKeys: ['M4'],
      p90Hours: dim(m, 'M4', ['stages', 'openToFirstReview', 'p90']),
    }),
    verifyCriterion: {
      metricKey: 'M4',
      op: 'lte',
      target: 24,
      windowDays: 30,
      dimPath: ['stages', 'openToFirstReview', 'p90'],
    },
  },
  {
    id: 'unreviewed-merges',
    title: 'Adopt a no-unreviewed-merge agreement with an explicit exception list',
    effort: 'S',
    source: 'metric',
    rankWeight: 85,
    condition: (m) => above(num(m, 'M6'), 0.05),
    evidence: (m) => ({ metricKeys: ['M6'], value: num(m, 'M6') }),
    verifyCriterion: { metricKey: 'M6', op: 'lte', target: 0.05, windowDays: 30 },
  },
  {
    id: 'oversized-prs',
    title: 'Adopt a pull-request size agreement (≤500 lines) with splitting guidance',
    effort: 'M',
    source: 'metric',
    rankWeight: 55,
    condition: (m) => above(dim(m, 'M7', ['xlShare']), 0.15),
    evidence: (m) => ({ metricKeys: ['M7'], xlShare: dim(m, 'M7', ['xlShare']) }),
    verifyCriterion: { metricKey: 'M7', op: 'lte', target: 0.15, windowDays: 30, dimPath: ['xlShare'] },
  },
  {
    id: 'stale-queue',
    title: 'Run a weekly stale pull-request triage',
    effort: 'S',
    source: 'metric',
    rankWeight: 50,
    condition: (m) => above(num(m, 'M8'), 10),
    evidence: (m) => ({ metricKeys: ['M8'], count: num(m, 'M8') }),
    // Target 5, not 10: clearing back to the threshold that raised the item
    // would flip it done while sitting exactly on the line.
    verifyCriterion: { metricKey: 'M8', op: 'lte', target: 5, windowDays: 14 },
  },
  {
    id: 'hotspot-bus-factor',
    title: 'Pair or document the top hotspot file — it has a single owner',
    effort: 'L',
    source: 'metric',
    rankWeight: 90,
    condition: (m) => above(num(m, 'M2'), 0.5) && dim(m, 'M3', ['busFactor']) === 1,
    evidence: (m) => ({
      metricKeys: ['M2', 'M3'],
      hotspot: num(m, 'M2'),
      busFactor: dim(m, 'M3', ['busFactor']),
    }),
    verifyCriterion: { metricKey: 'M3', op: 'gte', target: 2, windowDays: 365, dimPath: ['busFactor'] },
  },
  {
    id: 'flaky-workflow',
    title: 'Quarantine and fix the worst flaky workflow',
    effort: 'M',
    source: 'metric',
    rankWeight: 75,
    condition: (m) => above(dim(m, 'M9', ['topFlakiness']), 0.1),
    evidence: (m) => ({ metricKeys: ['M9'], topFlakiness: dim(m, 'M9', ['topFlakiness']) }),
    verifyCriterion: { metricKey: 'M9', op: 'lte', target: 0.05, windowDays: 30, dimPath: ['topFlakiness'] },
  },
  {
    id: 'ci-slow',
    title: 'Investigate CI duration — p90 is far above the repository median',
    effort: 'M',
    source: 'metric',
    rankWeight: 45,
    condition: (m) => {
      const p90 = dim(m, 'M9', ['duration', 'p90']);
      const median = dim(m, 'M9', ['duration', 'median']);
      // Both required: a p90 with no median to compare against is not evidence
      // of anything, and defaulting the median would invent the comparison.
      return p90 !== null && median !== null && median > 0 && p90 > 2 * median;
    },
    evidence: (m) => ({
      metricKeys: ['M9'],
      p90: dim(m, 'M9', ['duration', 'p90']),
      median: dim(m, 'M9', ['duration', 'median']),
    }),
    verifyCriterion: { metricKey: 'M9', op: 'lte', target: 1.2, windowDays: 30, dimPath: ['duration', 'p90Ratio'] },
  },
  {
    id: 'cfr-high',
    title: 'Review the deploy window — change-failure rate is high',
    effort: 'L',
    source: 'metric',
    rankWeight: 80,
    condition: (m) => above(dim(m, 'M12', ['changeFailureRate']), 0.15),
    evidence: (m) => ({ metricKeys: ['M12'], cfr: dim(m, 'M12', ['changeFailureRate']) }),
    verifyCriterion: { metricKey: 'M12', op: 'lte', target: 0.1, windowDays: 90, dimPath: ['changeFailureRate'] },
  },
  {
    id: 'release-stale',
    title: 'Review release cadence — nothing has shipped recently',
    effort: 'S',
    source: 'metric',
    rankWeight: 40,
    condition: (m) => above(dim(m, 'M11', ['daysSinceLast']), 60),
    evidence: (m) => ({ metricKeys: ['M11'], daysSinceLast: dim(m, 'M11', ['daysSinceLast']) }),
    verifyCriterion: { metricKey: 'M11', op: 'lte', target: 30, windowDays: 30, dimPath: ['daysSinceLast'] },
  },
  // The three finding-driven entries. Their conditions are false in v1 because
  // findings do not exist until W6 — declared now so the catalog is complete
  // and versioned, and so W6 wires data rather than adding vocabulary.
  {
    id: 'sev-findings-cluster',
    title: 'Remediate the clustered high-severity findings in this module',
    effort: 'L',
    source: 'finding',
    rankWeight: 95,
    condition: (m) => above(dim(m, 'FINDINGS', ['sevClusterCount']), 2),
    evidence: (m) => ({ findingIds: m.FINDINGS?.dims.clusterFindingIds ?? [] }),
    verifyCriterion: { metricKey: 'FINDINGS', op: 'lte', target: 0, windowDays: 1, dimPath: ['sevClusterCount'] },
  },
  {
    id: 'kev-or-chain-open',
    title: 'Remediate immediately — a known-exploited or chained finding is open',
    effort: 'L',
    source: 'chain',
    // Pinned first (IMPROVEMENT_PLANS.md §2): everything else waits.
    pinned: true,
    rankWeight: 1000,
    condition: (m) => above(dim(m, 'FINDINGS', ['kevOrChainOpen']), 0),
    evidence: (m) => ({ findingIds: m.FINDINGS?.dims.kevFindingIds ?? [] }),
    verifyCriterion: { metricKey: 'FINDINGS', op: 'lte', target: 0, windowDays: 1, dimPath: ['kevOrChainOpen'] },
  },
  {
    id: 'act-band-cluster',
    title: 'Remediate the clustered act-band findings in this module',
    effort: 'L',
    source: 'compound',
    rankWeight: 92,
    condition: (m) => above(dim(m, 'FINDINGS', ['actBandClusterCount']), 2),
    evidence: (m) => ({ findingIds: m.FINDINGS?.dims.actBandFindingIds ?? [] }),
    verifyCriterion: {
      metricKey: 'FINDINGS',
      op: 'lte',
      target: 0,
      windowDays: 1,
      dimPath: ['actBandClusterCount'],
    },
  },
  // ---- Code health, v2 additions (W9-06, FR-PLANS-3) --------------------
  //
  // Every one of these verifies off a ch_* snapshot the W9-02 scanner writes,
  // so the nightly verifier can close them WITHOUT anyone reporting progress.
  // A plan item whose completion depends on someone remembering to tick it is
  // a to-do list, not a plan.
  {
    id: 'duplication-over-ceiling',
    title: 'Bring duplication under the 5% ceiling',
    effort: 'M',
    source: 'metric',
    rankWeight: 55,
    condition: (m) => above(num(m, 'ch_duplication_pct'), 5),
    evidence: (m) => ({
      metricKeys: ['ch_duplication_pct'],
      value: num(m, 'ch_duplication_pct'),
    }),
    verifyCriterion: { metricKey: 'ch_duplication_pct', op: 'lte', target: 5, windowDays: 14 },
  },
  {
    id: 'complexity-worst-functions',
    title: 'Split the functions past the critical complexity threshold',
    effort: 'L',
    source: 'metric',
    rankWeight: 58,
    condition: (m) => above(num(m, 'ch_worst_fn_count'), 0),
    evidence: (m) => ({
      metricKeys: ['ch_worst_fn_count', 'ch_complexity_p90'],
      worstFunctions: num(m, 'ch_worst_fn_count'),
    }),
    // Zero functions past the CRITICAL threshold, held for a fortnight. Not
    // "reduce p90", which a single deleted file can achieve without anyone
    // touching the functions that are actually hard to read.
    verifyCriterion: { metricKey: 'ch_worst_fn_count', op: 'lte', target: 0, windowDays: 14 },
  },
  {
    id: 'slop-density-high',
    title: 'Clear the structural-slop backlog in the worst files',
    effort: 'M',
    source: 'finding',
    rankWeight: 45,
    condition: (m) => above(dim(m, 'FINDINGS', ['slopDensity']), 3),
    evidence: (m) => ({ findingIds: m.FINDINGS?.dims.slopFindingIds ?? [] }),
    verifyCriterion: {
      metricKey: 'FINDINGS',
      op: 'lte',
      target: 3,
      windowDays: 14,
      dimPath: ['slopDensity'],
    },
  },
  {
    id: 'logging-hygiene-adoption',
    title: 'Adopt the structured logger on the request path',
    effort: 'S',
    source: 'finding',
    rankWeight: 40,
    condition: (m) => above(dim(m, 'FINDINGS', ['loggingFindingCount']), 5),
    evidence: (m) => ({ findingIds: m.FINDINGS?.dims.loggingFindingIds ?? [] }),
    verifyCriterion: {
      metricKey: 'FINDINGS',
      op: 'lte',
      target: 0,
      windowDays: 14,
      dimPath: ['loggingFindingCount'],
    },
  },
  // ---- Structural registers, v4 (W10-01, FR-REG-1) ----------------------
  {
    id: 'knowledge-cluster',
    title: 'Bring a second maintainer into the concentrated module',
    effort: 'M',
    source: 'finding',
    rankWeight: 50,
    condition: (m) => above(dim(m, 'FINDINGS', ['knowledgeFindingCount']), 0),
    evidence: (m) => ({ findingIds: m.FINDINGS?.dims.knowledgeFindingIds ?? [] }),
    // Ninety days, not thirty: a second maintainer who reviewed one PR in a
    // quiet week has not learned a module. The criterion is the count of
    // concentrated modules falling to zero and STAYING there.
    verifyCriterion: {
      metricKey: 'FINDINGS',
      op: 'lte',
      target: 0,
      windowDays: 90,
      dimPath: ['knowledgeFindingCount'],
    },
  },
  {
    id: 'dependency-currency',
    title: 'Clear the abandoned and end-of-life dependencies',
    effort: 'M',
    source: 'finding',
    rankWeight: 55,
    condition: (m) => above(dim(m, 'FINDINGS', ['dependencyHealthFindingCount']), 0),
    evidence: (m) => ({ findingIds: m.FINDINGS?.dims.dependencyHealthFindingIds ?? [] }),
    // The W10-02 severity ramp, documented where a reader of the plan can see
    // it: yanked 4 · deprecated 3 · abandoned (24m no release) 3 · stale (12m)
    // 2 · two majors behind 3 · one major behind 2 · past-EOL runtime 4 ·
    // within 90d of EOL 2 · AGPL/SSPL prod-direct 3 · undeclared licence 2.
    // Dev-scoped findings drop one step and never below 1.
    verifyCriterion: {
      metricKey: 'FINDINGS',
      op: 'lte',
      target: 0,
      windowDays: 30,
      dimPath: ['dependencyHealthFindingCount'],
    },
  },
  {
    id: 'eol-runtimes',
    title: 'Move off the end-of-life runtimes',
    effort: 'L',
    source: 'finding',
    rankWeight: 70,
    // A runtime past EOL stops receiving security fixes entirely, which is why
    // this outranks the currency entry above it and why the target is zero
    // rather than a reduction.
    condition: (m) => above(dim(m, 'FINDINGS', ['eolRuntimeCount']), 0),
    evidence: (m) => ({ findingIds: m.FINDINGS?.dims.dependencyHealthFindingIds ?? [] }),
    verifyCriterion: {
      metricKey: 'FINDINGS',
      op: 'lte',
      target: 0,
      windowDays: 30,
      dimPath: ['eolRuntimeCount'],
    },
  },
  {
    id: 'architecture-cycles',
    title: 'Break the import cycles',
    effort: 'M',
    source: 'finding',
    rankWeight: 45,
    condition: (m) => above(dim(m, 'FINDINGS', ['architectureFindingCount']), 0),
    evidence: (m) => ({ findingIds: m.FINDINGS?.dims.architectureFindingIds ?? [] }),
    // Thirty days, not ninety: a cycle either got broken or it did not, and the
    // graph says which on the next scan.
    verifyCriterion: {
      metricKey: 'FINDINGS',
      op: 'lte',
      target: 0,
      windowDays: 30,
      dimPath: ['architectureFindingCount'],
    },
  },
  {
    id: 'test-gap-hot-files',
    title: 'Put the hot files under test',
    effort: 'M',
    source: 'finding',
    rankWeight: 40,
    condition: (m) => above(dim(m, 'FINDINGS', ['testGapFindingCount']), 0),
    evidence: (m) => ({ findingIds: m.FINDINGS?.dims.testGapFindingIds ?? [] }),
    // Sixty days: the criterion is that the co-change habit changed, and one
    // sprint of good intentions does not prove that.
    verifyCriterion: {
      metricKey: 'FINDINGS',
      op: 'lte',
      target: 0,
      windowDays: 60,
      dimPath: ['testGapFindingCount'],
    },
  },
];

export function findCatalogEntry(id: string): CatalogEntry | undefined {
  return CATALOG_V1.find((e) => e.id === id);
}
