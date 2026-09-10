import { describe, expect, it } from 'vitest';
import {
  CATALOG_VERSION,
  CATALOG_V1,
  evaluateCriterion,
  generatePlanItems,
  isSameProposal,
  normalizeRepoIds,
  planScopeKey,
  rankInputFor,
  riskOfBreachingSet,
  verifyTransition,
} from './engine.js';
import type { MetricSet } from './catalog.v1.js';

// Plans engine (W5-06, IMPROVEMENT_PLANS.md §1/§2/§3).

const healthy: MetricSet = {
  M5: { value: 0.95, dims: {} },
  M6: { value: 0.0, dims: {} },
  M8: { value: 1, dims: {} },
  M4: { value: 10, dims: { stages: { openToFirstReview: { p90: 6 } } } },
  M9: { value: 0.98, dims: { topFlakiness: 0.01, duration: { p90: 10, median: 9 } } },
};

describe('catalog v4', () => {
  it('carries every seed entry, each with a verify criterion', () => {
    // An entry with no criterion is advice, not a plan item — nothing could
    // ever mark it done, so it would sit on the board forever.
    // 13 until W9-06 added the four code-health entries; 18 with W10-01's
    // knowledge entry, 19 with W10-02's dependency-currency one, 22 once
    // W10-05 gave EOL, architecture and test-gap their own entries.
    expect(CATALOG_V1.length).toBe(22);
    for (const entry of CATALOG_V1) {
      expect(entry.verifyCriterion.metricKey, `${entry.id} criterion`).toBeTruthy();
      expect(entry.id).toMatch(/^[a-z0-9-]+$/);
    }
  });

  it('proposes NOTHING for a healthy repository', () => {
    // The most important negative case: a product that always finds something
    // to recommend is a product nobody believes.
    expect(generatePlanItems({ metrics: healthy })).toEqual([]);
  });

  it('proposes nothing when the metrics are ABSENT rather than bad', () => {
    // Missing data must not read as a breach. Recommending work because a
    // number has not been computed fills a plan with items nobody can act on.
    expect(generatePlanItems({ metrics: {} })).toEqual([]);
  });
});

describe('generation', () => {
  const breaching: MetricSet = {
    M5: { value: 0.4, dims: {} },
    M6: { value: 0.2, dims: {} },
    M8: { value: 40, dims: {} },
  };

  it('ranks by weight, deterministically, with no ties', () => {
    const a = generatePlanItems({ metrics: breaching });
    const b = generatePlanItems({ metrics: breaching });
    expect(a.map((i) => i.catalogId)).toEqual(b.map((i) => i.catalogId));
    // unreviewed-merges (85) outranks review-coverage-low (70) outranks stale-queue (50).
    expect(a.map((i) => i.catalogId)).toEqual([
      'unreviewed-merges',
      'review-coverage-low',
      'stale-queue',
    ]);
    expect(a.map((i) => i.rank)).toEqual([1, 2, 3]);
  });

  it('suppresses a dismissed catalog id instead of re-proposing it', () => {
    // FR-PLANS-2: dismissing has to stick, or the next nightly run undoes a
    // human decision and the dismiss button becomes noise.
    const items = generatePlanItems({ metrics: breaching, dismissedCatalogIds: ['unreviewed-merges'] });
    expect(items.map((i) => i.catalogId)).not.toContain('unreviewed-merges');
    expect(items[0]?.rank).toBe(1);
  });

  it('pins a KEV/chain finding above everything else', () => {
    const items = generatePlanItems({
      metrics: { ...breaching, FINDINGS: { value: null, dims: { kevOrChainOpen: 2, kevFindingIds: [7] } } },
    });
    expect(items[0]?.catalogId).toBe('kev-or-chain-open');
  });

  it('links evidence rather than copying data', () => {
    const [item] = generatePlanItems({ metrics: { M5: { value: 0.4, dims: {} } } });
    expect(item?.evidence).toMatchObject({ metricKeys: ['M5'], value: 0.4 });
  });
});

