import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { auditLog, plans, type Database } from '@repopulse/shared';
import { sendProblem } from '../../lib/problem.js';

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

    const rows = await db
      .select()
      .from(plans.fileIntents)
      .where(
        Number.isInteger(repoId)
          ? and(eq(plans.fileIntents.workspaceId, workspaceId), eq(plans.fileIntents.repoId, repoId))
          : eq(plans.fileIntents.workspaceId, workspaceId),
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
        return fail(request, reply, 400, 'Invalid intent', `intent must be one of ${INTENTS.join(', ')}`);
      }

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
