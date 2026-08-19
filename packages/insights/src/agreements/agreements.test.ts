import { describe, expect, it } from 'vitest';
import { aggregateBreached, computeExceptions, type Agreement, type PrFact } from './index.js';

// Working agreements (W5-08, FR-PLANS-4).

const pr = (over: Partial<PrFact> = {}): PrFact => ({
  repoId: 1,
  number: 10,
  title: 'change',
  additions: 100,
  deletions: 20,
  reviewCount: 2,
  firstReviewHours: 4,
  mergedAt: new Date(),
  ...over,
});

const agreement = (kind: Agreement['kind'], threshold: Record<string, unknown> = {}): Agreement => ({
  id: 1,
  kind,
  threshold,
  repoIds: [],
  active: true,
});

describe('exception lists', () => {
  it('names offending pull requests and never a person', () => {
    const [ex] = computeExceptions(agreement('pr_size_max', { lines: 100 }), [pr()]);
    expect(ex?.prNumber).toBe(10);
    // The row shape cannot leak an author because it does not carry one — the
    // list is artifacts to discuss, not a leaderboard (N-9, R-5).
    expect(Object.keys(ex ?? {})).not.toContain('author');
    expect(ex?.detail).toContain('120 lines');
  });

  it('does not report a PR that meets the agreement', () => {
    expect(computeExceptions(agreement('pr_size_max', { lines: 500 }), [pr()])).toEqual([]);
  });

  it('counts an UNREVIEWED pr under the right agreement, not as a late review', () => {
    // A PR with no review is not a slow review. Counting it under both would
    // make the same pull request appear twice, under two different agreements,
    // and inflate every exception count on the digest card.
    const unreviewed = pr({ reviewCount: 0, firstReviewHours: null });
    expect(computeExceptions(agreement('review_within_hours'), [unreviewed])).toEqual([]);
    expect(computeExceptions(agreement('no_unreviewed_merge'), [unreviewed])).toHaveLength(1);
  });

  it('only counts unreviewed merges that actually MERGED', () => {
    // An open PR with no review yet is normal; it is not a breach until it
    // lands without one.
    const open = pr({ reviewCount: 0, mergedAt: null });
    expect(computeExceptions(agreement('no_unreviewed_merge'), [open])).toEqual([]);
  });

  it('scopes to the agreement repos when it names any', () => {
    const prs = [pr({ repoId: 1 }), pr({ repoId: 2, number: 11 })];
    const scoped = { ...agreement('pr_size_max', { lines: 10 }), repoIds: [2] };
    expect(computeExceptions(scoped, prs).map((e) => e.prNumber)).toEqual([11]);
  });

  it('uses the documented default when the stored threshold omits it', () => {
    // 500 lines (IMPROVEMENT_PLANS.md §4). A missing threshold must not read
    // as zero, which would make every pull request an exception.
    expect(computeExceptions(agreement('pr_size_max'), [pr({ additions: 400, deletions: 50 })])).toEqual([]);
    expect(computeExceptions(agreement('pr_size_max'), [pr({ additions: 600, deletions: 0 })])).toHaveLength(1);
  });
});

describe('aggregate agreements', () => {
  it('judges stale ceiling and CI floor against the metric', () => {
    expect(aggregateBreached(agreement('stale_ceiling', { count: 5 }), 9)).toBe(true);
    expect(aggregateBreached(agreement('stale_ceiling', { count: 5 }), 3)).toBe(false);
    expect(aggregateBreached(agreement('ci_pass_floor', { rate: 0.9 }), 0.5)).toBe(true);
    expect(aggregateBreached(agreement('ci_pass_floor', { rate: 0.9 }), 0.99)).toBe(false);
  });

  it('returns null for a missing metric — unknown is never "fine"', () => {
    // Same rule as the plans verifier: absent data must not be reported as
    // compliance, or a team reads a green agreement for something nobody measured.
    expect(aggregateBreached(agreement('ci_pass_floor'), null)).toBeNull();
  });

  it('has no per-PR exception list, which is not the same as no violations', () => {
    expect(computeExceptions(agreement('stale_ceiling'), [pr()])).toEqual([]);
  });
});
