import 'dotenv/config';
import { eq } from 'drizzle-orm';
import { core, createDb, type Database } from '@repopulse/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isHistoryBackfillComplete } from './completion.js';
import { writeCursor } from './cursor.js';
import { PAGINATED_ENTITIES } from './backfill.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

// The reader for sync_cursors.backfill_done (W12-03). The column was written
// correctly from the start and consulted by nothing, which is why no repo ever
// left pending_backfill.

describeIfLiveInfra('isHistoryBackfillComplete (W12-03)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId: number;
  let connectionId: number;

  async function makeRepo(name: string): Promise<number> {
    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId,
        forgeRepoId: name,
        org: 'acme',
        name,
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'backfilling',
        tier2Auto: false,
      })
      .returning();
    if (!repo) throw new Error('repo insert failed');
    return repo.id;
  }

  const mark = (repoId: number, entity: string, done: boolean) =>
    writeCursor(db, { workspaceId, repoId }, entity, { cursorValue: null, backfillDone: done });

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'w12-03-completion', name: 'w12-03-completion' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'w12-03-completion' } })
      .returning();
    workspaceId = ws!.id;
    const [user] = await db
      .insert(core.users)
      .values({
        authProvider: 'github',
        authSubject: 'w12-03-user',
        forgeUserId: 'w12-03-user',
        login: 'w12-03-user',
      })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w12-03-user' } })
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
        credentialFingerprint: 'w12-03-fp',
        status: 'active',
        createdBy: user!.id,
      })
      .returning();
    connectionId = conn!.id;
  });

  afterAll(async () => {
    await db.delete(core.syncCursors).where(eq(core.syncCursors.workspaceId, workspaceId));
    await db.delete(core.repos).where(eq(core.repos.workspaceId, workspaceId));
    await db.delete(core.forgeConnections).where(eq(core.forgeConnections.id, connectionId));
    await db.delete(core.users).where(eq(core.users.forgeUserId, 'w12-03-user'));
    await db.delete(core.workspaces).where(eq(core.workspaces.id, workspaceId));
    await db.$client.end();
  });

  it('is false for a repo with no cursor rows at all', async () => {
    const repoId = await makeRepo('c-none');
    expect(await isHistoryBackfillComplete(db, repoId)).toBe(false);
  });

  it('is false mid-fan-out, when only some entities have finished', async () => {
    const repoId = await makeRepo('c-partial');
    await mark(repoId, 'commits', true);
    await mark(repoId, 'prs', true);
    expect(await isHistoryBackfillComplete(db, repoId)).toBe(false);
  });

  it('is false when an entity is present but still running', async () => {
    const repoId = await makeRepo('c-running');
    for (const e of PAGINATED_ENTITIES) await mark(repoId, e, true);
    await mark(repoId, 'issues', false); // re-opened by a continuation
    expect(await isHistoryBackfillComplete(db, repoId)).toBe(false);
  });

  it('is true once every paginated entity is done', async () => {
    const repoId = await makeRepo('c-done');
    for (const e of PAGINATED_ENTITIES) await mark(repoId, e, true);
    expect(await isHistoryBackfillComplete(db, repoId)).toBe(true);
  });

  it('ignores enrichment-phase cursors — an unfinished `checks` must not block it', async () => {
    // The regression this scoping exists to prevent: when the enrich processor
    // lands it will write reviews/pr_files/checks cursors, and a completion
    // check over ALL cursors would silently stop firing.
    const repoId = await makeRepo('c-enrich');
    for (const e of PAGINATED_ENTITIES) await mark(repoId, e, true);
    await mark(repoId, 'checks', false);
    await mark(repoId, 'reviews', false);
    expect(await isHistoryBackfillComplete(db, repoId)).toBe(true);
  });

  it('scopes to the repo — a sibling repo finishing does not complete this one', async () => {
    const mine = await makeRepo('c-mine');
    const other = await makeRepo('c-other');
    for (const e of PAGINATED_ENTITIES) await mark(other, e, true);
    await mark(mine, 'commits', true);
    expect(await isHistoryBackfillComplete(db, mine)).toBe(false);
    expect(await isHistoryBackfillComplete(db, other)).toBe(true);
  });
});
