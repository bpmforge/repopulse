import type { FastifyInstance } from 'fastify';
import type { Database } from '@repopulse/shared';
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
    const status = await orgSyncStatus(opts.db, workspaceId);
    return reply.send(status);
  });
}
