import { Redis } from 'ioredis';
import { sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Database } from '@repopulse/shared';
import { sendProblem } from '../../lib/problem.js';

export interface HealthRoutesOptions {
  db: Database;
  redisUrl: string;
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
      opts.db
        .execute(sql`select 1`)
        .then(() => true)
        .catch(() => false),
      healthzRedis
        .ping()
        .then(() => true)
        .catch(() => false),
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
