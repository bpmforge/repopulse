import { median, nearestRankPercentile } from '../engine/percentiles.js';
import { ratio, type RatioResult } from '../engine/ratio.js';
import {
  KNOWN_REVIEW_BOTS,
  isNonHumanReviewer,
  reviewBotForLogin,
  type KnownReviewBot,
} from '../engine/review-bots.js';

// AI reviewer activity (W18-23, METRICS.md §5 — that section is the law; this
// file implements it and must not drift from it).
//
// This compares TOOLS, never people (N-9): every number is per review bot, the
// bots come back in a fixed registry order rather than sorted by any value, and
// nothing here carries a grade or a "good/bad" verdict. A high follow-up share
// may mean useful feedback or a noisy bot whose nits got fixed to make it stop;
// the screen reports the signal and leaves the reading to the team.

export interface ReviewBotPrInput {
  pullRequestId: number;
  /** Bot-authored PRs are left out, as in every PR metric (METRICS.md §0). */
  isBot: boolean;
  state: 'open' | 'closed' | 'merged';
  createdAt: string;
  /** merged_at for a merged PR, closed_at for a closed one, null while open. */
  closedAt: string | null;
  /**
   * When this PR's inline comments were fetched; null = never. Comment metrics
   * read only PRs where it is set, so "no line data" never reads as "zero
   * comments".
   */
  commentsObservedAt: string | null;
}

export interface ReviewBotReviewInput {
  pullRequestId: number;
  reviewerLogin: string;
  forgeReviewId: string;
  state: string;
  submittedAt: string;
}

export interface ReviewBotCommentInput {
  pullRequestId: number;
  authorLogin: string;
  forgeReviewId: string | null;
  createdAt: string;
  path: string;
  subjectType: 'line' | 'file';
  isReply: boolean;
  originalLine: number | null;
  /** null = the forge no longer anchors the comment on the head diff. */
  currentLine: number | null;
}

/**
 * Whether the repo has per-line comment anchors to measure.
 * - available: at least one PR in the window had its comments fetched.
 * - refused: the forge refused the fetch (e.g. the token lacks the scope).
 * - not_collected: neither — the forge's adapter has no such fetch (Gitea,
 *   GitLab today) or the PRs were enriched before W18-23.
 */
export type LineDataStatus = 'available' | 'refused' | 'not_collected';

export interface TimeToFirstStats {
  medianHours: number | null;
  p90Hours: number | null;
  /** PRs the times were measured on. */
  n: number;
}

export interface FollowUpShare extends RatioResult {
  /** Line comments whose PR was open when fetched: their outcome is not known yet. */
  pending: number;
}

export interface RepeatAfterDismiss extends RatioResult {
  /** Dismissed reviews with no inline comment, so no file to repeat on. */
  dismissedWithoutInline: number;
}

export interface ReviewBotStats {
  key: string;
  name: string;
  /** The logins this bot was actually seen under, for the screen's footnote. */
  loginsSeen: string[];
  prsReviewed: number;
  /** prsReviewed / PRs opened in the window. */
  reach: RatioResult;
  reviews: number;
  reviewsPerPr: RatioResult;
  /** Of prsReviewed, the PRs with line-level data: the denominator below. */
  prsWithLineData: number;
  /** New inline comments (thread starters, not replies); null without line data. */
  inlineComments: number | null;
  commentsPerPr: RatioResult | null;
  timeToFirst: TimeToFirstStats;
  followedByChange: FollowUpShare | null;
  repeatAfterDismiss: RepeatAfterDismiss | null;
}

export interface ReviewBotMetricsResult {
  /** Non-bot PRs opened in the window — the shared denominator for reach. */
  prsInWindow: number;
  /** Of prsInWindow, how many had their inline comments fetched. */
  prsWithLineData: number;
  lineData: LineDataStatus;
  /** Only bots with activity in the window, in registry order (never ranked). */
  bots: ReviewBotStats[];
  /**
   * Review events by other non-human reviewers (github-actions, an unlisted
   * tool). Counted so the screen can say what it did not attribute.
   */
  otherBotReviews: number;
}

