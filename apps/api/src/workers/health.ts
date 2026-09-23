import { createServer, type Server } from 'node:http';
import { sql } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import type { Registry } from 'prom-client';
import type { Database } from '@repopulse/shared';

// Worker liveness (DEPLOYMENT.md §7, NFR-12): the worker process is not a
// Fastify app, so it runs a tiny node:http server exposing /healthz (Postgres +
// Redis dependency checks) and /metrics (the shared registry with the queue
// gauges). Mirrors apps/api's /healthz semantics.

export interface WorkerHealth {
  postgres: boolean;
  redis: boolean;
  ok: boolean;
}

/**
 * Deadline for each dependency probe (W17-06).
 *
 * WITHOUT this, "is Postgres up?" has no answer in the one case that matters. A
 * refused connection rejects immediately and is easy; a HUNG one — a dropped
 * NAT entry, a paused VM, a server that accepted the socket and stopped
 * reading — never settles at all. `select 1` then waits forever, the /healthz
 * request never responds, and the container healthcheck reports a timeout while
 * the process holds the socket open. The probe has to fail on its own terms.
 *
 * Two seconds: far longer than a healthy local query, far shorter than the 5s
 * timeout on the container healthcheck that calls this.
 */
export const HEALTH_PROBE_TIMEOUT_MS = 2_000;

/**
 * Resolve `false` if the probe has not settled in time.
 *
 * The timer is cleared on both paths — an uncleared timer would keep the
 * process alive past shutdown, which is exactly the kind of leak that makes a
 * container refuse to stop.
 */
function withDeadline(probe: Promise<unknown>, ms: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    probe.then(
      () => {
        clearTimeout(timer);
        resolve(true);
      },
      () => {
        clearTimeout(timer);
        resolve(false);
      },
    );
  });
}

export async function checkWorkerHealth(
  db: Database,
  redis: Redis,
  timeoutMs: number = HEALTH_PROBE_TIMEOUT_MS,
): Promise<WorkerHealth> {
  // NOTE what is deliberately NOT checked here: whether a model is configured.
  // Tier-1 ingestion needs no LLM at all, so an install with no analysis
  // provider is a WORKING install. Folding that into liveness would restart a
  // perfectly good worker (docs/NON_GOALS.md, D2).
  const [postgres, redisOk] = await Promise.all([
    withDeadline(db.execute(sql`select 1`), timeoutMs),
    withDeadline(redis.ping(), timeoutMs),
  ]);
  return { postgres, redis: redisOk, ok: postgres && redisOk };
}

export interface WorkerHealthServerOptions {
  db: Database;
  redis: Redis;
  registry: Registry;
  port: number;
  /** Interface to bind; loopback unless the caller says otherwise (W17-37). */
  host?: string;
}

export function startWorkerHealthServer(opts: WorkerHealthServerOptions): Server {
  const server = createServer((req, res) => {
    if (req.url === '/healthz') {
      // `.catch` on both, because an unhandled rejection in a bare `void
      // promise.then()` takes the whole worker down under Node's default
      // policy — the health endpoint must never be the thing that kills the
      // process it reports on.
      void checkWorkerHealth(opts.db, opts.redis).then(
        (h) => {
          res.writeHead(h.ok ? 200 : 503, { 'content-type': 'application/json' });
          res.end(JSON.stringify(h));
        },
        () => {
          res.writeHead(503, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ postgres: false, redis: false, ok: false }));
        },
      );
      return;
    }
    if (req.url === '/metrics') {
      void opts.registry.metrics().then(
        (body) => {
          res.writeHead(200, { 'content-type': opts.registry.contentType });
          res.end(body);
        },
        () => {
          res.writeHead(500, { 'content-type': 'text/plain' });
          res.end('metrics unavailable');
        },
      );
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(opts.port, opts.host ?? '127.0.0.1');
  return server;
}
