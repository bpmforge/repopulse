import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { core, type Database } from '@repopulse/shared';
import { requireAdmin } from '../../lib/rbac.js';
import { sendProblem } from '../../lib/problem.js';
import { ENV_REGISTRY, validateEnv } from './env-registry.js';

// Setup status (W11-02, E1.2).
//
// What this is FOR: an operator has the stack running and needs to know which
// of the remaining steps — forge App registration, a connection, a webhook —
// is not done yet. It is deliberately not a pre-boot wizard: the variables the
// app cannot run without are checked at STARTUP and named there, because a
// half-booted app serving a friendly setup page is a worse failure than one
// that refuses to start.
//
// IT NEVER RETURNS A VALUE. Only whether something is set, and what breaks if
// it is wrong. A setup screen that echoes secrets back is a credential leak
// wearing a helpful face.

export interface SetupRoutesOptions {
  db: Database;
}

export interface SetupCheck {
  id: string;
  label: string;
  status: 'ok' | 'missing' | 'unknown';
  detail: string;
  /** Where the operator goes to fix it. */
  docs: string;
}

function problem(
  request: FastifyRequest,
  reply: FastifyReply,
  status: number,
  title: string,
): FastifyReply {
  sendProblem(request, reply, status, title, {});
  return reply;
}

export default async function setupRoutes(
  app: FastifyInstance,
  opts: SetupRoutesOptions,
): Promise<void> {
  const { db } = opts;

  /** GET /setup/status — what is still missing, admin only. */
  app.get('/setup/status', { preHandler: requireAdmin }, async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return problem(request, reply, 401, 'No active session');

    const checks: SetupCheck[] = [];

    // Optional-but-important variables. The required ones cannot be missing —
    // the process would not have started — so listing them here as "ok" would
    // be theatre; they are reported as a single verified line instead.
    const problems = validateEnv(process.env, ['api', 'shared']);
    checks.push({
      id: 'env',
      label: 'Environment variables',
      status: problems.length === 0 ? 'ok' : 'missing',
      detail:
        problems.length === 0
          ? `All required variables are set and well-formed (${ENV_REGISTRY.filter((e) => e.required).length} required, ${ENV_REGISTRY.length} documented).`
          : problems.map((p) => `${p.name} ${p.reason}`).join('; '),
      docs: 'docs/CONFIG.md',
    });

    const [connection] = await db
      .select({ id: core.forgeConnections.id, provider: core.forgeConnections.provider, status: core.forgeConnections.status })
      .from(core.forgeConnections)
      .where(eq(core.forgeConnections.workspaceId, workspaceId))
      .limit(1);

    checks.push({
      id: 'forge_connection',
      label: 'Forge connection',
      status: connection ? 'ok' : 'missing',
      detail: connection
        ? `Connected to ${connection.provider} (status ${connection.status}).`
        : 'No forge connection yet. Register your own GitHub App (or a Gitea token) and connect it — RepoPulse never uses a shared App.',
      docs: 'docs/INSTALL.md#connect-your-forge',
    });

    const [repoCount] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(core.repos)
      .where(eq(core.repos.workspaceId, workspaceId));

    checks.push({
      id: 'repos',
      label: 'Tracked repositories',
      status: (repoCount?.count ?? 0) > 0 ? 'ok' : 'missing',
      detail:
        (repoCount?.count ?? 0) > 0
          ? `${repoCount!.count} repositories selected.`
          : 'No repositories selected yet. Nothing is ingested until you pick some.',
      docs: 'docs/INSTALL.md#select-repositories',
    });

    // Webhook delivery is a fact about the LAST delivery, not about config: a
    // secret can be perfectly set and the URL still unreachable from the forge.
    // 'unknown' is therefore a real state here rather than a failure.
    const [delivery] = await db
      .select({ receivedAt: core.webhookDelivery.receivedAt })
      .from(core.webhookDelivery)
      .where(eq(core.webhookDelivery.workspaceId, workspaceId))
      .orderBy(sql`${core.webhookDelivery.receivedAt} desc`)
      .limit(1);

    checks.push({
      id: 'webhook',
      label: 'Webhook deliveries',
      status: delivery ? 'ok' : 'unknown',
      detail: delivery
        ? `Last delivery received ${delivery.receivedAt.toISOString()}.`
        : 'No webhook delivery has arrived yet. That is expected before your first push — it is not proof the webhook is wrong, and not proof it is right.',
      docs: 'docs/INSTALL.md#webhooks',
    });

    return reply.send({
      ready: checks.every((check) => check.status === 'ok'),
      checks,
    });
  });

  /** GET /setup/config — the documented variables, WITHOUT any values. */
  app.get('/setup/config', { preHandler: requireAdmin }, async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return problem(request, reply, 401, 'No active session');

    return reply.send({
      variables: ENV_REGISTRY.map((entry) => ({
        name: entry.name,
        scope: entry.scope,
        required: entry.required,
        purpose: entry.purpose,
        if_wrong: entry.ifWrong,
        default: entry.default ?? null,
        secret: entry.secret ?? false,
        // Whether it is SET, never what it is set to.
        set: Boolean(process.env[entry.name]),
      })),
    });
  });
}
