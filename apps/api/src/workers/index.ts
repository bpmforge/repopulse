import 'dotenv/config';
import { and, desc, eq } from 'drizzle-orm';
import { auditLog, core, createDb, createLogger, facts, metricsRegistry } from '@repopulse/shared';
import { installAuditStore } from '../lib/audit-store.js';
import { outboundProxyNotice } from '../lib/outbound-proxy.js';
import { credentials, workspace as workspaceModule } from '@repopulse/auth';
import { QUEUE, createQueue, publishSyncEvent } from '@repopulse/ingest';
import { createRedisConnection, type SyncStreamEvent } from '@repopulse/ingest';
import { claudeCliStatus } from '@repopulse/analysis';
import { createWorkerRuntime } from './runtime.js';
import type { SecretsStreamRequest } from './processors.js';
import {
  backfillProcessor,
  deltaProcessor,
  enrichProcessor,
  reconcileProcessor,
  snapshotProcessor,
  enqueueRepriceAfterScan,
} from './processors.js';
import { startWorkerHealthServer } from './health.js';
import { startWorkerHeartbeat, type WorkerCliStatus } from './heartbeat.js';
import { listenHost } from '../lib/listen-host.js';
import { reportProcessor } from './report-processor.js';
import { plansVerifyProcessor } from './plans-processor.js';
import { scanProcessor } from './scan-processor.js';
import { patchProcessor } from './patch-processor.js';
import { aiPassProcessor } from './ai-pass-processor.js';
import { judgeConfigFromEnv, queueJudgeAfterScan } from './ai-judge.js';
import { fixConfigFor } from './ai-fix.js';
import { createSecondModelVerifier, cveVerifyHook } from './second-model.js';
import { snapshotSources } from './ai-pass-sources.js';
import { forgeDiffSources } from './ai-pass-diff.js';
import { SCHEDULER_TICK_MS, runScheduleTick } from './ai-pass-scheduler.js';
import { providerForRepo } from './forge-provider.js';
import { runKnowledgeRegister, runTestGapRegister } from '@repopulse/insights';
import { buildWorkerGateway, createGatewayResolver, reportGatewayHealth } from './gateway.js';
import { isAiPaused } from '../lib/ai-pause.js';
import { hasNeverBeenScanned, startableScannerKeys } from '../lib/startable-scanners.js';
import {
  antiSlopRunDataVersion,
  architectureDataVersion,
  buildScanProbes,
  headShaFor,
  judgementStateOf,
  stampDataVersion,
  supplyChainDataVersion,
} from '../routes/runs/probes.js';
import {
  jsonFetcher,
  readComponents,
  readSnapshotSources,
  runAntiSlopScan,
  runChainer,
  runCodeHealthScan,
  runOwaspChecklist,
  diffOf,
  runDependencyScan,
  runImageScan,
  runLoggingScan,
  runPerfScan,
  snapshotForScan,
  snapshotOrProvided,
  getScanner,
  runSecretsHistoryScan,
  runSecretsStreamScan,
  runArchitectureScan,
  latestBaseRun,
  DEPENDENCY_SCANNER_KEY,
  IMAGE_SCANNER_KEY,
  ARCHITECTURE_SCANNER_KEY,
  runRuleDraftPass,
  runStoredVerdictTweakPass,
  combineLearningPasses,
  runSemgrepFull,
  registerBuiltinScanners,
  runSupplyChainRegisters,
  startSweeper,
  syncEolProducts,
  syncReleaseMeta,
  runCodeScanningPull,
  PR_SCAN_MAX_TARGETS,
  pendingPrPatternTargets,
  runPrPatternScans,
} from '@repopulse/security';
import { security } from '@repopulse/shared';

/**
 * Products the nightly EOL sync tracks (W10-02).
 *
 * A FIXED list, tunable by env, rather than "every product endoflife.date
 * has": 464 products is 464 requests a night for data about runtimes nobody
 * here uses. A product missing from this list produces NO finding rather than
 * a wrong one — the register is silent on what it has no data for.
 */
const EOL_PRODUCTS = (
  process.env.EOL_PRODUCTS ??
  'nodejs,python,go,ruby,php,java,dotnet,debian,ubuntu,alpine,postgresql,redis,nginx'
)
  .split(',')
  .map((p) => p.trim())
  .filter((p) => p !== '');

/** Passes that run once per WORKSPACE rather than once per repository. */
const WORKSPACE_SCOPED_PASSES = new Set(['rule_draft_pass']);

export { createWorkerRuntime, type WorkerRuntime } from './runtime.js';
export { checkWorkerHealth, startWorkerHealthServer } from './health.js';

