import 'dotenv/config';
import { and, eq } from 'drizzle-orm';
import { core, createDb, type Database } from '@repopulse/shared';
import {
  ForgeHttpError,
  GiteaProvider,
  createAuthHeaderProvider,
  type ForgeHttpClient,
  type ForgeResponse,
} from '@repopulse/forge';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ingestEntityPages } from './backfill.js';
import { isHistoryBackfillComplete } from './completion.js';
import { repoSyncStatus } from '../status/status.js';
import { recordEnrichmentOutcome } from './entity-error.js';

// W17-35: a backfill entity whose fetch fails must say so (W14-01 acceptance:
// "no failure absorbed silently").
//
// Driven through the REAL GiteaProvider over a canned HTTP client, because the
// silence lived in the adapter: a 403 body is a JSON object, the list helper
// read "not an array" as zero items, and the entity checkpointed backfill_done.
// A fake ForgeProvider would have skipped exactly the code that was wrong.

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

const BASE = 'https://git.example.com';
const ISSUES = (repo: string) =>
  `${BASE}/api/v1/repos/${repo}/issues?state=all&type=issues&page=1&limit=50`;

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
    auth: createAuthHeaderProvider({ kind: 'pat', token: 'w17-35-test' }),
    baseUrl: BASE,
  });
}

const SCOPE_403 = {
  status: 403,
  body: { message: 'token does not have at least one of required scope(s): [read:issue]' },
};

