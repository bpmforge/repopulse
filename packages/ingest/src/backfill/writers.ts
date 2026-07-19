import { and, eq } from 'drizzle-orm';
import { facts } from '@repopulse/shared';
import type {
  ForgeCheckRun,
  ForgeCommit,
  ForgeDeployment,
  ForgeDiffFile,
  ForgeIssue,
  ForgePR,
  ForgeRelease,
  ForgeReview,
} from '@repopulse/forge';
import type { DbOrTx } from './db.js';
import { IdentityResolver } from './identity.js';

// Idempotent upserts (FR-INGEST-2). Every writer conflicts on the entity's
// documented natural key (DATABASE.md §2) and DOES NOT create duplicates on
// re-run — the crash-resume guarantee (FR-INGEST-3). All run inside the
// per-page checkpoint transaction (backfill.ts).

export interface RepoScope {
  workspaceId: number;
  repoId: number;
}

const REVERT_RE = /\brevert\b/i;
function messageHead(message: string): string {
  return message.split('\n', 1)[0] ?? '';
}

export async function upsertCommits(
  db: DbOrTx,
  scope: RepoScope,
  resolver: IdentityResolver,
  commits: readonly ForgeCommit[],
): Promise<number> {
  for (const c of commits) {
    const authorId = await resolver.resolve({ login: c.authorLogin, email: c.authorEmail });
    const stats = c.stats;
    await db
      .insert(facts.commits)
      .values({
        workspaceId: scope.workspaceId,
        repoId: scope.repoId,
        sha: c.sha,
        authorIdentityId: authorId,
        // The domain ForgeCommit carries no separate committer identity — the
        // author is the best available attribution (a richer commit fetch would
        // distinguish them). Documented, not silently wrong.
        committerIdentityId: authorId,
        authoredAt: new Date(c.authoredAt),
        committedAt: new Date(c.committedAt),
        messageHead: messageHead(c.message),
        isRevertHeuristic: REVERT_RE.test(c.message),
        additions: stats?.additions ?? null,
        deletions: stats?.deletions ?? null,
        filesCount: null,
        statsSource: stats ? 'graphql' : null,
      })
      .onConflictDoUpdate({
        target: [facts.commits.repoId, facts.commits.sha],
        set: { messageHead: messageHead(c.message), authoredAt: new Date(c.authoredAt) },
      });
  }
  return commits.length;
}

export async function upsertPullRequests(
  db: DbOrTx,
  scope: RepoScope,
  resolver: IdentityResolver,
  prs: readonly ForgePR[],
): Promise<number> {
  for (const p of prs) {
    const authorId = await resolver.resolve({ login: p.authorLogin, isBot: p.isBot });
    const mergedById = p.mergedByLogin ? await resolver.resolve({ login: p.mergedByLogin }) : null;
    await db
      .insert(facts.pullRequests)
      .values({
        workspaceId: scope.workspaceId,
        repoId: scope.repoId,
        number: p.number,
        forgePrId: p.externalId,
        title: p.title,
        authorIdentityId: authorId,
        state: p.state,
        isDraft: p.isDraft,
        isBot: p.isBot,
        createdAt: new Date(p.createdAt),
        updatedAt: new Date(p.updatedAt),
        closedAt: p.closedAt ? new Date(p.closedAt) : null,
        mergedAt: p.mergedAt ? new Date(p.mergedAt) : null,
        mergedByIdentityId: mergedById,
        baseRef: p.baseRef,
        headSha: p.headSha,
        additions: p.additions ?? 0,
        deletions: p.deletions ?? 0,
        changedFiles: p.changedFiles ?? 0,
      })
      .onConflictDoUpdate({
        target: [facts.pullRequests.repoId, facts.pullRequests.number],
        set: {
          state: p.state,
          updatedAt: new Date(p.updatedAt),
          closedAt: p.closedAt ? new Date(p.closedAt) : null,
          mergedAt: p.mergedAt ? new Date(p.mergedAt) : null,
          mergedByIdentityId: mergedById,
        },
      });
  }
  return prs.length;
}

/** Reviews are fetched per-PR; the PR must already be ingested (we look up its id). */
export async function upsertReviews(
  db: DbOrTx,
  scope: RepoScope,
  resolver: IdentityResolver,
  prNumber: number,
  reviews: readonly ForgeReview[],
): Promise<number> {
  const [pr] = await db
    .select({ id: facts.pullRequests.id })
    .from(facts.pullRequests)
    .where(
      and(eq(facts.pullRequests.repoId, scope.repoId), eq(facts.pullRequests.number, prNumber)),
    )
    .limit(1);
  if (!pr) return 0; // PR not ingested yet — reviews will be retried after PRs
  for (const r of reviews) {
    const reviewerId = await resolver.resolve({ login: r.reviewerLogin });
    await db
      .insert(facts.prReviews)
      .values({
        workspaceId: scope.workspaceId,
        repoId: scope.repoId,
        pullRequestId: pr.id,
        forgeReviewId: r.externalId,
        reviewerIdentityId: reviewerId,
        state: r.state,
        submittedAt: new Date(r.submittedAt),
      })
      .onConflictDoUpdate({
        target: [facts.prReviews.pullRequestId, facts.prReviews.forgeReviewId],
        set: { state: r.state, submittedAt: new Date(r.submittedAt) },
      });
  }
  return reviews.length;
}

