import { and, asc, eq, gt } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ZodTypeProvider } from 'fastify-type-provider-zod';
import { read, type Database } from '@repopulse/shared';
import { sendProblem } from '../../lib/problem.js';
import { decodeCursor, encodeCursor } from './cursor.js';
import { serializeSharedView, serializeView } from './serializer.js';
import { generateShareSlug } from './share-slug.js';
import {
  createViewBodySchema,
  defaultViewBodySchema,
  listViewsQuerySchema,
  patchViewBodySchema,
  shareResponseSchema,
  shareSlugParamsSchema,
  sharedViewResponseSchema,
  viewIdParamsSchema,
  viewListResponseSchema,
  viewResponseSchema,
  type ViewConfig,
} from './schema.js';

export interface ViewsRoutesOptions {
  db: Database;
}

// Registered inside api-v1.ts as a child of the guarded /api/v1 scope
// (its own HANDOFF comment invites this) — every handler here can assume
// request.workspace/request.session are already populated by that
// plugin's preHandler. The re-checks below guard only against the TS
// types being optional across the plugin boundary, not a real runtime gap.
function requireContext(
  request: FastifyRequest,
): { userId: number; workspaceId: number } | undefined {
  const userId = request.session.get('userId');
  const workspaceId = request.workspace?.id;
  if (userId === undefined || workspaceId === undefined) return undefined;
  return { userId, workspaceId };
}

// Explicitly `return reply` on every early-exit path rather than the
// implicit-undefined `return sendProblem(...)` idiom used elsewhere in this
// codebase (e.g. routes/auth) — verified empirically (not assumed) that an
// async route handler here that calls reply.send() after a prior `await`
// and then resolves with `undefined` causes @fastify/session's onSend hook
// to run a second time (a second Session.save()/store.set() call racing
// the first), throwing ERR_HTTP_HEADERS_SENT ~500ms later. Same failure
// class as W1-04's requireAdmin/api-v1.ts preHandler fix, but here it's a
// terminal route handler, not a chained preHandler.
function fail(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  title: string,
): FastifyReply {
  sendProblem(request, reply, status, title);
  return reply;
}

