import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { core, createDb, facts, type Database } from '@repopulse/shared';
import type { ForgeCommit, ForgePR } from '@repopulse/forge';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { IdentityResolver } from './identity.js';
import { upsertCommits, upsertPullRequests } from './writers.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

// W18-20: the two authorship signals ingest used to drop — the commit's
// trailers (the body was cut to its subject) and the PR's source branch.

describeIfLiveInfra('ingest keeps authorship signals (W18-20)', () => {
  const db: Database = createDb(databaseUrl as string);
  const SLUG = 'w18-20-ingest';
  let workspaceId: number;
  let repoId: number;

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: SLUG, name: SLUG })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: SLUG } })
      .returning();
    workspaceId = ws!.id;
    await cleanup();
    const [user] = await db
      .insert(core.users)
      .values({ authProvider: 'github', authSubject: SLUG, forgeUserId: SLUG, login: SLUG })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: SLUG } })
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
        credentialFingerprint: SLUG,
        status: 'active',
        createdBy: user!.id,
      })
      .returning();
    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId: conn!.id,
        forgeRepoId: SLUG,
        org: 'acme',
        name: SLUG,
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'live',
        tier2Auto: false,
      })
      .returning();
    repoId = repo!.id;
  });

  async function cleanup(): Promise<void> {
    const repos = await db
      .select({ id: core.repos.id })
      .from(core.repos)
      .where(eq(core.repos.workspaceId, workspaceId));
    for (const r of repos) {
      await db.delete(facts.commits).where(eq(facts.commits.repoId, r.id));
      await db.delete(facts.pullRequests).where(eq(facts.pullRequests.repoId, r.id));
      await db.delete(core.repos).where(eq(core.repos.id, r.id));
    }
    await db.delete(core.identities).where(eq(core.identities.workspaceId, workspaceId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.workspaceId, workspaceId));
  }

  afterAll(async () => {
    await cleanup();
    await db.delete(core.users).where(eq(core.users.forgeUserId, SLUG));
    await db.delete(core.workspaces).where(eq(core.workspaces.id, workspaceId));
    await db.$client.end();
  });

  const commit = (sha: string, message: string): ForgeCommit => ({
    sha,
    authorLogin: 'alice',
    authorEmail: 'alice@x.io',
    authoredAt: '2026-09-01T00:00:00Z',
    committedAt: '2026-09-01T00:00:00Z',
    message,
    parentShas: ['p'],
  });

  it('stores parsed trailers ([] when there are none) and fills them on re-ingest', async () => {
    const scope = { workspaceId, repoId };
    const resolver = new IdentityResolver(db, workspaceId, 'github');
    await upsertCommits(db, scope, resolver, [
      commit('t1', 'Fix it\n\nCo-Authored-By: Claude <noreply@anthropic.com>'),
      commit('t2', 'Plain subject'),
    ]);
    // A pre-0035 row: trailers NULL until the backfill runs again.
    await db.update(facts.commits).set({ trailers: null }).where(eq(facts.commits.sha, 't2'));
    await upsertCommits(db, scope, resolver, [commit('t2', 'Plain subject')]);

    const rows = await db
      .select({ sha: facts.commits.sha, trailers: facts.commits.trailers })
      .from(facts.commits)
      .where(eq(facts.commits.repoId, repoId));
    const bySha = Object.fromEntries(rows.map((r) => [r.sha, r.trailers]));
    expect(bySha.t1).toEqual(['Co-Authored-By: Claude <noreply@anthropic.com>']);
    expect(bySha.t2).toEqual([]);
  });

  it('stores the PR source branch and does not erase it when a later listing omits it', async () => {
    const scope = { workspaceId, repoId };
    const resolver = new IdentityResolver(db, workspaceId, 'github');
    const pr: ForgePR = {
      number: 1,
      externalId: 'x1',
      title: 't',
      body: null,
      authorLogin: 'alice',
      isBot: false,
      isDraft: false,
      state: 'open',
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
      mergedAt: null,
      closedAt: null,
      mergedByLogin: null,
      baseRef: 'main',
      headSha: 'h',
      headRef: 'claude/fix-it',
    };
    await upsertPullRequests(db, scope, resolver, [pr]);
    const withoutRef: ForgePR = { ...pr };
    delete withoutRef.headRef;
    await upsertPullRequests(db, scope, resolver, [withoutRef]);
    const [row] = await db
      .select({ headRef: facts.pullRequests.headRef })
      .from(facts.pullRequests)
      .where(eq(facts.pullRequests.repoId, repoId));
    expect(row!.headRef).toBe('claude/fix-it');
  });

  // W20-16 (UX_TODO DSH-85): requested reviewers as identity ids.
  it('stores requested reviewers, keeps them when a listing omits them, and clears to {}', async () => {
    const scope = { workspaceId, repoId };
    const resolver = new IdentityResolver(db, workspaceId, 'github');
    const pr: ForgePR = {
      number: 2,
      externalId: 'x2',
      title: 't',
      body: null,
      authorLogin: 'alice',
      isBot: false,
      isDraft: false,
      state: 'open',
      createdAt: '2026-09-01T00:00:00Z',
      updatedAt: '2026-09-01T00:00:00Z',
      mergedAt: null,
      closedAt: null,
      mergedByLogin: null,
      baseRef: 'main',
      headSha: 'h',
      requestedReviewerLogins: ['bob'],
    };
    const read = async () =>
      (
        await db
          .select({ ids: facts.pullRequests.requestedReviewerIdentityIds })
          .from(facts.pullRequests)
          .where(and(eq(facts.pullRequests.repoId, repoId), eq(facts.pullRequests.number, 2)))
      )[0]!.ids;
    await upsertPullRequests(db, scope, resolver, [pr]);
    const bob = await resolver.resolve({ login: 'bob' });
    expect(await read()).toEqual([bob]);

    const silent: ForgePR = { ...pr };
    delete silent.requestedReviewerLogins;
    await upsertPullRequests(db, scope, resolver, [silent]);
    expect(await read()).toEqual([bob]);

    await upsertPullRequests(db, scope, resolver, [{ ...pr, requestedReviewerLogins: [] }]);
    expect(await read()).toEqual([]);
  });
});