// BullMQ worker entrypoint (TECH_STACK: apps/api/src/workers, separate process).
// W2-02 stands up the harness — topology, DLQ, graceful shutdown, metrics,
// /healthz. The entity processors that actually pull GitHub data are wired in
// by W2-03; until then this runs producer-side queues + the DLQ + liveness.
// W16-18. The worker had NO logger: every operational line was a console.log,
// so none of it was structured, none of it honoured LOG_LEVEL, none of it
// reached an aggregator as anything but free text — and none of it passed
// through the SC-2 redaction stream hook. reportGatewayHealth prints provider
// base URLs, so a vendor that carries its key in a query string would have been
// printed in clear.
const log = createLogger({ name: 'repopulse-worker' });

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const redisUrl = process.env.REDIS_URL;
  if (!databaseUrl || !redisUrl) throw new Error('DATABASE_URL and REDIS_URL are required');

  const db = createDb(databaseUrl);
  // W20-10 (UX_TODO X-04): the worker's audit events (scheduled AI passes,
  // plan verifier transitions) reach Settings → Audit log too.
  installAuditStore(db, (err) => log.warn({ err }, 'audit event not persisted'));
  // W20-10 (UX_TODO INS-63): the worker makes most of the outbound calls.
  const proxyNotice = outboundProxyNotice(process.env);
  if (proxyNotice) log[proxyNotice.level](proxyNotice.message);

  // ONE gateway for the whole worker, built here and passed down. Null when no
  // Tier-2 host is configured, which is a supported deployment rather than a
  // fault — the scheduled passes then skip and say `no_gateway` rather than
  // reporting a clean repository they never looked at.
  // tokenKey: provider API keys live in the same vault as forge tokens, so the
  // worker needs it to use a configured provider at all (W16-08).
  // A GATEWAY PER WORKSPACE, resolved where the workspace is known (W16-19).
  //
  // This used to build ONE gateway at boot for the default workspace and hand
  // it to every scan — right while hosts came from a global env var, wrong once
  // providers became per-workspace rows (D-LLM-1). A second workspace would
  // have analysed on the first one's model, or silently got none at all while
  // its own configured provider sat there enabled.
  const gateways = createGatewayResolver(db, process.env, credentials.loadTokenKey());

  // W21-03: a second-model verifier for one scan run of one repository. The
  // pinned gateway is built fresh per connection (as a second opinion's is),
  // so a just-edited connection is what is used; its calls go on the monthly
  // cap through the analysis_runs verify row finish() writes.
  const secondModelFor = (
    workspaceId: number,
    repoId: number,
    hosts: Parameters<typeof createSecondModelVerifier>[0]['hosts'],
  ) =>
    createSecondModelVerifier({
      db,
      workspaceId,
      repoId,
      hosts,
      ledger: 'own',
      pinned: (pin) =>
        buildWorkerGateway(db, process.env, credentials.loadTokenKey(), workspaceId, pin),
    });

  // The boot line still reports the DEFAULT workspace, because that is the one
  // an operator setting this up has, and "which hosts answer" is worth saying
  // once at startup. It is labelled as the default's rather than presented as
  // the whole picture.
  const [defaultWorkspace] = await db
    .select({ id: core.workspaces.id })
    .from(core.workspaces)
    .where(eq(core.workspaces.slug, workspaceModule.DEFAULT_WORKSPACE_SLUG))
    .limit(1);
  const bootGateway = defaultWorkspace ? await gateways.for(defaultWorkspace.id) : null;
  log.info(`[worker] default workspace — ${await reportGatewayHealth(bootGateway)}`);

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
  // W22-03: judge runs are ai.pass jobs queued after a scan.
  const judgeQueue = createQueue(QUEUE.aiPass, connection);
  const judgeConfig = judgeConfigFromEnv({
    AI_JUDGE: process.env.AI_JUDGE,
    AI_JUDGE_MINUTES_PER_DAY: process.env.AI_JUDGE_MINUTES_PER_DAY,
    AI_JUDGE_SCAN_MINUTES: process.env.AI_JUDGE_SCAN_MINUTES,
    AI_JUDGE_FAST_MIN_CONFIDENCE: process.env.AI_JUDGE_FAST_MIN_CONFIDENCE,
    AI_JUDGE_BATCH_SIZE: process.env.AI_JUDGE_BATCH_SIZE,
  });
  // W22-09: verified fixes for the top confirmed findings, drafted in the
  // judge run after judging and within its budget.
  const fixConfig = fixConfigFor(judgeConfig);
  const processorDeps = {
    db,
    tokenKey: credentials.loadTokenKey(),
    backfillQueue,
    snapshotQueue,
    enrichQueue,
    reconcileQueue,
    // W20-17 (UX_TODO INS-09): auto-add registers hooks on new repositories at
    // the address the API registers them at.
    ...(process.env.PUBLIC_BASE_URL
      ? {
          webhookUrl: `${process.env.PUBLIC_BASE_URL.replace(/\/+$/, '')}/api/v1/webhooks/github`,
        }
      : {}),
    // W20-22 (UX_TODO INS-60): a repository's first security scan starts when
    // it first goes live, not on the next weekly sweep. Same scanner set as
    // "Run scans now"; only for a repository with no scan run at all, so a
    // resumed or retried one is not scanned again. Off with the weekly pass
    // (SECURITY_WEEKLY_CRON=off), or alone with FIRST_SCAN_ON_LIVE=off.
    ...(process.env.SECURITY_WEEKLY_CRON !== 'off' && process.env.FIRST_SCAN_ON_LIVE !== 'off'
      ? {
          onLive: async (workspaceId: number, repoId: number) => {
            if (!(await hasNeverBeenScanned(db, workspaceId, repoId))) return;
            // W23-02: ONE batch job — one commit, one archive for every
            // snapshot scanner — instead of a job per scanner.
            const scannerKeys = await startableScannerKeys(db, workspaceId, repoId);
            if (scannerKeys.length === 0) return;
            await securityScanQueue.add(
              'first-scan',
              {
                workspaceId,
                repoId,
                scannerKey: '',
                scannerKeys,
                commitSha: '',
                trigger: 'schedule' as const,
                mode: 'batch' as const,
              },
              { jobId: `sec-first-batch-${repoId}` },
            );
          },
        }
      : {}),
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
    // W21-02: the pattern scanners on every PR push. One job per unscanned open
    // head, keyed by the head, so a replayed webhook or a second delta for the
    // same push queues nothing new — and each job fetches one archive for every
    // scanner. PR_SCANS=off keeps PR pushes to the secrets stream alone.
    ...(process.env.PR_SCANS !== 'off'
      ? {
          queuePrScans: async (workspaceId: number, repoId: number) => {
            const found = await pendingPrPatternTargets(
              db,
              workspaceId,
              repoId,
              PR_SCAN_MAX_TARGETS,
            );
            const targets = found.slice(0, PR_SCAN_MAX_TARGETS);
            for (const t of targets) {
              await securityScanQueue.add(
                'pr-scan',
                {
                  workspaceId,
                  repoId,
                  scannerKey: 'pr_patterns',
                  commitSha: t.commitSha,
                  prNumber: t.prNumber,
                  trigger: 'pr_synced' as const,
                  mode: 'pr' as const,
                },
                { jobId: `sec-pr-${repoId}-${t.commitSha}` },
              );
            }
            return { queued: targets.length, deferred: found.length - targets.length };
          },
        }
      : {}),
    ...(process.env.FORGE_BASE_URL ? { forgeBaseUrl: process.env.FORGE_BASE_URL } : {}),
    // SC-12 escape hatch, off unless the operator sets it. Lets the e2e fake
    // forge (http://127.0.0.1:PORT) drive the real ingestion path; still
    // loopback-only and still allowlisted. See ValidateBaseUrlOptions.
    ...(process.env.FORGE_ALLOW_INSECURE_LOOPBACK === '1' ? { allowInsecureLoopback: true } : {}),
  };

  // ONE FORGE CONFIG FOR THE SCANNERS TOO (W16-29).
  //
  // The six scan runners below each built `providerForRepo({ db, tokenKey })`
  // with no forge options, so FORGE_BASE_URL and the SC-12 loopback opt-in were
  // honoured by ingestion and silently dropped by every scan. Against
  // api.github.com the omission was invisible — it IS the default — which is
  // why it survived: in demo mode it meant the fake credential went to the real
  // GitHub, and against any self-hosted forge (D1a puts those in the MVP) every
  // scan would have gone to github.com while ingestion went to the right host.
  const scanForgeDeps = {
    db,
    tokenKey: credentials.loadTokenKey(),
    ...(process.env.FORGE_BASE_URL ? { forgeBaseUrl: process.env.FORGE_BASE_URL } : {}),
    ...(process.env.FORGE_ALLOW_INSECURE_LOOPBACK === '1' ? { allowInsecureLoopback: true } : {}),
  };

  /**
   * One OWASP checklist over the newest ingested commit's diff (W16-33).
   *
   * Shared because the two checklists differ ONLY by key, and two copies of a
   * gateway lookup, a provider resolve and a diff fetch is two places for the
   * Tier-3 guard to drift.
   */
  const runChecklistNow = async (
    key: 'owasp_web' | 'owasp_llm',
    workspaceId: number,
    repoId: number,
  ) => {
    const nothing = (skipped: string) => ({
      scanned: 0,
      findingsCreated: 0,
      deferred: 0,
      skipped,
    });

    // THIS workspace's model (W16-19). A checklist with no gateway cannot run
    // at all — it is the judgement, not a deterministic pass with a judgement
    // half — so this is a skip with a name, not a quiet zero.
    // W20-18 (UX_TODO AI-77): the workspace's "AI off" switch, said by name.
    if (await isAiPaused(db, workspaceId)) return nothing('ai_paused');
    const analysisGateway = await gateways.for(workspaceId);
    if (!analysisGateway) return nothing('no_gateway');

    const resolved = await providerForRepo(scanForgeDeps, workspaceId, repoId);
    if (!resolved) return nothing('no_connection');

    const [head] = await db
      .select({ sha: facts.commits.sha })
      .from(facts.commits)
      .where(eq(facts.commits.repoId, repoId))
      .orderBy(desc(facts.commits.committedAt))
      .limit(1);
    if (!head?.sha) return nothing('no_head_sha');

    // `patch` is OPTIONAL on the forge's shape and REQUIRED on the chunker's,
    // and the difference is meaningful: a file with no patch is a binary or a
    // too-large one, and the chunker's own SkipReason vocabulary already has a
    // word for it (`no_patch`). Normalised to null here so that stays the
    // chunker's decision rather than becoming a silently dropped file.
    const files = (
      await diffOf(
        { provider: resolved.provider, repo: resolved.repoFullName, repoId },
        { commitSha: head.sha },
      )
    ).map((f) => ({ ...f, patch: f.patch ?? null }));

    const result = await runOwaspChecklist({
      db,
      gateway: analysisGateway.gateway,
      workspaceId,
      repoId,
      files,
      commitSha: head.sha,
      trigger: 'manual',
      key,
    });

    return {
      scanned: result.status === 'succeeded' ? 1 : 0,
      findingsCreated: result.findingsCreated,
      // Findings the validator threw out — a pass that rejected everything
      // must not read as a quiet one.
      deferred: result.rejected,
      ...(result.error ? { error: result.error } : {}),
      ...(result.skippedReason ? { skipped: result.skippedReason } : {}),
    };
  };

  // W16-28. The process that RUNS the scans registers the catalogue too, so
  // getScanner() resolves here and a scan_run records a real scanner version
  // instead of "unregistered".
  registerBuiltinScanners();

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
        // 2026-10-27: price what the scan wrote within a minute, not overnight.
        afterScan: async ({ workspaceId, repoId }) => {
          try {
            await enqueueRepriceAfterScan(snapshotQueue, { workspaceId, repoId });
          } catch (err) {
            log.warn({ err, repoId }, '[worker] reprice after scan not queued');
          }
          // W22-03: the AI judges the rule hits this scan left open, within
          // the workspace's budget (local by default; hosted only when opted in).
          try {
            const judged = await queueJudgeAfterScan(
              {
                db,
                config: judgeConfig,
                fixes: fixConfig,
                enqueue: async (data) => {
                  await judgeQueue.add('ai.pass', data, { jobId: `ai-pass-${data.runId}` });
                },
              },
              { workspaceId, repoId },
            );
            if (judged.queued)
              log.info({ repoId, runId: judged.runId }, '[worker] AI judge queued');
            else log.debug({ repoId, code: judged.code }, '[worker] AI judge not queued');
          } catch (err) {
            log.warn({ err, repoId }, '[worker] AI judge after scan not queued');
          }
        },
        // W21-02. One PR head, every enabled pattern scanner, one archive.
        prRunner: async ({ workspaceId, repoId, commitSha, prNumber }) => {
          if (prNumber === undefined) return { skipped: 'no_pr' };
          const [pr] = await db
            .select({ id: facts.pullRequests.id, headSha: facts.pullRequests.headSha })
            .from(facts.pullRequests)
            .where(
              and(
                eq(facts.pullRequests.workspaceId, workspaceId),
                eq(facts.pullRequests.repoId, repoId),
                eq(facts.pullRequests.number, prNumber),
              ),
            )
            .limit(1);
          // Pushed again while this waited: the new head has its own job, and
          // an archive of the old one would be budget spent on nothing.
          if (!pr || pr.headSha !== commitSha) return { skipped: 'superseded' };
          const resolved = await providerForRepo(scanForgeDeps, workspaceId, repoId);
          if (!resolved) return { skipped: 'no_connection' };
          return runPrPatternScans({
            db,
            provider: resolved.provider,
            workspaceId,
            repoId,
            repo: resolved.repoFullName,
            target: { commitSha, prNumber, pullRequestId: pr.id },
          });
        },
        // W8-05: history mode, by scanner key. A map rather than a switch, so
        // FR-SEC-1's "the framework never branches on a scanner key" stays true.
        historyRunners: {
          secrets: async ({ workspaceId, repoId, force }) => {
            const resolved = await providerForRepo(scanForgeDeps, workspaceId, repoId);
            // No active connection: nothing to fetch patches with. Reported as
            // zero work, not as a failure — the repo simply is not connected.
            if (!resolved)
              return { scanned: 0, findingsCreated: 0, deferred: 0, skipped: 'no_connection' };
            return runSecretsHistoryScan({
              db,
              provider: resolved.provider,
              workspaceId,
              repoId,
              repo: resolved.repoFullName,
              // W23-09: "Full rescan" re-sweeps commits the covered filter would
              // exclude, including one stuck in `running`.
              ...(force ? { force: true } : {}),
            });
          },
        },
        // W8-07 + W8-09 share ONE weekly pass, wired once. A semgrep full run
        // and a chain recompute are the same shape of work — per repo, on a
        // schedule, no user waiting — and two crons doing it would drift.
        // W23-01: what each weekly runner would pin to and stamp, so an
        // unchanged scan is skipped. A runner with no probe always runs.
        // W23-09: every runner below either has a probe here or is listed in
        // ALWAYS_RUN (routes/runs/probes.ts) with the reason it never skips.
        // Anti-slop's probe needs the workspace's gateway, which only this
        // process can build, so it is injected here and absent from the API's.
        probes: buildScanProbes(db, {
          antiSlopJudgement: async (workspaceId) =>
            judgementStateOf(
              (await isAiPaused(db, workspaceId))
                ? null
                : ((await gateways.for(workspaceId))?.hosts ?? null),
            ),
        }),
        // W23-02: one snapshot per scan batch. `dependency_cve` and
        // `container_image` read a tree too but are declared `manifests` (they
        // work from the SBOM they build), so they are named here, at the wiring,
        // rather than in the framework.
        batch: {
          usesSnapshot: (key) =>
            getScanner(key)?.inputs === 'snapshot' ||
            key === 'dependency_cve' ||
            key === 'container_image',
          // No connection or no ingested commit: null, and each scanner records
          // its own no_connection / no_head_sha row on its own path.
          headSha: async (workspaceId, repoId) =>
            (await providerForRepo(scanForgeDeps, workspaceId, repoId))
              ? headShaFor(db, workspaceId, repoId)
              : null,
          withSnapshot: async ({ workspaceId, repoId, commitSha }, fn) => {
            const resolved = await providerForRepo(scanForgeDeps, workspaceId, repoId);
            if (!resolved) throw new Error('No forge connection for this repository');
            return snapshotForScan(
              { provider: resolved.provider, repo: resolved.repoFullName, commitSha },
              (snapshot) => fn({ dir: snapshot.dir, commitSha: snapshot.commitSha }),
            );
          },
        },
        weeklyRunners: {
          semgrep: async ({ workspaceId, repoId, force }, opts) => {
            const resolved = await providerForRepo(scanForgeDeps, workspaceId, repoId);
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
              commitSha: opts?.snapshot?.commitSha ?? sha,
              ...(opts?.snapshot ? { snapshot: opts.snapshot } : {}),
              // W23-03: with a baseline (and no tree already on disk) this scans
              // only the files changed since it; "Full rescan" never does.
              ...(force ? { force: true } : {}),
            });
            return {
              scanned: result.status === 'succeeded' ? 1 : 0,
              findingsCreated: result.findingsCreated,
              deferred: 0,
              ...(result.error ? { error: result.error } : {}),
            };
          },
          // W9-02. Same weekly slot as semgrep: both want a snapshot of the
          // same commit, and complexity is a property of a codebase rather
          // than of a change — a per-PR run would report the same findings on
          // every branch until people filtered the scanner out of their view.
          code_health_tools: async ({ workspaceId, repoId, force }, opts) => {
            const resolved = await providerForRepo(scanForgeDeps, workspaceId, repoId);
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
              commitSha: opts?.snapshot?.commitSha ?? head.sha,
              ...(opts?.snapshot ? { snapshot: opts.snapshot } : {}),
              // W23-03: changed files only when a baseline allows it; never on "Full rescan".
              ...(force ? { force: true } : {}),
            });
            return {
              scanned: result.status === 'succeeded' ? 1 : 0,
              findingsCreated: result.findingsCreated,
              deferred: 0,
              ...(result.error ? { error: result.error } : {}),
            };
          },
          // W8-06's dependency scan, wired at last (W16-36).
          //
          // The scanner has been shipped, tested and marked done since W8 and
          // NOTHING CALLED IT. So `security.sboms` had never held a row, the
          // Security tab told every reader "the CVE scanner is not available
          // yet", the supply-chain register returned `no_sbom` every night,
          // and owasp_llm could only ever skip for want of a document to read.
          // One scanner unwired, four screens telling the truth about it.
          //
          // Same weekly slot and same shape as code health: it needs a
          // snapshot of one pinned commit, and a vulnerable dependency is a
          // property of a tree rather than of a change.
          //
          // A missing grype database FAILS this scan rather than reporting a
          // clean one, by the scanner's own design — and says
          // `run deploy/scan-db-sync.sh` in the error, which now reaches the
          // coverage table verbatim (W16-35).
          dependency_cve: async ({ workspaceId, repoId, force }, opts) => {
            const resolved = await providerForRepo(scanForgeDeps, workspaceId, repoId);
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
            // W21-03: V5, the second opinion on the run's top CVEs, on a
            // connection the decisions allow (see second-model.ts). AI off,
            // no usable connection or no calls left: nobody is asked.
            const cveGateway = (await isAiPaused(db, workspaceId))
              ? null
              : await gateways.for(workspaceId);
            const result = await runDependencyScan({
              db,
              provider: resolved.provider,
              workspaceId,
              repoId,
              // W23-04: the newest real run, so the runner can skip or re-match.
              // "Full rescan" passes none and gets today's full scan.
              baseRun: force
                ? undefined
                : await latestBaseRun(db, { workspaceId, repoId, scannerKey: DEPENDENCY_SCANNER_KEY }),
              repo: resolved.repoFullName,
              commitSha: opts?.snapshot?.commitSha ?? head.sha,
              ...(opts?.snapshot ? { snapshot: opts.snapshot } : {}),
              ...(cveGateway
                ? {
                    verifyCves: cveVerifyHook({
                      db,
                      workspaceId,
                      repoId,
                      verifier: secondModelFor(workspaceId, repoId, cveGateway.hosts),
                    }),
                  }
                : {}),
            });
            return {
              scanned: result.status === 'succeeded' ? 1 : 0,
              findingsCreated: result.findingsCreated,
              // Components the SBOM held that our own reader could not scope.
              // Carried rather than dropped: a CVE count over an unstated
              // fraction of a dependency tree is a number with no denominator.
              deferred: Math.max(0, result.componentsScanned - result.syncableComponents),
              ...(result.error ? { error: result.error } : {}),
            };
          },
          // W18-34. Opt-in (container_image is off by default), so the scheduler
          // and the manual route only reach this for a repository whose owner
          // turned it on. Pulls happen host-side in runImageScan.
          container_image: async ({ workspaceId, repoId, force }, opts) => {
            const resolved = await providerForRepo(scanForgeDeps, workspaceId, repoId);
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
            const result = await runImageScan({
              db,
              provider: resolved.provider,
              workspaceId,
              repoId,
              // W23-04: the newest real run, so the runner can skip or re-match.
              // "Full rescan" passes none and gets today's full scan.
              baseRun: force
                ? undefined
                : await latestBaseRun(db, { workspaceId, repoId, scannerKey: IMAGE_SCANNER_KEY }),
              repo: resolved.repoFullName,
              commitSha: opts?.snapshot?.commitSha ?? head.sha,
              ...(opts?.snapshot ? { snapshot: opts.snapshot } : {}),
            });
            return {
              scanned: result.imagesScanned,
              findingsCreated: result.findingsCreated,
              deferred: result.imagesFailed.length + result.imagesOverCap,
              ...(result.error ? { error: result.error } : {}),
            };
          },
          // W9-06: the weekly deterministic pass for the two scanners whose
          // judgement halves need a gateway. LDR, docstring inflation and the
          // logging pack are arithmetic and patterns — they need a snapshot,
          // not a model — so they run here and the judgement layer stays on
          // the pull-request path where a gateway already exists.
          anti_slop: async ({ workspaceId, repoId }, opts) => {
            // THIS WORKSPACE'S gateway (W16-19), resolved here because here is
            // where the workspace is known. Cached by the resolver, so the two
            // scanners below share one build rather than each paying for a
            // credential decrypt.
            // W20-18 (UX_TODO AI-77): with AI off only the deterministic half runs.
            const analysisGateway = (await isAiPaused(db, workspaceId))
              ? null
              : await gateways.for(workspaceId);
            const resolved = await providerForRepo(scanForgeDeps, workspaceId, repoId);
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

            // W23-09: the stamp is built from the SAME gateway this run uses, so
            // a run made with AI off never stands in for one with a model on.
            const slopDataVersion = await antiSlopRunDataVersion(
              db,
              workspaceId,
              judgementStateOf(analysisGateway?.hosts ?? null),
            );

            // The batch's tree pins the commit (W23-02); alone, the head.
            const commitSha = opts?.snapshot?.commitSha ?? head.sha;
            return snapshotOrProvided(
              opts?.snapshot,
              {
                provider: resolved.provider,
                repo: resolved.repoFullName,
                commitSha: commitSha,
              },
              async (snapshot) => {
                const sources = readSnapshotSources(snapshot.dir);
                // W21-03: the second opinion on what the judgement halves
                // raise, on a different connection from the one that raised
                // it. Its calls are recorded on the monthly cap below.
                const verifier = analysisGateway
                  ? secondModelFor(workspaceId, repoId, analysisGateway.hosts)
                  : null;
                let slop: Awaited<ReturnType<typeof runAntiSlopScan>>;
                let logging: Awaited<ReturnType<typeof runLoggingScan>>;
                try {
                  [slop, logging] = [
                    await runAntiSlopScan({
                      db,
                      workspaceId,
                      repoId,
                      commitSha: commitSha,
                      files: [],
                      sources: sources.files,
                      sourcesComplete: !sources.truncated && sources.skipped === 0,
                      snapshotDir: snapshot.dir,
                      // W18-30. The pack's eight bpm-ch-* rules, on the tree the
                      // logging scanner already runs over. Each scanner loads only
                      // its own pack files, so this is no second pass over the
                      // same rules — it is the first pass over these ones.
                      targetDir: snapshot.dir,
                      trigger: 'schedule',
                      dataVersion: slopDataVersion,
                      // THE JUDGEMENT HALF, finally reachable. It was written,
                      // tested against a stub and shipped with no gateway to
                      // call — `deps.gateway ? ... : { chunks: [] }` meant every
                      // scheduled run reported judgment: 0 and nobody noticed,
                      // because that is also what a clean repository looks like.
                      ...(analysisGateway ? { gateway: analysisGateway.gateway } : {}),
                      ...(verifier ? { verify: verifier.verify } : {}),
                    }),
                    await runLoggingScan({
                      db,
                      workspaceId,
                      repoId,
                      commitSha: commitSha,
                      files: [],
                      targetDir: snapshot.dir,
                      trigger: 'schedule',
                      ...(analysisGateway ? { gateway: analysisGateway.gateway } : {}),
                      ...(verifier ? { verify: verifier.verify } : {}),
                    }),
                  ];
                } finally {
                  // Calls made before a throw still go on the cap.
                  await verifier?.finish();
                }
                // W18-22. The ONE recorded trace of files the reader skipped
                // (over the size limit, or past the read cap): the run that
                // read the tree is marked partial, which the coverage map
                // reports. The skip COUNT has no column to live in yet.
                if (slop.scanRunId !== null && (sources.truncated || sources.skipped > 0)) {
                  await db
                    .update(security.scanRuns)
                    .set({ partial: true })
                    .where(eq(security.scanRuns.id, slop.scanRunId));
                }
                // W9-13. Third scan on the SAME snapshot: the perf pack needs a
                // tree, and a second tarball for eight structural rules would
                // be a rate-limit cost with nothing to show for it. It has no
                // judgement half, so it needs no gateway.
                const perf = await runPerfScan({
                  db,
                  workspaceId,
                  repoId,
                  commitSha: commitSha,
                  targetDir: snapshot.dir,
                  trigger: 'schedule',
                });
                return {
                  scanned: sources.files.length,
                  findingsCreated:
                    slop.findingsCreated + logging.findingsCreated + perf.findingsCreated,
                  // Files the reader never saw, surfaced rather than swallowed:
                  // a slop density over an unstated fraction of a repository is
                  // a number with no denominator.
                  deferred: sources.skipped,
                  ...(sources.truncated ? { skipped: 'source_cap_reached' } : {}),
                };
              },
            );
          },
          // The nightly register pass (W10-01/W10-02). Same injected-map slot
          // as the weekly scanners because it is the same shape of job — a
          // per-repo run on a schedule — and adding a second dispatch table
          // would give the processor two ways to reach the same place.
          //
          // ORDER MATTERS INSIDE THIS RUNNER: the registry sync must finish
          // before the register reads release_meta, or the first night of a
          // new dependency reports "no data" for a package we could have
          // asked about a second earlier.
          supply_chain_register: async ({ workspaceId, repoId }) => {
            const [sbom] = await db
              .select({ document: security.sboms.document })
              .from(security.sboms)
              .where(
                and(eq(security.sboms.workspaceId, workspaceId), eq(security.sboms.repoId, repoId)),
              )
              .orderBy(desc(security.sboms.createdAt))
              .limit(1);
            // No SBOM means W8-06 has not run — it is blocked for missing
            // syft. Reported by name so an empty Supply Chain tab never reads
            // as "no dependency problems".
            if (!sbom) return { scanned: 0, findingsCreated: 0, deferred: 0, skipped: 'no_sbom' };

            // W23-09: the stamp is read BEFORE the registries are synced, so a
            // day that turns mid-run makes the next probe disagree, never agree.
            const registerStamp = await supplyChainDataVersion(db, workspaceId, repoId);

            const fetchJson = jsonFetcher();
            const components = readComponents(sbom.document);
            const byPackage = new Map<
              string,
              { ecosystem: 'npm' | 'pypi'; name: string; installedVersions: string[] }
            >();
            for (const component of components) {
              const key = `${component.ecosystem}:${component.name}`;
              const entry = byPackage.get(key) ?? {
                ecosystem: component.ecosystem,
                name: component.name,
                installedVersions: [],
              };
              if (component.version) entry.installedVersions.push(component.version);
              byPackage.set(key, entry);
            }

            const sync = await syncReleaseMeta({
              db,
              fetchJson,
              packages: [...byPackage.values()],
            });
            const eol = await syncEolProducts({ db, fetchJson, products: EOL_PRODUCTS });

            const resolved = await providerForRepo(scanForgeDeps, workspaceId, repoId);
            const [head] = await db
              .select({ sha: facts.commits.sha })
              .from(facts.commits)
              .where(eq(facts.commits.repoId, repoId))
              .orderBy(desc(facts.commits.committedAt))
              .limit(1);

            // The EOL half needs the C1a snapshot to read Dockerfiles and
            // manifests. Without a connection or a head SHA the other two
            // registers still run — a partial pass that says which part was
            // partial beats skipping the whole thing.
            const run = async (snapshotDir?: string) =>
              runSupplyChainRegisters({
                db,
                workspaceId,
                repoId,
                ...(snapshotDir ? { snapshotDir } : {}),
              });

            const result =
              resolved && head?.sha
                ? await snapshotForScan(
                    {
                      provider: resolved.provider,
                      repo: resolved.repoFullName,
                      commitSha: head.sha,
                    },
                    async (snapshot) => run(snapshot.dir),
                  )
                : await run();

            if (result.status === 'succeeded') {
              await stampDataVersion(
                db,
                workspaceId,
                result.scanRunId,
                registerStamp?.dataVersion ?? null,
              );
            }

            return {
              scanned: result.measured,
              findingsCreated: result.created,
              // The denominator, carried out of the job rather than logged and
              // lost: components with no registry answer are not healthy ones.
              deferred: result.unmeasured + sync.failed.length + eol.failed.length,
              ...(result.error ? { error: result.error } : {}),
              ...(result.skippedReason ? { skipped: result.skippedReason } : {}),
            };
          },
          // W10-03. Needs a snapshot like the other tool scanners, so it
          // carries the same no-connection / no-head-sha guards: a register
          // that cannot fetch a tree reports why rather than reporting clean.
          architecture_register: async ({ workspaceId, repoId, force }, opts) => {
            const resolved = await providerForRepo(scanForgeDeps, workspaceId, repoId);
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
            // W23-09: the data stamp, read before the run and written onto its
            // row after (the row is the package's; the stamp is the probe's).
            const archDataVersion = architectureDataVersion();
            const result = await runArchitectureScan({
              db,
              provider: resolved.provider,
              workspaceId,
              repoId,
              // W23-04: the newest real run, so the runner can skip or re-match.
              // "Full rescan" passes none and gets today's full scan.
              baseRun: force
                ? undefined
                : await latestBaseRun(db, { workspaceId, repoId, scannerKey: ARCHITECTURE_SCANNER_KEY }),
              repo: resolved.repoFullName,
              commitSha: opts?.snapshot?.commitSha ?? head.sha,
              ...(opts?.snapshot ? { snapshot: opts.snapshot } : {}),
            });
            if (result.status === 'succeeded' || result.status === 'skipped') {
              await stampDataVersion(db, workspaceId, result.scanRunId, archDataVersion);
            }
            return {
              scanned: result.moduleCount,
              findingsCreated: result.findingsCreated,
              // Detections that could not run — too few modules for a
              // distribution — carried out rather than logged and lost.
              deferred: result.notRun.length,
              ...(result.error ? { error: result.error } : {}),
            };
          },
          // W10-01, wired here rather than left as an unreferenced export.
          knowledge_register: async ({ workspaceId, repoId }) => {
            const result = await runKnowledgeRegister({ db, workspaceId, repoId });
            return {
              scanned: result.modules,
              findingsCreated: result.created,
              deferred: 0,
              ...(result.error ? { error: result.error } : {}),
            };
          },
          // W8-08's OWASP checklists, wired at last (W16-33).
          //
          // Both were shipped, tested and reachable by nothing: runOwaspChecklist
          // had no caller, so `owasp_web` and `owasp_llm` read "not in this
          // build" on every install — truthfully, which is the only reason it
          // was not worse.
          //
          // MANUAL ONLY, and deliberately not on the weekly cron. Their own
          // default says so: owasp_web is `enabled: false, schedule: 'manual'`
          // because it is "costly per run, so a human starts it" — a checklist
          // is a gateway call per chunk, not a regex over a tree.
          //
          // A DIFF, not a snapshot, which is why they do not share the weekly
          // runners' shape: chunkDiff reviews changed files, and a checklist
          // over a whole tree would ask a model the same questions about code
          // nobody touched. The newest ingested commit is the one a person
          // pressing the button means.
          owasp_web: async ({ workspaceId, repoId }) =>
            await runChecklistNow('owasp_web', workspaceId, repoId),
          // W8-08 §3.4 gates this one on the repository actually depending on
          // an LLM client, and runOwaspChecklist checks that itself against the
          // SBOM — which nothing wrote until W16-36 gave the dependency scanner
          // a caller. Until a dependency scan has run for a repo it reports
          // `no_sbom` and says so, rather than reading as "not applicable".
          owasp_llm: async ({ workspaceId, repoId }) =>
            await runChecklistNow('owasp_llm', workspaceId, repoId),
          // W9-07's scheduled drafting pass, wired here rather than left as
          // three exported functions nothing called. Workspace-scoped, so it
          // runs once per workspace rather than once per repo — it clusters
          // dismissals across the whole workspace, and running it per repo
          // would draft the same rule N times.
          rule_draft_pass: async ({ workspaceId }) => {
            // THIS WORKSPACE'S gateway (W16-19). The pass clusters one
            // workspace's dismissals, so borrowing another's model to judge
            // them would be both wrong and a cross-tenant use of a credential.
            // W20-18 (UX_TODO AI-77): with AI off no model drafts a rule.
            const analysisGateway = (await isAiPaused(db, workspaceId))
              ? null
              : await gateways.for(workspaceId);
            const gatewayDep = analysisGateway ? { gateway: analysisGateway.gateway } : {};
            const drafts = await runRuleDraftPass({ db, workspaceId, ...gatewayDep });
            // W22-06. Beside it, the same week and the same gateway: rule-tweak
            // PROPOSALS from the AI judge's stored false-positive verdicts
            // (W22-03). It writes `proposed` registry rows with new ids and
            // nothing else; one failed call is recorded and the rest still run.
            const tweaks = await runStoredVerdictTweakPass({ db, workspaceId, ...gatewayDep });
            // Thrown-out drafts and name collisions land in `deferred`: a pass
            // that rejected everything must not read as a quiet one.
            return combineLearningPasses(drafts, tweaks);
          },
          // W10-04. Warehouse-only, so it needs neither a connection nor a
          // snapshot — it reads the commits we already have.
          test_gap_register: async ({ workspaceId, repoId }) => {
            const result = await runTestGapRegister({ db, workspaceId, repoId });
            return {
              scanned: result.files,
              findingsCreated: result.created,
              // Detections that could not run, carried out rather than logged
              // and lost: "no churn distribution" is not "no test gaps".
              deferred: result.notRun.length,
              ...(result.error ? { error: result.error } : {}),
            };
          },
          // W18-24. GitHub code-scanning alerts, read-only through the
          // budgeted client on the scan lane. Every skip is a reason the run
          // row states — no connection, a forge without the feature, or the
          // App lacking "Code scanning alerts: Read" — never a silent zero.
          code_scanning_pull: async ({ workspaceId, repoId }) => {
            const resolved = await providerForRepo(scanForgeDeps, workspaceId, repoId);
            if (!resolved) {
              return { scanned: 0, findingsCreated: 0, deferred: 0, skipped: 'no_connection' };
            }
            const result = await runCodeScanningPull({
              db,
              provider: resolved.provider,
              workspaceId,
              repoId,
              repo: resolved.repoFullName,
            });
            if (result.status === 'skipped') {
              return {
                scanned: 0,
                findingsCreated: 0,
                deferred: 0,
                skipped: result.skipped ?? 'code_scanning_not_supported',
              };
            }
            return {
              // The pull wrote its own run row, so this is never "nothing
              // scanned" — zero open alerts is a measurement.
              scanned: 1,
              findingsCreated: result.tools.reduce((n, t) => n + t.created, 0),
              deferred: 0,
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
              ...(result.error ? { error: result.error } : {}),
            };
          },
        },
        weeklySweep: async (scannerKey) => {
          const workspaces = await db.select({ id: core.workspaces.id }).from(core.workspaces);
          const week = `${new Date().getUTCFullYear()}w${Math.ceil(new Date().getUTCDate() / 7)}`;
          let enqueued = 0;

          // WORKSPACE-SCOPED passes fan out once per workspace, not once per
          // repo. The drafting pass clusters dismissals across the whole
          // workspace; per-repo it would draft the same rule N times and an
          // admin would open the workbench to N copies of one suggestion.
          if (WORKSPACE_SCOPED_PASSES.has(scannerKey)) {
            for (const ws of workspaces) {
              await securityScanQueue.add(
                'weekly',
                {
                  workspaceId: ws.id,
                  repoId: 0,
                  scannerKey,
                  commitSha: '',
                  trigger: 'schedule' as const,
                  mode: 'weekly' as const,
                },
                { jobId: `sec-weekly-${scannerKey}-ws${ws.id}-${week}` },
              );
              enqueued += 1;
            }
            return { enqueued };
          }

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
        // The headless printer loads /print/reports/:id from HERE (W20-02).
        // PUBLIC_BASE_URL is where users reach the install, which from inside a
        // container is usually not reachable at all (localhost is the worker
        // itself), so the packaged stack points this at the internal web service.
        // `||`, not `??`: .env.example ships the variable blank, meaning unset.
        printBaseUrl:
          process.env.REPORT_PRINT_BASE_URL ||
          (process.env.PUBLIC_BASE_URL ?? 'http://localhost:5273'),
        // Finding rows in the PDF link to where readers open RepoPulse (W20-15).
        ...(process.env.PUBLIC_BASE_URL ? { linkBaseUrl: process.env.PUBLIC_BASE_URL } : {}),
      }),
      // W18-19. A verified patch: this workspace's model drafts, the sandbox
      // re-scans. The forge is read through the same scan-lane config as every
      // scanner above, and only read (D9a).
      [QUEUE.patchDraft]: patchProcessor({
        db,
        gatewayFor: async (workspaceId) => (await gateways.for(workspaceId))?.gateway ?? null,
        forgeFor: (workspaceId, repoId) => providerForRepo(scanForgeDeps, workspaceId, repoId),
      }),
      // W19-09. The AI pass: the planned specialists, then evidence-fed triage,
      // through this workspace's routing chain. Reads an archive (D9a), writes
      // findings and SUGGESTIONS, and cannot change a finding's status.
      [QUEUE.aiPass]: aiPassProcessor({
        db,
        // W22-03: judge runs; their verdicts move verify_status, so reprice.
        judge: {
          config: judgeConfig,
          // W22-09: read-only forge access (D9a), the same scan-lane config.
          fixes: {
            config: fixConfig,
            forgeFor: (workspaceId, repoId) => providerForRepo(scanForgeDeps, workspaceId, repoId),
          },
          gatewayFor: async (workspaceId) => {
            const built = await gateways.forBackground(workspaceId);
            return built
              ? {
                  gateway: built.gateway,
                  hosts: built.hosts,
                  ...(built.routing ? { routing: built.routing } : {}),
                }
              : null;
          },
          scansPending: async ({ workspaceId, repoId }) => {
            const jobs = await securityScanQueue.getJobs([
              'active',
              'waiting',
              'delayed',
              'prioritized',
              'waiting-children',
            ]);
            return jobs.some(
              (sj) =>
                sj?.data?.workspaceId === workspaceId &&
                sj.data.repoId === repoId &&
                sj.data.mode !== 'weekly_sweep' &&
                sj.data.mode !== 'history_sweep',
            );
          },
          requeue: async (data, delayMs) => {
            await judgeQueue.add('ai.pass', data, {
              jobId: `ai-pass-${data.runId}-wait-${Date.now()}`,
              delay: delayMs,
            });
          },
          afterVerdicts: async ({ workspaceId, repoId, runId }) => {
            await snapshotQueue.add(
              'reprice',
              { workspaceId, repoId, repriceOnly: true },
              { jobId: `reprice-judge-${runId}` },
            );
          },
        },
        gatewayFor: async (workspaceId) => {
          const built = await gateways.for(workspaceId);
          return built
            ? {
                gateway: built.gateway,
                hosts: built.hosts,
                ...(built.routing ? { routing: built.routing } : {}),
              }
            : null;
        },
        loadSources: snapshotSources({
          db,
          forgeFor: (workspaceId, repoId) => providerForRepo(scanForgeDeps, workspaceId, repoId),
        }),
        // Diff modes (W19-11): a pull request's files or a short commit range,
        // through the budgeted client on the scan lane.
        loadDiff: forgeDiffSources({
          db,
          forgeFor: (workspaceId, repoId) => providerForRepo(scanForgeDeps, workspaceId, repoId),
        }),
        // W20-18 (UX_TODO AI-14): a second opinion runs on the ONE connection and
        // model the person chose, built fresh (not cached) so a just-edited
        // connection is what is used.
        secondOpinionGatewayFor: async (workspaceId, pin) => {
          const built = await buildWorkerGateway(
            db,
            process.env,
            credentials.loadTokenKey(),
            workspaceId,
            pin,
          );
          return built ? { gateway: built.gateway, hosts: built.hosts } : null;
        },
        // W21-03: the pass's own findings get a second model's verdict, inside
        // the pass's call cap and counted on its row (not a separate ledger).
        verifierFor: ({ workspaceId, repoId, hosts, maxCalls, wrap }) =>
          createSecondModelVerifier({
            db,
            workspaceId,
            repoId,
            hosts,
            ledger: 'caller',
            maxCalls,
            wrap,
            pinned: (pin) =>
              buildWorkerGateway(db, process.env, credentials.loadTokenKey(), workspaceId, pin),
          }),
      }),
    },
    // Structured, so an aggregator can alert on it: this is the callback that
    // fires when a job has exhausted its retries, which is the single most
    // important worker event there is.
    onError: (err) => log.error({ err }, '[worker] DLQ/error'),
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
  log.info(`[worker] nightly reconcile: ${reconcileCron === 'off' ? 'disabled' : reconcileCron}`);

  // Nightly plan verification (W5-06, IMPROVEMENT_PLANS.md §3, FR-PLANS-3).
  // The processor was registered above but nothing ever added a job, so in a
  // real install a plan item could never reach `done` or `regressed`: users
  // cannot set those by hand, only this job can. Scheduled after the reconcile
  // sweep (03:17), whose snapshots are what it reads. One job covers every
  // workspace; the repeat key keeps it to one schedule across replicas.
  const plansVerifyCron = process.env.PLANS_VERIFY_CRON ?? '47 5 * * *';
  if (plansVerifyCron !== 'off') {
    await createQueue(QUEUE.plansVerify, connection).add(
      'verify',
      {},
      { repeat: { pattern: plansVerifyCron }, jobId: 'plans-verify-nightly' },
    );
  }
  log.info(
    `[worker] nightly plan verification: ${plansVerifyCron === 'off' ? 'disabled' : plansVerifyCron}`,
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
  log.info(
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
  log.info(
    `[worker] monthly secrets history sweep: ${historyCron === 'off' ? 'disabled' : historyCron}`,
  );

  // The weekly security pass (SECURITY_SUITE §4): a full semgrep scan and a
  // chain recompute, per repo. Two scanners, ONE schedule — a chain built from
  // findings a full scan is about to replace is a chain about last week.
  // Chainer runs an hour later for exactly that reason.
  const weeklyCron = process.env.SECURITY_WEEKLY_CRON ?? '41 2 * * 0';
  // NIGHTLY, not weekly (D13): a runtime crossing its EOL date and a package
  // being deprecated are both things that happen on a date rather than on a
  // commit, so a weekly cadence would report them up to six days late.
  const registersCron = process.env.REGISTERS_NIGHTLY_CRON ?? '17 3 * * *';
  const chainCron = process.env.SECURITY_CHAIN_CRON ?? '41 3 * * 0';
  if (weeklyCron !== 'off') {
    for (const [scannerKey, pattern] of [
      ['semgrep', weeklyCron],
      ['code_health_tools', weeklyCron],
      // W16-36. The CVE scan rides the same weekly slot as code health: both
      // want a snapshot of the same commit, and taking two tarballs for one
      // tree would be a rate-limit cost with nothing to show for it.
      ['dependency_cve', weeklyCron],
      // W9-06: one entry drives both deterministic code-health scanners; they
      // share a snapshot, and taking two would double the forge cost of the
      // same commit.
      ['anti_slop', weeklyCron],
      ['attack_chainer', chainCron],
      ['supply_chain_register', registersCron],
      ['architecture_register', registersCron],
      ['test_gap_register', registersCron],
      // Weekly, not nightly: it drafts from a 30-day window of dismissals, and
      // a nightly pass would re-draft the same clusters six times before
      // anyone had opened the workbench. W22-06: the same job also turns the
      // AI judge's stored false-positive verdicts into rule-tweak proposals.
      // On the chain slot, an hour after the weekly sweep: it calls the same
      // model as anti-slop's judgement, and starting with the sweep it took
      // the model first (2026-10-30). It reads stored findings, so later is fine.
      ['rule_draft_pass', chainCron],
      ['knowledge_register', registersCron],
      // W18-24. Nightly with the registers: alerts change when someone's CI
      // runs, not on our weekly cadence, and the pull is one read per repo.
      ['code_scanning_pull', registersCron],
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
  log.info(
    `[worker] weekly security pass: ${weeklyCron === 'off' ? 'disabled' : `${weeklyCron} (semgrep), ${chainCron} (chains)`}`,
  );

  // 3301 — see the note beside the API port; 3001 is the neighbour every 3000
  // picks and was already taken on this machine.
  const healthPort = Number(process.env.WORKER_HEALTH_PORT ?? 3301);
  const healthServer = startWorkerHealthServer({
    db,
    redis: healthRedis,
    registry: metricsRegistry,
    port: healthPort,
    host: listenHost(),
  });

  // AFTER the consumers exist (W17-06). The heartbeat asserts "this instance can
  // pick up work", so publishing it during startup would state something untrue
  // for as long as the boot took. Its key is per-instance, so one worker
  // stopping cannot erase another's.
  // W20-16 (UX_TODO AI-73/74): look for the Claude Code CLI from HERE, the
  // container that runs it, and publish what was found with the heartbeat.
  // Presence and `auth status` only — no model call. Re-checked every ten
  // minutes so a volume dropped by a restart without the overlay shows up in
  // System health instead of as failing passes.
  let workerCli: WorkerCliStatus | undefined;
  const checkCli = async () => {
    try {
      const st = await claudeCliStatus();
      workerCli = { ...st, checkedAt: new Date().toISOString() };
    } catch (err) {
      log.warn({ err }, '[worker] claude cli status check failed');
    }
  };
  void checkCli();
  const cliTimer = setInterval(() => void checkCli(), 10 * 60 * 1000);
  cliTimer.unref?.();

  const heartbeat = startWorkerHeartbeat({
    redis: healthRedis,
    queues: [...runtime.queues.keys()],
    onError: (err) => log.warn({ err }, '[worker] heartbeat write failed'),
    claudeCli: () => workerCli,
  });

  // The AI-pass scheduler (W19-12). Strictly opt-in: it only ever acts on a
  // schedule an admin enabled for a repository AFTER acknowledging where source
  // is sent, so with nothing enabled a tick reads one empty query and does
  // nothing. AI_PASS_SCHEDULER=off removes even that. The first tick is one
  // interval after boot, never at boot.
  const schedulerOn = (process.env.AI_PASS_SCHEDULER ?? 'on') !== 'off';
  const tickMs = Number(process.env.AI_PASS_SCHEDULER_TICK_MS ?? SCHEDULER_TICK_MS);
  const aiPassQueue = createQueue(QUEUE.aiPass, connection);
  let schedulerRunning = false;
  const schedulerTimer = schedulerOn
    ? setInterval(() => {
        if (schedulerRunning) return;
        schedulerRunning = true;
        runScheduleTick({
          db,
          enqueue: async (data) => {
            await aiPassQueue.add('ai.pass', data, { jobId: `ai-pass-${data.runId}` });
          },
          audit: (event, detail, workspaceId) =>
            auditLog(log, {
              event,
              actorUserId: null,
              workspaceId,
              ip: 'worker',
              ua: null,
              detail,
            }),
        })
          .then((r) => {
            if (r.started + r.skipped > 0) log.info(r, '[worker] ai-pass scheduler tick');
          })
          .catch((err: unknown) => log.warn({ err }, '[worker] ai-pass scheduler tick failed'))
          .finally(() => {
            schedulerRunning = false;
          });
      }, tickMs)
    : null;
  schedulerTimer?.unref();
  log.info(`[worker] ai-pass scheduler: ${schedulerOn ? `every ${tickMs} ms` : 'disabled'}`);

  runtime.coordinator.installSignalHandlers({
    onTimeout: () => log.warn('[worker] drain timed out — forcing close, jobs resume from cursor'),
  });
  process.once('SIGTERM', () => {
    if (schedulerTimer) clearInterval(schedulerTimer);
    clearInterval(cliTimer);
    void aiPassQueue.close().catch(() => {});
    sweeper.stop();
    healthServer.close();
    // Remove the heartbeat BEFORE dropping the connection it needs, so a clean
    // stop is visible immediately instead of lingering for the TTL.
    void heartbeat
      .stop()
      .catch(() => {})
      .finally(() => {
        void connection.quit().catch(() => {});
        void publisher.quit().catch(() => {});
        void healthRedis.quit().catch(() => {});
      });
  });

  log.info(`[worker] runtime up; healthz on :${healthPort}; heartbeat ${heartbeat.instanceId}`);
}

// Only run when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    log.error({ err }, '[worker] fatal');
    process.exit(1);
  });
}
