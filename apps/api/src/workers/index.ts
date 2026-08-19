import 'dotenv/config';
import { createDb, metricsRegistry } from '@repopulse/shared';
import { credentials } from '@repopulse/auth';
import { QUEUE, createQueue, publishSyncEvent } from '@repopulse/ingest';
import { createRedisConnection, type SyncStreamEvent } from '@repopulse/ingest';
import { createWorkerRuntime } from './runtime.js';
import type { SecretsStreamRequest } from './processors.js';
import {
  backfillProcessor,
  deltaProcessor,
  enrichProcessor,
  reconcileProcessor,
  snapshotProcessor,
} from './processors.js';
import { startWorkerHealthServer } from './health.js';
import { reportProcessor } from './report-processor.js';
import { plansVerifyProcessor } from './plans-processor.js';
import { scanProcessor } from './scan-processor.js';
import { runSecretsStreamScan, startSweeper } from '@repopulse/security';

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
  // A SECOND connection for pub/sub publishing. Publishing on the BullMQ
  // connection works today, but the runtime may put its own into subscriber
  // mode, and a connection in subscriber mode refuses ordinary commands — a
  // failure that would present as sync events silently stopping, which is
  // exactly the symptom this ticket exists to end.
  const publisher = createRedisConnection(redisUrl);

  const backfillQueue = createQueue(QUEUE.backfill, connection);
  const snapshotQueue = createQueue(QUEUE.snapshot, connection);
  const enrichQueue = createQueue(QUEUE.enrich, connection);
  const reconcileQueue = createQueue(QUEUE.reconcile, connection);
  const processorDeps = {
    db,
    tokenKey: credentials.loadTokenKey(),
    backfillQueue,
    snapshotQueue,
    enrichQueue,
    reconcileQueue,
    // W4-22: the missing half. publishSyncEvent was built, documented and
    // unit-tested, and had ZERO production callers — so GET /api/v1/events
    // relayed a channel nothing ever wrote to, and live sync had never worked.
    publish: (workspaceId: number, event: SyncStreamEvent) =>
      publishSyncEvent(publisher, workspaceId, event),
    // W8-04: the secrets scanner rides the webhook delta. Wired HERE, in the
    // one place that already owns "which side effects a delta has", so the
    // scanner never becomes another thing that exists and is never called.
    runSecretsStream: (req: SecretsStreamRequest) =>
      runSecretsStreamScan({
        db,
        provider: req.provider as Parameters<typeof runSecretsStreamScan>[0]['provider'],
        workspaceId: req.workspaceId,
        repoId: req.repoId,
        repo: req.repo,
        trigger: req.trigger,
      }),
    ...(process.env.FORGE_BASE_URL ? { forgeBaseUrl: process.env.FORGE_BASE_URL } : {}),
    // SC-12 escape hatch, off unless the operator sets it. Lets the e2e fake
    // forge (http://127.0.0.1:PORT) drive the real ingestion path; still
    // loopback-only and still allowlisted. See ValidateBaseUrlOptions.
    ...(process.env.FORGE_ALLOW_INSECURE_LOOPBACK === '1' ? { allowInsecureLoopback: true } : {}),
  };

  const runtime = createWorkerRuntime({
    db,
    connection,
    // Every queue that should have a consumer now has one (W12-03 wired
    // backfill/delta/snapshot, W12-05 enrich/reconcile). `dlq` is deliberately
    // absent: it is a SINK, fed by attachDeadLetter and read by the admin ops
    // page — giving it a processor would consume the failures it exists to
    // preserve. apps/api/test/wiring.test.ts asserts both halves of that.
    processors: {
      [QUEUE.backfill]: backfillProcessor(processorDeps),
      [QUEUE.delta]: deltaProcessor(processorDeps),
      [QUEUE.snapshot]: snapshotProcessor(processorDeps),
      [QUEUE.enrich]: enrichProcessor(processorDeps),
      [QUEUE.reconcile]: reconcileProcessor(processorDeps),
      // W5-04. Report generation runs in the WORKER, not the API: a headless
      // print holds a browser for seconds and must not occupy an API process
      // that is serving requests.
      // W5-06. Nightly, after metrics.snapshot writes the numbers it reads.
      [QUEUE.plansVerify]: plansVerifyProcessor({ db }),
      // W8-01. Own lane, own workers (NFR-15).
      [QUEUE.securityScan]: scanProcessor({ db }),
      [QUEUE.reports]: reportProcessor({
        db,
        dataDir: process.env.DATA_DIR ?? './.data',
        printBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:5173',
      }),
    },
    onError: (err) => console.error('[worker] DLQ/error:', err),
  });

  // The nightly sweep (INGESTION §6: reconcile is a cron, not an on-demand
  // queue). A registered processor with nothing feeding it is inert under a
  // different name — the exact defect this wave exists to close — so the
  // schedule ships with the consumer.
  //
  // A repeatable job carries its own dedupe key, so every worker replica
  // registering it on boot yields ONE schedule, not one per replica.
  //
  // RECONCILE_CRON=off disables it. That exists because a sweep is the one
  // piece of this worker that starts work NOBODY ASKED FOR, at a wall-clock
  // time: it re-lists five entities for every `live` repo. That is correct
  // nightly behaviour in production and pure interference anywhere a test
  // suite seeds `live` repos and expects a quiet worker — the e2e harness sets
  // it off for exactly that reason. An operator who wants to schedule
  // reconciliation externally gets the same switch.
  const reconcileCron = process.env.RECONCILE_CRON ?? '17 3 * * *';
  if (reconcileCron !== 'off') {
    await reconcileQueue.add(
      'sweep',
      {},
      { repeat: { pattern: reconcileCron }, jobId: 'reconcile-nightly-sweep' },
    );
  }
  console.log(
    `[worker] nightly reconcile: ${reconcileCron === 'off' ? 'disabled' : reconcileCron}`,
  );

  // Snapshot orphan sweep (W8-03, NFR-13). A scan brackets its own snapshot in
  // a `finally`, which covers returning and throwing and CANNOT cover SIGKILL —
  // so a killed worker leaves a customer's source on disk until something else
  // removes it. This is that something else, and it is wired here rather than
  // merely exported, because an unwired cleanup is the same defect as an
  // unwired processor: it exists, it is tested, and it never runs.
  const sweeper = startSweeper({
    ...(process.env.SNAPSHOT_ROOT ? { root: process.env.SNAPSHOT_ROOT } : {}),
  });
  const sweptOnBoot = await sweeper.ran;
  console.log(
    `[worker] snapshot sweep on boot: removed ${sweptOnBoot.removed.length}, in flight ${sweptOnBoot.keptInFlight}`,
  );

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
    sweeper.stop();
    healthServer.close();
    void connection.quit().catch(() => {});
    void publisher.quit().catch(() => {});
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
