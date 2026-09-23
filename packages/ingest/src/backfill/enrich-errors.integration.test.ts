import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { core, createDb, facts, type Database } from '@repopulse/shared';
import {
  GiteaProvider,
  createAuthHeaderProvider,
  type ForgeHttpClient,
  type ForgeResponse,
} from '@repopulse/forge';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enrichCommitChurn } from './enrich.js';
import { enrichPullRequest, isPrEnrichmentDrained } from './enrich-pr.js';
import { isEnrichmentDrained } from './enrich-queue.js';
import { writeCursor } from './cursor.js';
import { PAGINATED_ENTITIES } from './backfill.js';
import { repoSyncStatus } from '../status/status.js';

// W17-38 (residual R-15 of W17-35): the ENRICHMENT fetches — reviews, check
// runs, commit files — read an HTTP error as "nothing here". A token without
// the checks scope stamped every PR "enriched, zero CI runs"; a 404 on a commit
// recorded zero churn as a measurement. Same treatment as the backfill lists:
// a permanent refusal is recorded per entity and on repos.last_error, the other
// fetches still run, the PR/commit is still marked handled so the repo can
// reach live, and a transient failure fails the job for BullMQ to retry.
//
// Driven through the REAL GiteaProvider over a canned client, as W17-35's test
// is: the silence lived in the adapter, which a fake ForgeProvider would skip.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

const BASE = 'https://git.example.com';
const API = `${BASE}/api/v1/repos`;
const REVIEWS = (repo: string, n: number) => `${API}/${repo}/pulls/${n}/reviews`;
const STATUSES = (repo: string, sha: string) =>
  `${API}/${repo}/commits/${sha}/statuses?page=1&limit=50`;
const COMMIT = (repo: string, sha: string) => `${API}/${repo}/git/commits/${sha}`;

type Canned = Record<string, { status: number; body: unknown; headers?: Record<string, string> }>;

function giteaOver(canned: Canned): GiteaProvider {
  const client: ForgeHttpClient = {
    request: (_ctx, req): Promise<ForgeResponse> => {
      const r = canned[req.url];
      if (!r) throw new Error(`canned client: no response for ${req.method} ${req.url}`);
      return Promise.resolve({
        status: r.status,
        headers: r.headers ?? {},
        body: r.body,
        servedFromCache: false,
      });
    },
  };
  return new GiteaProvider({
    client,
    auth: createAuthHeaderProvider({ kind: 'pat', token: 'w17-38-test' }),
    baseUrl: BASE,
  });
}

const SCOPE_403 = {
  status: 403,
  body: { message: 'token does not have at least one of required scope(s): [read:repository]' },
};
const ONE_STATUS = {
  status: 200,
  headers: { 'x-total-count': '1' },
  body: [
    {
      id: 1,
      status: 'success',
      context: 'ci/build',
      created_at: '2026-09-01T00:00:00Z',
      updated_at: '2026-09-01T00:01:00Z',
    },
  ],
};

