import { describe, expect, it } from 'vitest';
import { CATALOG_V1, evaluateCriterion, generatePlanItems, verifyTransition } from './engine.js';
import type { MetricSet } from './catalog.v1.js';

// Plans engine (W5-06, IMPROVEMENT_PLANS.md §1/§2/§3).

const healthy: MetricSet = {
  M5: { value: 0.95, dims: {} },
  M6: { value: 0.0, dims: {} },
  M8: { value: 1, dims: {} },
  M4: { value: 10, dims: { stages: { openToFirstReview: { p90: 6 } } } },
  M9: { value: 0.98, dims: { topFlakiness: 0.01, duration: { p90: 10, median: 9 } } },
};

describe('catalog v1', () => {
  it('carries every seed entry, each with a verify criterion', () => {
    // An entry with no criterion is advice, not a plan item — nothing could
    // ever mark it done, so it would sit on the board forever.
    expect(CATALOG_V1.length).toBe(13);
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