describe('verification', () => {
  const criterion = { metricKey: 'M5', op: 'gte' as const, target: 0.8, windowDays: 30 };

  it('flips accepted work to done when the criterion holds', () => {
    expect(evaluateCriterion({ M5: { value: 0.9, dims: {} } }, criterion)).toBe('holds');
    expect(verifyTransition('accepted', 'holds', criterion)?.next).toBe('done');
    expect(verifyTransition('in_progress', 'holds', criterion)?.next).toBe('done');
  });

  it('flips done work to regressed when it breaks later', () => {
    expect(evaluateCriterion({ M5: { value: 0.5, dims: {} } }, criterion)).toBe('broken');
    const decision = verifyTransition('done', 'broken', criterion);
    expect(decision?.next).toBe('regressed');
    // The reason travels with the transition — "why did this reopen" is the
    // first question, and the audit row has to answer it.
    expect(decision?.reason).toContain('M5');
  });

  it('recovers a regression back to done', () => {
    expect(verifyTransition('regressed', 'holds', criterion)?.next).toBe('done');
  });

  it('does NOT regress an item when the metric is merely MISSING', () => {
    // The distinction that matters most in this file. A metric that stopped
    // being computed must never tell a team their fix came undone.
    expect(evaluateCriterion({}, criterion)).toBe('unknown');
    expect(verifyTransition('done', 'unknown', criterion)).toBeNull();
    expect(verifyTransition('accepted', 'unknown', criterion)).toBeNull();
  });

  it('never accepts or un-dismisses on a human\'s behalf', () => {
    // proposed → accepted is a decision; the verifier does not make it, and it
    // must not resurrect something a person deliberately dismissed.
    expect(verifyTransition('proposed', 'holds', criterion)).toBeNull();
    expect(verifyTransition('dismissed', 'holds', criterion)).toBeNull();
    expect(verifyTransition('dismissed', 'broken', criterion)).toBeNull();
  });

  it('reads a dim path when the criterion names one', () => {
    const p90 = { metricKey: 'M4', op: 'lte' as const, target: 24, windowDays: 30, dimPath: ['stages', 'openToFirstReview', 'p90'] };
    expect(evaluateCriterion({ M4: { value: 99, dims: { stages: { openToFirstReview: { p90: 12 } } } } }, p90)).toBe('holds');
    // The snapshot VALUE is 99 and would fail; reading the wrong field would
    // regress an item that is actually fine.
    expect(evaluateCriterion({ M4: { value: 1, dims: {} } }, p90)).toBe('unknown');
  });
});

describe('code-health catalog entries (W9-06, FR-PLANS-3)', () => {
  it('verifies off the ch_* snapshots the scanner writes', () => {
    // The property that makes these plan items rather than advice: the nightly
    // verifier can close them from measured numbers, with nobody reporting
    // progress.
    const dup = CATALOG_V1.find((e) => e.id === 'duplication-over-ceiling');
    expect(dup?.verifyCriterion).toMatchObject({
      metricKey: 'ch_duplication_pct',
      op: 'lte',
      target: 5,
    });
    const complexity = CATALOG_V1.find((e) => e.id === 'complexity-worst-functions');
    // ch_worst_fn_count, not p90: a single deleted file moves a percentile
    // without anyone touching the functions that are actually hard to read.
    expect(complexity?.verifyCriterion.metricKey).toBe('ch_worst_fn_count');
    expect(complexity?.verifyCriterion.target).toBe(0);
  });

  it('proposes NOTHING when the scanners have not run', () => {
    // The null-vs-zero rule this catalog already states: a condition on a
    // metric we do not have must be false. Otherwise every unscanned repo
    // gets a duplication plan for a number nobody measured.
    const empty = {} as never;
    for (const id of [
      'duplication-over-ceiling',
      'complexity-worst-functions',
      'slop-density-high',
      'logging-hygiene-adoption',
    ]) {
      const entry = CATALOG_V1.find((e) => e.id === id);
      expect(entry?.condition(empty), id).toBe(false);
    }
  });

  it('fires once a measurement crosses its threshold', () => {
    const dup = CATALOG_V1.find((e) => e.id === 'duplication-over-ceiling');
    expect(dup?.condition({ ch_duplication_pct: { value: 7, dims: {} } })).toBe(true);
    // At the ceiling is not over it.
    expect(dup?.condition({ ch_duplication_pct: { value: 5, dims: {} } })).toBe(false);
  });
});

