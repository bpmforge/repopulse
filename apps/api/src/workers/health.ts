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

export async function checkWorkerHealth(db: Database, redis: Redis): Promise<WorkerHealth> {
  const [postgres, redisOk] = await Promise.all([
    db
      .execute(sql`select 1`)
      .then(() => true)
      .catch(() => false),
    redis
      .ping()
      .then(() => true)
      .catch(() => false),
  ]);
  return { postgres, redis: redisOk, ok: postgres && redisOk };
}

export interface WorkerHealthServerOptions {
  db: Database;
  redis: Redis;
  registry: Registry;
  port: number;
}

export function startWorkerHealthServer(opts: WorkerHealthServerOptions): Server {
  const server = createServer((req, res) => {
    if (req.url === '/healthz') {
      void checkWorkerHealth(opts.db, opts.redis).then((h) => {
        res.writeHead(h.ok ? 200 : 503, { 'content-type': 'application/json' });
        res.end(JSON.stringify(h));
      });
      return;
    }
    if (req.url === '/metrics') {
      void opts.registry.metrics().then((body) => {
        res.writeHead(200, { 'content-type': opts.registry.contentType });
        res.end(body);
      });
      return;
    }
    res.writeHead(404);
    res.end();
  });
  server.listen(opts.port);
  return server;
}
