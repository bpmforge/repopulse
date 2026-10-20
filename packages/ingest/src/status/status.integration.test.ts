import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { core, createDb, facts, type Database } from '@repopulse/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectionHost, orgSyncStatus, repoSyncStatus } from './status.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;
const NOW = Date.parse('2026-07-19T00:00:00Z');

describeIfLiveInfra('sync status model (W2-05, INGESTION §7, FR-INGEST-8)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId: number;
  let repoId: number;
  let identityId: number;

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'w2-05-status', name: 'w2-05-status' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'w2-05-status' } })
      .returning();
    workspaceId = ws!.id;
    const [user] = await db
      .insert(core.users)
      .values({
        authProvider: 'github',
        authSubject: 'w2-05-user',
        forgeUserId: 'w2-05-user',
        login: 'w2-05-user',
      })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w2-05-user' } })
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
        forgeRepoId: 'r-status',
        org: 'acme',
        name: 'status',
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'backfilling',
        tier2Auto: false,
        lastSyncedAt: new Date('2026-07-18T00:00:00Z'),
      })
      .returning();
    repoId = repo!.id;
    const [id] = await db
      .insert(core.identities)
      .values({ workspaceId, provider: 'github', forgeLogin: 'alice', displayName: 'alice' })
      .returning();
    identityId = id!.id;
    // A commit ~180d old → ~49% time-coverage; and one recent (low lag).
    await db.insert(facts.commits).values([
      {
        workspaceId,
        repoId,
        sha: 's-old',
        authorIdentityId: identityId,
        committerIdentityId: identityId,
        authoredAt: new Date('2026-01-20T00:00:00Z'),
        committedAt: new Date('2026-01-20T00:00:00Z'),
        messageHead: 'old',
        isRevertHeuristic: false,
      },
      {
        workspaceId,
        repoId,
        sha: 's-new',
        authorIdentityId: identityId,
        committerIdentityId: identityId,
        authoredAt: new Date('2026-07-18T00:00:00Z'),
        committedAt: new Date('2026-07-18T00:00:00Z'),
        messageHead: 'new',
        isRevertHeuristic: false,
      },
    ]);
    await db.insert(core.syncCursors).values({
      workspaceId,
      repoId,
      entityType: 'commits',
      cursorValue: null,
      backfillDone: true,
    });
  });

  afterAll(async () => {
    await db.delete(facts.commits).where(eq(facts.commits.workspaceId, workspaceId));
    await db.delete(core.syncCursors).where(eq(core.syncCursors.workspaceId, workspaceId));
    await db.delete(core.identities).where(eq(core.identities.workspaceId, workspaceId));
    await db.delete(core.repos).where(eq(core.repos.workspaceId, workspaceId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.workspaceId, workspaceId));
    await db.delete(core.users).where(eq(core.users.forgeUserId, 'w2-05-user'));
    await db.delete(core.workspaces).where(eq(core.workspaces.id, workspaceId));
    await db.$client.end();
  });

  it('computes phase, time-coverage percentComplete, entities and lag from the warehouse', async () => {
    const status = await repoSyncStatus(db, repoId, { nowMs: NOW });
    expect(status).not.toBeNull();
    // backfilling + all cursors done → enrichment phase
    expect(status!.phase).toBe('enrichment');
    // oldest commit ~180d ago → coverage ~0.49 → ~49%
    expect(status!.percentComplete).toBeGreaterThan(40);
    expect(status!.percentComplete).toBeLessThan(60);
    expect(status!.entities.commits).toMatchObject({ done: true });
    // newest commit 2026-07-18, now 2026-07-19 → ~1 day lag
    expect(status!.lagSeconds).toBeGreaterThan(0);
    expect(status!.lagSeconds).toBeLessThan(2 * 24 * 60 * 60);
  });

  // W20-15 (UX_TODO X-18): with several forges connected, which one is it?
  it('names the connection each repository syncs through', async () => {
    const status = await repoSyncStatus(db, repoId, { nowMs: NOW });
    expect(status!.connection).toMatchObject({ provider: 'github' });
    expect(typeof status!.connection!.id).toBe('number');
    // No base URL on a github connection is github.com; a URL names its host.
    expect(connectionHost('github', null)).toBe('github.com');
    expect(connectionHost('github', 'https://api.github.com')).toBe('github.com');
    expect(connectionHost('gitea', 'https://git.corp.example:8443/')).toBe('git.corp.example');
  });

  it('org aggregate reports worst phase + repo count', async () => {
    const org = await orgSyncStatus(db, workspaceId, { nowMs: NOW });
    expect(org.repoCount).toBe(1);
    expect(org.phase).toBe('enrichment');
    expect(org.repos).toHaveLength(1);
  });
});