describeIfLiveInfra('enrichment fetch errors are recorded, not absorbed (W17-38)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId: number;
  let connectionId: number;
  let identityId: number;

  async function makeRepo(name: string): Promise<number> {
    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId,
        forgeRepoId: `w17-38-${name}`,
        org: 'acme',
        name,
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'backfilling',
        tier2Auto: false,
      })
      .returning();
    return repo!.id;
  }

  async function makePr(repoId: number, number: number, headSha: string): Promise<void> {
    await db.insert(facts.pullRequests).values({
      workspaceId,
      repoId,
      number,
      forgePrId: `w17-38-${repoId}-${number}`,
      title: `PR ${number}`,
      authorIdentityId: identityId,
      state: 'open',
      isDraft: false,
      isBot: false,
      createdAt: new Date(),
      updatedAt: new Date(),
      baseRef: 'main',
      headSha,
      additions: 1,
      deletions: 0,
      changedFiles: 1,
    });
  }

  async function makeCommit(repoId: number, sha: string): Promise<void> {
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
    });
  }

  async function repoLastError(repoId: number): Promise<string | null> {
    const [r] = await db
      .select({ lastError: core.repos.lastError })
      .from(core.repos)
      .where(eq(core.repos.id, repoId));
    return r?.lastError ?? null;
  }

  async function cursorError(repoId: number, entity: string): Promise<string | null | undefined> {
    const [row] = await db
      .select({ lastError: core.syncCursors.lastError })
      .from(core.syncCursors)
      .where(and(eq(core.syncCursors.repoId, repoId), eq(core.syncCursors.entityType, entity)));
    return row === undefined ? undefined : row.lastError;
  }

  async function checkRunCount(repoId: number): Promise<number> {
    const rows = await db
      .select({ id: facts.checkRuns.id })
      .from(facts.checkRuns)
      .where(eq(facts.checkRuns.repoId, repoId));
    return rows.length;
  }

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'w17-38-enrich-errors', name: 'w17-38-enrich-errors' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'w17-38-enrich-errors' } })
      .returning();
    workspaceId = ws!.id;
    const [user] = await db
      .insert(core.users)
      .values({
        authProvider: 'github',
        authSubject: 'w17-38-user',
        forgeUserId: 'w17-38-user',
        login: 'w17-38-user',
      })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w17-38-user' } })
      .returning();
    const [conn] = await db
      .insert(core.forgeConnections)
      .values({
        workspaceId,
        provider: 'gitea',
        baseUrl: BASE,
        authKind: 'pat',
        credentialCiphertext: Buffer.from('x'),
        credentialIv: Buffer.from('iv-1234567890123'),
        keyVersion: 1,
        credentialFingerprint: 'w17-38-fp',
        status: 'active',
        createdBy: user!.id,
      })
      .returning();
    connectionId = conn!.id;
    const [identity] = await db
      .insert(core.identities)
      .values({ workspaceId, provider: 'gitea', forgeLogin: 'w17-38-dev', displayName: 'Dev' })
      .returning();
    identityId = identity!.id;
  });

  afterAll(async () => {
    await db.delete(facts.checkRuns).where(eq(facts.checkRuns.workspaceId, workspaceId));
    await db.delete(facts.prReviews).where(eq(facts.prReviews.workspaceId, workspaceId));
    await db.delete(facts.pullRequests).where(eq(facts.pullRequests.workspaceId, workspaceId));
    await db.delete(facts.commitFiles).where(eq(facts.commitFiles.workspaceId, workspaceId));
    await db.delete(facts.commits).where(eq(facts.commits.workspaceId, workspaceId));
    await db.delete(core.syncCursors).where(eq(core.syncCursors.workspaceId, workspaceId));
    await db.delete(core.repos).where(eq(core.repos.workspaceId, workspaceId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.workspaceId, workspaceId));
    await db.delete(core.identities).where(eq(core.identities.workspaceId, workspaceId));
    await db.delete(core.users).where(eq(core.users.forgeUserId, 'w17-38-user'));
    await db.delete(core.workspaces).where(eq(core.workspaces.id, workspaceId));
    await db.$client.end();
  });

  it('a 403 on reviews is recorded, check runs are still written, and the PR still drains', async () => {
    const repoId = await makeRepo('reviews-403');
    await makePr(repoId, 7, 'sha7');
    const provider = giteaOver({
      [REVIEWS('acme/reviews-403', 7)]: SCOPE_403,
      [STATUSES('acme/reviews-403', 'sha7')]: ONE_STATUS,
    });

    await enrichPullRequest(
      { db, provider },
      { workspaceId, repoId, repo: 'acme/reviews-403', prNumber: 7, headSha: 'sha7' },
    );

    // Behaviour: on the old code the 403 read as "zero reviews", last_error null.
    const lastError = await repoLastError(repoId);
    expect(lastError).toMatch(/reviews not ingested — HTTP 403/);
    expect(await cursorError(repoId, 'reviews')).toMatch(/403/);
    // The other fetch in the same job was not skipped.
    expect(await checkRunCount(repoId)).toBe(1);
    // And the PR is handled, so the repo can still reach live.
    expect(await isPrEnrichmentDrained(db, repoId)).toBe(true);
  });

  it('an enrichment error row does not flip the sync phase back to history', async () => {
    const repoId = await makeRepo('phase');
    await makePr(repoId, 1, 'shaP');
    for (const entity of PAGINATED_ENTITIES) {
      await writeCursor(db, { workspaceId, repoId }, entity, {
        cursorValue: null,
        backfillDone: true,
      });
    }
    await enrichPullRequest(
      {
        db,
        provider: giteaOver({
          [REVIEWS('acme/phase', 1)]: SCOPE_403,
          [STATUSES('acme/phase', 'shaP')]: SCOPE_403,
        }),
      },
      { workspaceId, repoId, repo: 'acme/phase', prNumber: 1, headSha: 'shaP' },
    );
    const status = await repoSyncStatus(db, repoId);
    expect(status?.phase).toBe('enrichment');
    expect(status?.entities.checks?.error).toMatch(/checks not ingested — HTTP 403/);
  });

  it('a 5xx on check runs fails the job and leaves the PR un-enriched for the retry', async () => {
    const repoId = await makeRepo('checks-502');
    await makePr(repoId, 3, 'sha3');
    const provider = giteaOver({
      [REVIEWS('acme/checks-502', 3)]: { status: 200, body: [] },
      [STATUSES('acme/checks-502', 'sha3')]: { status: 502, body: 'bad gateway' },
    });
    await expect(
      enrichPullRequest(
        { db, provider },
        { workspaceId, repoId, repo: 'acme/checks-502', prNumber: 3, headSha: 'sha3' },
      ),
    ).rejects.toMatchObject({ status: 502 });
    expect(await isPrEnrichmentDrained(db, repoId)).toBe(false);
  });

  it('clears the recorded refusal once the entity fetches successfully', async () => {
    const repoId = await makeRepo('recovers');
    await makePr(repoId, 1, 'shaA');
    await makePr(repoId, 2, 'shaB');
    await enrichPullRequest(
      {
        db,
        provider: giteaOver({
          [REVIEWS('acme/recovers', 1)]: SCOPE_403,
          [STATUSES('acme/recovers', 'shaA')]: ONE_STATUS,
        }),
      },
      { workspaceId, repoId, repo: 'acme/recovers', prNumber: 1, headSha: 'shaA' },
    );
    expect(await repoLastError(repoId)).toMatch(/reviews/);
    await enrichPullRequest(
      {
        db,
        provider: giteaOver({
          [REVIEWS('acme/recovers', 2)]: { status: 200, body: [] },
          [STATUSES('acme/recovers', 'shaB')]: ONE_STATUS,
        }),
      },
      { workspaceId, repoId, repo: 'acme/recovers', prNumber: 2, headSha: 'shaB' },
    );
    expect(await repoLastError(repoId)).toBeNull();
    expect(await cursorError(repoId, 'reviews')).toBeNull();
  });

  it('a 404 on a commit is recorded, not written as zero churn, and still drains', async () => {
    const repoId = await makeRepo('commit-404');
    await makeCommit(repoId, 'gone1');
    const provider = giteaOver({
      [COMMIT('acme/commit-404', 'gone1')]: { status: 404, body: { message: 'not found' } },
    });

    await enrichCommitChurn(
      { db, provider },
      { workspaceId, repoId, repo: 'acme/commit-404', sha: 'gone1' },
    );

    expect(await repoLastError(repoId)).toMatch(/commit_files not ingested — HTTP 404/);
    expect(await cursorError(repoId, 'commit_files')).toMatch(/404/);
    const [c] = await db
      .select({ statsSource: facts.commits.statsSource })
      .from(facts.commits)
      .where(and(eq(facts.commits.repoId, repoId), eq(facts.commits.sha, 'gone1')));
    // Not 'detail': nothing was measured, and a churn metric must not read it as zero.
    expect(c?.statsSource).not.toBe('detail');
    expect(await isEnrichmentDrained(db, repoId)).toBe(true);
  });

  it('a 5xx on a commit fails the job and leaves the commit pending', async () => {
    const repoId = await makeRepo('commit-503');
    await makeCommit(repoId, 'flaky1');
    const provider = giteaOver({
      [COMMIT('acme/commit-503', 'flaky1')]: { status: 503, body: 'unavailable' },
    });
    await expect(
      enrichCommitChurn(
        { db, provider },
        { workspaceId, repoId, repo: 'acme/commit-503', sha: 'flaky1' },
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(await isEnrichmentDrained(db, repoId)).toBe(false);
  });
});
