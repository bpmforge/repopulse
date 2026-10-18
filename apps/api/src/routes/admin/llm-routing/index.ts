import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { auditLog, core, type Database } from '@repopulse/shared';
import { LLM_ROLES, isLlmRole, type LlmRole } from '@repopulse/analysis';
import { requireAdmin } from '../../../lib/rbac.js';
import { sendProblem } from '../../../lib/problem.js';
import {
  describeEndpoint,
  loadStoredRouting,
  providersFor,
  violationsFor,
  type StoredRoute,
} from '../../../lib/llm-routing.js';

// Admin → Models → Routing (W19-02).
//
// WHICH connection and model serves WHICH role, as an ordered chain, plus the
// local-only switch. Admin-only and audited for the same reason Admin → Models
// is: this decides where diffs go. A change takes effect within about a minute
// (the worker's gateway cache), with no restart.

export interface LlmRoutingRoutesOptions {
  db: Database;
}

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

interface PutBody {
  local_only?: unknown;
  roles?: unknown;
}

export default async function llmRoutingRoutes(
  app: FastifyInstance,
  opts: LlmRoutingRoutesOptions,
): Promise<void> {
  const { db } = opts;

  app.get('/admin/llm-routing', { preHandler: requireAdmin }, async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');

    const stored = await loadStoredRouting(db, workspaceId);
    const providers = await providersFor(db, workspaceId);
    const names = new Map(providers.map((p) => [p.id, p.name]));

    return reply.send({
      local_only: stored.localOnly,
      roles: LLM_ROLES.map((role) => ({
        role,
        chain: stored.routes
          .filter((r) => r.role === role)
          .map((r) => ({
            provider_id: r.providerId,
            provider_name: names.get(r.providerId) ?? null,
            model: r.model,
            // Where this link sends requests, so the screen can say what leaves.
            ...(() => {
              const p = providers.find((x) => x.id === r.providerId);
              const e = p ? describeEndpoint(p.kind, p.baseUrl) : null;
              return { host: e?.host ?? null, leaves_network: e?.leavesNetwork ?? null };
            })(),
          })),
      })),
      // For the pickers: the connections a chain may use. Never a credential.
      providers: providers.map((p) => ({
        id: p.id,
        name: p.name,
        kind: p.kind,
        model: p.model,
        enabled: p.enabled,
        host: describeEndpoint(p.kind, p.baseUrl).host,
        leaves_network: describeEndpoint(p.kind, p.baseUrl).leavesNetwork,
      })),
    });
  });

  /** Full replace: the screen sends the whole picture, so there is no merge to get wrong. */
  app.put('/admin/llm-routing', { preHandler: requireAdmin }, async (request, reply) => {
    const workspaceId = request.workspace?.id;
    const userId = request.session?.get('userId');
    if (workspaceId === undefined || userId === undefined) {
      return fail(request, reply, 401, 'No active session');
    }

    const body = (request.body ?? {}) as PutBody;
    if (typeof body.local_only !== 'boolean') {
      return fail(request, reply, 400, 'local_only must be true or false');
    }
    if (typeof body.roles !== 'object' || body.roles === null || Array.isArray(body.roles)) {
      return fail(request, reply, 400, 'roles must be an object of role -> chain');
    }

    const providers = await providersFor(db, workspaceId);
    const byId = new Map(providers.map((p) => [p.id, p]));
    const routes: StoredRoute[] = [];

    for (const [role, chain] of Object.entries(body.roles as Record<string, unknown>)) {
      if (!isLlmRole(role)) {
        return fail(
          request,
          reply,
          400,
          `Unknown role "${role}"`,
          `Roles are: ${LLM_ROLES.join(', ')}.`,
        );
      }
      if (!Array.isArray(chain)) {
        return fail(request, reply, 400, `The chain for "${role}" must be a list`);
      }
      const seen = new Set<string>();
      for (const link of chain as Record<string, unknown>[]) {
        const providerId = link?.provider_id;
        if (typeof providerId !== 'number') {
          return fail(request, reply, 400, `A link in "${role}" has no provider_id`);
        }
        // Workspace-filtered by construction: `providers` is this workspace's.
        const p = byId.get(providerId);
        if (!p)
          return fail(request, reply, 400, `Role "${role}" names a connection that does not exist`);
        if (!p.enabled) {
          return fail(
            request,
            reply,
            400,
            `Role "${role}" names connection "${p.name}", which is disabled`,
            'Enable it in Admin → Models first.',
          );
        }
        const model =
          typeof link.model === 'string' && link.model.trim() !== '' ? link.model.trim() : null;
        const key = `${providerId}\u0000${model ?? p.model}`;
        if (seen.has(key)) {
          return fail(
            request,
            reply,
            400,
            `Role "${role}" lists "${p.name}" with the same model twice`,
          );
        }
        seen.add(key);
        routes.push({ role: role as LlmRole, providerId, model });
      }
    }

    // THE LOCAL-ONLY RULE, at configuration time: refused with the role and the
    // connection named, so nobody finds out from a pass that skipped.
    const violations = violationsFor(body.local_only, routes, providers);
    if (violations.length > 0) {
      return fail(
        request,
        reply,
        422,
        'Local-only is on, and a role would leave your network',
        violations.join(' '),
      );
    }

    await db.transaction(async (tx) => {
      await tx.delete(core.llmRoleRoutes).where(eq(core.llmRoleRoutes.workspaceId, workspaceId));
      const perRole = new Map<LlmRole, number>();
      if (routes.length > 0) {
        await tx.insert(core.llmRoleRoutes).values(
          routes.map((r) => {
            const position = perRole.get(r.role) ?? 0;
            perRole.set(r.role, position + 1);
            return {
              workspaceId,
              role: r.role,
              position,
              providerId: r.providerId,
              model: r.model,
            };
          }),
        );
      }
      await tx
        .insert(core.llmRoutingPolicy)
        .values({ workspaceId, localOnly: body.local_only as boolean, updatedBy: userId })
        .onConflictDoUpdate({
          target: core.llmRoutingPolicy.workspaceId,
          set: { localOnly: body.local_only as boolean, updatedBy: userId, updatedAt: new Date() },
        });
    });

    auditLog(request.log, {
      event: 'llm_routing.updated',
      actorUserId: userId,
      workspaceId,
      ip: request.ip,
      ua: request.headers['user-agent'] ?? null,
      detail: {
        local_only: body.local_only,
        routed_roles: [...new Set(routes.map((r) => r.role))],
        links: routes.length,
      },
    });

    return reply.code(204).send();
  });
}
