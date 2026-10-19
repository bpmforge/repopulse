import { sql, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';
import { core, security, type Database } from '@repopulse/shared';
import { orgSyncStatus, type SyncStatusPhase } from '@repopulse/ingest';
import { requireAdmin } from '../../../lib/rbac.js';
import { sendProblem } from '../../../lib/problem.js';
import { readWorkerHeartbeats } from '../../../workers/heartbeat.js';

// GET /admin/system (W17-06/W17-07) — "is this install actually working?"
//
// WHY THIS IS NOT /setup/status. That endpoint answers "has the operator
// finished configuring this?" — a checklist of things a human still has to do.
// This one answers "is what they configured still running?" A fully configured
// install with a dead worker passes every setup check and ingests nothing.
//
// READ-ONLY, and cheap on purpose. It is polled by the Settings page, so it must
// never trigger a forge call, a paid model test, or a scan. Every component here
// is answered from our own Postgres, our own Redis, or a recorded row. The one
// live thing it does is ping the two dependencies the API already holds
// connections to.

/**
 * `ready`       working, nothing to do
 * `degraded`    working, but something is wrong or stale
 * `unavailable` not working
 * `unknown`     we genuinely cannot tell — never a synonym for "fine"
 *
 * `setup_needed` exists so an install that has simply not been configured yet
 * is never painted as broken. A fresh install with no forge connected and no
 * model is working exactly as intended — it just has nothing to show. Reporting
 * that as `unavailable` teaches operators to ignore red, which is the one
 * outcome this endpoint cannot afford.
 *
 * It therefore ranks BELOW `unknown`/`degraded`/`unavailable` in `RANK`, so a
 * missing optional model cannot make a healthy install look broken overall.
 */
export type ComponentState = 'ready' | 'degraded' | 'unavailable' | 'unknown' | 'setup_needed';

export interface SystemComponent {
  id: string;
  label: string;
  state: ComponentState;
  /** Plain language, for a human who is not holding the source. */
  reason: string;
  /** ISO, or null when nothing has ever succeeded. Never a zero date. */
  lastSuccessAt: string | null;
  /** An in-product path the operator can act on, or null. */
  action: { label: string; href: string } | null;
}

export interface SystemStatusResponse {
  checkedAt: string;
  /** Worst state across components — the one thing a badge can show. */
  overall: ComponentState;
  components: SystemComponent[];
}

export interface SystemRoutesOptions {
  db: Database;
  redisUrl: string;
  /** Injected so a test can supply a stub or a broken client. */
  redis?: Redis;
  /** Injected so a test can drive the clock. */
  now?: () => Date;
}

/** Probe deadline. Matches the health routes: a hung socket must not hang this. */
const PROBE_TIMEOUT_MS = 2_000;

function withDeadline<T>(probe: Promise<T>, ms: number): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    probe.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/**
 * Freshness threshold for recorded evidence.
 *
 * 24 hours, documented as a UI freshness hint and NOT a security guarantee:
 * "we have not measured this recently" is all it means.
 */
export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;

/**
 * Every in-product link this endpoint can hand out (W20-04, UX_TODO ADM-03).
 *
 * In one place so a test can hold each `href` against the web app's real
 * route list: three of them pointed at /admin/ops and /admin/connections,
 * which never existed, so the links shown when something is BROKEN were the
 * ones that led to "Page not found". There is no in-product log viewer, so a
 * dead dependency names the container whose logs to read in its reason
 * instead of offering a link to nowhere.
 */
export const SYSTEM_ACTIONS = {
  connections: { label: 'Connections', href: '/admin/' },
  connect: { label: 'Connect a forge', href: '/admin/' },
  analysis: { label: 'Analysis settings', href: '/admin/analysis' },
  models: { label: 'Models', href: '/admin/models' },
} as const satisfies Record<string, { label: string; href: string }>;

/** Where to look when a container is the problem — no page exists for it. */
function logsHint(service: string): string {
  return ` On the server, \`docker compose logs ${service}\` (or podman) shows why.`;
}

const RANK: Record<ComponentState, number> = {
  ready: 0,
  setup_needed: 1,
  unknown: 2,
  degraded: 3,
  unavailable: 4,
};

export function worstState(states: ComponentState[]): ComponentState {
  return states.reduce<ComponentState>((worst, s) => (RANK[s] > RANK[worst] ? s : worst), 'ready');
}

export default async function systemRoutes(
  app: FastifyInstance,
  opts: SystemRoutesOptions,
): Promise<void> {
  const db = opts.db;
  const now = opts.now ?? (() => new Date());

  // Its own connection, lazily, exactly as routes/health does — packages/auth
  // does not expose the session client, and a second connection is simpler than
  // plumbing one through. `lazyConnect` matters here: this route must not make
  // building the app depend on Redis being up.
  const redis = opts.redis ?? new Redis(opts.redisUrl, { lazyConnect: true });
  const ownsRedis = opts.redis === undefined;
  if (ownsRedis) {
    // Without a listener ioredis prints "[ioredis] Unhandled error event" and,
    // for a bare client, that is the whole of the reporting (W17-03).
    redis.on('error', (err: Error) => app.log.warn({ err }, 'system-status redis error'));
    app.addHook('onClose', async () => {
      await redis.quit().catch(() => redis.disconnect());
    });
  }

  app.get('/admin/system', { preHandler: requireAdmin }, async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) {
      sendProblem(request, reply, 401, 'No active session');
      return reply;
    }

    const at = now();
    const components: SystemComponent[] = [];

    // ---- database ---------------------------------------------------------
    const dbOk = await withDeadline(db.execute(sql`select 1`), PROBE_TIMEOUT_MS);
    components.push({
      id: 'database',
      label: 'Database',
      state: dbOk === null ? 'unavailable' : 'ready',
      reason:
        dbOk === null
          ? `Postgres did not answer within ${PROBE_TIMEOUT_MS / 1000}s. Nothing can be read or stored until it does.${logsHint('postgres')}`
          : 'Postgres is answering.',
      lastSuccessAt: dbOk === null ? null : at.toISOString(),
      action: null,
    });

    // ---- cache / queue transport ------------------------------------------
    const redisOk = await withDeadline(redis.ping(), PROBE_TIMEOUT_MS);
    components.push({
      id: 'cache',
      label: 'Cache and job queue',
      state: redisOk === null ? 'unavailable' : 'ready',
      reason:
        redisOk === null
          ? `Redis did not answer within ${PROBE_TIMEOUT_MS / 1000}s. Sessions and every background job stop with it.${logsHint('redis')}`
          : 'Redis is answering.',
      lastSuccessAt: redisOk === null ? null : at.toISOString(),
      action: null,
    });

    // ---- worker -----------------------------------------------------------
    //
    // The component this endpoint exists for. /healthz proves a process is
    // serving; only the heartbeat proves a queue consumer is alive, and it is
    // the one signal the API can actually see.
    const beats = redisOk === null ? [] : await readWorkerHeartbeats(redis).catch(() => []);
    const workerState: ComponentState =
      redisOk === null ? 'unknown' : beats.length > 0 ? 'ready' : 'unavailable';
    components.push({
      id: 'worker',
      label: 'Background worker',
      state: workerState,
      reason:
        workerState === 'unknown'
          ? 'Cannot tell: the heartbeat lives in Redis, which is not answering.'
          : beats.length > 0
            ? `${beats.length} worker ${beats.length === 1 ? 'instance is' : 'instances are'} running and consuming queues.`
            : `No worker has published a heartbeat in the last minute. Ingestion, scans and reports will queue up and never run.${logsHint('worker')}`,
      lastSuccessAt: beats[0]?.lastBeatAt ?? null,
      action: null,
    });

    // ---- forge sync -------------------------------------------------------
    //
    // Recorded rows only, through the EXISTING producer. Calling the forge here
    // would spend the operator's rate-limit budget every time an admin opened a
    // settings page, and orgSyncStatus is already the one place that decides
    // what "syncing" means — a second opinion here would eventually disagree
    // with the banner the user is looking at.
    const connections = await db
      .select({
        id: core.forgeConnections.id,
        provider: core.forgeConnections.provider,
        status: core.forgeConnections.status,
      })
      .from(core.forgeConnections)
      .where(eq(core.forgeConnections.workspaceId, workspaceId))
      .limit(50);

    if (connections.length === 0) {
      components.push({
        id: 'forge',
        label: 'Forge connection',
        // NOT unavailable: a fresh install with nothing connected is working
        // exactly as intended. It has nothing to show, which is different.
        state: 'setup_needed',
        reason:
          'No forge is connected yet, so there is nothing to measure. Sign-in and administration work without one.',
        lastSuccessAt: null,
        action: SYSTEM_ACTIONS.connect,
      });
    } else {
      const broken = connections.filter((c) => c.status !== 'active');
      const sync = await orgSyncStatus(db, workspaceId).catch(() => null);

      // Map the sync phase onto a component state. 'queued' and 'history' are a
      // backfill in progress — normal, not a fault.
      const PHASE_STATE: Record<SyncStatusPhase, ComponentState> = {
        live: 'ready',
        enrichment: 'ready',
        history: 'ready',
        queued: 'ready',
        paused: 'degraded',
        paused_budget: 'degraded',
        error: 'unavailable',
      };
      const phaseState: ComponentState =
        sync === null ? 'unknown' : sync.repoCount === 0 ? 'setup_needed' : PHASE_STATE[sync.phase];

      const state: ComponentState =
        broken.length > 0 && RANK['degraded'] > RANK[phaseState] ? 'degraded' : phaseState;

      components.push({
        id: 'forge',
        label: 'Forge connection',
        state,
        reason:
          broken.length > 0
            ? `${broken.length} of ${connections.length} connections are not active (${[...new Set(broken.map((c) => c.status))].join(', ')}). Re-authorise them or the data behind them stops updating.`
            : sync === null
              ? 'Connected, but the sync state could not be read.'
              : sync.repoCount === 0
                ? 'Connected, but no repositories are selected yet — so there is still nothing to measure.'
                : sync.phase === 'error'
                  ? 'Connected, but at least one repository is failing to sync. Its data is frozen at the last success.'
                  : sync.phase === 'paused_budget'
                    ? 'Paused against the forge rate-limit budget. This is the budget working, not a fault; it resumes on its own.'
                    : sync.phase === 'paused'
                      ? 'Sync is paused.'
                      : `Connected, ${sync.repoCount} repositories, ${sync.percentComplete}% complete (${sync.phase}).`,
        // Deliberately null rather than "now": the sync producer reports a
        // phase and a lag, not a last-success timestamp, and inventing one
        // here would be a number nothing measured.
        lastSuccessAt: null,
        action: SYSTEM_ACTIONS.connections,
      });
    }

    // ---- scanners ---------------------------------------------------------
    const [scanAgg] = await db
      .select({
        lastSuccess: sql<
          string | null
        >`max(${security.scanRuns.finishedAt}) filter (where ${security.scanRuns.status} = 'succeeded')`,
        failed: sql<number>`count(*) filter (where ${security.scanRuns.status} = 'failed')::int`,
        total: sql<number>`count(*)::int`,
      })
      .from(security.scanRuns)
      .where(eq(security.scanRuns.workspaceId, workspaceId));

    const scanLastSuccess = scanAgg?.lastSuccess ?? null;
    const scanState: ComponentState =
      (scanAgg?.total ?? 0) === 0
        ? 'setup_needed'
        : scanLastSuccess === null
          ? 'unavailable'
          : (scanAgg?.failed ?? 0) > 0
            ? 'degraded'
            : 'ready';
    components.push({
      id: 'scanners',
      label: 'Security and code-health scanners',
      state: scanState,
      reason:
        scanState === 'setup_needed'
          ? 'No scan has ever run. A repository with no findings looks exactly like a clean one until a scan has actually completed.'
          : scanState === 'unavailable'
            ? `${scanAgg?.total ?? 0} scan runs recorded and not one has succeeded.`
            : scanState === 'degraded'
              ? `Some scans are failing (${scanAgg?.failed} of ${scanAgg?.total}). Earlier successful results are still shown and are still real.`
              : 'Scans are completing.',
      lastSuccessAt: scanLastSuccess ? new Date(scanLastSuccess).toISOString() : null,
      action: SYSTEM_ACTIONS.analysis,
    });

    // ---- models -----------------------------------------------------------
    //
    // Configured is read from the database. Whether the endpoint ANSWERS is not
    // asked here: that is a paid network call on some providers, and this route
    // is polled. The Models screen has an explicit "test" button for that.
    const providers = await db
      .select({
        id: core.llmProviders.id,
        name: core.llmProviders.name,
        kind: core.llmProviders.kind,
        enabled: core.llmProviders.enabled,
      })
      .from(core.llmProviders)
      .where(eq(core.llmProviders.workspaceId, workspaceId));

    const enabled = providers.filter((p) => p.enabled);
    components.push({
      id: 'models',
      label: 'AI review models',
      state: providers.length === 0 ? 'setup_needed' : enabled.length === 0 ? 'degraded' : 'ready',
      reason:
        providers.length === 0
          ? 'No model configured. This is OPTIONAL — delivery metrics, hotspots and deterministic scanners all work without one. Only AI code review is unavailable.'
          : enabled.length === 0
            ? `${providers.length} configured, none enabled. AI review will not run.`
            : `${enabled.length} of ${providers.length} enabled (${[...new Set(enabled.map((p) => p.kind))].join(', ')}).`,
      lastSuccessAt: null,
      action: SYSTEM_ACTIONS.models,
    });

    const body: SystemStatusResponse = {
      checkedAt: at.toISOString(),
      // A missing optional model must not turn the whole install red, so the
      // states that mean "you have not set this up" rank below the ones that
      // mean "this is broken".
      overall: worstState(components.map((c) => c.state)),
      components,
    };
    return reply.send(body);
  });
}
