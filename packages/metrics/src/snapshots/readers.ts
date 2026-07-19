import { and, eq, gte } from 'drizzle-orm';
import { core, facts, type Database } from '@repopulse/shared';
import type { ChurnFileTouch } from '../metrics/churn.js';
import type { ReviewCoveragePr, ReviewCoverageReview } from '../metrics/review-coverage.js';
import type { CyclePr, CycleEvent, CycleEventKind } from '../metrics/cycle.js';
import type { PrSizeInput } from '../metrics/pr-size.js';
import type { StalePrInput } from '../metrics/stale-prs.js';
import type { CiRunInput } from '../metrics/ci.js';
import type { IssueThroughputInput } from '../metrics/issues.js';
import type { ReleaseInput } from '../metrics/releases.js';
import type { DeploymentInput, ReleaseFallbackInput } from '../metrics/dora.js';

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

/** M1 churn / M2 hotspots / M3 ownership — one read feeds all three. */
export async function readChurnTouches(
  db: Database,
  repoId: number,
  windowStart: Date,
): Promise<ChurnFileTouch[]> {
  const rows = await db
    .select({
      sha: facts.commits.sha,
      isMerge: facts.commits.isMerge,
      authoredAt: facts.commits.authoredAt,
      authorLogin: core.identities.forgeLogin,
      path: facts.commitFiles.path,
      previousPath: facts.commitFiles.previousPath,
      additions: facts.commitFiles.additions,
      deletions: facts.commitFiles.deletions,
    })
    .from(facts.commitFiles)
    .innerJoin(facts.commits, eq(facts.commitFiles.commitId, facts.commits.id))
    .innerJoin(core.identities, eq(facts.commits.authorIdentityId, core.identities.id))
    .where(and(eq(facts.commits.repoId, repoId), gte(facts.commits.authoredAt, windowStart)));

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

async function prRowsWithReviews(db: Database, repoId: number, windowStart: Date) {
  const prRows = await db
    .select({
      id: facts.pullRequests.id,
      number: facts.pullRequests.number,
      authorLogin: core.identities.forgeLogin,
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
    .where(
      and(eq(facts.pullRequests.repoId, repoId), gte(facts.pullRequests.createdAt, windowStart)),
    );

  const reviewRows = await db
    .select({
      pullRequestId: facts.prReviews.pullRequestId,
      reviewerLogin: core.identities.forgeLogin,
      state: facts.prReviews.state,
      submittedAt: facts.prReviews.submittedAt,
    })
    .from(facts.prReviews)
    .innerJoin(core.identities, eq(facts.prReviews.reviewerIdentityId, core.identities.id))
    .where(eq(facts.prReviews.repoId, repoId));

  const byPr = new Map<number, typeof reviewRows>();
  for (const rv of reviewRows) {
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
): Promise<ReviewCoveragePr[]> {
  const { prRows, byPr } = await prRowsWithReviews(db, repoId, windowStart);
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
): Promise<CyclePr[]> {
  const { prRows, byPr } = await prRowsWithReviews(db, repoId, windowStart);
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
): Promise<CiRunInput[]> {
  const rows = await db
    .select()
    .from(facts.checkRuns)
    .where(and(eq(facts.checkRuns.repoId, repoId), gte(facts.checkRuns.startedAt, windowStart)));
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
export async function readIssues(db: Database, repoId: number): Promise<IssueThroughputInput[]> {
  const rows = await db.select().from(facts.issues).where(eq(facts.issues.repoId, repoId));
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
