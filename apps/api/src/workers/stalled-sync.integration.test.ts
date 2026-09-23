import 'dotenv/config';
import { Queue, Worker, type Job } from 'bullmq';
import { and, eq, ne } from 'drizzle-orm';
import { core, createDb, facts, type Database } from '@repopulse/shared';
import { credentials } from '@repopulse/auth';
import {
  attachDeadLetter,
  createRedisConnection,
  defaultJobOptions,
  jobId,
  PAGINATED_ENTITIES,
  QUEUE,
  writeCursor,
} from '@repopulse/ingest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  backfillProcessor,
  enrichProcessor,
  reconcileProcessor,
  type ProcessorDeps,
} from './processors.js';

// W17-41: a dead-lettered enrich/backfill job must not leave its repo in
// `backfilling` forever.
//
// Real BullMQ, in its own keyspace (the dlq.integration.test.ts pattern): the
// defect lives in BullMQ's jobId semantics — a re-add under the id of a failed
// or completed job is silently ignored — so a recording fake of queue.add would
// pass on the broken code for free.

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const describeIfLiveInfra = databaseUrl && redisUrl ? describe : describe.skip;

const TEST_PREFIX = 'repopulse-test-w17-41';
const KEY = Buffer.alloc(32, 41);
const SLUG = 'w17-41-stall';
const SHA = 'w17-41-poison-sha';
const REFUSAL = 'reviews not ingested — HTTP 403: Resource not accessible';

async function waitFor<T>(read: () => Promise<T>, done: (v: T) => boolean): Promise<T> {
  let value = await read();
  for (let i = 0; i < 100 && !done(value); i++) {
    await new Promise((r) => setTimeout(r, 100));
    value = await read();
  }
  return value;
}

