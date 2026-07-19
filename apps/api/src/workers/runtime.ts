import type { Processor, Queue, Worker } from 'bullmq';
import type { Redis } from 'ioredis';
import type { Database } from '@repopulse/shared';
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
    const worker = createWorker(name, processor, opts.connection);
    attachDeadLetter(worker, dlqQueue, opts.db, opts.onError);
    coordinator.registerWorker(worker);
    workers.push(worker);
  }

  registerQueueMetrics([...queues.values()]);
  return { queues, workers, dlqQueue, coordinator };
}
