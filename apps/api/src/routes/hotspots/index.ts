import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { core, type Database } from '@repopulse/shared';
import { rankHotspots } from '@repopulse/insights';
import { sendProblem } from '../../lib/problem.js';

// Cross-repo hotspot ranking (FR-INSIGHTS-5, FR-API-2). Warehouse-only —
// rankHotspots reads commit_files/commits (no forge). Session-authed.

export interface HotspotsRoutesOptions {
  db: Database;
}

const WINDOW_DAYS: Record<string, number> = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 };

const hotspotsQuery = z.object({
  window: z.enum(['7d', '30d', '90d', '365d']).default('30d'),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

function fail(
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  title: string,
): FastifyReply {
  sendProblem(req, reply, status, title);
  return reply;
}

export default async function hotspotsRoutes(
  app: FastifyInstance,
  opts: HotspotsRoutesOptions,
): Promise<void> {
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.get('/hotspots', { schema: { querystring: hotspotsQuery } }, async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
    const { window, limit } = request.query;

    const repos = await opts.db
      .select({ id: core.repos.id })
      .from(core.repos)
      .where(eq(core.repos.workspaceId, workspaceId));

    const ranked = await rankHotspots(opts.db, {
      repoIds: repos.map((r) => r.id),
      asOf: new Date(),
      windowDays: WINDOW_DAYS[window] ?? 30,
      topN: limit,
    });
    return reply.send({ items: ranked });
  });
}
