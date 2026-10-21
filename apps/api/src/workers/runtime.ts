import type { Job, Processor, Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import { and, eq } from 'drizzle-orm';
import { core, type Database } from '@repopulse/shared';
import {
  attachDeadLetter,
  createQueue,
  createWorker,
  QUEUE,
  registerQueueMetrics,
  ShutdownCoordinator,
  type QueueName,
} from '@repopulse/ingest';

// Worker runtime (W2-02): builds the queue topology, starts a worker per queue
// that has a processor, wires each worker's exhausted-job path to the DLQ,
// registers the queue gauges, and hands back a ShutdownCoordinator with
// everything registered (workers close before queues). The actual entity
// processors are injected — W2-03 supplies the real ones; this ticket owns the
// harness (topology + DLQ + shutdown + metrics).

export interface WorkerRuntimeOptions {
  db: Database;
  connection: Redis;
  /** One processor per queue we run; queues without one are producer-only here. */
  processors: Partial<Record<QueueName, Processor>>;
  onError?: (err: unknown) => void;
}

export interface WorkerRuntime {
  queues: Map<QueueName, Queue>;
  workers: Worker[];
  dlqQueue: Queue;
  coordinator: ShutdownCoordinator;
}

const ALL_QUEUES: QueueName[] = [
  QUEUE.backfill,
  QUEUE.delta,
  QUEUE.enrich,
  QUEUE.reconcile,
  QUEUE.snapshot,
  QUEUE.dlq,
];

/** Postgres foreign_key_violation (23503), as thrown directly or wrapped by drizzle. */
export function isForeignKeyViolation(err: unknown): boolean {
  for (let e: unknown = err, depth = 0; e && typeof e === 'object' && depth < 4; depth++) {
    if ((e as { code?: unknown }).code === '23503') return true;
    e = (e as { cause?: unknown }).cause;
  }
  return false;
}

/** The (workspaceId, repoId) a job is about, when its payload carries both. */
export function repoOfJob(data: unknown): { workspaceId: number; repoId: number } | null {
  if (!data || typeof data !== 'object') return null;
  const { workspaceId, repoId } = data as { workspaceId?: unknown; repoId?: unknown };
  return typeof workspaceId === 'number' && typeof repoId === 'number'
    ? { workspaceId, repoId }
    : null;
}

/**
 * A job queued for a repository that was purged while it waited or ran
 * (W20-22; W20-19 noted it): its inserts fail on the repo foreign key, and it
 * used to retry into the dead-letter queue, where nothing could ever replay
 * it. It now ends quietly as skipped. Any other failure, or a foreign-key
 * failure for a repository that still exists, is thrown as before.
 */
export function skipRemovedRepoJobs(
  processor: Processor,
  repoExists: (workspaceId: number, repoId: number) => Promise<boolean>,
): Processor {
  return async (job: Job, token?: string, signal?: AbortSignal) => {
    try {
      return await processor(job, token, signal);
    } catch (err) {
      const target = repoOfJob(job.data);
      if (target && isForeignKeyViolation(err)) {
        if (!(await repoExists(target.workspaceId, target.repoId))) {
          return { skipped: 'repository was removed' };
        }
      }
      throw err;
    }
  };
}

function repoExistsIn(db: Database) {
  return async (workspaceId: number, repoId: number): Promise<boolean> => {
    const [row] = await db
      .select({ id: core.repos.id })
      .from(core.repos)
      .where(and(eq(core.repos.id, repoId), eq(core.repos.workspaceId, workspaceId)))
      .limit(1);
    return row !== undefined;
  };
}

export function createWorkerRuntime(opts: WorkerRuntimeOptions): WorkerRuntime {
  const coordinator = new ShutdownCoordinator();
  const queues = new Map<QueueName, Queue>();
  for (const name of ALL_QUEUES) {
    const q = createQueue(name, opts.connection);
    queues.set(name, q);
    coordinator.registerQueue(q);
  }
  const dlqQueue = queues.get(QUEUE.dlq)!;

  const workers: Worker[] = [];
  for (const [name, processor] of Object.entries(opts.processors) as [QueueName, Processor][]) {
    const worker = createWorker(
      name,
      skipRemovedRepoJobs(processor, repoExistsIn(opts.db)),
      opts.connection,
    );
    attachDeadLetter(worker, dlqQueue, opts.db, opts.onError);
    coordinator.registerWorker(worker);
    workers.push(worker);
  }

  registerQueueMetrics([...queues.values()]);
  return { queues, workers, dlqQueue, coordinator };
}
