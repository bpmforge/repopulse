import { and, eq, gte, inArray, lte, ne, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { core, facts, read, security, type Database } from '@repopulse/shared';
import { readChurnTouches, readReviewCoveragePrs } from '../snapshots/readers.js';
import { DEFAULT_BOT_LOGIN_GLOBS } from '../engine/bots.js';
import {
  computeRepoGovernance,
  mergeGovernanceTotals,
  summarizeGovernance,
  type GovCommit,
  type GovFinding,
  type GovPr,
  type GovernanceSummary,
} from './governance.js';
import {
  patternsFingerprint,
  resolveAiAuthorshipPatterns,
  type AiAuthorshipPatterns,
} from './patterns.js';

// Warehouse reads for the AI-code governance report (W18-20). Every query is
// workspace AND repo scoped (Law 5) and bounded on BOTH sides of the window:
// the report assembler passes a pinned windowEnd, and a read that only had a
// lower bound would let a regeneration next week count next week's commits.
//
// M13 and M5 come from their OWN readers (readChurnTouches,
// readReviewCoveragePrs), so the slice and the whole-repo number are computed
// from the same rows.

const canonicalIdentity = alias(core.identities, 'gov_canonical_identity');
const canonicalOf = sql`coalesce(${core.identities.mergedIntoId}, ${core.identities.id})`;

async function readGovCommits(
  db: Database,
  workspaceId: number,
  repoId: number,
  windowStart: Date,
  windowEnd: Date,
): Promise<GovCommit[]> {
  return db
    .select({
      sha: facts.commits.sha,
      authorLogin: canonicalIdentity.forgeLogin,
      trailers: facts.commits.trailers,
      messageHead: facts.commits.messageHead,
      isMerge: facts.commits.isMerge,
      isRevertHeuristic: facts.commits.isRevertHeuristic,
    })
    .from(facts.commits)
    .innerJoin(core.identities, eq(facts.commits.authorIdentityId, core.identities.id))
    .innerJoin(canonicalIdentity, eq(canonicalIdentity.id, canonicalOf))
    .where(
      and(
        eq(facts.commits.workspaceId, workspaceId),
        eq(facts.commits.repoId, repoId),
        gte(facts.commits.authoredAt, windowStart),
        lte(facts.commits.authoredAt, windowEnd),
      ),
    );
}

/**
 * PRs opened OR merged in the window. The merged-in-window ones that were
 * opened earlier are needed for linking (their squash commit is in the window)
 * and for review depth, but are not counted in the PR share.
 */
async function readGovPrs(
  db: Database,
  workspaceId: number,
  repoId: number,
  windowStart: Date,
  windowEnd: Date,
): Promise<GovPr[]> {
  const rows = await db
    .select({
      id: facts.pullRequests.id,
      number: facts.pullRequests.number,
      authorLogin: canonicalIdentity.forgeLogin,
      isBot: facts.pullRequests.isBot,
      headRef: facts.pullRequests.headRef,
      headSha: facts.pullRequests.headSha,
      createdAt: facts.pullRequests.createdAt,
    })
    .from(facts.pullRequests)
    .innerJoin(core.identities, eq(facts.pullRequests.authorIdentityId, core.identities.id))
    .innerJoin(canonicalIdentity, eq(canonicalIdentity.id, canonicalOf))
    .where(
      and(
        eq(facts.pullRequests.workspaceId, workspaceId),
        eq(facts.pullRequests.repoId, repoId),
        lte(facts.pullRequests.createdAt, windowEnd),
        or(
          gte(facts.pullRequests.createdAt, windowStart),
          gte(facts.pullRequests.mergedAt, windowStart),
        ),
      ),
    );
  return rows.map((r) => ({
    id: r.id,
    number: r.number,
    authorLogin: r.authorLogin,
    isBot: r.isBot,
    headRef: r.headRef,
    headSha: r.headSha,
    openedInWindow: r.createdAt >= windowStart,
  }));
}

async function readGovFindings(
  db: Database,
  workspaceId: number,
  repoId: number,
  windowStart: Date,
  windowEnd: Date,
): Promise<GovFinding[]> {
  const rows = await db
    .select({
      pullRequestId: read.findings.pullRequestId,
      file: read.findings.file,
      firstSeenAt: read.findings.firstSeenAt,
    })
    .from(read.findings)
    .where(
      and(
        eq(read.findings.workspaceId, workspaceId),
        eq(read.findings.repoId, repoId),
        gte(read.findings.firstSeenAt, windowStart),
        lte(read.findings.firstSeenAt, windowEnd),
        // Shadow-rule findings are excluded from every score and report
        // (W9-07); a dismissed finding was judged not to be one.
        eq(read.findings.experimental, false),
        ne(read.findings.status, 'dismissed'),
      ),
    );
  return rows.map((r) => ({ ...r, firstSeenAt: r.firstSeenAt.toISOString() }));
}

/** Did anything look for findings in this window? Without it, zero findings is silence, not a result. */
async function findingsMeasured(
  db: Database,
  workspaceId: number,
  repoId: number,
  windowStart: Date,
  windowEnd: Date,
): Promise<boolean> {
  const [scan] = await db
    .select({ id: security.scanRuns.id })
    .from(security.scanRuns)
    .where(
      and(
        eq(security.scanRuns.workspaceId, workspaceId),
        eq(security.scanRuns.repoId, repoId),
        eq(security.scanRuns.status, 'succeeded'),
        gte(security.scanRuns.startedAt, windowStart),
        lte(security.scanRuns.startedAt, windowEnd),
      ),
    )
    .limit(1);
  if (scan) return true;
  const [run] = await db
    .select({ id: read.analysisRuns.id })
    .from(read.analysisRuns)
    .where(
      and(
        eq(read.analysisRuns.workspaceId, workspaceId),
        eq(read.analysisRuns.repoId, repoId),
        eq(read.analysisRuns.status, 'succeeded'),
        gte(read.analysisRuns.startedAt, windowStart),
        lte(read.analysisRuns.startedAt, windowEnd),
      ),
    )
    .limit(1);
  return run !== undefined;
}

/** The workspace's pattern list and automation globs, with defaults applied. */
export async function readAuthorshipSettings(
  db: Database,
  workspaceId: number,
): Promise<{ patterns: AiAuthorshipPatterns; automationGlobs: readonly string[] }> {
  const [row] = await db
    .select({ settings: core.workspaces.settings })
    .from(core.workspaces)
    .where(eq(core.workspaces.id, workspaceId))
    .limit(1);
  const settings = row?.settings ?? {};
  const globs = settings.bot_login_globs;
  return {
    patterns: resolveAiAuthorshipPatterns(settings),
    // The workspace's own bot list decides what counts as automation, the same
    // list every other metric excludes (FR-METRICS-8). `[]` is honoured.
    automationGlobs:
      Array.isArray(globs) && globs.every((g) => typeof g === 'string')
        ? (globs as string[])
        : DEFAULT_BOT_LOGIN_GLOBS,
  };
}

export interface AiGovernanceParams {
  workspaceId: number;
  /** Empty = every repository in the workspace. */
  repoIds: readonly number[];
  windowEnd: Date;
  windowDays: number;
}

export interface AiGovernanceResult extends GovernanceSummary {
  windowDays: number;
  windowEnd: string;
  repoCount: number;
  /** Changes the classification without changing the data — printed beside the numbers. */
  patternsFingerprint: string;
}

/** The governance summary for a scope and window. Aggregate only — no logins leave this function. */
export async function computeAiGovernance(
  db: Database,
  params: AiGovernanceParams,
): Promise<AiGovernanceResult> {
  const { workspaceId, windowEnd, windowDays } = params;
  const windowStart = new Date(windowEnd.getTime() - windowDays * 86_400_000);
  const { patterns, automationGlobs } = await readAuthorshipSettings(db, workspaceId);

  const repos = await db
    .select({ id: core.repos.id })
    .from(core.repos)
    .where(
      and(
        eq(core.repos.workspaceId, workspaceId),
        params.repoIds.length > 0 ? inArray(core.repos.id, [...params.repoIds]) : undefined,
      ),
    );

  const perRepo = [];
  for (const { id: repoId } of repos) {
    const end = windowEnd.getTime();
    const [commits, prs, touches, reviewPrs, findings, measured] = await Promise.all([
      readGovCommits(db, workspaceId, repoId, windowStart, windowEnd),
      readGovPrs(db, workspaceId, repoId, windowStart, windowEnd),
      readChurnTouches(db, repoId, windowStart),
      readReviewCoveragePrs(db, repoId, windowStart),
      readGovFindings(db, workspaceId, repoId, windowStart, windowEnd),
      findingsMeasured(db, workspaceId, repoId, windowStart, windowEnd),
    ]);
    perRepo.push(
      computeRepoGovernance(
        {
          commits,
          prs,
          // The shared readers bound only the start; the end is applied here
          // so a pinned report window cannot grow on regeneration.
          touches: touches.filter((t) => new Date(t.touchedAt).getTime() <= end),
          reviewPrs: reviewPrs.filter(
            (p) => p.mergedAt !== null && new Date(p.mergedAt).getTime() <= end,
          ),
          findings,
          findingsMeasured: measured,
        },
        patterns,
        automationGlobs,
      ),
    );
  }

  return {
    ...summarizeGovernance(mergeGovernanceTotals(perRepo)),
    windowDays,
    windowEnd: windowEnd.toISOString(),
    repoCount: repos.length,
    patternsFingerprint: patternsFingerprint(patterns),
  };
}
