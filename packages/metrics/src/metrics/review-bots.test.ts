import { describe, expect, it } from 'vitest';
import {
  computeReviewBotMetrics,
  type ReviewBotCommentInput,
  type ReviewBotPrInput,
  type ReviewBotReviewInput,
} from './review-bots.js';
import {
  DEFAULT_BOT_LOGIN_GLOBS,
  KNOWN_REVIEW_BOTS,
  isNonHumanReviewer,
  reviewBotForLogin,
} from '../engine/index.js';

// METRICS.md §5 worked example E5, built to exercise every branch of the
// definitions: a PR with final anchors, a PR still open, a PR with no line data.

const T0 = '2026-07-01T00:00:00Z';
const at = (hours: number) => new Date(Date.parse(T0) + hours * 3_600_000).toISOString();

function pr(id: number, over: Partial<ReviewBotPrInput> = {}): ReviewBotPrInput {
  return {
    pullRequestId: id,
    isBot: false,
    state: 'merged',
    createdAt: T0,
    closedAt: at(48),
    commentsObservedAt: at(72),
    ...over,
  };
}

function review(
  over: Partial<ReviewBotReviewInput> & { pullRequestId: number },
): ReviewBotReviewInput {
  return {
    reviewerLogin: 'coderabbitai[bot]',
    forgeReviewId: 'r1',
    state: 'COMMENTED',
    submittedAt: at(1),
    ...over,
  };
}

function comment(
  over: Partial<ReviewBotCommentInput> & { pullRequestId: number },
): ReviewBotCommentInput {
  return {
    authorLogin: 'coderabbitai[bot]',
    forgeReviewId: 'r1',
    createdAt: at(1),
    path: 'src/a.ts',
    subjectType: 'line',
    isReply: false,
    originalLine: 10,
    currentLine: 10,
    ...over,
  };
}

describe('review bot registry (METRICS.md §5)', () => {
  it('attributes each listed login, case-insensitively, and nobody else', () => {
    expect(reviewBotForLogin('coderabbitai[bot]')?.key).toBe('coderabbit');
    expect(reviewBotForLogin('CodeRabbitAI')?.key).toBe('coderabbit');
    expect(reviewBotForLogin('Copilot')?.key).toBe('copilot');
    expect(reviewBotForLogin('copilot-pull-request-reviewer[bot]')?.key).toBe('copilot');
    expect(reviewBotForLogin('qodo-merge-pro[bot]')?.key).toBe('qodo');
    expect(reviewBotForLogin('greptile-apps[bot]')?.key).toBe('greptile');
    expect(reviewBotForLogin('cursor[bot]')?.key).toBe('bugbot');
    // A person whose handle merely contains a tool's name is a person.
    expect(reviewBotForLogin('copilot-fan')).toBeNull();
    expect(reviewBotForLogin('cursor')).toBeNull();
    expect(reviewBotForLogin('dependabot[bot]')).toBeNull();
  });

  it('every known review bot login is non-human, even with the default globs replaced', () => {
    const logins = KNOWN_REVIEW_BOTS.flatMap((b) => b.logins);
    for (const login of logins) {
      expect(isNonHumanReviewer(login), login).toBe(true);
      expect(isNonHumanReviewer(login, DEFAULT_BOT_LOGIN_GLOBS), login).toBe(true);
      // An admin who set their own bot list (even an empty one) keeps them out.
      expect(isNonHumanReviewer(login, []), login).toBe(true);
    }
  });

  it('a person is human unless their identity row says bot', () => {
    expect(isNonHumanReviewer('alice')).toBe(false);
    expect(isNonHumanReviewer('alice', undefined, true)).toBe(true);
    expect(isNonHumanReviewer('github-actions[bot]')).toBe(true);
  });
});

