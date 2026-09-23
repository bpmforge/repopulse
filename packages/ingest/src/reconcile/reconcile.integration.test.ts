import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { core, createDb, facts, type Database } from '@repopulse/shared';
import type { ForgePR, ForgeProvider, Page } from '@repopulse/forge';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { reconcileRepo, requeueErrorRepos } from './reconcile.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

function pr(number: number): ForgePR {
  return {
    number,
    externalId: `PR${number}`,
    title: `pr ${number}`,
    body: null,
    authorLogin: 'alice',
    isBot: false,
    isDraft: false,
    state: 'open',
    createdAt: '2026-07-01T00:00:00Z',
    updatedAt: '2026-07-10T00:00:00Z',
    mergedAt: null,
    closedAt: null,
    mergedByLogin: null,
    baseRef: 'main',
    headSha: `h${number}`,
    additions: 1,
    deletions: 0,
    changedFiles: 1,
  };
}

describeIfLiveInfra('reconciliation sweep (W2-05, FR-INGEST-7)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId: number;
  let repoId: number;
  let errorRepoId: number;

  async function makeRepo(forgeRepoId: string, syncStatus: string): Promise<number> {
    const [conn] = await db
      .select()
      .from(core.forgeConnections)
      .where(eq(core.forgeConnections.workspaceId, workspaceId))
      .limit(1);
    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId: conn!.id,
        forgeRepoId,
        org: 'acme',
        name: forgeRepoId,
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus,
        tier2Auto: false,
      })
      .returning();
    return repo!.id;
  }

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'w2-05-recon', name: 'w2-05-recon' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'w2-05-recon' } })
      .returning();
    workspaceId = ws!.id;
    const [user] = await db
      .insert(core.users)
      .values({
        authProvider: 'github',
        authSubject: 'w2-05-recon-user',
        forgeUserId: 'w2-05-recon-user',
        login: 'w2-05-recon-user',
      })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w2-05-recon-user' } })
      .returning();
    await db.insert(core.forgeConnections).values({
      workspaceId,
      provider: 'github',
      authKind: 'pat',
      credentialCiphertext: Buffer.from('x'),
      credentialIv: Buffer.from('iv-1234567890123'),
      keyVersion: 1,
      credentialFingerprint: 'fp',
      status: 'active',
      createdBy: user!.id,
    });
    repoId = await makeRepo('r-recon', 'live');
    errorRepoId = await makeRepo('r-error', 'error');
  });

  afterAll(async () => {
    await db.delete(facts.pullRequests).where(eq(facts.pullRequests.workspaceId, workspaceId));
    await db.delete(core.syncCursors).where(eq(core.syncCursors.workspaceId, workspaceId));
    await db.delete(core.identities).where(eq(core.identities.workspaceId, workspaceId));
    await db.delete(core.repos).where(eq(core.repos.workspaceId, workspaceId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.workspaceId, workspaceId));
    await db.delete(core.users).where(eq(core.users.forgeUserId, 'w2-05-recon-user'));
    await db.delete(core.workspaces).where(eq(core.workspaces.id, workspaceId));
    await db.$client.end();
  });

  it('repairs a missed-webhook gap: a PR absent from the warehouse is upserted by the sweep', async () => {
    // Simulate a missed webhook — the forge has PR #1 and #2, warehouse has neither yet.
    const provider = {
      listPullRequests: (): Promise<Page<ForgePR>> => Promise.resolve({ items: [pr(1), pr(2)] }),
      listCommits: (): Promise<Page<never>> => Promise.resolve({ items: [] }),
      listIssues: (): Promise<Page<never>> => Promise.resolve({ items: [] }),
      listReleases: (): Promise<Page<never>> => Promise.resolve({ items: [] }),
      listDeployments: (): Promise<Page<never>> => Promise.resolve({ items: [] }),
    } as unknown as ForgeProvider;

    const counts = await reconcileRepo(
      { db, provider },
      { workspaceId, repoId, repo: 'acme/r-recon' },
    );
    expect(counts.prs).toBe(2);
    const prs = await db
      .select()
      .from(facts.pullRequests)
      .where(eq(facts.pullRequests.repoId, repoId));
    expect(prs).toHaveLength(2); // the gap is repaired

    // A second sweep is idempotent (no dupes).
    await reconcileRepo({ db, provider }, { workspaceId, repoId, repo: 'acme/r-recon' });
    const prs2 = await db
      .select()
      .from(facts.pullRequests)
      .where(eq(facts.pullRequests.repoId, repoId));
    expect(prs2).toHaveLength(2);
  });

  it('requeues a repo stuck in error → pending_backfill + re-enqueued plan', async () => {
    const enqueuePlan = vi.fn(async () => {});
    const requeued = await requeueErrorRepos({ db, enqueuePlan }, workspaceId);
    expect(requeued).toContain(errorRepoId);
    expect(enqueuePlan).toHaveBeenCalledWith({ workspaceId, repoId: errorRepoId });
    const [repo] = await db.select().from(core.repos).where(eq(core.repos.id, errorRepoId));
    expect(repo!.syncStatus).toBe('pending_backfill');
    expect(repo!.lastError).toBeNull();
  });
});
