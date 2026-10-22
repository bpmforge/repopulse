import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { auditLog, core, plans, type Database } from '@repopulse/shared';
import { recordIntentHotspotScores } from '@repopulse/metrics';
import { sendProblem } from '../../lib/problem.js';
import { intentsWithStatus } from '../../lib/intent-status.js';
import { readWorkspaceSettings } from '../../lib/workspace-settings.js';

// Artifact intents API (W6-07, FR-PLANS-5).

export interface IntentsRoutesOptions {
  db: Database;
}

const INTENTS = ['refactor', 'supervise', 'acknowledged'] as const;

function fail(
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  title: string,
  detail?: string,
): FastifyReply {
  sendProblem(req, reply, status, title, detail === undefined ? {} : { detail });
  return reply;
}

export default async function intentsRoutes(
  app: FastifyInstance,
  opts: IntentsRoutesOptions,
): Promise<void> {
  const { db } = opts;

  /** GET /intents?repo_id= — every intent in scope. */
  app.get<{ Querystring: { repo_id?: string } }>('/intents', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
    const repoId = Number(request.query.repo_id);

    // W20-24 (UX_TODO DSH-37): each intent with whether its hotspot improved
    // since it was declared, from the stored score history.
    const rows = await intentsWithStatus(
      db,
      workspaceId,
      Number.isInteger(repoId) && repoId > 0 ? [repoId] : [],
    );

    return reply.send({
      items: rows.map((r) => ({
        id: r.id,
        repo_id: r.repoId,
        path: r.path,
        intent: r.intent,
        note: r.note,
        warn_after_months: r.warnAfterMonths,
        created_at: r.createdAt.toISOString(),
        hotspot: r.status,
      })),
    });
  });

  /** PUT /intents — set or replace the intent for one file. */
  app.put<{ Body: { repo_id?: unknown; path?: unknown; intent?: unknown; note?: unknown } }>(
    '/intents',
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      const userId = request.session.get('userId');
      if (workspaceId === undefined || userId === undefined) {
        return fail(request, reply, 401, 'No active session');
      }
      const repoId = Number(request.body?.repo_id);
      const path = typeof request.body?.path === 'string' ? request.body.path : '';
      const intent = request.body?.intent;
      if (!Number.isInteger(repoId) || path === '') {
        return fail(request, reply, 400, 'repo_id and path are required');
      }
      if (typeof intent !== 'string' || !INTENTS.includes(intent as (typeof INTENTS)[number])) {
        return fail(
          request,
          reply,
          400,
          'Invalid intent',
          `intent must be one of ${INTENTS.join(', ')}`,
        );
      }
      // Law 5 (W20-24): the repository must be this workspace's. file_intents
      // has no foreign key to repos, so another tenant's id was stored as-is.
      const [repo] = await db
        .select({ id: core.repos.id })
        .from(core.repos)
        .where(and(eq(core.repos.id, repoId), eq(core.repos.workspaceId, workspaceId)))
        .limit(1);
      if (!repo) return fail(request, reply, 404, 'Not Found');

      // One intent per file (DATABASE.md D9 unique key): setting a new one
      // REPLACES the old. Two live intents on one path would make "is this
      // acknowledged?" unanswerable.
      const [row] = await db
        .insert(plans.fileIntents)
        .values({
          workspaceId,
          repoId,
          path,
          intent,
          note: typeof request.body?.note === 'string' ? request.body.note : null,
          createdBy: userId,
        })
        .onConflictDoUpdate({
          target: [plans.fileIntents.workspaceId, plans.fileIntents.repoId, plans.fileIntents.path],
          set: {
            intent,
            note: typeof request.body?.note === 'string' ? request.body.note : null,
            createdBy: userId,
            // Reset the clock: a refactor intent declared today has today's
            // deadline, even on a path someone acknowledged last year.
            createdAt: new Date(),
          },
        })
        .returning();

      // The baseline (W20-24, DSH-37): the file's score as the intent is
      // declared, so the first snapshot after it already has something to be
      // compared with. Best effort — the intent is saved either way.
      try {
        const { effective } = await readWorkspaceSettings(db, workspaceId);
        await recordIntentHotspotScores(db, {
          workspaceId,
          repoId,
          asOf: row!.createdAt,
          botGlobs: effective.botLoginGlobs,
          paths: [path],
        });
      } catch (err) {
        request.log.warn({ err }, 'intent baseline hotspot score not recorded');
      }

      auditLog(request.log, {
        event: 'file.intent_set',
        actorUserId: userId,
        workspaceId,
        ip: request.ip,
        ua: request.headers['user-agent'] ?? null,
        repoId,
        path,
        intent,
      });

      return reply.send({ id: row!.id, path, intent });
    },
  );

  /** DELETE /intents — clear the intent on a file. */
  app.delete<{ Querystring: { repo_id?: string; path?: string } }>(
    '/intents',
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
      const repoId = Number(request.query.repo_id);
      const path = request.query.path ?? '';
      if (!Number.isInteger(repoId) || path === '') {
        return fail(request, reply, 400, 'repo_id and path are required');
      }
      const deleted = await db
        .delete(plans.fileIntents)
        .where(
          and(
            eq(plans.fileIntents.workspaceId, workspaceId),
            eq(plans.fileIntents.repoId, repoId),
            eq(plans.fileIntents.path, path),
          ),
        )
        .returning({ id: plans.fileIntents.id });
      if (deleted.length === 0) return fail(request, reply, 404, 'Not Found');
      return reply.send({ deleted: true, path });
    },
  );
}