describe('computeReviewBotMetrics (METRICS.md §5)', () => {
  it('E5: per-bot counts, follow-up share, time to first, repeat-after-dismiss', () => {
    const prs = [
      pr(1), // final anchors
      pr(2, { state: 'open', closedAt: null, commentsObservedAt: at(5) }), // pending
      pr(3, { commentsObservedAt: null }), // no line data (enriched pre-W18-23)
      pr(4), // no bot activity at all
      pr(5, { isBot: true }), // bot-authored: out of every denominator
    ];
    const reviews: ReviewBotReviewInput[] = [
      review({ pullRequestId: 1, forgeReviewId: 'r1', state: 'DISMISSED', submittedAt: at(2) }),
      review({ pullRequestId: 1, forgeReviewId: 'r2', submittedAt: at(10) }),
      review({ pullRequestId: 2, forgeReviewId: 'r3', submittedAt: at(4) }),
      review({ pullRequestId: 3, forgeReviewId: 'r4', submittedAt: at(6) }),
      review({ pullRequestId: 5, forgeReviewId: 'r5', submittedAt: at(1) }),
      // A human: never attributed, never counted as "other bot".
      review({ pullRequestId: 1, forgeReviewId: 'h1', reviewerLogin: 'alice', state: 'APPROVED' }),
      review({ pullRequestId: 4, forgeReviewId: 'g1', reviewerLogin: 'github-actions[bot]' }),
    ];
    const comments: ReviewBotCommentInput[] = [
      // r1 (later dismissed): two line comments, one later rewritten, on a.ts
      comment({ pullRequestId: 1, forgeReviewId: 'r1', createdAt: at(2), currentLine: null }),
      comment({ pullRequestId: 1, forgeReviewId: 'r1', createdAt: at(2), originalLine: 30 }),
      // r2 returns to a.ts after the dismissal: a repeat
      comment({ pullRequestId: 1, forgeReviewId: 'r2', createdAt: at(10), currentLine: null }),
      // a file-level comment counts as a comment but has no lines to change
      comment({
        pullRequestId: 1,
        forgeReviewId: 'r2',
        createdAt: at(10),
        path: 'README.md',
        subjectType: 'file',
        originalLine: null,
        currentLine: null,
      }),
      // a reply inside a thread is not new feedback
      comment({ pullRequestId: 1, forgeReviewId: 'r2', createdAt: at(11), isReply: true }),
      // PR 2 is still open: pending, not "unchanged"
      comment({ pullRequestId: 2, forgeReviewId: 'r3', createdAt: at(3), currentLine: null }),
      // PR 3 has no observation stamp: ignored entirely
      comment({ pullRequestId: 3, forgeReviewId: 'r4', createdAt: at(6) }),
    ];

    const result = computeReviewBotMetrics({ prs, reviews, comments });
    expect(result.prsInWindow).toBe(4);
    expect(result.prsWithLineData).toBe(3);
    expect(result.lineData).toBe('available');
    expect(result.otherBotReviews).toBe(1);
    expect(result.bots).toHaveLength(1);

    const cr = result.bots[0]!;
    expect(cr.key).toBe('coderabbit');
    expect(cr.prsReviewed).toBe(3);
    expect(cr.reach).toMatchObject({ numerator: 3, denominator: 4, value: 0.75 });
    expect(cr.reviews).toBe(4);
    expect(cr.reviewsPerPr.value).toBeCloseTo(4 / 3);
    // Comments only over PRs with line data (1 and 2): 4 + 1 thread starters.
    expect(cr.prsWithLineData).toBe(2);
    expect(cr.inlineComments).toBe(5);
    expect(cr.commentsPerPr).toMatchObject({ numerator: 5, denominator: 2, value: 2.5 });
    // First activity: PR1 at 2h, PR2 at 3h (comment before its review), PR3 at 6h.
    expect(cr.timeToFirst).toEqual({ medianHours: 3, p90Hours: 6, n: 3 });
    // PR1's three line comments are final; two lost their anchor. PR2's is pending.
    expect(cr.followedByChange).toEqual({ numerator: 2, denominator: 3, value: 2 / 3, pending: 1 });
    expect(cr.repeatAfterDismiss).toEqual({
      numerator: 1,
      denominator: 1,
      value: 1,
      dismissedWithoutInline: 0,
    });
  });

  it('a dismissed review the bot never returns from is not a repeat', () => {
    const result = computeReviewBotMetrics({
      prs: [pr(1)],
      reviews: [
        review({ pullRequestId: 1, forgeReviewId: 'r1', state: 'DISMISSED' }),
        review({ pullRequestId: 1, forgeReviewId: 'r2', state: 'DISMISSED' }),
      ],
      comments: [
        comment({ pullRequestId: 1, forgeReviewId: 'r1', path: 'a.ts' }),
        // Later, but on a DIFFERENT file — not the same feedback coming back.
        comment({ pullRequestId: 1, forgeReviewId: 'r3', path: 'b.ts', createdAt: at(9) }),
      ],
    });
    expect(result.bots[0]!.repeatAfterDismiss).toEqual({
      numerator: 0,
      denominator: 1,
      value: 0,
      dismissedWithoutInline: 1,
    });
  });

  it('without line data the comment metrics are null, never zero', () => {
    const result = computeReviewBotMetrics({
      prs: [pr(1, { commentsObservedAt: null })],
      reviews: [review({ pullRequestId: 1, reviewerLogin: 'cursor[bot]' })],
      comments: [],
    });
    expect(result.lineData).toBe('not_collected');
    const bugbot = result.bots[0]!;
    expect(bugbot.key).toBe('bugbot');
    expect(bugbot.prsReviewed).toBe(1);
    expect(bugbot.inlineComments).toBeNull();
    expect(bugbot.commentsPerPr).toBeNull();
    expect(bugbot.followedByChange).toBeNull();
    expect(bugbot.repeatAfterDismiss).toBeNull();
    // Review-level numbers need no line data.
    expect(bugbot.timeToFirst.n).toBe(1);
  });

  it('a refused comment fetch is reported as refused', () => {
    const result = computeReviewBotMetrics({
      prs: [pr(1, { commentsObservedAt: null })],
      reviews: [],
      comments: [],
      lineDataRefused: true,
    });
    expect(result.lineData).toBe('refused');
    expect(result.bots).toEqual([]);
  });

  it('returns bots in registry order, not ranked by any number (N-9)', () => {
    const result = computeReviewBotMetrics({
      prs: [pr(1), pr(2), pr(3)],
      reviews: [
        review({ pullRequestId: 1, reviewerLogin: 'cursor[bot]' }),
        review({ pullRequestId: 2, reviewerLogin: 'cursor[bot]' }),
        review({ pullRequestId: 3, reviewerLogin: 'cursor[bot]' }),
        review({ pullRequestId: 1, reviewerLogin: 'Copilot' }),
        review({ pullRequestId: 1, reviewerLogin: 'greptile-apps[bot]' }),
      ],
      comments: [],
    });
    expect(result.bots.map((b) => b.key)).toEqual(['copilot', 'greptile', 'bugbot']);
  });

  it('empty window: no bots, null-safe', () => {
    const result = computeReviewBotMetrics({ prs: [], reviews: [], comments: [] });
    expect(result).toEqual({
      prsInWindow: 0,
      prsWithLineData: 0,
      lineData: 'not_collected',
      bots: [],
      otherBotReviews: 0,
    });
  });
});
