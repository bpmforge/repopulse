import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { core, createDb, facts, type Database } from '@repopulse/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { commitsNeedingChurn, isEnrichmentDrained } from './enrich-queue.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

// The enrichment work-list and the `enrichment --> live` drained condition
// (W12-05). Both read the SAME predicate, so these tests are what stop the
// producer and the state transition from disagreeing about when enrichment is
// finished.

describeIfLiveInfra('enrichment work list (W12-05)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId: number;
  let connectionId: number;
  let repoId: number;
  let identityId: number;

  async function addCommit(sha: string, statsSource: string | null): Promise<void> {
    await db.insert(facts.commits).values({
      workspaceId,
      repoId,
      sha,
      authorIdentityId: identityId,
      committerIdentityId: identityId,
      authoredAt: new Date(),
      committedAt: new Date(),
      messageHead: sha,
      isRevertHeuristic: false,
      // The history backfill stamps 'graphql' whenever the LIST payload carried
      // stats; only enrichment writes 'detail'. That distinction is the whole
      // point of the predicate.
      ...(statsSource ? { statsSource, additions: 10, deletions: 2 } : {}),
    });
  }

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'w12-05-enrich', name: 'w12-05-enrich' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'w12-05-enrich' } })
      .returning();
    workspaceId = ws!.id;
    const [user] = await db
      .insert(core.users)
      .values({
        authProvider: 'github',
        authSubject: 'w12-05-user',
        forgeUserId: 'w12-05-user',
        login: 'w12-05-user',
      })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w12-05-user' } })
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
        credentialFingerprint: 'w12-05-fp',
        status: 'active',
        createdBy: user!.id,
      })
      .returning();
    connectionId = conn!.id;
    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId,
        forgeRepoId: 'w12-05-repo',
        org: 'acme',
        name: 'w12-05-repo',
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'backfilling',
        tier2Auto: false,
      })
      .returning();
    repoId = repo!.id;
    const [identity] = await db
      .insert(core.identities)
      .values({
        workspaceId,
        provider: 'github',
        forgeLogin: 'w12-05-dev',
        displayName: 'W12-05 Dev',
      })
      .returning();
    identityId = identity!.id;
  });

  afterAll(async () => {
    await db.delete(facts.commitFiles).where(eq(facts.commitFiles.workspaceId, workspaceId));
    await db.delete(facts.commits).where(eq(facts.commits.workspaceId, workspaceId));
    await db.delete(core.repos).where(eq(core.repos.workspaceId, workspaceId));
    await db.delete(core.forgeConnections).where(eq(core.forgeConnections.id, connectionId));
    await db.delete(core.identities).where(eq(core.identities.workspaceId, workspaceId));
    await db.delete(core.users).where(eq(core.users.forgeUserId, 'w12-05-user'));
    await db.delete(core.workspaces).where(eq(core.workspaces.id, workspaceId));
    await db.$client.end();
  });

  it('a repo with no commits counts as drained rather than stalling forever', async () => {
    expect(await isEnrichmentDrained(db, repoId)).toBe(true);
    expect(await commitsNeedingChurn(db, repoId)).toEqual([]);
  });

  it('a commit stamped `graphql` by the history backfill STILL needs churn', async () => {
    // The bug this pins: keying off `additions IS NULL` would have treated
    // every list-sourced commit as already enriched, enqueued nothing, and left
    // M1/M2 at zero while reporting the repo fully ingested.
    await addCommit('sha-graphql', 'graphql');
    const pending = await commitsNeedingChurn(db, repoId);
    expect(pending.map((c) => c.sha)).toEqual(['sha-graphql']);
    expect(await isEnrichmentDrained(db, repoId)).toBe(false);
  });

  it('a commit with no stats at all needs churn', async () => {
    await addCommit('sha-bare', null);
    const pending = await commitsNeedingChurn(db, repoId);
    expect(pending.map((c) => c.sha)).toContain('sha-bare');
  });

  it('only `detail` counts as enriched, and drains the repo once every commit has it', async () => {
    await db
      .update(facts.commits)
      .set({ statsSource: 'detail' })
      .where(eq(facts.commits.repoId, repoId));
    expect(await commitsNeedingChurn(db, repoId)).toEqual([]);
    expect(await isEnrichmentDrained(db, repoId)).toBe(true);
  });

  it('respects the fan-out limit so one round cannot flood the queue', async () => {
    await addCommit('sha-a', null);
    await addCommit('sha-b', null);
    await addCommit('sha-c', null);
    expect(await commitsNeedingChurn(db, repoId, 2)).toHaveLength(2);
  });
});
