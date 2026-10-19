import type { FastifyInstance } from 'fastify';
import { and, eq, max, sql } from 'drizzle-orm';
import { core, type Database } from '@repopulse/shared';
import { orgSyncStatus } from '@repopulse/ingest';
import { sendProblem } from '../../lib/problem.js';

// GET /sync/status (INGESTION §7, FR-INGEST-8/FR-API-2). Org aggregate +
// per-repo RepoSyncStatus, served entirely from the warehouse — the fallback
// read the SSE stream degrades to (API_DESIGN §3). No response schema is set so
// Fastify's default serializer handles the nested SyncStatus shape (the status
// model's types are the contract).

export interface SyncRoutesOptions {
  db: Database;
}

/**
 * The newest webhook delivery per tracked repo (W20-14, UX_TODO INS-32;
 * UX_SPEC §4.i's "last webhook" column). Matched on the connection and the
 * repository's full name, which is what the delivery ledger records.
 */
export async function lastWebhookByRepo(
  db: Database,
  workspaceId: number,
): Promise<Map<string, string>> {
  const rows = await db
    .select({ repoId: core.repos.id, at: max(core.webhookDelivery.receivedAt) })
    .from(core.repos)
    .innerJoin(
      core.webhookDelivery,
      and(
        eq(core.webhookDelivery.workspaceId, core.repos.workspaceId),
        eq(core.webhookDelivery.connectionId, core.repos.connectionId),
        eq(core.webhookDelivery.repoFullName, sql`${core.repos.org} || '/' || ${core.repos.name}`),
      ),
    )
    .where(eq(core.repos.workspaceId, workspaceId))
    .groupBy(core.repos.id);
  const out = new Map<string, string>();
  for (const r of rows) {
    if (r.at) out.set(String(r.repoId), new Date(r.at).toISOString());
  }
  return out;
}

export default async function syncRoutes(
  app: FastifyInstance,
  opts: SyncRoutesOptions,
): Promise<void> {
  app.get('/sync/status', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) {
      sendProblem(request, reply, 401, 'No active session');
      return reply;
    }
    const [status, hooks] = await Promise.all([
      orgSyncStatus(opts.db, workspaceId),
      lastWebhookByRepo(opts.db, workspaceId),
    ]);
    return reply.send({
      ...status,
      repos: status.repos.map((r) => ({
        ...r,
        lastWebhookAt: hooks.get(String(r.repoId)) ?? null,
      })),
    });
  });
}