describeIfLiveInfra('backfill entity fetch errors are recorded, not absorbed (W17-35)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId: number;
  let connectionId: number;

  async function makeRepo(name: string, lastError: string | null = null): Promise<number> {
    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId,
        forgeRepoId: `w17-35-${name}`,
        org: 'acme',
        name,
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'backfilling',
        tier2Auto: false,
        lastError,
      })
      .returning();
    return repo!.id;
  }

  async function repoLastError(repoId: number): Promise<string | null> {
    const [r] = await db
      .select({ lastError: core.repos.lastError })
      .from(core.repos)
      .where(eq(core.repos.id, repoId));
    return r?.lastError ?? null;
  }

  async function cursorRow(repoId: number, entity: string) {
    const [row] = await db
      .select({
        backfill_done: core.syncCursors.backfillDone,
        last_error: core.syncCursors.lastError,
      })
      .from(core.syncCursors)
      .where(and(eq(core.syncCursors.repoId, repoId), eq(core.syncCursors.entityType, entity)));
    return row;
  }

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'w17-35-entity-errors', name: 'w17-35-entity-errors' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'w17-35-entity-errors' } })
      .returning();
    workspaceId = ws!.id;
    const [user] = await db
      .insert(core.users)
      .values({
        authProvider: 'github',
        authSubject: 'w17-35-user',
        forgeUserId: 'w17-35-user',
        login: 'w17-35-user',
      })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w17-35-user' } })
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
        credentialFingerprint: 'w17-35-fp',
        status: 'active',
        createdBy: user!.id,
      })
      .returning();
    connectionId = conn!.id;
  });

  afterAll(async () => {
    await db.delete(core.syncCursors).where(eq(core.syncCursors.workspaceId, workspaceId));
    await db.delete(core.repos).where(eq(core.repos.workspaceId, workspaceId));
    await db
      .delete(core.forgeConnections)
      .where(eq(core.forgeConnections.workspaceId, workspaceId));
    await db.delete(core.users).where(eq(core.users.forgeUserId, 'w17-35-user'));
    await db.delete(core.workspaces).where(eq(core.workspaces.id, workspaceId));
    await db.$client.end();
  });

  it('a 403 on issues is recorded on the repo and the entity, and still finishes the entity', async () => {
    const repoId = await makeRepo('scoped');
    const provider = giteaOver({ [ISSUES('acme/scoped')]: SCOPE_403 });

    const result = await ingestEntityPages(
      { db, provider },
      { workspaceId, repoId, repo: 'acme/scoped', entityType: 'issues' },
    );

    // Behaviour first: on the old code this resolved done with last_error null.
    const lastError = await repoLastError(repoId);
    expect(lastError).toMatch(/issues/);
    expect(lastError).toMatch(/403/);
    expect(lastError).toContain('read:issue');

    // Finished, so the other four entities can still complete the repo.
    expect(result).toMatchObject({ done: true, pages: 0, itemsTotal: 0 });
    expect(result.failed).toMatchObject({ status: 403 });
    const cursor = await cursorRow(repoId, 'issues');
    expect(cursor?.backfill_done).toBe(true);
    expect(cursor?.last_error).toMatch(/403/);

    // And the sync status the admin screen reads carries it per entity.
    const status = await repoSyncStatus(db, repoId);
    expect(status?.entities.issues).toMatchObject({ done: true, error: cursor?.last_error });
    expect(status?.lastError?.message).toBe(lastError);
  });

  it('keeps an earlier repo error (the webhook one) rather than overwriting it', async () => {
    const webhook = 'live updates unavailable — webhook registration failed: 403';
    const repoId = await makeRepo('both', webhook);
    const provider = giteaOver({ [ISSUES('acme/both')]: SCOPE_403 });
    await ingestEntityPages(
      { db, provider },
      { workspaceId, repoId, repo: 'acme/both', entityType: 'issues' },
    );
    // A second sweep of the same failure must not stack a duplicate.
    await ingestEntityPages(
      { db, provider },
      { workspaceId, repoId, repo: 'acme/both', entityType: 'issues' },
    );
    const lastError = (await repoLastError(repoId)) ?? '';
    expect(lastError).toContain(webhook);
    expect(lastError.match(/issues not ingested/g)).toHaveLength(1);
  });

  it('clears the entity error once the same entity fetches successfully (token fixed)', async () => {
    const webhook = 'live updates unavailable — webhook registration failed: 403';
    const repoId = await makeRepo('fixed', webhook);
    await ingestEntityPages(
      { db, provider: giteaOver({ [ISSUES('acme/fixed')]: SCOPE_403 }) },
      { workspaceId, repoId, repo: 'acme/fixed', entityType: 'issues' },
    );
    await ingestEntityPages(
      {
        db,
        provider: giteaOver({
          [ISSUES('acme/fixed')]: { status: 200, body: [], headers: { 'x-total-count': '0' } },
        }),
      },
      { workspaceId, repoId, repo: 'acme/fixed', entityType: 'issues' },
    );
    expect(await repoLastError(repoId)).toBe(webhook);
    expect((await cursorRow(repoId, 'issues'))?.last_error).toBeNull();
  });

  it('a 5xx that outlived the client retries fails the job and checkpoints nothing', async () => {
    const repoId = await makeRepo('flaky');
    const provider = giteaOver({ [ISSUES('acme/flaky')]: { status: 502, body: 'bad gateway' } });
    await expect(
      ingestEntityPages(
        { db, provider },
        { workspaceId, repoId, repo: 'acme/flaky', entityType: 'issues' },
      ),
    ).rejects.toMatchObject({ status: 502 });
    expect(await cursorRow(repoId, 'issues')).toBeUndefined();
    expect(await isHistoryBackfillComplete(db, repoId)).toBe(false);
  });
  it('two enrich jobs of one repo recording a refusal do not deadlock (W21-01)', async () => {
    // Each PR enrichment transaction inserts child rows of the repo first (its
    // reviews and check runs), and every such foreign key holds a KEY SHARE
    // lock on the repo row. recordEnrichmentOutcome then locked that row FOR
    // UPDATE, which conflicts with KEY SHARE: two jobs at once each waited on
    // the other, and the e2e ingest spec's repo stayed backfilling while one
    // job sat out its retry backoff.
    const repoId = await makeRepo('two-jobs');
    const scope = { workspaceId, repoId };
    const refused = new ForgeHttpError(404, 'review_comments', 'not found');
    let arrived = 0;
    let release!: () => void;
    const bothHoldKeyShare = new Promise<void>((r) => (release = r));
    const job = (entity: 'commits' | 'prs') =>
      db.transaction(async (tx) => {
        await tx
          .insert(core.syncCursors)
          .values({ workspaceId, repoId, entityType: entity, backfillDone: true });
        arrived += 1;
        if (arrived === 2) release();
        await bothHoldKeyShare;
        await recordEnrichmentOutcome(tx, scope, 'review_comments', refused);
      });

    await expect(Promise.all([job('commits'), job('prs')])).resolves.toBeDefined();
    expect((await cursorRow(repoId, 'review_comments'))?.last_error).toMatch(/404/);
    expect(await repoLastError(repoId)).toMatch(/review_comments/);
  });
});
