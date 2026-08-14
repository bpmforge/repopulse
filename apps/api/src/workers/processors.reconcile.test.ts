import 'dotenv/config';
import type { Job, Queue } from 'bullmq';
import { eq } from 'drizzle-orm';
import { core, createDb, type Database } from '@repopulse/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { reconcileProcessor, type ProcessorDeps } from './processors.js';

const databaseUrl = process.env.DATABASE_URL;
const describeIfLiveInfra = databaseUrl ? describe : describe.skip;

// The nightly reconcile SWEEP (W12-05).
//
// requeueErrorRepos was implemented in W2 with integration tests and no caller;
// this covers the orchestration that finally calls it, because "registered a
// processor" is not the same as "the processor does the right thing" — and a
// sweep that silently swept nothing would look identical to a healthy one.

interface AddedJob {
  name: string;
  data: unknown;
  opts: { jobId?: string } | undefined;
}

function recordingQueue(): Queue & { added: AddedJob[] } {
  const added: AddedJob[] = [];
  return {
    added,
    add: (name: string, data: unknown, opts?: { jobId?: string }) => {
      added.push({ name, data, opts });
      return Promise.resolve({} as Job);
    },
  } as unknown as Queue & { added: AddedJob[] };
}

describeIfLiveInfra('reconcile sweep (W12-05)', () => {
  const db: Database = createDb(databaseUrl as string);
  let workspaceId: number;
  let connectionId: number;
  let erroredRepoId: number;
  let liveRepoId: number;
  let backfillingRepoId: number;

  async function makeRepo(name: string, syncStatus: string): Promise<number> {
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
        syncStatus,
        tier2Auto: false,
      })
      .returning();
    return repo!.id;
  }

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'w12-05-reconcile', name: 'w12-05-reconcile' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'w12-05-reconcile' } })
      .returning();
    workspaceId = ws!.id;
    const [user] = await db
      .insert(core.users)
      .values({ forgeUserId: 'w12-05-rc-user', login: 'w12-05-rc-user' })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: 'w12-05-rc-user' } })
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
        credentialFingerprint: 'w12-05-rc-fp',
        status: 'active',
        createdBy: user!.id,
      })
      .returning();
    connectionId = conn!.id;
    erroredRepoId = await makeRepo('rc-errored', 'error');
    liveRepoId = await makeRepo('rc-live', 'live');
    backfillingRepoId = await makeRepo('rc-backfilling', 'backfilling');
  });

  afterAll(async () => {
    await db.delete(core.repos).where(eq(core.repos.workspaceId, workspaceId));
    await db.delete(core.forgeConnections).where(eq(core.forgeConnections.id, connectionId));
    await db.delete(core.users).where(eq(core.users.forgeUserId, 'w12-05-rc-user'));
    await db.delete(core.workspaces).where(eq(core.workspaces.id, workspaceId));
    await db.$client.end();
  });

  it('rescues errored repos and sweeps live ones, leaving in-flight repos alone', async () => {
    const backfillQueue = recordingQueue();
    const reconcileQueue = recordingQueue();
    const deps = {
      db,
      tokenKey: Buffer.alloc(32),
      backfillQueue,
      snapshotQueue: recordingQueue(),
      enrichQueue: recordingQueue(),
      reconcileQueue,
    } as unknown as ProcessorDeps;

    const result = (await reconcileProcessor(deps)({ name: 'sweep', data: {} } as Job)) as {
      requeued: number;
      swept: number;
    };

    // The errored repo is back in the queue with a fresh plan (INGESTION §5).
    const [errored] = await db
      .select({ syncStatus: core.repos.syncStatus })
      .from(core.repos)
      .where(eq(core.repos.id, erroredRepoId));
    expect(errored!.syncStatus).toBe('pending_backfill');
    expect(
      backfillQueue.added.some(
        (j) => j.name === 'plan' && (j.data as { repoId: number }).repoId === erroredRepoId,
      ),
      'an errored repo must be re-planned, or it stays stuck forever',
    ).toBe(true);

    // Live repos get a per-repo sweep, keyed by the §6 idempotency key so two
    // sweeps in one day collapse instead of double-fetching every entity.
    const sweptIds = reconcileQueue.added.map((j) => (j.data as { repoId: number }).repoId);
    expect(sweptIds).toContain(liveRepoId);
    // Located by repo, not by position: the sweep spans every workspace (it is
    // a global nightly cron), so seeded repos legitimately appear alongside
    // this fixture's and an index-based assertion picks an arbitrary one.
    const mine = reconcileQueue.added.find(
      (j) => (j.data as { repoId: number }).repoId === liveRepoId,
    );
    expect(mine?.opts?.jobId).toMatch(new RegExp(`^rc-${liveRepoId}-\\d{8}$`));

    // A repo still backfilling is NOT swept: reconciliation repairs gaps in
    // data that is supposed to be complete, and racing an in-flight backfill
    // would fight its cursors.
    expect(sweptIds).not.toContain(backfillingRepoId);

    expect(result.requeued).toBeGreaterThanOrEqual(1);
    expect(result.swept).toBeGreaterThanOrEqual(1);
  });
});