export interface ReviewBotMetricsInput {
  prs: readonly ReviewBotPrInput[];
  reviews: readonly ReviewBotReviewInput[];
  comments: readonly ReviewBotCommentInput[];
  /** The forge refused the comment fetch for this repo (sync_cursors). */
  lineDataRefused?: boolean;
  botGlobs?: readonly string[];
}

const HOUR_MS = 60 * 60 * 1000;

function ms(iso: string): number {
  return new Date(iso).getTime();
}

/**
 * §5 "followed by a code change on the commented lines": a new line comment
 * whose anchor the forge dropped from the PR's final head diff.
 */
function followUp(
  comments: readonly ReviewBotCommentInput[],
  prs: ReadonlyMap<number, ReviewBotPrInput>,
): FollowUpShare {
  let changed = 0;
  let final = 0;
  let pending = 0;
  for (const c of comments) {
    if (c.isReply || c.subjectType !== 'line' || c.originalLine === null) continue;
    const pr = prs.get(c.pullRequestId);
    if (!pr || pr.commentsObservedAt === null) continue;
    // Final only when fetched after the PR closed: before that, a later push
    // could still move the anchor, and reading an open PR would report "not
    // yet" as "no".
    if (pr.closedAt === null || ms(pr.commentsObservedAt) < ms(pr.closedAt)) {
      pending++;
      continue;
    }
    final++;
    if (c.currentLine === null) changed++;
  }
  return { ...ratio(changed, final), pending };
}

/** §5 repeat-after-dismiss: the bot came back to a file after its review was dismissed. */
function repeats(
  reviews: readonly ReviewBotReviewInput[],
  comments: readonly ReviewBotCommentInput[],
): RepeatAfterDismiss {
  let dismissedWithInline = 0;
  let repeated = 0;
  let dismissedWithoutInline = 0;
  // Comments grouped by PR once, so each dismissed review looks only at its own
  // PR's comments: O(comments + reviews) instead of O(dismissed × comments),
  // which ran on every request (measured 110 ms → 2.4 ms at 50k comments).
  const byPr = new Map<number, ReviewBotCommentInput[]>();
  for (const c of comments) {
    const bucket = byPr.get(c.pullRequestId);
    if (bucket) bucket.push(c);
    else byPr.set(c.pullRequestId, [c]);
  }
  for (const r of reviews) {
    if (r.state.toUpperCase() !== 'DISMISSED') continue;
    const prComments = byPr.get(r.pullRequestId) ?? [];
    const files = new Set(
      prComments.filter((c) => c.forgeReviewId === r.forgeReviewId).map((c) => c.path),
    );
    if (files.size === 0) {
      dismissedWithoutInline++;
      continue;
    }
    dismissedWithInline++;
    const submitted = ms(r.submittedAt);
    const cameBack = prComments.some(
      (c) =>
        c.forgeReviewId !== r.forgeReviewId && files.has(c.path) && ms(c.createdAt) > submitted,
    );
    if (cameBack) repeated++;
  }
  return { ...ratio(repeated, dismissedWithInline), dismissedWithoutInline };
}

/**
 * METRICS.md §5, per known review bot, over non-bot PRs opened in the window.
 *
 * Reviews and comments are attributed by login through the registry; anything
 * else non-human is counted in otherBotReviews and nothing more. Human reviews
 * are ignored entirely — this function never reports on a person.
 */
