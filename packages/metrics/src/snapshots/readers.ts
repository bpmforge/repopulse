import { and, eq, gte, lt, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { core, facts, type Database } from '@repopulse/shared';

// Identity merges resolve HERE, in the readers, so every metric computed from
// them inherits it (W5-05). DATABASE.md §2 specifies merges as non-destructive
// and reversible — the row stays, `merged_into_id` points at the survivor, and
// queries read through COALESCE(merged_into_id, id). Until this landed the
// column was referenced NOWHERE outside the schema: merging was a no-op that
// no screen or metric would ever have reflected.
//
// Attribution is by LOGIN downstream (churn, ownership, review load all group
// on the string), so resolving means reading the canonical identity's login in
// place of the merged one. One hop only — the API keeps chains flat by
// resolving a merge target to ITS canonical before writing, so A→B→C cannot
// exist and a recursive CTE is not needed.
const canonicalOf = (id: typeof core.identities) => sql`coalesce(${id.mergedIntoId}, ${id.id})`;
import { isNonHumanReviewer } from '../engine/review-bots.js';
import type { ChurnFileTouch } from '../metrics/churn.js';
import type { ReviewCoveragePr, ReviewCoverageReview } from '../metrics/review-coverage.js';
import type { CyclePr, CycleEvent, CycleEventKind } from '../metrics/cycle.js';
import type { PrSizeInput } from '../metrics/pr-size.js';
import type { StalePrInput } from '../metrics/stale-prs.js';
import type { CiRunInput } from '../metrics/ci.js';
import type { IssueThroughputInput } from '../metrics/issues.js';
import type { ReleaseInput } from '../metrics/releases.js';
import type { DeploymentInput, ReleaseFallbackInput } from '../metrics/dora.js';
import type { ReviewBotMetricsInput } from '../metrics/review-bots.js';

// Warehouse → metric-input readers (W3-10). The pure metric functions
// (W3-02..W3-09) were built against these shapes; here we read the actual
// fact tables and adapt. Every read is workspace+repo scoped.
//
// KNOWN LIMITATIONS (documented, not silent):
// - superseded = false always: nothing is tombstoned yet (W2-05 deferred it),
//   so this is correct today, not an approximation.
// - review hasContent = true always: the review body isn't warehoused, so an
//   empty "rubber-stamp" COMMENTED review can't be distinguished — a
//   conservative over-count of coverage (APPROVED/CHANGES_REQUESTED are exact).
// - commit parentShaCount is 2 for a merge / 1 otherwise (from commits.is_merge,
//   W3-10 migration) — the metric only tests >1, so the exact count is moot.

export interface RepoRef {
  repoId: number;
}

/**
 * Optional extra bounds on a windowed read (W20-20, UX_TODO DSH-56). The
 * nightly job reads "from windowStart until now"; a custom date range also
 * needs an END (exclusive), and the API caller passes its workspace so the
 * read is tenancy-filtered on its own rather than trusting the repo id alone.
 */
export interface ReadBounds {
  /** Exclusive end of the window; absent = open-ended (until now). */
  end?: Date | undefined;
  workspaceId?: number | undefined;
}

/** The survivor of a merge, or the identity itself when it was never merged. */
const canonicalIdentity = alias(core.identities, 'canonical_identity');

/** M1 churn / M2 hotspots / M3 ownership — one read feeds all three. */
/**
 * Commit-level flags for M14 (W9-06).
 *
 * A separate read from readChurnTouches because that one joins commit_files —
 * a commit touching twelve files appears twelve times there, and counting
 * reverts off it would weight a revert by how much it changed.
 */
export async function readCommitFlags(
  db: Database,
  repoId: number,
  windowStart: Date,
): Promise<{ sha: string; isMerge: boolean; isRevertHeuristic: boolean }[]> {
  const rows = await db
    .select({
      sha: facts.commits.sha,
      isMerge: facts.commits.isMerge,
      isRevertHeuristic: facts.commits.isRevertHeuristic,
    })
    .from(facts.commits)
    .where(and(eq(facts.commits.repoId, repoId), gte(facts.commits.authoredAt, windowStart)));
  return rows;
}

export async function readChurnTouches(
  db: Database,
  repoId: number,
  windowStart: Date,
  bounds: ReadBounds = {},
): Promise<ChurnFileTouch[]> {
  const rows = await db
    .select({
      sha: facts.commits.sha,
      isMerge: facts.commits.isMerge,
      authoredAt: facts.commits.authoredAt,
      authorLogin: canonicalIdentity.forgeLogin,
      path: facts.commitFiles.path,
      previousPath: facts.commitFiles.previousPath,
      additions: facts.commitFiles.additions,
      deletions: facts.commitFiles.deletions,
    })
    .from(facts.commitFiles)
    .innerJoin(facts.commits, eq(facts.commitFiles.commitId, facts.commits.id))
    .innerJoin(core.identities, eq(facts.commits.authorIdentityId, core.identities.id))
    .innerJoin(canonicalIdentity, eq(canonicalIdentity.id, canonicalOf(core.identities)))
    .where(
      and(
        eq(facts.commits.repoId, repoId),
        gte(facts.commits.authoredAt, windowStart),
        bounds.end ? lt(facts.commits.authoredAt, bounds.end) : undefined,
        bounds.workspaceId === undefined
          ? undefined
          : eq(facts.commits.workspaceId, bounds.workspaceId),
      ),
    );

  return rows.map((r) => ({
    sha: r.sha,
    authorLogin: r.authorLogin,
    parentShaCount: r.isMerge ? 2 : 1,
    superseded: false,
    path: r.path,
    ...(r.previousPath ? { previousPath: r.previousPath } : {}),
    additions: r.additions,
    deletions: r.deletions,
    touchedAt: r.authoredAt.toISOString(),
  }));
}

async function prRowsWithReviews(
  db: Database,
  repoId: number,
  windowStart: Date,
  botGlobs?: readonly string[],
  bounds: ReadBounds = {},
) {
  const prRows = await db
    .select({
      id: facts.pullRequests.id,
      number: facts.pullRequests.number,
      authorLogin: canonicalIdentity.forgeLogin,
      isBot: facts.pullRequests.isBot,
      createdAt: facts.pullRequests.createdAt,
      mergedAt: facts.pullRequests.mergedAt,
      additions: facts.pullRequests.additions,
      deletions: facts.pullRequests.deletions,
      lastActivityAt: facts.pullRequests.lastActivityAt,
      isDraft: facts.pullRequests.isDraft,
      state: facts.pullRequests.state,
    })
    .from(facts.pullRequests)
    .innerJoin(core.identities, eq(facts.pullRequests.authorIdentityId, core.identities.id))
    .innerJoin(canonicalIdentity, eq(canonicalIdentity.id, canonicalOf(core.identities)))
    .where(
      and(
        eq(facts.pullRequests.repoId, repoId),
        gte(facts.pullRequests.createdAt, windowStart),
        bounds.end ? lt(facts.pullRequests.createdAt, bounds.end) : undefined,
        bounds.workspaceId === undefined
          ? undefined
          : eq(facts.pullRequests.workspaceId, bounds.workspaceId),
      ),
    );

  const reviewRows = await db
    .select({
      pullRequestId: facts.prReviews.pullRequestId,
      reviewerLogin: canonicalIdentity.forgeLogin,
      reviewerIsBot: sql<boolean>`(${core.identities.isBot} or ${canonicalIdentity.isBot})`,
      state: facts.prReviews.state,
      submittedAt: facts.prReviews.submittedAt,
    })
    .from(facts.prReviews)
    .innerJoin(core.identities, eq(facts.prReviews.reviewerIdentityId, core.identities.id))
    .innerJoin(canonicalIdentity, eq(canonicalIdentity.id, canonicalOf(core.identities)))
    .where(
      and(
        eq(facts.prReviews.repoId, repoId),
        bounds.workspaceId === undefined
          ? undefined
          : eq(facts.prReviews.workspaceId, bounds.workspaceId),
      ),
    );

  // METRICS.md §0: a bot's review is not review. Before W18-23 nothing here
  // looked at the REVIEWER, only at the PR author, so a CodeRabbit or Copilot
  // comment posted a minute after a PR opened counted as its first review
  // (M4 open→firstReview) and as human review coverage (M5). Every PR-family
  // metric reads through this function, so excluding them here covers all of
  // them; the bots' own activity is measured separately (§5, review-bots.ts).
  const byPr = new Map<number, typeof reviewRows>();
  for (const rv of reviewRows) {
    if (isNonHumanReviewer(rv.reviewerLogin, botGlobs, rv.reviewerIsBot)) continue;
    const bucket = byPr.get(rv.pullRequestId);
    if (bucket) bucket.push(rv);
    else byPr.set(rv.pullRequestId, [rv]);
  }
  return { prRows, byPr };
}

/** M5 review coverage / M6 merged-without-review. */
export async function readReviewCoveragePrs(
  db: Database,
  repoId: number,
  windowStart: Date,
  botGlobs?: readonly string[],
  bounds: ReadBounds = {},
): Promise<ReviewCoveragePr[]> {
  const { prRows, byPr } = await prRowsWithReviews(db, repoId, windowStart, botGlobs, bounds);
  return prRows.map((p) => {
    const reviews: ReviewCoverageReview[] = (byPr.get(p.id) ?? []).map((rv) => ({
      reviewerLogin: rv.reviewerLogin,
      state: rv.state as ReviewCoverageReview['state'],
      hasContent: true, // review body not warehoused — conservative (see header)
    }));
    return {
      number: p.number,
      authorLogin: p.authorLogin,
      isBot: p.isBot,
      mergedAt: p.mergedAt ? p.mergedAt.toISOString() : null,
      // merged_by identity isn't joined here; self-merge detection uses author
      // vs merger — approximated as null (no merger) so a merge counts as
      // author-merged only when a review exists. Documented.
      mergedByLogin: null,
      additions: p.additions,
      deletions: p.deletions,
      reviews,
    };
  });
}

const REVIEW_STATE_TO_EVENT: Record<string, CycleEventKind> = {
  APPROVED: 'approval',
  CHANGES_REQUESTED: 'changes_requested',
  COMMENTED: 'comment',
  DISMISSED: 'comment',
};

/** M4 cycle-time stages. Review events derived from pr_reviews. */
export async function readCyclePrs(
  db: Database,
  repoId: number,
  windowStart: Date,
  botGlobs?: readonly string[],
  bounds: ReadBounds = {},
): Promise<CyclePr[]> {
  const { prRows, byPr } = await prRowsWithReviews(db, repoId, windowStart, botGlobs, bounds);
  return prRows.map((p) => {
    const events: CycleEvent[] = (byPr.get(p.id) ?? [])
      .map((rv) => {
        const kind = REVIEW_STATE_TO_EVENT[rv.state];
        return kind
          ? { kind, actorLogin: rv.reviewerLogin, at: rv.submittedAt.toISOString() }
          : null;
      })
      .filter((e): e is CycleEvent => e !== null);
    return {
      authorLogin: p.authorLogin,
      isBot: p.isBot,
      createdAt: p.createdAt.toISOString(),
      mergedAt: p.mergedAt ? p.mergedAt.toISOString() : null,
      events,
    };
  });
}

/** M7 PR size distribution — merged PRs in window. */
export async function readPrSizeInputs(
  db: Database,
  repoId: number,
  windowStart: Date,
): Promise<PrSizeInput[]> {
  const { prRows } = await prRowsWithReviews(db, repoId, windowStart);
  return prRows
    .filter((p) => p.mergedAt !== null)
    .map((p) => ({ additions: p.additions, deletions: p.deletions }));
}

/** M8 stale PRs — open PRs (no window). */
export async function readStalePrs(db: Database, repoId: number): Promise<StalePrInput[]> {
  const rows = await db
    .select({
      number: facts.pullRequests.number,
      state: facts.pullRequests.state,
      isDraft: facts.pullRequests.isDraft,
      lastActivityAt: facts.pullRequests.lastActivityAt,
      updatedAt: facts.pullRequests.updatedAt,
    })
    .from(facts.pullRequests)
    .where(and(eq(facts.pullRequests.repoId, repoId), eq(facts.pullRequests.state, 'open')));
  return rows.map((p) => ({
    number: p.number,
    isOpen: p.state === 'open',
    isDraft: p.isDraft,
    lastActivityAt: (p.lastActivityAt ?? p.updatedAt).toISOString(),
  }));
}

/** M9 CI — check_runs in window. */
export async function readCiRuns(
  db: Database,
  repoId: number,
  windowStart: Date,
  bounds: ReadBounds = {},
): Promise<CiRunInput[]> {
  const rows = await db
    .select()
    .from(facts.checkRuns)
    .where(
      and(
        eq(facts.checkRuns.repoId, repoId),
        gte(facts.checkRuns.startedAt, windowStart),
        bounds.end ? lt(facts.checkRuns.startedAt, bounds.end) : undefined,
        bounds.workspaceId === undefined
          ? undefined
          : eq(facts.checkRuns.workspaceId, bounds.workspaceId),
      ),
    );
  return rows.map((r) => ({
    workflowName: r.workflowName,
    headSha: r.headSha,
    pullRequestId: r.pullRequestId,
    status: r.status as CiRunInput['status'],
    conclusion: r.conclusion as CiRunInput['conclusion'],
    runAttempt: r.runAttempt,
    startedAt: r.startedAt ? r.startedAt.toISOString() : null,
    completedAt: r.completedAt ? r.completedAt.toISOString() : null,
  }));
}

/** M10 issue throughput. */
export async function readIssues(
  db: Database,
  repoId: number,
  bounds: ReadBounds = {},
): Promise<IssueThroughputInput[]> {
  const rows = await db
    .select()
    .from(facts.issues)
    .where(
      and(
        eq(facts.issues.repoId, repoId),
        bounds.workspaceId === undefined
          ? undefined
          : eq(facts.issues.workspaceId, bounds.workspaceId),
      ),
    );
  return rows.map((i) => ({
    number: i.number,
    isPullRequest: i.isPullRequest,
    createdAt: i.createdAt.toISOString(),
    isOpenAtSnapshot: i.state === 'open',
    // Reopen history isn't warehoused (only reopenedCount) — approximate a
    // single close event (createdAt→closedAt open period). Documented.
    closeEvents: i.closedAt
      ? [{ closedAt: i.closedAt.toISOString(), openPeriodStartedAt: i.createdAt.toISOString() }]
      : [],
  }));
}

/** M11 release cadence. */
export async function readReleaseInputs(db: Database, repoId: number): Promise<ReleaseInput[]> {
  const rows = await db.select().from(facts.releases).where(eq(facts.releases.repoId, repoId));
  return rows.map((r) => ({
    isDraft: r.isDraft,
    isPrerelease: r.isPrerelease,
    publishedAt: r.publishedAt ? r.publishedAt.toISOString() : null,
  }));
}

/** M12 DORA — deployments + release fallback. */
export async function readDoraInputs(
  db: Database,
  repoId: number,
): Promise<{ deployments: DeploymentInput[]; releases: ReleaseFallbackInput[] }> {
  const deployRows = await db
    .select()
    .from(facts.deployments)
    .where(eq(facts.deployments.repoId, repoId));
  const releaseRows = await db
    .select()
    .from(facts.releases)
    .where(eq(facts.releases.repoId, repoId));
  return {
    deployments: deployRows.map((d) => ({
      environment: d.environment,
      createdAt: d.createdAt.toISOString(),
      latestStatus: d.latestStatus,
    })),
    releases: releaseRows
      .filter((r) => r.publishedAt !== null)
      .map((r) => ({
        publishedAt: (r.publishedAt as Date).toISOString(),
        isDraft: r.isDraft,
        isPrerelease: r.isPrerelease,
      })),
  };
}

/**
 * METRICS.md §5 AI-reviewer inputs (W18-23): every PR opened in the
 * window with its reviews and inline-comment anchors, plus whether the forge
 * refused the comment fetch. Workspace AND repo scoped (Law 5) because the API
 * calls this directly, not only the snapshot job.
 *
 * Logins are read through the canonical identity like every other reader, so
 * an admin merging `Copilot` into `copilot-pull-request-reviewer` changes
 * nothing about attribution — both are the same registry entry anyway.
 */
export async function readReviewBotInputs(
  db: Database,
  scope: { workspaceId: number; repoId: number },
  windowStart: Date,
): Promise<Omit<ReviewBotMetricsInput, 'botGlobs'>> {
  const inScope = and(
    eq(facts.pullRequests.workspaceId, scope.workspaceId),
    eq(facts.pullRequests.repoId, scope.repoId),
    gte(facts.pullRequests.createdAt, windowStart),
  );

  const prRows = await db
    .select({
      id: facts.pullRequests.id,
      isBot: facts.pullRequests.isBot,
      state: facts.pullRequests.state,
      createdAt: facts.pullRequests.createdAt,
      mergedAt: facts.pullRequests.mergedAt,
      closedAt: facts.pullRequests.closedAt,
      commentsObservedAt: facts.pullRequests.reviewCommentsObservedAt,
    })
    .from(facts.pullRequests)
    .where(inScope);

  const reviewRows = await db
    .select({
      pullRequestId: facts.prReviews.pullRequestId,
      reviewerLogin: canonicalIdentity.forgeLogin,
      forgeReviewId: facts.prReviews.forgeReviewId,
      state: facts.prReviews.state,
      submittedAt: facts.prReviews.submittedAt,
    })
    .from(facts.prReviews)
    .innerJoin(facts.pullRequests, eq(facts.prReviews.pullRequestId, facts.pullRequests.id))
    .innerJoin(core.identities, eq(facts.prReviews.reviewerIdentityId, core.identities.id))
    .innerJoin(canonicalIdentity, eq(canonicalIdentity.id, canonicalOf(core.identities)))
    .where(inScope);

  const commentRows = await db
    .select({
      pullRequestId: facts.prReviewComments.pullRequestId,
      authorLogin: canonicalIdentity.forgeLogin,
      forgeReviewId: facts.prReviewComments.forgeReviewId,
      createdAt: facts.prReviewComments.createdAt,
      path: facts.prReviewComments.path,
      subjectType: facts.prReviewComments.subjectType,
      isReply: facts.prReviewComments.isReply,
      originalLine: facts.prReviewComments.originalLine,
      currentLine: facts.prReviewComments.currentLine,
    })
    .from(facts.prReviewComments)
    .innerJoin(facts.pullRequests, eq(facts.prReviewComments.pullRequestId, facts.pullRequests.id))
    .innerJoin(core.identities, eq(facts.prReviewComments.authorIdentityId, core.identities.id))
    .innerJoin(canonicalIdentity, eq(canonicalIdentity.id, canonicalOf(core.identities)))
    .where(inScope);

  const [refusal] = await db
    .select({ lastError: core.syncCursors.lastError })
    .from(core.syncCursors)
    .where(
      and(
        eq(core.syncCursors.workspaceId, scope.workspaceId),
        eq(core.syncCursors.repoId, scope.repoId),
        eq(core.syncCursors.entityType, 'review_comments'),
      ),
    )
    .limit(1);

  return {
    prs: prRows.map((p) => {
      // A merged PR's merged_at is its close; closed_at is set too on GitHub,
      // but merged_at is the one every other PR metric keys on.
      const closed = p.state === 'open' ? null : (p.mergedAt ?? p.closedAt);
      return {
        pullRequestId: p.id,
        isBot: p.isBot,
        state: p.state as 'open' | 'closed' | 'merged',
        createdAt: p.createdAt.toISOString(),
        closedAt: closed ? closed.toISOString() : null,
        commentsObservedAt: p.commentsObservedAt ? p.commentsObservedAt.toISOString() : null,
      };
    }),
    reviews: reviewRows.map((r) => ({
      pullRequestId: r.pullRequestId,
      reviewerLogin: r.reviewerLogin,
      forgeReviewId: r.forgeReviewId,
      state: r.state,
      submittedAt: r.submittedAt.toISOString(),
    })),
    comments: commentRows.map((c) => ({
      pullRequestId: c.pullRequestId,
      authorLogin: c.authorLogin,
      forgeReviewId: c.forgeReviewId,
      createdAt: c.createdAt.toISOString(),
      path: c.path,
      subjectType: c.subjectType === 'file' ? 'file' : 'line',
      isReply: c.isReply,
      originalLine: c.originalLine,
      currentLine: c.currentLine,
    })),
    lineDataRefused: (refusal?.lastError ?? null) !== null,
  };
}
