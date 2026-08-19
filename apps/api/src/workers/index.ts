import 'dotenv/config';
import { and, desc, eq } from 'drizzle-orm';
import { core, createDb, facts, metricsRegistry } from '@repopulse/shared';
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
import { providerForRepo } from './forge-provider.js';
import {
  runChainer,
  runCodeHealthScan,
  runSecretsHistoryScan,
  runSecretsStreamScan,
  runSemgrepFull,
  startSweeper,
} from '@repopulse/security';

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
  const securityScanQueue = createQueue(QUEUE.securityScan, connection);
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
      [QUEUE.securityScan]: scanProcessor({
        db,
        // W8-05: history mode, by scanner key. A map rather than a switch, so
        // FR-SEC-1's "the framework never branches on a scanner key" stays true.
        historyRunners: {
          secrets: async ({ workspaceId, repoId }) => {
            const resolved = await providerForRepo(
              { db, tokenKey: credentials.loadTokenKey() },
              workspaceId,
              repoId,
            );
            // No active connection: nothing to fetch patches with. Reported as
            // zero work, not as a failure — the repo simply is not connected.
            if (!resolved) return { scanned: 0, findingsCreated: 0, deferred: 0, skipped: 'no_connection' };
            return runSecretsHistoryScan({
              db,
              provider: resolved.provider,
              workspaceId,
              repoId,
              repo: resolved.repoFullName,
            });
          },
        },
        // W8-07 + W8-09 share ONE weekly pass, wired once. A semgrep full run
        // and a chain recompute are the same shape of work — per repo, on a
        // schedule, no user waiting — and two crons doing it would drift.
        weeklyRunners: {
          semgrep: async ({ workspaceId, repoId }) => {
            const resolved = await providerForRepo(
              { db, tokenKey: credentials.loadTokenKey() },
              workspaceId,
              repoId,
            );
            if (!resolved) {
              return { scanned: 0, findingsCreated: 0, deferred: 0, skipped: 'no_connection' };
            }
            // The newest commit we have ingested, which is the only head SHA
            // this side of the product actually knows: repos carries pushed_at
            // but not the sha it belongs to.
            const [head] = await db
              .select({ sha: facts.commits.sha })
              .from(facts.commits)
              .where(eq(facts.commits.repoId, repoId))
              .orderBy(desc(facts.commits.committedAt))
              .limit(1);
            const sha = head?.sha;
            // No known head SHA means no pinned commit to scan. Reported as
            // skipped rather than scanning "whatever is current", which would
            // produce findings nobody can reproduce.
            if (!sha) {
              return { scanned: 0, findingsCreated: 0, deferred: 0, skipped: 'no_head_sha' };
            }
            const result = await runSemgrepFull({
              db,
              provider: resolved.provider,
              workspaceId,
              repoId,
              repo: resolved.repoFullName,
              commitSha: sha,
            });
            return {
              scanned: result.status === 'succeeded' ? 1 : 0,
              findingsCreated: result.findingsCreated,
              deferred: 0,
              ...(result.error ? { skipped: result.error } : {}),
            };
          },
          // W9-02. Same weekly slot as semgrep: both want a snapshot of the
          // same commit, and complexity is a property of a codebase rather
          // than of a change — a per-PR run would report the same findings on
          // every branch until people filtered the scanner out of their view.
          code_health_tools: async ({ workspaceId, repoId }) => {
            const resolved = await providerForRepo(
              { db, tokenKey: credentials.loadTokenKey() },
              workspaceId,
              repoId,
            );
            if (!resolved) {
              return { scanned: 0, findingsCreated: 0, deferred: 0, skipped: 'no_connection' };
            }
            const [head] = await db
              .select({ sha: facts.commits.sha })
              .from(facts.commits)
              .where(eq(facts.commits.repoId, repoId))
              .orderBy(desc(facts.commits.committedAt))
              .limit(1);
            if (!head?.sha) {
              return { scanned: 0, findingsCreated: 0, deferred: 0, skipped: 'no_head_sha' };
            }
            const result = await runCodeHealthScan({
              db,
              provider: resolved.provider,
              workspaceId,
              repoId,
              repo: resolved.repoFullName,
              commitSha: head.sha,
            });
            return {
              scanned: result.status === 'succeeded' ? 1 : 0,
              findingsCreated: result.findingsCreated,
              deferred: 0,
              ...(result.error ? { skipped: result.error } : {}),
            };
          },
          attack_chainer: async ({ workspaceId, repoId }) => {
            // Runs whether or not the repo has a connection: it reads findings
            // we already have and calls no forge at all.
            const result = await runChainer({ db, workspaceId, repoId, trigger: 'schedule' });
            return {
              scanned: result.chains + result.compound,
              findingsCreated: result.created,
              deferred: 0,
              ...(result.error ? { skipped: result.error } : {}),
            };
          },
        },
        weeklySweep: async (scannerKey) => {
          const workspaces = await db.select({ id: core.workspaces.id }).from(core.workspaces);
          const week = `${new Date().getUTCFullYear()}w${Math.ceil(new Date().getUTCDate() / 7)}`;
          let enqueued = 0;
          for (const ws of workspaces) {
            const live = await db
              .select({ id: core.repos.id })
              .from(core.repos)
              .where(and(eq(core.repos.workspaceId, ws.id), eq(core.repos.syncStatus, 'live')));
            for (const repo of live) {
              await securityScanQueue.add(
                'weekly',
                {
                  workspaceId: ws.id,
                  repoId: repo.id,
                  scannerKey,
                  commitSha: '',
                  trigger: 'schedule' as const,
                  mode: 'weekly' as const,
                },
                { jobId: `sec-weekly-${scannerKey}-${repo.id}-${week}` },
              );
              enqueued += 1;
            }
          }
          return { enqueued };
        },
        historySweep: async (scannerKey) => {
          // Same shape as the nightly reconcile fan-out: list what is live,
          // enqueue one job each, and let the per-repo job own its own caps.
          const workspaces = await db.select({ id: core.workspaces.id }).from(core.workspaces);
          const month = new Date().toISOString().slice(0, 7);
          let enqueued = 0;
          for (const ws of workspaces) {
            const live = await db
              .select({ id: core.repos.id })
              .from(core.repos)
              .where(and(eq(core.repos.workspaceId, ws.id), eq(core.repos.syncStatus, 'live')));
            for (const repo of live) {
              await securityScanQueue.add(
                'history',
                {
                  workspaceId: ws.id,
                  repoId: repo.id,
                  scannerKey,
                  commitSha: '',
                  trigger: 'schedule' as const,
                  mode: 'history' as const,
                },
                { jobId: `sec-history-${scannerKey}-${repo.id}-${month}` },
              );
              enqueued += 1;
            }
          }
          return { enqueued };
        },
      }),
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

  // Secrets history sweep (W8-05, SECURITY_SUITE §4: "secrets(history,
  // monthly)"). Stream mode only sees diffs arriving now, so without this a
  // credential committed last March and deleted in April is never found —
  // and deleting a secret from the working tree changes nothing about the
  // secret. Same switch-off as the reconcile cron, for the same reason: it
  // starts work nobody asked for at a wall-clock time.
  const historyCron = process.env.SECRETS_HISTORY_CRON ?? '23 4 1 * *';
  if (historyCron !== 'off') {
    await securityScanQueue.add(
      'history-sweep',
      {
        workspaceId: 0,
        repoId: 0,
        scannerKey: 'secrets',
        commitSha: '',
        trigger: 'schedule' as const,
        mode: 'history_sweep' as const,
      },
      { repeat: { pattern: historyCron }, jobId: 'secrets-history-monthly-sweep' },
    );
  }
  console.log(
    `[worker] monthly secrets history sweep: ${historyCron === 'off' ? 'disabled' : historyCron}`,
  );

  // The weekly security pass (SECURITY_SUITE §4): a full semgrep scan and a
  // chain recompute, per repo. Two scanners, ONE schedule — a chain built from
  // findings a full scan is about to replace is a chain about last week.
  // Chainer runs an hour later for exactly that reason.
  const weeklyCron = process.env.SECURITY_WEEKLY_CRON ?? '41 2 * * 0';
  const chainCron = process.env.SECURITY_CHAIN_CRON ?? '41 3 * * 0';
  if (weeklyCron !== 'off') {
    for (const [scannerKey, pattern] of [
      ['semgrep', weeklyCron],
      ['code_health_tools', weeklyCron],
      ['attack_chainer', chainCron],
    ] as const) {
      await securityScanQueue.add(
        'weekly-sweep',
        {
          workspaceId: 0,
          repoId: 0,
          scannerKey,
          commitSha: '',
          trigger: 'schedule' as const,
          mode: 'weekly_sweep' as const,
        },
        { repeat: { pattern }, jobId: `security-weekly-sweep-${scannerKey}` },
      );
    }
  }
  console.log(
    `[worker] weekly security pass: ${weeklyCron === 'off' ? 'disabled' : `${weeklyCron} (semgrep), ${chainCron} (chains)`}`,
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