describe('rank input is effective_risk, not raw severity (W9-10, FR-RISK-5)', () => {
  const withRisk = (dims: Record<string, unknown>) => ({
    FINDINGS: { value: 1, dims },
  });

  it('reorders when RISK changes, with severity untouched', () => {
    // The whole point of the swap. Raw severity used to decide this order, and
    // it is exactly the input the risk engine replaces: a critical finding in a
    // file nobody touches outranked a high one in the hot path.
    const slop = CATALOG_V1.find((e) => e.id === 'slop-density-high')!;
    const cluster = CATALOG_V1.find((e) => e.id === 'act-band-cluster')!;

    const slopHot = rankInputFor(slop, withRisk({ slopRiskSum: 90 }));
    const slopCold = rankInputFor(slop, withRisk({ slopRiskSum: 5 }));
    expect(slopHot).toBeGreaterThan(slopCold);

    // And across entries: a low-weight entry with high risk can overtake a
    // high-weight entry with low risk, which is the reordering the acceptance
    // asks for.
    const clusterCold = rankInputFor(cluster, withRisk({ actBandRiskSum: 3 }));
    expect(slopHot).toBeGreaterThan(clusterCold);
  });

  it('leaves METRIC-only entries on rankWeight alone', () => {
    // There are no findings to price; multiplying by a risk that does not
    // exist would either zero the entry or require inventing a number.
    const metricEntry = CATALOG_V1.find((e) => e.source === 'metric')!;
    expect(rankInputFor(metricEntry, withRisk({ riskSum: 5 }))).toBe(metricEntry.rankWeight);
  });

  it('keeps the KEV/chain PIN first whatever the arithmetic says', () => {
    const pin = CATALOG_V1.find((e) => e.id === 'kev-or-chain-open')!;
    expect(pin.pinned).toBe(true);
    // Even priced at the bottom of the scale, it outranks everything.
    expect(rankInputFor(pin, withRisk({ riskSum: 1 }))).toBe(1000);
    const best = Math.max(
      ...CATALOG_V1.filter((e) => e.id !== 'kev-or-chain-open').map((e) =>
        rankInputFor(e, withRisk({ actBandRiskSum: 100, slopRiskSum: 100, riskSum: 100 })),
      ),
    );
    expect(rankInputFor(pin, withRisk({ riskSum: 1 }))).toBeGreaterThan(best);
  });

  it('falls back to rankWeight when nothing has been priced yet', () => {
    // A finding set nobody has priced is not a finding set that does not
    // matter — falling to zero would hide it until the nightly reprice ran.
    const cluster = CATALOG_V1.find((e) => e.id === 'act-band-cluster')!;
    expect(rankInputFor(cluster, {})).toBe(cluster.rankWeight);
    expect(rankInputFor(cluster, withRisk({}))).toBe(cluster.rankWeight);
  });

  it('sums risk across a cluster rather than taking the worst', () => {
    // Three act-band findings in one module is a bigger job than one, and the
    // plan is a list of jobs.
    const cluster = CATALOG_V1.find((e) => e.id === 'act-band-cluster')!;
    expect(riskOfBreachingSet(cluster, withRisk({ actBandRiskSum: 180 }))).toBe(180);
  });

  it('act-band-cluster closes when the set resolves OR reprices below act', () => {
    // One criterion covers both: the count is of ACT-BAND findings, so a
    // reprice out of act empties it exactly as a fix would.
    const cluster = CATALOG_V1.find((e) => e.id === 'act-band-cluster')!;
    expect(cluster.verifyCriterion).toMatchObject({
      metricKey: 'FINDINGS',
      op: 'lte',
      target: 0,
      dimPath: ['actBandClusterCount'],
    });
  });

  it('stamps a bumped catalog version, because the ORDER rule changed', () => {
    // No entry was added or removed — but plans generated from identical data
    // now come out in a different order, which is what a version records.
    // v3 was the rank-rule change; v4 and v5 add the W10 register entries.
    expect(CATALOG_VERSION).toBe('v6');
  });
});

describe('one plan per scope (W17-24)', () => {
  it('names the same scope for the same repositories in any order', () => {
    // A double-click and a second tab must land on ONE key, and `[2,1]` is not
    // a different scope from `[1,2]`.
    expect(planScopeKey(1, '30d', [2, 1, 2])).toBe(planScopeKey(1, '30d', [1, 2]));
    expect(normalizeRepoIds([3, 1, 3, 0, -1, 2.5])).toEqual([1, 3]);
  });

  it('separates the whole workspace from a repository, and one window from another', () => {
    expect(planScopeKey(1, '30d', [])).not.toBe(planScopeKey(1, '30d', [1]));
    expect(planScopeKey(1, '30d', [1])).not.toBe(planScopeKey(1, '90d', [1]));
    expect(planScopeKey(1, '30d', [1])).not.toBe(planScopeKey(2, '30d', [1]));
  });

  it('treats an identical ordered proposal as the plan that already exists', () => {
    const fresh = [{ catalogId: 'unreviewed-merges' }, { catalogId: 'stale-queue' }];
    expect(
      isSameProposal(fresh, [
        { catalogId: 'unreviewed-merges', status: 'accepted' },
        { catalogId: 'stale-queue', status: 'proposed' },
      ]),
    ).toBe(true);
  });

  it('ignores the existing plan\'s dismissed items, which generation never re-proposes', () => {
    const fresh = [{ catalogId: 'stale-queue' }];
    expect(
      isSameProposal(fresh, [
        { catalogId: 'unreviewed-merges', status: 'dismissed' },
        { catalogId: 'stale-queue', status: 'proposed' },
      ]),
    ).toBe(true);
  });

  it('is a NEW plan when the content or the order differs', () => {
    expect(
      isSameProposal(
        [{ catalogId: 'a' }, { catalogId: 'b' }],
        [{ catalogId: 'b', status: 'proposed' }, { catalogId: 'a', status: 'proposed' }],
      ),
    ).toBe(false);
    expect(isSameProposal([{ catalogId: 'a' }], [])).toBe(false);
    expect(isSameProposal([], [{ catalogId: 'a', status: 'proposed' }])).toBe(false);
    // Two empty plans are the same empty plan.
    expect(isSameProposal([], [])).toBe(true);
  });
});
