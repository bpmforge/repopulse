import 'dotenv/config';
import { and, desc, eq } from 'drizzle-orm';
import { core, createDb, createLogger, facts, metricsRegistry } from '@repopulse/shared';
import { credentials, workspace as workspaceModule } from '@repopulse/auth';
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
import { startWorkerHeartbeat } from './heartbeat.js';
import { reportProcessor } from './report-processor.js';
import { plansVerifyProcessor } from './plans-processor.js';
import { scanProcessor } from './scan-processor.js';
import { providerForRepo } from './forge-provider.js';
import { runKnowledgeRegister, runTestGapRegister } from '@repopulse/insights';
import { createGatewayResolver, reportGatewayHealth } from './gateway.js';
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
  runLoggingScan,
  runPerfScan,
  snapshotForScan,
  runSecretsHistoryScan,
  runSecretsStreamScan,
  runArchitectureScan,
  runRuleDraftPass,
  runSemgrepFull,
  registerBuiltinScanners,
  runSupplyChainRegisters,
  startSweeper,
  syncEolProducts,
  syncReleaseMeta,
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
  log.info(
    `[worker] default workspace — ${await reportGatewayHealth(bootGateway)}`,
  );

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
        // W8-05: history mode, by scanner key. A map rather than a switch, so
        // FR-SEC-1's "the framework never branches on a scanner key" stays true.
        historyRunners: {
          secrets: async ({ workspaceId, repoId }) => {
            const resolved = await providerForRepo(scanForgeDeps, workspaceId, repoId);
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
              commitSha: sha,
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
          code_health_tools: async ({ workspaceId, repoId }) => {
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
              commitSha: head.sha,
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
          dependency_cve: async ({ workspaceId, repoId }) => {
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
            const result = await runDependencyScan({
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
              // Components the SBOM held that our own reader could not scope.
              // Carried rather than dropped: a CVE count over an unstated
              // fraction of a dependency tree is a number with no denominator.
              deferred: Math.max(0, result.componentsScanned - result.syncableComponents),
              ...(result.error ? { error: result.error } : {}),
            };
          },
          // W9-06: the weekly deterministic pass for the two scanners whose
          // judgement halves need a gateway. LDR, docstring inflation and the
          // logging pack are arithmetic and patterns — they need a snapshot,
          // not a model — so they run here and the judgement layer stays on
          // the pull-request path where a gateway already exists.
          anti_slop: async ({ workspaceId, repoId }) => {
            // THIS WORKSPACE'S gateway (W16-19), resolved here because here is
            // where the workspace is known. Cached by the resolver, so the two
            // scanners below share one build rather than each paying for a
            // credential decrypt.
            const analysisGateway = await gateways.for(workspaceId);
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

            return snapshotForScan(
              {
                provider: resolved.provider,
                repo: resolved.repoFullName,
                commitSha: head.sha,
              },
              async (snapshot) => {
                const sources = readSnapshotSources(snapshot.dir);
                const [slop, logging] = [
                  await runAntiSlopScan({
                    db,
                    workspaceId,
                    repoId,
                    commitSha: head.sha,
                    files: [],
                    sources: sources.files,
                    trigger: 'schedule',
                    // THE JUDGEMENT HALF, finally reachable. It was written,
                    // tested against a stub and shipped with no gateway to
                    // call — `deps.gateway ? ... : { chunks: [] }` meant every
                    // scheduled run reported judgment: 0 and nobody noticed,
                    // because that is also what a clean repository looks like.
                    ...(analysisGateway ? { gateway: analysisGateway.gateway } : {}),
                  }),
                  await runLoggingScan({
                    db,
                    workspaceId,
                    repoId,
                    commitSha: head.sha,
                    files: [],
                    targetDir: snapshot.dir,
                    trigger: 'schedule',
                    ...(analysisGateway ? { gateway: analysisGateway.gateway } : {}),
                  }),
                ];
                // W9-13. Third scan on the SAME snapshot: the perf pack needs a
                // tree, and a second tarball for eight structural rules would
                // be a rate-limit cost with nothing to show for it. It has no
                // judgement half, so it needs no gateway.
                const perf = await runPerfScan({
                  db,
                  workspaceId,
                  repoId,
                  commitSha: head.sha,
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
              .where(and(eq(security.sboms.workspaceId, workspaceId), eq(security.sboms.repoId, repoId)))
              .orderBy(desc(security.sboms.createdAt))
              .limit(1);
            // No SBOM means W8-06 has not run — it is blocked for missing
            // syft. Reported by name so an empty Supply Chain tab never reads
            // as "no dependency problems".
            if (!sbom) return { scanned: 0, findingsCreated: 0, deferred: 0, skipped: 'no_sbom' };

            const fetchJson = jsonFetcher();
            const components = readComponents(sbom.document);
            const byPackage = new Map<string, { ecosystem: 'npm' | 'pypi'; name: string; installedVersions: string[] }>();
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
                    { provider: resolved.provider, repo: resolved.repoFullName, commitSha: head.sha },
                    async (snapshot) => run(snapshot.dir),
                  )
                : await run();

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
          architecture_register: async ({ workspaceId, repoId }) => {
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
            const result = await runArchitectureScan({
              db,
              provider: resolved.provider,
              workspaceId,
              repoId,
              repo: resolved.repoFullName,
              commitSha: head.sha,
            });
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
            const analysisGateway = await gateways.for(workspaceId);
            const result = await runRuleDraftPass({
              db,
              workspaceId,
              ...(analysisGateway ? { gateway: analysisGateway.gateway } : {}),
            });
            return {
              scanned: result.clusters,
              findingsCreated: result.drafted,
              // Drafts the validator threw out, carried rather than logged:
              // a pass that rejected everything must not read as a quiet one.
              deferred: result.rejected,
              ...(result.error ? { error: result.error } : {}),
              ...(result.skippedReason ? { skipped: result.skippedReason } : {}),
            };
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
        printBaseUrl: process.env.PUBLIC_BASE_URL ?? 'http://localhost:5273',
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
  log.info(`[worker] snapshot sweep on boot: removed ${sweptOnBoot.removed.length}, in flight ${sweptOnBoot.keptInFlight}`);

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
  log.info(`[worker] monthly secrets history sweep: ${historyCron === 'off' ? 'disabled' : historyCron}`);

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
      // anyone had opened the workbench.
      ['rule_draft_pass', weeklyCron],
      ['knowledge_register', registersCron],
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
  });

  // AFTER the consumers exist (W17-06). The heartbeat asserts "this instance can
  // pick up work", so publishing it during startup would state something untrue
  // for as long as the boot took. Its key is per-instance, so one worker
  // stopping cannot erase another's.
  const heartbeat = startWorkerHeartbeat({
    redis: healthRedis,
    queues: [...runtime.queues.keys()],
    onError: (err) => log.warn({ err }, '[worker] heartbeat write failed'),
  });

  runtime.coordinator.installSignalHandlers({
    onTimeout: () =>
      log.warn('[worker] drain timed out — forcing close, jobs resume from cursor'),
  });
  process.once('SIGTERM', () => {
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

  log.info(
    `[worker] runtime up; healthz on :${healthPort}; heartbeat ${heartbeat.instanceId}`,
  );
}

// Only run when executed directly (not when imported by tests).
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err: unknown) => {
    log.error({ err }, '[worker] fatal');
    process.exit(1);
  });
}
