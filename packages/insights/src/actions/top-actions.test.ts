import { describe, expect, it } from 'vitest';
import {
  MAX_ACTIONS,
  selectTopActions,
  type FindingActionCandidate,
  type PlanItemActionCandidate,
} from './top-actions.js';
import { summarizeCoverage, type RepoCoverageInput } from './coverage.js';

// W17-16. The card promises "here is what to do next", and the promise only
// holds if the answer is the same on two consecutive reads.

function finding(over: Partial<FindingActionCandidate> = {}): FindingActionCandidate {
  return {
    kind: 'finding',
    findingId: 1,
    repoId: 10,
    repoName: 'alpha',
    title: 'Hardcoded credential',
    dimension: 'security',
    severity: 4,
    effectiveRisk: 50,
    riskBand: 'schedule',
    ...over,
  };
}

function planItem(over: Partial<PlanItemActionCandidate> = {}): PlanItemActionCandidate {
  return {
    kind: 'plan_item',
    planItemId: 100,
    planId: 7,
    catalogId: 'review-coverage-low',
    recommendation: 'Raise review coverage',
    effort: 'M',
    rank: 1,
    findingIds: [],
    ...over,
  };
}

describe('selectTopActions ordering (W17-16)', () => {
  it('ranks findings by priced risk, not by input order', () => {
    const actions = selectTopActions({
      findings: [
        finding({ findingId: 1, effectiveRisk: 9 }),
        finding({ findingId: 2, effectiveRisk: 80 }),
      ],
      planItems: [],
    });
    expect(actions.map((a) => a.id)).toEqual(['finding:2', 'finding:1']);
  });

  it('orders two findings with the SAME TITLE in different repositories', () => {
    // The case the acceptance names. Same rule, same price, two repositories:
    // without a tie-break past the title the two rows are unordered relative to
    // each other and the card reshuffles between refreshes.
    const a = finding({ findingId: 30, repoId: 2, repoName: 'zulu' });
    const b = finding({ findingId: 31, repoId: 3, repoName: 'alpha' });
    const forward = selectTopActions({ findings: [a, b], planItems: [] }).map((x) => x.id);
    const reverse = selectTopActions({ findings: [b, a], planItems: [] }).map((x) => x.id);
    expect(forward).toEqual(reverse);
    // alpha before zulu — repository name is the tie-break that decides it.
    expect(forward).toEqual(['finding:31', 'finding:30']);
  });

  it('breaks a full tie on the finding id, which is unique', () => {
    const a = finding({ findingId: 9, repoId: 2, repoName: 'same' });
    const b = finding({ findingId: 4, repoId: 3, repoName: 'same' });
    expect(selectTopActions({ findings: [a, b], planItems: [] }).map((x) => x.id)).toEqual([
      'finding:4',
      'finding:9',
    ]);
  });

  it('sorts unpriced findings last without dropping them', () => {
    const actions = selectTopActions({
      findings: [finding({ findingId: 1, effectiveRisk: null }), finding({ findingId: 2 })],
      planItems: [],
    });
    expect(actions.map((a) => a.id)).toEqual(['finding:2', 'finding:1']);
    expect(actions[1]?.reason).toContain('Not priced yet');
  });

  it('never returns more than three', () => {
    const actions = selectTopActions({
      findings: [1, 2, 3, 4, 5].map((i) => finding({ findingId: i, effectiveRisk: 100 - i })),
      planItems: [1, 2, 3].map((i) => planItem({ planItemId: i, rank: i })),
    });
    expect(actions).toHaveLength(MAX_ACTIONS);
    // Two findings, then the top plan item: the per-kind cap is what keeps an
    // agreed plan visible next to freshly priced findings.
    expect(actions.map((a) => a.id)).toEqual(['finding:1', 'finding:2', 'plan_item:1']);
  });

  it('spends the leftover slots on findings when there are no plans', () => {
    const actions = selectTopActions({
      findings: [1, 2, 3, 4].map((i) => finding({ findingId: i, effectiveRisk: 100 - i })),
      planItems: [],
    });
    expect(actions.map((a) => a.id)).toEqual(['finding:1', 'finding:2', 'finding:3']);
  });
});

describe('selectTopActions deduplication (W17-16)', () => {
  it('drops a duplicate finding id arriving twice', () => {
    const actions = selectTopActions({
      findings: [finding({ findingId: 5 }), finding({ findingId: 5 })],
      planItems: [],
    });
    expect(actions.map((a) => a.id)).toEqual(['finding:5']);
  });

  it('does not list a finding and the plan item that is about it', () => {
    // One job, two rows. plan_items.evidence carries finding ids, so a plan
    // item can name exactly the finding sitting above it on the card.
    const actions = selectTopActions({
      findings: [finding({ findingId: 5, effectiveRisk: 90 })],
      planItems: [planItem({ planItemId: 42, findingIds: [5] })],
    });
    expect(actions.map((a) => a.id)).toEqual(['finding:5']);
  });
});