describeIfLiveInfra('a dead-lettered sync job is visible and recoverable (W17-41)', () => {
  const db: Database = createDb(databaseUrl as string);
  const connection = createRedisConnection(redisUrl as string);
  const queue = (name: (typeof QUEUE)[keyof typeof QUEUE]) =>
    new Queue(name, {
      connection,
      prefix: TEST_PREFIX,
      defaultJobOptions: defaultJobOptions(name),
    });
  const enrichQueue = queue(QUEUE.enrich);
  const backfillQueue = queue(QUEUE.backfill);
  const snapshotQueue = queue(QUEUE.snapshot);
  const reconcileQueue = queue(QUEUE.reconcile);
  const dlqQueue = queue(QUEUE.dlq);
  let workspaceId = 0;
  let userId = 0;
  let connectionId = 0;
  let repoId = 0;
  let liveRepoId = 0;

  const repoRow = async (id: number) =>
    (
      await db
        .select({ syncStatus: core.repos.syncStatus, lastError: core.repos.lastError })
        .from(core.repos)
        .where(eq(core.repos.id, id))
    )[0]!;

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: SLUG, name: SLUG })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: SLUG } })
      .returning();
    workspaceId = ws!.id;
    const [user] = await db
      .insert(core.users)
      .values({ authProvider: 'github', authSubject: SLUG, forgeUserId: SLUG, login: SLUG })
      .onConflictDoUpdate({ target: core.users.forgeUserId, set: { login: SLUG } })
      .returning();
    userId = user!.id;
    const enc = credentials.encryptCredential('w17-41-token', KEY);
    const [conn] = await db
      .insert(core.forgeConnections)
      .values({
        workspaceId,
        provider: 'github',
        authKind: 'pat',
        credentialCiphertext: enc.ciphertext,
        credentialIv: enc.iv,
        keyVersion: enc.keyVersion,
        credentialFingerprint: enc.fingerprint,
        status: 'active',
        createdBy: userId,
      })
      .returning();
    connectionId = conn!.id;
    const makeRepo = async (name: string, syncStatus: string, lastError: string | null) => {
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
          lastError,
        })
        .returning();
      return repo!.id;
    };
    // History finished (every entity cursor done), one refusal recorded by
    // W17-38, and one commit still waiting for its churn — the job for that
    // commit is the one that will dead-letter.
    repoId = await makeRepo('stalled', 'backfilling', REFUSAL);
    liveRepoId = await makeRepo('already-live', 'live', null);
    for (const entity of PAGINATED_ENTITIES) {
      await writeCursor(db, { workspaceId, repoId }, entity, {
        cursorValue: null,
        backfillDone: true,
      });
    }
    const [identity] = await db
      .insert(core.identities)
      .values({ workspaceId, provider: 'github', forgeLogin: 'w17-41-dev', displayName: 'W17-41' })
      .returning();
    await db.insert(facts.commits).values({
      workspaceId,
      repoId,
      sha: SHA,
      authorIdentityId: identity!.id,
      committerIdentityId: identity!.id,
      authoredAt: new Date(),
      committedAt: new Date(),
      messageHead: 'poison',
      isRevertHeuristic: false,
    });
  });

  afterAll(async () => {
    for (const q of [enrichQueue, backfillQueue, snapshotQueue, reconcileQueue, dlqQueue]) {
      await q.obliterate({ force: true }).catch(() => {});
      await q.close();
    }
    await db.delete(core.jobFailure).where(eq(core.jobFailure.workspaceId, workspaceId));
    await db.delete(facts.commits).where(eq(facts.commits.workspaceId, workspaceId));
    await db.delete(core.identities).where(eq(core.identities.workspaceId, workspaceId));
    await db.delete(core.syncCursors).where(eq(core.syncCursors.workspaceId, workspaceId));
    await db.delete(core.repos).where(eq(core.repos.workspaceId, workspaceId));
    await db.delete(core.forgeConnections).where(eq(core.forgeConnections.id, connectionId));
    await db.delete(core.users).where(eq(core.users.id, userId));
    await db.delete(core.workspaces).where(eq(core.workspaces.id, workspaceId));
    await connection.quit();
    await db.$client.end();
  });

  it('an exhausted enrich job moves its repo to error with the cause, keeping earlier fragments', async () => {
    // The shape a 5xx that outlived the client's retries produces.
    const worker = new Worker(
      QUEUE.enrich,
      (): Promise<void> =>
        Promise.reject(new Error('HTTP 502 from GET /repos/acme/stalled/commits/sha')),
      { connection, prefix: TEST_PREFIX },
    );
    attachDeadLetter(worker, dlqQueue, db);
    // A live repo's job dead-lettering must not downgrade it.
    for (const [id, sha] of [
      [repoId, SHA],
      [liveRepoId, 'live-sha'],
    ] as const) {
      await enrichQueue.add(
        'commitFiles',
        { workspaceId, repoId: id, sha },
        { jobId: jobId.enrich(id, sha), attempts: 2, backoff: { type: 'fixed', delay: 50 } },
      );
    }

    const row = await waitFor(
      () => repoRow(repoId),
      (r) => r.syncStatus !== 'backfilling',
    );
    await waitFor(
      () => enrichQueue.getJobCounts('failed'),
      (c) => c.failed === 2,
    );
    await worker.close();

    expect(row.syncStatus, 'a sync that gave up must not read as still backfilling').toBe('error');
    expect(row.lastError).toContain('sync stalled');
    expect(row.lastError).toContain('HTTP 502');
    expect(row.lastError, 'the W17-38 refusal is not overwritten').toContain(REFUSAL);
    expect((await repoRow(liveRepoId)).syncStatus).toBe('live');
  }, 30_000);

  it('the nightly sweep re-plans it and the dead-lettered work is actually re-enqueued', async () => {
    const deps = {
      db,
      tokenKey: KEY,
      backfillQueue,
      snapshotQueue,
      enrichQueue,
      reconcileQueue,
    } as unknown as ProcessorDeps;

    // Independent of the first test: whatever marked the repo, recovery starts
    // from `error` with a stall fragment ahead of the refusal.
    await db
      .update(core.repos)
      .set({
        syncStatus: 'error',
        lastError: `sync stalled — enrich job commitFiles failed · ${REFUSAL}`,
      })
      .where(eq(core.repos.id, repoId));

    // The failed job still holds its id (removeOnFail: false).
    expect(await (await enrichQueue.getJob(jobId.enrich(repoId, SHA)))?.getState()).toBe('failed');

    await reconcileProcessor(deps)({ name: 'sweep', data: {} } as Job);
    const afterSweep = await repoRow(repoId);
    expect(afterSweep.syncStatus).toBe('pending_backfill');
    expect(afterSweep.lastError, 'the retried stall is cleared').not.toContain('sync stalled');
    expect(afterSweep.lastError, 'refusals survive the retry').toBe(REFUSAL);

    // Run the plan the sweep enqueued, as the backfill worker would.
    const plan = (await backfillQueue.getJobs(['waiting', 'prioritized'])).find(
      (j) => j.name === 'plan' && (j.data as { repoId: number }).repoId === repoId,
    );
    expect(plan, 'the sweep enqueued a plan for the stalled repo').toBeTruthy();
    await backfillProcessor(deps)(plan!);

    // History was already complete: the re-plan goes straight to enrichment
    // rather than re-walking five entities' history against the forge budget.
    const backfillJobs = await backfillQueue.getJobs(['waiting', 'prioritized', 'delayed']);
    expect(backfillJobs.filter((j) => j.name !== 'plan')).toHaveLength(0);

    const retried = await enrichQueue.getJob(jobId.enrich(repoId, SHA));
    expect(
      await retried?.getState(),
      'the dead-lettered commit is queued again, not absorbed by its failed job id',
    ).toMatch(/^(waiting|prioritized)$/);
    expect((await repoRow(repoId)).syncStatus).toBe('backfilling');
  }, 30_000);
  it('a repo with more than one fan-out batch of commits is not stranded after the first', async () => {
    const deps = {
      db,
      tokenKey: KEY,
      backfillQueue,
      snapshotQueue,
      enrichQueue,
      reconcileQueue,
    } as unknown as ProcessorDeps;
    const [repo] = await db
      .insert(core.repos)
      .values({
        workspaceId,
        connectionId,
        forgeRepoId: 'big',
        org: 'acme',
        name: 'big',
        defaultBranch: 'main',
        isPrivate: true,
        isArchived: false,
        syncStatus: 'pending_backfill',
        tier2Auto: false,
      })
      .returning();
    const bigId = repo!.id;
    for (const entity of PAGINATED_ENTITIES) {
      await writeCursor(db, { workspaceId, repoId: bigId }, entity, {
        cursorValue: null,
        backfillDone: true,
      });
    }
    const [identity] = await db
      .select({ id: core.identities.id })
      .from(core.identities)
      .where(eq(core.identities.workspaceId, workspaceId))
      .limit(1);
    const shas = Array.from({ length: 501 }, (_, i) => `big-${String(i).padStart(4, '0')}`);
    await db.insert(facts.commits).values(
      shas.map((sha, i) => ({
        workspaceId,
        repoId: bigId,
        sha,
        authorIdentityId: identity!.id,
        committerIdentityId: identity!.id,
        authoredAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
        committedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, i)),
        messageHead: sha,
        isRevertHeuristic: false,
      })),
    );

    await backfillProcessor(deps)({ name: 'plan', data: { workspaceId, repoId: bigId } } as Job);
    const last = shas[500]!;
    expect(await enrichQueue.getJob(jobId.enrich(bigId, shas[0]!))).toBeTruthy();
    expect(
      await enrichQueue.getJob(jobId.enrich(bigId, last)),
      'the 501st is beyond the first batch',
    ).toBeUndefined();

    // The first batch drains (as the enrich worker would leave it).
    await db
      .update(facts.commits)
      .set({ statsSource: 'detail' })
      .where(and(eq(facts.commits.repoId, bigId), ne(facts.commits.sha, last)));

    const continuation = (await enrichQueue.getJobs(['waiting', 'prioritized'])).find(
      (j) => j.name === 'fanOut' && (j.data as { repoId: number }).repoId === bigId,
    );
    expect(continuation, 'something must ask for the next batch').toBeTruthy();
    await enrichProcessor(deps)(continuation!);
    expect(await (await enrichQueue.getJob(jobId.enrich(bigId, last)))?.getState()).toMatch(
      /^(waiting|prioritized)$/,
    );
  }, 30_000);
  it('a fan-out round that handled nothing does not queue another (no endless loop)', async () => {
    // An enrich job can complete without handling its item — e.g. the repo's
    // connection was revoked, providerForRepo returns null and the job ends
    // "skipped". Replacing completed jobs then re-adds the same batch, which
    // is full again, which would queue another continuation forever.
    const deps = {
      db,
      tokenKey: KEY,
      backfillQueue,
      snapshotQueue,
      enrichQueue,
      reconcileQueue,
    } as unknown as ProcessorDeps;
    const [big] = await db
      .select({ id: core.repos.id })
      .from(core.repos)
      .where(eq(core.repos.forgeRepoId, 'big'));
    const bigId = big!.id;
    // Everything pending again: nothing was handled since the last round.
    await db
      .update(facts.commits)
      .set({ statsSource: null })
      .where(eq(facts.commits.repoId, bigId));
    await enrichQueue.obliterate({ force: true });

    const continuations = async () =>
      (await enrichQueue.getJobs(['waiting', 'prioritized'])).filter(
        (j) => j.name === 'fanOut' && (j.data as { repoId: number }).repoId === bigId,
      );
    await backfillProcessor(deps)({ name: 'plan', data: { workspaceId, repoId: bigId } } as Job);
    const [first] = await continuations();
    expect(first, 'a full batch asks for the next one').toBeTruthy();
    await first!.remove();

    await enrichProcessor(deps)(first!);
    expect(await continuations(), 'no progress since the last round: stop asking').toHaveLength(0);
  }, 30_000);
});