export async function upsertCheckRuns(
  db: DbOrTx,
  scope: RepoScope,
  checks: readonly ForgeCheckRun[],
): Promise<number> {
  for (const c of checks) {
    const durationMs =
      c.startedAt && c.completedAt
        ? new Date(c.completedAt).getTime() - new Date(c.startedAt).getTime()
        : null;
    await db
      .insert(facts.checkRuns)
      .values({
        workspaceId: scope.workspaceId,
        repoId: scope.repoId,
        forgeRunId: c.externalId,
        kind: 'check_run',
        workflowName: c.workflowName ?? null,
        headSha: c.headSha,
        pullRequestId: null,
        status: c.status,
        conclusion: c.conclusion,
        runAttempt: 1,
        startedAt: c.startedAt ? new Date(c.startedAt) : null,
        completedAt: c.completedAt ? new Date(c.completedAt) : null,
        durationMs,
      })
      .onConflictDoUpdate({
        target: [
          facts.checkRuns.repoId,
          facts.checkRuns.kind,
          facts.checkRuns.forgeRunId,
          facts.checkRuns.runAttempt,
        ],
        set: { status: c.status, conclusion: c.conclusion, durationMs },
      });
  }
  return checks.length;
}

export async function upsertIssues(
  db: DbOrTx,
  scope: RepoScope,
  resolver: IdentityResolver,
  issues: readonly ForgeIssue[],
): Promise<number> {
  for (const i of issues) {
    const authorId = await resolver.resolve({ login: i.authorLogin });
    await db
      .insert(facts.issues)
      .values({
        workspaceId: scope.workspaceId,
        repoId: scope.repoId,
        number: i.number,
        authorIdentityId: authorId,
        state: i.state,
        createdAt: new Date(i.createdAt),
        closedAt: i.closedAt ? new Date(i.closedAt) : null,
        isPullRequest: i.isPullRequest,
      })
      .onConflictDoUpdate({
        target: [facts.issues.repoId, facts.issues.number],
        set: { state: i.state, closedAt: i.closedAt ? new Date(i.closedAt) : null },
      });
  }
  return issues.length;
}

export async function upsertReleases(
  db: DbOrTx,
  scope: RepoScope,
  releases: readonly ForgeRelease[],
): Promise<number> {
  for (const r of releases) {
    await db
      .insert(facts.releases)
      .values({
        workspaceId: scope.workspaceId,
        repoId: scope.repoId,
        forgeReleaseId: r.externalId,
        tag: r.tagName,
        name: r.name,
        isDraft: r.isDraft,
        isPrerelease: r.isPrerelease,
        publishedAt: r.publishedAt ? new Date(r.publishedAt) : null,
      })
      .onConflictDoUpdate({
        target: [facts.releases.repoId, facts.releases.forgeReleaseId],
        set: { tag: r.tagName, name: r.name, isDraft: r.isDraft },
      });
  }
  return releases.length;
}

export async function upsertDeployments(
  db: DbOrTx,
  scope: RepoScope,
  deployments: readonly ForgeDeployment[],
): Promise<number> {
  for (const d of deployments) {
    // The table requires a non-null status/time; the domain latestStatus may be
    // null before any status event → 'pending', stamped at createdAt.
    const latestStatus = d.latestStatus ?? 'pending';
    await db
      .insert(facts.deployments)
      .values({
        workspaceId: scope.workspaceId,
        repoId: scope.repoId,
        forgeDeploymentId: d.externalId,
        environment: d.environment,
        sha: d.sha,
        createdAt: new Date(d.createdAt),
        latestStatus,
        statusUpdatedAt: new Date(d.createdAt),
      })
      .onConflictDoUpdate({
        target: [facts.deployments.repoId, facts.deployments.forgeDeploymentId],
        set: { latestStatus },
      });
  }
  return deployments.length;
}

/** Enrichment: per-commit file churn (FR-METRICS-1/2/3). Needs the commit's DB id. */
export async function upsertCommitFiles(
  db: DbOrTx,
  scope: RepoScope,
  sha: string,
  files: readonly ForgeDiffFile[],
  stats: { additions: number; deletions: number },
): Promise<number> {
  const [commit] = await db
    .select({ id: facts.commits.id })
    .from(facts.commits)
    .where(and(eq(facts.commits.repoId, scope.repoId), eq(facts.commits.sha, sha)))
    .limit(1);
  if (!commit) return 0;

  for (const f of files) {
    await db
      .insert(facts.commitFiles)
      .values({
        workspaceId: scope.workspaceId,
        repoId: scope.repoId,
        commitId: commit.id,
        path: f.path,
        additions: f.additions,
        deletions: f.deletions,
        status: f.status,
        previousPath: f.previousPath ?? null,
      })
      .onConflictDoUpdate({
        target: [facts.commitFiles.commitId, facts.commitFiles.path],
        set: { additions: f.additions, deletions: f.deletions, status: f.status },
      });
  }
  // Roll the per-file totals up onto the commit (stats_source=detail).
  await db
    .update(facts.commits)
    .set({
      additions: stats.additions,
      deletions: stats.deletions,
      filesCount: files.length,
      statsSource: 'detail',
    })
    .where(and(eq(facts.commits.repoId, scope.repoId), eq(facts.commits.sha, sha)));
  return files.length;
}
