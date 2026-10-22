import 'dotenv/config';
import { asc, eq } from 'drizzle-orm';
import { core, createDb, facts, type Database } from '@repopulse/shared';
import {
  DEFAULT_GITHUB_BASE_URL,
  GitHubProvider,
  createAuthHeaderProvider,
  type ForgeHttpClient,
  type ForgePR,
  type ForgeResponse,
} from '@repopulse/forge';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enrichPullRequest } from './enrich-pr.js';
import { IdentityResolver } from './identity.js';
import { upsertPullRequests } from './writers.js';

// W20-24 (UX_TODO DSH-41): when each reviewer was asked. Enrichment reads the
// PR's issue events through the real GitHub adapter (over a canned client) and
// stores `timeline` rows; a reviewer who appears on a later listing of an OPEN
// PR is stored as `observed` at that listing's updated time; and the events,
// being exact, replace the observed rows for the same PR.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;
const GH = `${DEFAULT_GITHUB_BASE_URL}/repos`;
type Canned = Record<string, { status: number; body: unknown }>;

function clientOver(canned: Canned): ForgeHttpClient {
  return {
    request: (_ctx, req): Promise<ForgeResponse> => {
      const r = canned[req.url];
      if (!r) throw new Error(`canned client: no response for ${req.method} ${req.url}`);
      return Promise.resolve({
        status: r.status,
        headers: {},
        body: r.body,
        servedFromCache: false,
      });
    },
  };
}

