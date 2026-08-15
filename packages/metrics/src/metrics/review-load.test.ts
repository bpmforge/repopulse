import { describe, expect, it } from 'vitest';
import { computeReviewLoad, type ReviewLoadInput } from './review-load.js';

// W4-15. The matrix answers "who carries the review burden", and the ways to
// get that wrong all produce plausible-looking output — which is why W4-04
// shipped an empty state rather than a chart built from author data.

const review = (over: Partial<ReviewLoadInput> = {}): ReviewLoadInput => ({
  reviewerLogin: 'alice',
  state: 'APPROVED',
  pullRequestId: 1,
  isSelfReview: false,
  isBot: false,
  ...over,
});

describe('computeReviewLoad (UX_SPEC §4.b)', () => {
  it('counts distinct PRs, not review events', () => {
    // Four passes over one PR is one PR's worth of load. Reporting only the
    // event count would flatter a reviewer who kept re-reviewing one change.
    const result = computeReviewLoad([
      review({ pullRequestId: 1 }),
      review({ pullRequestId: 1, state: 'CHANGES_REQUESTED' }),
      review({ pullRequestId: 1, state: 'COMMENTED' }),
      review({ pullRequestId: 1 }),
    ]);
    expect(result.reviewers[0]!.prsReviewed).toBe(1);
    expect(result.reviewers[0]!.reviews).toBe(4);
  });

  it('excludes self-reviews and says how many', () => {
    // A repo where everyone approves their own work must NOT look evenly
    // reviewed — that is the opposite of what the matrix exists to reveal.
    const result = computeReviewLoad([
      review({ reviewerLogin: 'alice', pullRequestId: 1 }),
      review({ reviewerLogin: 'bob', pullRequestId: 2, isSelfReview: true }),
    ]);
    expect(result.reviewers.map((r) => r.reviewerLogin)).toEqual(['alice']);
    expect(result.excluded.selfReviews).toBe(1);
    // Reported, not silently dropped: the screen can say what was left out.
    expect(result.prsWithReview).toBe(1);
  });

  it('excludes bots (METRICS.md §0) and says how many', () => {
    const result = computeReviewLoad([
      review({ reviewerLogin: 'dependabot[bot]', isBot: true }),
      review({ reviewerLogin: 'alice' }),
    ]);
    expect(result.reviewers).toHaveLength(1);
    expect(result.excluded.botReviews).toBe(1);
  });

  it('breaks down states, folding DISMISSED into comments', () => {
    const result = computeReviewLoad([
      review({ pullRequestId: 1, state: 'APPROVED' }),
      review({ pullRequestId: 2, state: 'CHANGES_REQUESTED' }),
      review({ pullRequestId: 3, state: 'COMMENTED' }),
      // A dismissed review still consumed a reviewer's time, which is what
      // "load" measures — so it counts rather than vanishing.
      review({ pullRequestId: 4, state: 'DISMISSED' }),
    ]);
    const alice = result.reviewers[0]!;
    expect(alice.approvals).toBe(1);
    expect(alice.changesRequested).toBe(1);
    expect(alice.comments).toBe(2);
    expect(alice.prsReviewed).toBe(4);
  });

  it('orders by load with a stable tiebreak', () => {
    // An unstable order makes the matrix appear to change when nothing has.
    const result = computeReviewLoad([
      review({ reviewerLogin: 'carol', pullRequestId: 1 }),
      review({ reviewerLogin: 'alice', pullRequestId: 2 }),
      review({ reviewerLogin: 'bob', pullRequestId: 3 }),
      review({ reviewerLogin: 'bob', pullRequestId: 4 }),
    ]);
    expect(result.reviewers.map((r) => r.reviewerLogin)).toEqual(['bob', 'alice', 'carol']);
  });

  it('an unreviewed window yields no reviewers, not a zero row', () => {
    const result = computeReviewLoad([]);
    expect(result.reviewers).toEqual([]);
    expect(result.prsWithReview).toBe(0);
  });
});
