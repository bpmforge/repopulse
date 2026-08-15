import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { auditLog, core, type Database } from '@repopulse/shared';
import { requireAdmin } from '../../../lib/rbac.js';
import { sendProblem } from '../../../lib/problem.js';
import {
  SETTINGS_DEFAULTS,
  applyDefaults,
  readWorkspaceSettings,
  workspaceSettingsSchema,
} from '../../../lib/workspace-settings.js';

// GET/PATCH /admin/workspace (W4-09, API_DESIGN.md §2 "admin"). The knobs that
// change what every metric counts: health-score weights (FR-INSIGHTS-2),
// bot-login globs and stale-PR N (FR-METRICS-8), forge budget share/floor
// (FR-FORGE-3).
//
// PATCH is a MERGE over the stored jsonb, not a replace: the LLM settings
// (LM host list, concurrency cap, T3 monthly cap) render as disabled
// placeholders until W6/W7, and a naive `.set({ settings: body })` would
// delete any key this wave does not know about the moment an admin saved a
// weight. The schema is deliberately narrow; the write must not be.
//
// ERROR RETURNS: sendProblem sends AND the handler must return the reply —
// `return sendProblem(...)` returns void after sending, so Fastify serialises
// `undefined` and sends a second time. Same trap documented in ../index.ts.

export interface WorkspaceRoutesOptions {
  db: Database;
}

export default async function workspaceRoutes(
  app: FastifyInstance,
  opts: WorkspaceRoutesOptions,
): Promise<void> {
  /** GET /admin/workspace — stored values, what is in effect, and the defaults. */
  app.get('/admin/workspace', { preHandler: requireAdmin }, async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) {
      sendProblem(request, reply, 401, 'No active session');
      return reply;
    }

    const { stored, effective } = await readWorkspaceSettings(opts.db, workspaceId);
    return reply.send({
      // `stored` is what an admin actually chose; `effective` is what the
      // engines use. The screen labels a value as a default only when the key
      // is absent from `stored`, so "the default happens to be 7" and "an admin
      // typed 7" stay distinguishable — that difference is the whole reason the
      // schema keys are optional.
      stored,
      effective,
      defaults: SETTINGS_DEFAULTS,
      /** Rendered disabled until the analysis wave (W6/W7) supplies them. */
      pending: ['lm_hosts', 'lm_concurrency_cap', 'tier3_monthly_usd_cap'],
    });
  });

  /** PATCH /admin/workspace — merge a partial settings object. */
  app.patch<{ Body: unknown }>(
    '/admin/workspace',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) {
        sendProblem(request, reply, 401, 'No active session');
        return reply;
      }

      const parsed = workspaceSettingsSchema.safeParse(request.body ?? {});
      if (!parsed.success) {
        const first = parsed.error.issues[0];
        sendProblem(request, reply, 400, 'Invalid workspace settings', {
          detail: first ? `${first.path.join('.') || 'body'}: ${first.message}` : 'invalid body',
        });
        return reply;
      }

      const { stored: before } = await readWorkspaceSettings(opts.db, workspaceId);
      const merged = { ...before, ...parsed.data };

      const [row] = await opts.db
        .update(core.workspaces)
        .set({ settings: merged })
        .where(eq(core.workspaces.id, workspaceId))
        .returning({ settings: core.workspaces.settings });
      if (!row) {
        sendProblem(request, reply, 404, 'Workspace not found');
        return reply;
      }

      // SC-22. The KEYS that changed, never a dump of the settings object: a
      // future key could carry a credential (the LM host list is already
      // planned), and an audit stream is exactly where that must not land.
      auditLog(request.log, {
        event: 'workspace.settings.updated',
        actorUserId: request.session?.get('userId') ?? null,
        workspaceId,
        ip: request.ip,
        ua: request.headers['user-agent'] ?? null,
        changedKeys: Object.keys(parsed.data),
      });

      const stored = workspaceSettingsSchema.parse(row.settings);
      return reply.send({
        stored,
        effective: applyDefaults(stored),
        defaults: SETTINGS_DEFAULTS,
      });
    },
  );
}