describeIfLiveInfra('review-request times (W20-24, DSH-41)', () => {
  const db: Database = createDb(databaseUrl as string);
  const slug = `w20-24-rr-${process.pid}`;
  let workspaceId: number;
  let connectionId: number;
  let userId: number;
  let repoId: number;

  const pr = (over: Partial<ForgePR> = {}): ForgePR =>
    ({
      externalId: `${slug}-pr-3`,
      number: 3,
      title: 'pr',
      authorLogin: 'dana',
      isBot: false,
      state: 'open',
      isDraft: false,
      createdAt: '2026-10-01T00:00:00Z',
      updatedAt: '2026-10-02T00:00:00Z',
      closedAt: null,
      mergedAt: null,
      mergedByLogin: null,
      baseRef: 'main',
      headSha: 'sha3',
      ...over,
    }) as ForgePR;

  async function requestRows() {
    return db
      .select({
        login: core.identities.forgeLogin,
        at: facts.prReviewRequests.requestedAt,
        source: facts.prReviewRequests.source,
      })
      .from(facts.prReviewRequests)
      .innerJoin(core.identities, eq(core.identities.id, facts.prReviewRequests.reviewerIdentityId))
      .where(eq(facts.prReviewRequests.workspaceId, workspaceId))
      .orderBy(asc(facts.prReviewRequests.requestedAt));
  }

  async function list(p: ForgePR) {
    await db.transaction(async (tx) => {
      const resolver = new IdentityResolver(tx, workspaceId, 'github');
      await upsertPullRequests(tx, { workspaceId, repoId }, resolver, [p]);
    });
  }

  beforeAll(async () => {
    const [ws] = await db.insert(core.workspaces).values({ slug, name: slug }).returning();
    workspaceId = ws!.id;
    const [user] = await db
      .insert(core.users)
      .values({ authProvider: 'github', authSubject: slug, login: slug })
      .returning();
    userId = user!.id;
    const [conn] = await db
      .insert(core.forgeConnections)
      .values({
        workspaceId,
        provider: 'github',
        authKind: 'pat',
        credentialCiphertext: Buffer.from('x'),
        credentialIv: Buffer.from('iv-1234567890123'),
        keyVersion: 1,
        credentialFingerprint: `${slug}-fp`,
        status: 'active',
        createdBy: userId,
      })
      .returning();
    connectionId = conn!.id;
    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId,
        forgeRepoId: `${slug}-repo`,
        org: 'acme',
        name: 'rr',
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
    await db
      .delete(facts.prReviewRequests)
      .where(eq(facts.prReviewRequests.workspaceId, workspaceId));
    await db.delete(facts.prReviews).where(eq(facts.prReviews.workspaceId, workspaceId));
    await db.delete(facts.pullRequests).where(eq(facts.pullRequests.workspaceId, workspaceId));
    await db.delete(core.syncCursors).where(eq(core.syncCursors.workspaceId, workspaceId));
    await db.delete(core.identities).where(eq(core.identities.workspaceId, workspaceId));
    await db.delete(core.repos).where(eq(core.repos.workspaceId, workspaceId));
    await db.delete(core.forgeConnections).where(eq(core.forgeConnections.id, connectionId));
    await db.delete(core.workspaces).where(eq(core.workspaces.id, workspaceId));
    await db.delete(core.users).where(eq(core.users.id, userId));
    await db.$client.end();
  });

  it('records a reviewer added between two listings of an open PR as observed', async () => {
    // First sight: the request's time is unknown, so nothing is recorded.
    await list(pr({ requestedReviewerLogins: ['ana'] }));
    expect(await requestRows()).toEqual([]);
    // Bo appears on the next listing: asked no later than its updated time.
    await list(pr({ requestedReviewerLogins: ['ana', 'bo'], updatedAt: '2026-10-05T00:00:00Z' }));
    expect(await requestRows()).toEqual([
      { login: 'bo', at: new Date('2026-10-05T00:00:00Z'), source: 'observed' },
    ]);
    // The same listing again changes nothing (idempotent).
    await list(pr({ requestedReviewerLogins: ['ana', 'bo'], updatedAt: '2026-10-05T00:00:00Z' }));
    expect(await requestRows()).toHaveLength(1);
  });

  it('enrichment stores the forge events and they replace the observed rows', async () => {
    const repo = 'acme/rr';
    const provider = new GitHubProvider({
      auth: createAuthHeaderProvider({ kind: 'pat', token: 'w20-24-test' }),
      client: clientOver({
        [`${GH}/${repo}/pulls/3/reviews?per_page=100`]: { status: 200, body: [] },
        [`${GH}/${repo}/commits/sha3/check-runs?per_page=100`]: {
          status: 200,
          body: { total_count: 0, check_runs: [] },
        },
        [`${GH}/${repo}/pulls/3/comments?per_page=100`]: { status: 200, body: [] },
        [`${GH}/${repo}/issues/3/events?per_page=100`]: {
          status: 200,
          body: [
            {
              event: 'review_requested',
              created_at: '2026-10-01T10:00:00Z',
              requested_reviewer: { login: 'ana' },
            },
            {
              event: 'review_requested',
              created_at: '2026-10-04T08:00:00Z',
              requested_reviewer: { login: 'bo' },
            },
            { event: 'labeled', created_at: '2026-10-04T09:00:00Z' },
          ],
        },
      }),
    });
    const out = await enrichPullRequest(
      { db, provider },
      { workspaceId, repoId, repo, prNumber: 3, headSha: 'sha3' },
    );
    expect(out.reviewRequests).toBe(2);
    expect(await requestRows()).toEqual([
      { login: 'ana', at: new Date('2026-10-01T10:00:00Z'), source: 'timeline' },
      { login: 'bo', at: new Date('2026-10-04T08:00:00Z'), source: 'timeline' },
    ]);
  });

  it('a refused events read keeps what was stored and enriches the rest', async () => {
    await db
      .update(facts.pullRequests)
      .set({ enrichedAt: null })
      .where(eq(facts.pullRequests.repoId, repoId));
    const repo = 'acme/rr';
    const provider = new GitHubProvider({
      auth: createAuthHeaderProvider({ kind: 'pat', token: 'w20-24-test' }),
      client: clientOver({
        [`${GH}/${repo}/pulls/3/reviews?per_page=100`]: { status: 200, body: [] },
        [`${GH}/${repo}/commits/sha3/check-runs?per_page=100`]: {
          status: 200,
          body: { total_count: 0, check_runs: [] },
        },
        [`${GH}/${repo}/pulls/3/comments?per_page=100`]: { status: 200, body: [] },
        [`${GH}/${repo}/issues/3/events?per_page=100`]: { status: 403, body: { message: 'no' } },
      }),
    });
    const out = await enrichPullRequest(
      { db, provider },
      { workspaceId, repoId, repo, prNumber: 3, headSha: 'sha3' },
    );
    expect(out.reviewRequests).toBe(0);
    expect(await requestRows()).toHaveLength(2);
  });
});
