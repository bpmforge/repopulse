import 'dotenv/config';
import { createDb, metricsRegistry } from '@repopulse/shared';
import { credentials } from '@repopulse/auth';
import { QUEUE, createQueue } from '@repopulse/ingest';
import { createRedisConnection } from '@repopulse/ingest';
import { createWorkerRuntime } from './runtime.js';
import { backfillProcessor, deltaProcessor, snapshotProcessor } from './processors.js';
import { startWorkerHealthServer } from './health.js';

export { createWorkerRuntime, type WorkerRuntime } from './runtime.js';
export { checkWorkerHealth, startWorkerHealthServer } from './health.js';

// BullMQ worker entrypoint (TECH_STACK: apps/api/src/workers, separate process).
// W2-02 stands up the harness — topology, DLQ, graceful shutdown, metrics,
// /healthz. The entity processors that actually pull GitHub data are wired in
// by W2-03; until then this runs producer-side queues + the DLQ + liveness.
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!databaseUrl || !redisUrl) throw new Error('DATABASE_URL and REDIS_URL are required');

  const db = createDb(databaseUrl);
  const connection = createRedisConnection(redisUrl);
  const healthRedis = createRedisConnection(redisUrl);

  // Producer handles for continuations and the metrics hand-off. Separate from
  // the runtime's consumer workers: a processor re-enqueueing onto its own queue
  // needs a Queue, not the Worker.
  const backfillQueue = createQueue(QUEUE.backfill, connection);
  const snapshotQueue = createQueue(QUEUE.snapshot, connection);
  const processorDeps = {
    db,
    tokenKey: credentials.loadTokenKey(),
    backfillQueue,
    snapshotQueue,
    ...(process.env.FORGE_BASE_URL ? { forgeBaseUrl: process.env.FORGE_BASE_URL } : {}),
    // SC-12 escape hatch, off unless the operator sets it. Lets the e2e fake
    // forge (http://127.0.0.1:PORT) drive the real ingestion path; still
    // loopback-only and still allowlisted. See ValidateBaseUrlOptions.
    ...(process.env.FORGE_ALLOW_INSECURE_LOOPBACK === '1' ? { allowInsecureLoopback: true } : {}),
  };

  const runtime = createWorkerRuntime({
    db,
    connection,
    // W12-03: these were built and unit-tested in W2/W3 and never registered,
    // so the worker consumed nothing and the warehouse was only ever populated
    // by the seeder. enrich and reconcile remain unwired — see the KNOWN_INERT
    // list in apps/api/test/wiring.test.ts, which fails if that list grows.
    processors: {
      [QUEUE.backfill]: backfillProcessor(processorDeps),
      [QUEUE.delta]: deltaProcessor(processorDeps),
      [QUEUE.snapshot]: snapshotProcessor(processorDeps),
    },
    onError: (err) => console.error('[worker] DLQ/error:', err),
  });

  const healthPort = Number(process.env.WORKER_HEALTH_PORT ?? 3001);
  const healthServer = startWorkerHealthServer({
    db,
    redis: healthRedis,
    registry: metricsRegistry,
    port: healthPort,
  });

  runtime.coordinator.installSignalHandlers({
    onTimeout: () =>
      console.warn('[worker] drain timed out — forcing close, jobs resume from cursor'),
  });
  process.once('SIGTERM', () => {
    healthServer.close();
    void connection.quit().catch(() => {});
    void healthRedis.quit().catch(() => {});
  });

  console.log(`[worker] runtime up; healthz on :${healthPort}`);
}

// Only run when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    console.error('[worker] fatal:', err);
    process.exit(1);
  });
}
