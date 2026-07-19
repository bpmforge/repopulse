import 'dotenv/config';
import { createDb, metricsRegistry } from '@repopulse/shared';
import { createRedisConnection } from '@repopulse/ingest';
import { createWorkerRuntime } from './runtime.js';
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

  const runtime = createWorkerRuntime({
    db,
    connection,
    // Empty until W2-03 supplies the real entity processors.
    processors: {},
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
