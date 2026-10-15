import { Queue, Worker, type Processor, type WorkerOptions } from 'bullmq';
import { Redis } from 'ioredis';
import { redactQueryError } from '@repopulse/shared';
import { defaultJobOptions, type QueueName } from './topology.js';

// BullMQ connection + queue/worker construction. One place applies the topology
// defaults (retry/priority) and the BullMQ-mandated ioredis setting.

// BullMQ requires maxRetriesPerRequest:null on the connection its blocking
// commands use (documented requirement, verified against bullmq 5.x). ioredis
// is the mandated client (TECH_STACK) — shared with the session store.
export function createRedisConnection(url: string): Redis {
  return new Redis(url, { maxRetriesPerRequest: null });
}

export function createQueue(name: QueueName, connection: Redis): Queue {
  return new Queue(name, { connection, defaultJobOptions: defaultJobOptions(name) });
}

export function createWorker<T>(
  name: QueueName,
  processor: Processor<T>,
  connection: Redis,
  opts: Partial<WorkerOptions> = {},
): Worker<T> {
  // Concurrency is deliberately generous: the BudgetedClient's semaphore
  // (FORGE_PROVIDER §3) is the real limiter, not the worker pool (INGESTION §6).
  return new Worker<T>(name, redactingProcessor(processor), {
    connection,
    concurrency: 10,
    ...opts,
  });
}

/**
 * Everything a processor throws reaches places that outlive the job: BullMQ
 * writes `failedReason` and the stack into Redis, and the `failed` listeners
 * copy the error into job_failure, the DLQ and repos.last_error. A drizzle
 * query failure's message and stack carry the statement's bound values, so it
 * is swapped for its redacted form at this one exit. Every other error is
 * rethrown as the same object (BullMQ's UnrecoverableError must stay one).
 */
export function redactingProcessor<T>(processor: Processor<T>): Processor<T> {
  return async (job, token, signal) => {
    try {
      return await processor(job, token, signal);
    } catch (err) {
      throw redactQueryError(err);
    }
  };
}
