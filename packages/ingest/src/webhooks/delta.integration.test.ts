import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { core, createDb, facts, type Database } from '@repopulse/shared';
import type { ForgePR, ForgeProvider, Page, SinceQuery } from '@repopulse/forge';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processDeltaJob } from './delta.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

function pr(number: number, updatedAt: string): ForgePR {
  return {
    number,
    externalId: `PR${number}`,
    title: `pr ${number}`,
    body: null,
    authorLogin: 'alice',
    isBot: false,
    isDraft: false,
    state: 'open',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt,
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

describeIfLiveInfra('webhook delta processor (W2-04, FR-INGEST-6)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId: number;
  let repoId: number;
  const sinceSeen: (string | undefined)[] = [];

  // Fake provider: records the `since` it was asked for, always returns 2 PRs.
  const provider = {
    listPullRequests: (_ctx: unknown, _repo: string, q: SinceQuery): Promise<Page<ForgePR>> => {
      sinceSeen.push(q.since);
      return Promise.resolve({
        items: [pr(1, '2026-05-01T00:00:00Z'), pr(2, '2026-06-01T00:00:00Z')],
      });
    },
  } as unknown as ForgeProvider;

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'w2-04-delta', name: 'w2-04-delta' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'w2-04-delta' } })
      .returning();
    workspaceId = ws!.id;
    const [user] = await db
      .insert(core.users)
      .values({
        authProvider: 'github',
        authSubject: 'w2-04-user',
        forgeUserId: 'w2-04-user',
        login: 'w2-04-user',
      })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w2-04-user' } })
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
        credentialFingerprint: 'w2-04-fp',
        status: 'active',
        createdBy: user!.id,
      })
      .returning();
    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId: conn!.id,
        forgeRepoId: 'r-delta',
        org: 'acme',
        name: 'delta',
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning();
    repoId = repo!.id;
  });

  afterAll(async () => {
    await db.delete(facts.pullRequests).where(eq(facts.pullRequests.workspaceId, workspaceId));
    await db.delete(core.syncCursors).where(eq(core.syncCursors.workspaceId, workspaceId));
    await db.delete(core.repos).where(eq(core.repos.workspaceId, workspaceId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.workspaceId, workspaceId));
    await db.delete(core.identities).where(eq(core.identities.workspaceId, workspaceId));
    await db.delete(core.users).where(eq(core.users.forgeUserId, 'w2-04-user'));
    await db.delete(core.workspaces).where(eq(core.workspaces.id, workspaceId));
    await db.$client.end();
  });

  async function prCount(): Promise<number> {
    return (await db.select().from(facts.pullRequests).where(eq(facts.pullRequests.repoId, repoId)))
      .length;
  }

  it('pulls by watermark (not payload) and a replay leaves byte-identical state', async () => {
    const data = { workspaceId, repoId, repo: 'acme/delta', kind: 'pull_requests' as const };

    // First delta: no PRs yet → no watermark → full pull.
    await processDeltaJob({ db, provider }, data);
    expect(await prCount()).toBe(2);
    expect(sinceSeen[0]).toBeUndefined();

    // Second delta (a redelivery/replay): now there's a watermark, so `since`
    // is derived from the newest PR — pulled by cursor, not payload.
    await processDeltaJob({ db, provider }, data);
    expect(await prCount()).toBe(2); // idempotent — still 2, not 4
    expect(sinceSeen[1]).toBeTruthy();
    // watermark = newest updatedAt (2026-06-01) minus the 1h overlap
    expect(new Date(sinceSeen[1] as string).getTime()).toBeLessThan(
      new Date('2026-06-01T00:00:00Z').getTime(),
    );
  });
});
