import { Queue, Worker, type Processor, type WorkerOptions } from 'bullmq';
import { Redis } from 'ioredis';
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
  return new Worker<T>(name, processor, { connection, concurrency: 10, ...opts });
}