describe('top action deep links (W17-16, W16-49)', () => {
  it('a finding links with the explorer’s own param', () => {
    const [action] = selectTopActions({ findings: [finding({ findingId: 77 })], planItems: [] });
    expect(action?.href).toBe('/findings?finding=77');
    expect(action?.target).toEqual({ kind: 'finding', findingId: 77, repoId: 10 });
  });

  it('a plan item links to /plans with no invented search param', () => {
    // The plans route validates no per-item param, and TanStack REPLACES the
    // search object — an unknown key would be stripped and open nothing.
    const [action] = selectTopActions({
      findings: [],
      planItems: [planItem({ planItemId: 42, planId: 7 })],
    });
    expect(action?.href).toBe('/plans');
    expect(action?.target).toEqual({ kind: 'plan_item', planId: 7, planItemId: 42 });
  });

  it('carries the stored effort for a plan item and none for a finding', () => {
    const [item] = selectTopActions({ findings: [], planItems: [planItem({ effort: 'L' })] });
    expect(item?.effort).toBe('L');
    const [found] = selectTopActions({ findings: [finding()], planItems: [] });
    expect(found?.effort).toBeNull();
  });
});

describe('summarizeCoverage (W17-16)', () => {
  const repo = (over: Partial<RepoCoverageInput> = {}): RepoCoverageInput => ({
    repoId: 1,
    repoName: 'alpha',
    capabilities: [
      {
        id: 'metadata',
        kind: 'metadata',
        state: 'succeeded',
        lastSuccessAt: '2026-09-10T00:00:00.000Z',
        stale: false,
      },
    ],
    ...over,
  });

  it('never-measured reads as an absence of a result, not a clean one', () => {
    const state = summarizeCoverage([
      repo({
        capabilities: [
          {
            id: 'metadata',
            kind: 'metadata',
            state: 'not_configured',
            lastSuccessAt: null,
            stale: false,
          },
        ],
      }),
    ]);
    expect(state.basis).toBe('none');
    expect(state.reposMeasured).toBe(0);
    expect(state.summary).toContain('not a clean result');
  });

  it('says how much was measured when only some of it was', () => {
    const state = summarizeCoverage([
      repo({ repoId: 1, repoName: 'alpha' }),
      repo({
        repoId: 2,
        repoName: 'bravo',
        capabilities: [
          {
            id: 'metadata',
            kind: 'metadata',
            state: 'not_configured',
            lastSuccessAt: null,
            stale: false,
          },
        ],
      }),
    ]);
    expect(state.basis).toBe('partial');
    expect(state.summary).toContain('1 of 2 repositories have been measured');
  });

  it('reports a failed scan as an operational notice, not a finding', () => {
    const state = summarizeCoverage([
      repo({
        capabilities: [
          {
            id: 'metadata',
            kind: 'metadata',
            state: 'succeeded',
            lastSuccessAt: '2026-09-10T00:00:00.000Z',
            stale: false,
          },
          {
            id: 'semgrep',
            kind: 'scanner',
            state: 'failed',
            lastSuccessAt: null,
            stale: false,
            detail: 'boom',
          },
        ],
      }),
    ]);
    expect(state.notices).toEqual([
      { repoId: 1, repoName: 'alpha', capability: 'semgrep', state: 'failed', detail: 'boom' },
    ]);
    expect(state.basis).toBe('partial');
  });

  it('lists reserved-but-unshipped capabilities once, sorted', () => {
    const state = summarizeCoverage([
      repo({
        repoId: 1,
        capabilities: [
          {
            id: 'test_coverage',
            kind: 'scanner',
            state: 'not_supported',
            lastSuccessAt: null,
            stale: false,
          },
          { id: 'iac', kind: 'scanner', state: 'not_supported', lastSuccessAt: null, stale: false },
        ],
      }),
      repo({
        repoId: 2,
        repoName: 'bravo',
        capabilities: [
          { id: 'iac', kind: 'scanner', state: 'not_supported', lastSuccessAt: null, stale: false },
        ],
      }),
    ]);
    expect(state.unsupported).toEqual(['iac', 'test_coverage']);
  });

  it('counts stale repositories separately from unmeasured ones', () => {
    const state = summarizeCoverage([
      repo({
        capabilities: [
          {
            id: 'metadata',
            kind: 'metadata',
            state: 'succeeded',
            lastSuccessAt: '2026-08-01T00:00:00.000Z',
            stale: true,
          },
        ],
      }),
    ]);
    expect(state.reposMeasured).toBe(1);
    expect(state.reposStale).toBe(1);
    expect(state.basis).toBe('partial');
    expect(state.summary).toContain('not been measured recently');
  });

  it('says nothing is connected when nothing is', () => {
    expect(summarizeCoverage([]).summary).toContain('No repositories are connected');
  });
});
