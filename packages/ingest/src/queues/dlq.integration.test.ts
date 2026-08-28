import 'dotenv/config';
import { Queue, Worker } from 'bullmq';
import { and, eq } from 'drizzle-orm';
import { core, createDb, type Database } from '@repopulse/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRedisConnection } from './factory.js';
import { attachDeadLetter } from './dlq.js';
import { QUEUE } from './topology.js';

const databaseUrl = process.env.DATABASE_URL;
const redisUrl = process.env.REDIS_URL;
const describeIfLiveInfra = databaseUrl && redisUrl ? describe : describe.skip;

const POISON_QUEUE = QUEUE.enrich; // a real queue NAME — see the prefix below
const JOB_ID = 'en-99999-poisontest'; // BullMQ forbids ':' in custom ids

/**
 * ITS OWN KEYSPACE (W16-17).
 *
 * This ran on the shared dev Redis under BullMQ's default `bull` prefix, on
 * the real `enrich` queue name. Two consequences, both seen:
 *
 *   a `pnpm dev` worker running alongside CONSUMED the poison message before
 *   this suite could assert on it, so the test failed for anyone with the app
 *   running — which is most people, most of the time
 *
 *   the afterAll `obliterate` wiped the developer's actual enrich queue, which
 *   is a test destroying work outside itself
 *
 * A prefix is the whole fix: BullMQ namespaces every key by it, so a dev
 * worker on `bull:` cannot see these jobs and this suite cannot touch theirs.
 * The queue NAME is left real so the topology under test is the shipped one.
 */
const TEST_PREFIX = 'repopulse-test';

// Proves the NFR-11 acceptance: a poison message that exhausts its attempts
// lands in the DLQ + a job_failure row, and never blocks the queue.
describeIfLiveInfra('DLQ poison-message (W2-02, NFR-11)', () => {
  const db: Database = createDb(databaseUrl as string);
  const connection = createRedisConnection(redisUrl as string);
  let workspaceId: number;
  let poisonQueue: Queue;
  let dlqQueue: Queue;
  let worker: Worker;

  beforeAll(async () => {
    const [ws] = await db
      .insert(core.workspaces)
      .values({ slug: 'w2-02-dlq-test', name: 'w2-02-dlq-test' })
      .onConflictDoUpdate({ target: core.workspaces.slug, set: { name: 'w2-02-dlq-test' } })
      .returning();
    if (!ws) throw new Error('workspace upsert failed');
    workspaceId = ws.id;

    poisonQueue = new Queue(POISON_QUEUE, { connection, prefix: TEST_PREFIX });
    dlqQueue = new Queue(QUEUE.dlq, { connection, prefix: TEST_PREFIX });
    // A processor that always throws — the poison.
    worker = new Worker(POISON_QUEUE, () => Promise.reject(new Error('poison')), {
      connection,
      prefix: TEST_PREFIX,
    });
    attachDeadLetter(worker, dlqQueue, db);
  });

  afterAll(async () => {
    await worker.close();
    await poisonQueue.obliterate({ force: true }).catch(() => {});
    await dlqQueue.obliterate({ force: true }).catch(() => {});
    await db.delete(core.jobFailure).where(eq(core.jobFailure.workspaceId, workspaceId));
    await db.delete(core.workspaces).where(eq(core.workspaces.id, workspaceId));
    await connection.quit();
    await db.$client.end();
  });

  it('exhausts attempts, then writes a job_failure row + a DLQ job', async () => {
    await poisonQueue.add(
      'poison',
      { repoId: 99999, workspaceId },
      { jobId: JOB_ID, attempts: 2, backoff: { type: 'fixed', delay: 50 } },
    );

    // The worker retries with backoff then dead-letters: insert job_failure
    // THEN add to the DLQ queue. Poll for the DLQ job (the last step — once
    // present, both writes are done).
    let dlqTotal = 0;
    for (let i = 0; i < 100; i++) {
      const counts = await dlqQueue.getJobCounts(
        'waiting',
        'active',
        'completed',
        'failed',
        'delayed',
      );
      dlqTotal = Object.values(counts).reduce((a, b) => a + b, 0);
      if (dlqTotal > 0) break;
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(dlqTotal, 'poison payload parked in the DLQ').toBeGreaterThan(0);

    const rows = await db
      .select()
      .from(core.jobFailure)
      .where(and(eq(core.jobFailure.workspaceId, workspaceId), eq(core.jobFailure.jobId, JOB_ID)))
      .limit(1);
    expect(rows[0], 'job_failure ledger row for the exhausted poison job').toBeTruthy();
    expect(rows[0]?.jobId).toBe(JOB_ID);
  }, 15_000);
});