export function computeReviewBotMetrics(input: ReviewBotMetricsInput): ReviewBotMetricsResult {
  const prs = new Map<number, ReviewBotPrInput>();
  for (const p of input.prs) if (!p.isBot) prs.set(p.pullRequestId, p);
  const observed = (prId: number) => (prs.get(prId)?.commentsObservedAt ?? null) !== null;
  const prsWithLineData = [...prs.values()].filter((p) => p.commentsObservedAt !== null).length;
  const lineData: LineDataStatus =
    prsWithLineData > 0 ? 'available' : input.lineDataRefused ? 'refused' : 'not_collected';
  const lineAvailable = lineData === 'available';

  const reviewsByBot = new Map<KnownReviewBot, ReviewBotReviewInput[]>();
  const commentsByBot = new Map<KnownReviewBot, ReviewBotCommentInput[]>();
  const loginsByBot = new Map<KnownReviewBot, Set<string>>();
  let otherBotReviews = 0;

  const note = (bot: KnownReviewBot, login: string) => {
    const seen = loginsByBot.get(bot) ?? new Set<string>();
    seen.add(login);
    loginsByBot.set(bot, seen);
  };

  for (const r of input.reviews) {
    if (!prs.has(r.pullRequestId)) continue;
    const bot = reviewBotForLogin(r.reviewerLogin);
    if (!bot) {
      if (isNonHumanReviewer(r.reviewerLogin, input.botGlobs)) otherBotReviews++;
      continue;
    }
    note(bot, r.reviewerLogin);
    const list = reviewsByBot.get(bot) ?? [];
    list.push(r);
    reviewsByBot.set(bot, list);
  }
  for (const c of input.comments) {
    if (!observed(c.pullRequestId)) continue;
    const bot = reviewBotForLogin(c.authorLogin);
    if (!bot) continue;
    note(bot, c.authorLogin);
    const list = commentsByBot.get(bot) ?? [];
    list.push(c);
    commentsByBot.set(bot, list);
  }

  const bots: ReviewBotStats[] = [];
  for (const bot of KNOWN_REVIEW_BOTS) {
    const reviews = reviewsByBot.get(bot) ?? [];
    const comments = commentsByBot.get(bot) ?? [];
    if (reviews.length === 0 && comments.length === 0) continue;

    // First bot activity per PR: its earliest review OR inline comment. A bot
    // whose summary review lands minutes after its inline comments would
    // otherwise read slower than it was.
    const firstAt = new Map<number, number>();
    const touch = (prId: number, at: number) => {
      const prev = firstAt.get(prId);
      if (prev === undefined || at < prev) firstAt.set(prId, at);
    };
    for (const r of reviews) touch(r.pullRequestId, ms(r.submittedAt));
    for (const c of comments) touch(c.pullRequestId, ms(c.createdAt));

    const hours: number[] = [];
    for (const [prId, at] of firstAt) {
      const pr = prs.get(prId);
      if (!pr) continue;
      const h = (at - ms(pr.createdAt)) / HOUR_MS;
      // A negative gap is clock skew or an import artefact, not a review that
      // arrived before its PR; dropping it beats letting it pull the median.
      if (h >= 0) hours.push(h);
    }

    const prsReviewed = firstAt.size;
    const botPrsWithLineData = [...firstAt.keys()].filter(observed).length;
    const topLevel = comments.filter((c) => !c.isReply).length;
    bots.push({
      key: bot.key,
      name: bot.name,
      loginsSeen: [...(loginsByBot.get(bot) ?? [])].sort(),
      prsReviewed,
      reach: ratio(prsReviewed, prs.size),
      reviews: reviews.length,
      reviewsPerPr: ratio(reviews.length, prsReviewed),
      prsWithLineData: botPrsWithLineData,
      inlineComments: lineAvailable ? topLevel : null,
      commentsPerPr: lineAvailable ? ratio(topLevel, botPrsWithLineData) : null,
      timeToFirst: {
        medianHours: median(hours),
        p90Hours: nearestRankPercentile(hours, 90),
        n: hours.length,
      },
      followedByChange: lineAvailable ? followUp(comments, prs) : null,
      repeatAfterDismiss: lineAvailable
        ? repeats(
            reviews.filter((r) => observed(r.pullRequestId)),
            comments,
          )
        : null,
    });
  }

  return { prsInWindow: prs.size, prsWithLineData, lineData, bots, otherBotReviews };
}
