// Review load per reviewer (W4-15, UX_SPEC §4.b "review-load matrix").
//
// The matrix answers "who is carrying the review burden", which is a question
// about REVIEWERS. The PR list exposes author and a review_covered flag, and a
// matrix built from those would render plausibly while answering a different
// question — W4-04 shipped the funnel and the size histogram and left the
// matrix out for exactly that reason, on a screen whose whole job is evidence.
//
// N-9 / D6 note: this is per-reviewer aggregate data on a REPO screen, which
// UX_SPEC §7's presentation rule permits as workload distribution — but it is
// never a ranking of people and must not be presented as one. The consumer
// labels it "review load", shows counts, and does not sort people into a
// leaderboard.

export interface ReviewLoadInput {
  reviewerLogin: string;
  /** GitHub review states: APPROVED / CHANGES_REQUESTED / COMMENTED / DISMISSED. */
  state: string;
  /** The PR reviewed — one reviewer may review the same PR several times. */
  pullRequestId: number;
  /** Whether the reviewer also authored the PR (self-review). */
  isSelfReview: boolean;
  isBot: boolean;
}

export interface ReviewerLoad {
  reviewerLogin: string;
  /** DISTINCT PRs reviewed — the honest measure of load. */
  prsReviewed: number;
  /** Every review event, which is larger whenever a PR needed several rounds. */
  reviews: number;
  approvals: number;
  changesRequested: number;
  comments: number;
}

export interface ReviewLoadResult {
  reviewers: readonly ReviewerLoad[];
  /** Distinct PRs with at least one non-self, non-bot review in the window. */
  prsWithReview: number;
  /** Excluded from every count above, reported so the screen can say so. */
  excluded: { selfReviews: number; botReviews: number };
}

/**
 * Per-reviewer counts over a window's review events, ranked by distinct PRs
 * reviewed.
 *
 * SELF-REVIEWS AND BOTS ARE EXCLUDED, and reported rather than dropped
 * silently. A self-review is not review load — counting it would let a repo
 * where everyone approves their own work look evenly reviewed, which is the
 * opposite of what the matrix exists to reveal. METRICS.md §0 excludes bots
 * from every human-flow metric, and review load is one.
 *
 * `prsReviewed` counts DISTINCT PRs and `reviews` counts events: a reviewer who
 * makes four passes over one PR did one PR's worth of review, and reporting
 * only the event count would flatter them. Both are returned because the gap
 * between them is itself informative.
 */
export function computeReviewLoad(inputs: readonly ReviewLoadInput[]): ReviewLoadResult {
  const excluded = { selfReviews: 0, botReviews: 0 };
  const byReviewer = new Map<string, { prs: Set<number>; load: ReviewerLoad }>();
  const prsWithReview = new Set<number>();

  for (const input of inputs) {
    if (input.isBot) {
      excluded.botReviews++;
      continue;
    }
    if (input.isSelfReview) {
      excluded.selfReviews++;
      continue;
    }

    let entry = byReviewer.get(input.reviewerLogin);
    if (!entry) {
      entry = {
        prs: new Set<number>(),
        load: {
          reviewerLogin: input.reviewerLogin,
          prsReviewed: 0,
          reviews: 0,
          approvals: 0,
          changesRequested: 0,
          comments: 0,
        },
      };
      byReviewer.set(input.reviewerLogin, entry);
    }

    entry.prs.add(input.pullRequestId);
    entry.load.reviews++;
    prsWithReview.add(input.pullRequestId);

    switch (input.state.toUpperCase()) {
      case 'APPROVED':
        entry.load.approvals++;
        break;
      case 'CHANGES_REQUESTED':
        entry.load.changesRequested++;
        break;
      // COMMENTED and DISMISSED both land here. DISMISSED is deliberately not
      // its own column: a dismissed review still consumed a reviewer's time,
      // which is what "load" measures.
      default:
        entry.load.comments++;
    }
  }

  const reviewers = [...byReviewer.values()]
    .map((e) => ({ ...e.load, prsReviewed: e.prs.size }))
    // Ties broken by login so the order is stable across runs — an unstable
    // ordering makes a matrix appear to change when nothing has.
    .sort(
      (a, b) => b.prsReviewed - a.prsReviewed || a.reviewerLogin.localeCompare(b.reviewerLogin),
    );

  return { reviewers, prsWithReview: prsWithReview.size, excluded };
}
