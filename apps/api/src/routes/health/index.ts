import { Redis } from 'ioredis';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Database } from '@repopulse/shared';
import { sendProblem } from '../../lib/problem.js';

export interface HealthRoutesOptions {
  db: Database;
  redisUrl: string;
}

/**
 * Deadline for each dependency probe (W17-06), matching the worker's.
 *
 * A REFUSED connection rejects at once. A HUNG one — dropped NAT entry, paused
 * VM, a server that accepted the socket and stopped reading — never settles, so
 * without a deadline /healthz simply never responds and the container
 * healthcheck reports a timeout while this process holds the socket open.
 */
export const HEALTH_PROBE_TIMEOUT_MS = 2_000;

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

// DEPLOYMENT.md §7 / API_DESIGN.md §5: unauthenticated liveness with
// Postgres + Redis dependency checks. FR-API-4's route-walker exempts
// /healthz the same way it exempts /auth/* and /webhooks/* (W1-07,
// packages/shared/src/testing/route-walker.ts's DEFAULT_EXEMPT_PREFIXES
// already lists /healthz - no change needed there since the URL doesn't
// move, only which module owns the handler).
async function healthRoutes(app: FastifyInstance, opts: HealthRoutesOptions): Promise<void> {
  // Own connection, not the session plugin's internal client (packages/auth
  // doesn't expose it) - cheap enough that a second connection is simpler
  // than plumbing one through.
  const healthzRedis = new Redis(opts.redisUrl, { lazyConnect: true });
  app.addHook('onClose', async () => {
    await healthzRedis.quit().catch(() => {});
  });

  app.get('/healthz', async (request, reply) => {
    const [dbOk, redisOk] = await Promise.all([
      withDeadline(opts.db.execute(sql`select 1`), HEALTH_PROBE_TIMEOUT_MS),
      withDeadline(healthzRedis.ping(), HEALTH_PROBE_TIMEOUT_MS),
    ]);
    if (!dbOk || !redisOk) {
      return sendProblem(request, reply, 503, 'Service Unavailable', {
        detail: `postgres=${dbOk ? 'ok' : 'down'} redis=${redisOk ? 'ok' : 'down'}`,
      });
    }
    return reply.send({ status: 'ok' });
  });
}

export default healthRoutes;
