import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { core, createDb, facts, read, type Database } from '@repopulse/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { computeRepoSnapshots } from './compute.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;
const ASOF = new Date('2026-07-19T00:00:00Z');
const RECENT = new Date('2026-07-10T00:00:00Z');

describeIfLiveInfra('metrics snapshot compute driver (W3-10, FR-METRICS-13)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId: number;
  let repoId: number;
  let identityId: number;
  let commitId: number;
  let mergeCommitId: number;
  let prId: number;

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'w3-10-compute', name: 'w3-10-compute' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'w3-10-compute' } })
      .returning();
    workspaceId = ws!.id;
    const [user] = await db
      .insert(core.users)
      .values({ forgeUserId: 'w3-10-user', login: 'w3-10-user' })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w3-10-user' } })
      .returning();
    const [conn] = await db
      .insert(core.forgeConnections)
      .values({
        workspaceId,
        provider: 'github',
        authKind: 'pat',
        credentialCiphertext: Buffer.from('x'),
        credentialIv: Buffer.from('iv-1234567890123'),
        keyVersion: 1,
        credentialFingerprint: 'fp',
        status: 'active',
        createdBy: user!.id,
      })
      .returning();
    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId: conn!.id,
        forgeRepoId: 'r-compute',
        org: 'acme',
        name: 'compute',
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning();
    repoId = repo!.id;
    const [id] = await db
      .insert(core.identities)
      .values({ workspaceId, provider: 'github', forgeLogin: 'alice', displayName: 'alice' })
      .returning();
    identityId = id!.id;
    const [id2] = await db
      .insert(core.identities)
      .values({ workspaceId, provider: 'github', forgeLogin: 'bob', displayName: 'bob' })
      .returning();

    // A normal commit (churn 15) and a MERGE commit (churn 200 — must be excluded).
    const [c1] = await db
      .insert(facts.commits)
      .values({
        workspaceId,
        repoId,
        sha: 'c-normal',
        authorIdentityId: identityId,
        committerIdentityId: identityId,
        authoredAt: RECENT,
        committedAt: RECENT,
        messageHead: 'feat',
        isRevertHeuristic: false,
        isMerge: false,
      })
      .returning();
    commitId = c1!.id;
    const [c2] = await db
      .insert(facts.commits)
      .values({
        workspaceId,
        repoId,
        sha: 'c-merge',
        authorIdentityId: identityId,
        committerIdentityId: identityId,
        authoredAt: RECENT,
        committedAt: RECENT,
        messageHead: 'Merge',
        isRevertHeuristic: false,
        isMerge: true,
      })
      .returning();
    mergeCommitId = c2!.id;
    await db.insert(facts.commitFiles).values([
      {
        workspaceId,
        repoId,
        commitId,
        path: 'a.ts',
        additions: 10,
        deletions: 5,
        status: 'modified',
      },
      {
        workspaceId,
        repoId,
        commitId: mergeCommitId,
        path: 'a.ts',
        additions: 100,
        deletions: 100,
        status: 'modified',
      },
    ]);

    // A merged PR with a review (covered) + an open PR.
    const [pr] = await db
      .insert(facts.pullRequests)
      .values({
        workspaceId,
        repoId,
        number: 1,
        forgePrId: 'PR1',
        title: 't',
        authorIdentityId: identityId,
        state: 'merged',
        isDraft: false,
        isBot: false,
        createdAt: RECENT,
        updatedAt: RECENT,
        mergedAt: RECENT,
        baseRef: 'main',
        headSha: 'h1',
        additions: 10,
        deletions: 2,
        changedFiles: 1,
        lastActivityAt: RECENT,
      })
      .returning();
    prId = pr!.id;
    await db
      .insert(facts.pullRequests)
      .values({
        workspaceId,
        repoId,
        number: 2,
        forgePrId: 'PR2',
        title: 'open',
        authorIdentityId: identityId,
        state: 'open',
        isDraft: false,
        isBot: false,
        createdAt: RECENT,
        updatedAt: RECENT,
        baseRef: 'main',
        headSha: 'h2',
        additions: 3,
        deletions: 0,
        changedFiles: 1,
        lastActivityAt: new Date('2026-01-01T00:00:00Z'),
      });
    await db
      .insert(facts.prReviews)
      .values({
        workspaceId,
        repoId,
        pullRequestId: prId,
        forgeReviewId: 'RV1',
        reviewerIdentityId: id2!.id,
        state: 'APPROVED',
        submittedAt: RECENT,
      });

    await db
      .insert(facts.checkRuns)
      .values({
        workspaceId,
        repoId,
        forgeRunId: 'CR1',
        kind: 'check_run',
        headSha: 'h1',
        status: 'completed',
        conclusion: 'success',
        runAttempt: 1,
        startedAt: RECENT,
        completedAt: RECENT,
      });
    await db
      .insert(facts.issues)
      .values({
        workspaceId,
        repoId,
        number: 4,
        authorIdentityId: identityId,
        state: 'closed',
        createdAt: RECENT,
        closedAt: RECENT,
        isPullRequest: false,
      });
    await db
      .insert(facts.releases)
      .values({
        workspaceId,
        repoId,
        forgeReleaseId: 'REL1',
        tag: 'v1',
        name: 'v1',
        isDraft: false,
        isPrerelease: false,
        publishedAt: RECENT,
      });
    await db
      .insert(facts.deployments)
      .values({
        workspaceId,
        repoId,
        forgeDeploymentId: 'DEP1',
        environment: 'production',
        sha: 'h1',
        createdAt: RECENT,
        latestStatus: 'success',
        statusUpdatedAt: RECENT,
      });
  });

  afterAll(async () => {
    await db.delete(read.metricSnapshots).where(eq(read.metricSnapshots.workspaceId, workspaceId));
    await db.delete(facts.commitFiles).where(eq(facts.commitFiles.workspaceId, workspaceId));
    await db.delete(facts.prReviews).where(eq(facts.prReviews.workspaceId, workspaceId));
    await db.delete(facts.checkRuns).where(eq(facts.checkRuns.workspaceId, workspaceId));
    await db.delete(facts.pullRequests).where(eq(facts.pullRequests.workspaceId, workspaceId));
    await db.delete(facts.commits).where(eq(facts.commits.workspaceId, workspaceId));
    await db.delete(facts.issues).where(eq(facts.issues.workspaceId, workspaceId));
    await db.delete(facts.releases).where(eq(facts.releases.workspaceId, workspaceId));
    await db.delete(facts.deployments).where(eq(facts.deployments.workspaceId, workspaceId));
    await db.delete(core.identities).where(eq(core.identities.workspaceId, workspaceId));
    await db.delete(core.repos).where(eq(core.repos.workspaceId, workspaceId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.workspaceId, workspaceId));
    await db.delete(core.users).where(eq(core.users.forgeUserId, 'w3-10-user'));
    await db.delete(core.workspaces).where(eq(core.workspaces.id, workspaceId));
    await db.$client.end();
  });

  async function snapshots() {
    return db.select().from(read.metricSnapshots).where(eq(read.metricSnapshots.repoId, repoId));
  }

  it('writes one row per metric × window (12 × 1) and repeats append-only', async () => {
    const written = await computeRepoSnapshots(db, {
      workspaceId,
      repoId,
      asOf: ASOF,
      windows: [{ key: '365d', days: 365 }],
    });
    expect(written).toBe(12);
    const rows = await snapshots();
    expect(rows).toHaveLength(12);
    expect(new Set(rows.map((r) => r.metricKey)).size).toBe(12); // M1..M12

    // Two nightly runs → two rows per metric (FR-METRICS-13 append-only).
    await computeRepoSnapshots(db, {
      workspaceId,
      repoId,
      asOf: ASOF,
      windows: [{ key: '365d', days: 365 }],
    });
    expect(await snapshots()).toHaveLength(24);
  });

  it('EXCLUDES the merge commit from churn (M1) — the whole point of is_merge', async () => {
    const rows = await snapshots();
    const m1 = rows.find((r) => r.metricKey === 'M1');
    // Only the non-merge commit's 15 lines; the merge's 200 must NOT count.
    expect(Number(m1!.value)).toBe(15);
  });

  it('ratio metrics carry numerator/denominator (M5 review coverage)', async () => {
    const rows = await snapshots();
    const m5 = rows.find((r) => r.metricKey === 'M5');
    // 1 merged PR, covered by bob's approval → covered=1, merged=1, m5=1.0
    expect(m5!.numerator).not.toBeNull();
    expect(m5!.denominator).not.toBeNull();
    expect(Number(m5!.numerator)).toBe(1);
    expect(Number(m5!.denominator)).toBe(1);
  });
});
