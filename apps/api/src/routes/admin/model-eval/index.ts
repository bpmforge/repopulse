import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { core, type Database } from '@repopulse/shared';
import { SPECIALIST_IDS, specialistById } from '@repopulse/analysis';
import { MODEL_EVAL_RESULTS } from '@repopulse/security';
import { requireAdmin } from '../../../lib/rbac.js';
import { sendProblem } from '../../../lib/problem.js';

// Settings → Models → per-model quality (W19-05).
//
// The committed evaluation results (packages/security/src/eval), joined to this
// workspace's configured models so the table answers "how good is the model I
// am actually using" — and says "not yet run" for a configured model nobody has
// measured, rather than leaving it off the page.

export interface ModelEvalRoutesOptions {
  db: Database;
}

function fail(
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  title: string,
): FastifyReply {
  sendProblem(req, reply, status, title, {});
  return reply;
}

export default async function modelEvalRoutes(
  app: FastifyInstance,
  opts: ModelEvalRoutesOptions,
): Promise<void> {
  const { db } = opts;

  app.get('/admin/model-eval', { preHandler: requireAdmin }, async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');

    const providers = await db
      .select({ name: core.llmProviders.name, model: core.llmProviders.model })
      .from(core.llmProviders)
      .where(eq(core.llmProviders.workspaceId, workspaceId));

    const measured = new Map(MODEL_EVAL_RESULTS.rows.map((r) => [r.model, r]));
    const configured = new Set(providers.map((p) => p.model));

    return reply.send({
      roles: SPECIALIST_IDS.map((id) => ({ id, label: specialistById(id).label })),
      models: [
        // Configured models first, measured or not.
        ...providers.map((p) => ({
          model: p.model,
          provider_name: p.name,
          configured: true,
          result: measured.get(p.model) ?? null,
        })),
        // Then models that have a published result but are not configured here.
        ...MODEL_EVAL_RESULTS.rows
          .filter((r) => !configured.has(r.model))
          .map((r) => ({ model: r.model, provider_name: null, configured: false, result: r })),
      ],
    });
  });
}