export default async function viewsRoutes(
  app: FastifyInstance,
  opts: ViewsRoutesOptions,
): Promise<void> {
  const { db } = opts;
  const typedApp = app.withTypeProvider<ZodTypeProvider>();

  typedApp.get(
    '/views',
    { schema: { querystring: listViewsQuerySchema, response: { 200: viewListResponseSchema } } },
    async (request, reply) => {
      const ctx = requireContext(request);
      if (!ctx) return fail(request, reply, 401, 'No active session');

      const { cursor, limit } = request.query;
      let afterId: number | null = null;
      if (cursor !== undefined) {
        afterId = decodeCursor(cursor);
        if (afterId === null) return fail(request, reply, 400, 'Invalid cursor');
      }

      const rows = await db
        .select()
        .from(read.savedViews)
        .where(
          and(
            eq(read.savedViews.workspaceId, ctx.workspaceId),
            eq(read.savedViews.ownerUserId, ctx.userId),
            afterId !== null ? gt(read.savedViews.id, afterId) : undefined,
          ),
        )
        .orderBy(asc(read.savedViews.id))
        .limit(limit + 1);

      const hasMore = rows.length > limit;
      const page = hasMore ? rows.slice(0, limit) : rows;
      const lastRow = page[page.length - 1];
      return reply.send({
        items: page.map(serializeView),
        next_cursor: hasMore && lastRow ? encodeCursor(lastRow.id) : null,
      });
    },
  );

  typedApp.post(
    '/views',
    { schema: { body: createViewBodySchema, response: { 201: viewResponseSchema } } },
    async (request, reply) => {
      const ctx = requireContext(request);
      if (!ctx) return fail(request, reply, 401, 'No active session');

      const [row] = await db
        .insert(read.savedViews)
        .values({
          workspaceId: ctx.workspaceId,
          ownerUserId: ctx.userId,
          name: request.body.name,
          config: request.body.config,
          isShared: request.body.is_shared,
        })
        .returning();
      if (!row) throw new Error('saved_views insert returned no row');
      return reply.code(201).send(serializeView(row));
    },
  );

  typedApp.patch(
    '/views/:id',
    {
      schema: {
        params: viewIdParamsSchema,
        body: patchViewBodySchema,
        response: { 200: viewResponseSchema },
      },
    },
    async (request, reply) => {
      const ctx = requireContext(request);
      if (!ctx) return fail(request, reply, 401, 'No active session');

      const [existing] = await db
        .select()
        .from(read.savedViews)
        .where(eq(read.savedViews.id, request.params.id))
        .limit(1);
      if (!existing || existing.workspaceId !== ctx.workspaceId) {
        return fail(request, reply, 404, 'Not Found');
      }
      if (existing.ownerUserId !== ctx.userId) {
        return fail(request, reply, 403, 'Forbidden — owner only');
      }

      const body = request.body;
      const existingConfig = existing.config as ViewConfig;
      // Explicit per-field fallback rather than `{...existing, ...body.config}` —
      // spreading a Partial<ViewConfig> over a full ViewConfig types each
      // overlapping field as possibly-undefined even though every field is
      // actually resolved below.
      const nextConfig: ViewConfig | undefined = body.config
        ? {
            repo_ids: body.config.repo_ids ?? existingConfig.repo_ids,
            window: body.config.window ?? existingConfig.window,
            layout: body.config.layout ?? existingConfig.layout,
          }
        : undefined;

      const [updated] = await db
        .update(read.savedViews)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(nextConfig ? { config: nextConfig } : {}),
          ...(body.is_shared !== undefined ? { isShared: body.is_shared } : {}),
          updatedAt: new Date(),
        })
        .where(eq(read.savedViews.id, request.params.id))
        .returning();
      if (!updated) throw new Error('saved_views update returned no row');
      return reply.send(serializeView(updated));
    },
  );

  typedApp.delete(
    '/views/:id',
    { schema: { params: viewIdParamsSchema } },
    async (request, reply) => {
      const ctx = requireContext(request);
      if (!ctx) return fail(request, reply, 401, 'No active session');

      const [existing] = await db
        .select()
        .from(read.savedViews)
        .where(eq(read.savedViews.id, request.params.id))
        .limit(1);
      if (!existing || existing.workspaceId !== ctx.workspaceId) {
        return fail(request, reply, 404, 'Not Found');
      }
      if (existing.ownerUserId !== ctx.userId) {
        return fail(request, reply, 403, 'Forbidden — owner only');
      }

      await db.delete(read.savedViews).where(eq(read.savedViews.id, request.params.id));
      return reply.code(204).send();
    },
  );

  typedApp.post(
    '/views/:id/share',
    { schema: { params: viewIdParamsSchema, response: { 200: shareResponseSchema } } },
    async (request, reply) => {
      const ctx = requireContext(request);
      if (!ctx) return fail(request, reply, 401, 'No active session');

      const [existing] = await db
        .select()
        .from(read.savedViews)
        .where(eq(read.savedViews.id, request.params.id))
        .limit(1);
      if (!existing || existing.workspaceId !== ctx.workspaceId) {
        return fail(request, reply, 404, 'Not Found');
      }
      if (existing.ownerUserId !== ctx.userId) {
        return fail(request, reply, 403, 'Forbidden — owner only');
      }

      // SC-17: 128-bit crypto-random, minted fresh on every call. This is
      // also how a share gets revoked — re-sharing invalidates whatever
      // slug was live before it, since only the newest one resolves.
      const shareSlug = generateShareSlug();
      const [updated] = await db
        .update(read.savedViews)
        .set({ shareSlug, isShared: true, updatedAt: new Date() })
        .where(eq(read.savedViews.id, request.params.id))
        .returning();
      if (!updated || !updated.shareSlug)
        throw new Error('saved_views share update returned no slug');
      return reply.send({ share_slug: updated.shareSlug });
    },
  );

  // Deliberately still inside the guarded /api/v1 scope: a shared view is
  // "any workspace member", not an unauthenticated public link (SC-17).
  typedApp.get(
    '/views/shared/:slug',
    { schema: { params: shareSlugParamsSchema, response: { 200: sharedViewResponseSchema } } },
    async (request, reply) => {
      const ctx = requireContext(request);
      if (!ctx) return fail(request, reply, 401, 'No active session');

      const [row] = await db
        .select()
        .from(read.savedViews)
        .where(
          and(
            eq(read.savedViews.shareSlug, request.params.slug),
            eq(read.savedViews.isShared, true),
            eq(read.savedViews.workspaceId, ctx.workspaceId),
          ),
        )
        .limit(1);
      if (!row) return fail(request, reply, 404, 'Not Found');
      return reply.send(serializeSharedView(row));
    },
  );

  typedApp.put(
    '/me/default-view',
    { schema: { body: defaultViewBodySchema } },
    async (request, reply) => {
      const ctx = requireContext(request);
      if (!ctx) return fail(request, reply, 401, 'No active session');

      const [target] = await db
        .select()
        .from(read.savedViews)
        .where(eq(read.savedViews.id, request.body.view_id))
        .limit(1);
      if (!target || target.workspaceId !== ctx.workspaceId) {
        return fail(request, reply, 404, 'Not Found');
      }
      if (target.ownerUserId !== ctx.userId) {
        return fail(request, reply, 403, 'Forbidden — can only default your own view');
      }

      await db.transaction(async (tx) => {
        await tx
          .update(read.savedViews)
          .set({ isDefaultForOwner: false, updatedAt: new Date() })
          .where(
            and(
              eq(read.savedViews.workspaceId, ctx.workspaceId),
              eq(read.savedViews.ownerUserId, ctx.userId),
              eq(read.savedViews.isDefaultForOwner, true),
            ),
          );
        await tx
          .update(read.savedViews)
          .set({ isDefaultForOwner: true, updatedAt: new Date() })
          .where(eq(read.savedViews.id, target.id));
      });

      return reply.code(204).send();
    },
  );
}
