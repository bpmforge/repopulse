import type { FastifyInstance } from 'fastify';
import type { Database } from '@repopulse/shared';
import { sendProblem } from '../../lib/problem.js';
import { rulePrecision } from '../../lib/rule-precision.js';
import { repoCoverageMap } from '../../lib/coverage-map.js';

// Trust surfaces (W18-22): how far each rule can be believed, and what was not
// looked at in a repository.
//
// Member-readable, unlike the /rules workbench: a reader deciding whether to
// act on a finding is the person who needs its rule's track record, and that
// person is usually not an admin. Read-only; nothing here changes state.

export interface TrustRoutesOptions {
  db: Database;
}

export default async function trustRoutes(
  app: FastifyInstance,
  opts: TrustRoutesOptions,
): Promise<void> {
  const { db } = opts;

  /** GET /rules/precision[?rule_id=] — per-rule precision from triage and benchmark. */
  app.get<{ Querystring: { rule_id?: string } }>('/rules/precision', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) {
      sendProblem(request, reply, 401, 'No active session', {});
      return reply;
    }
    const ruleId = request.query.rule_id;
    if (ruleId !== undefined && (ruleId.length === 0 || ruleId.length > 200)) {
      sendProblem(request, reply, 400, 'Invalid rule_id', {});
      return reply;
    }
    const report = await rulePrecision(db, workspaceId, ruleId === undefined ? {} : { ruleId });
    return reply.send(report);
  });

  /** GET /repos/:repoId/coverage-map — what was not looked at here. */
  app.get<{ Params: { repoId: string } }>('/repos/:repoId/coverage-map', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) {
      sendProblem(request, reply, 401, 'No active session', {});
      return reply;
    }
    const repoId = Number(request.params.repoId);
    if (!Number.isInteger(repoId)) {
      sendProblem(request, reply, 400, 'Invalid repo id', {});
      return reply;
    }
    const map = await repoCoverageMap(db, workspaceId, repoId);
    // Tenancy (Law 5): another workspace's repository is a 404, never a 403.
    if (!map) {
      sendProblem(request, reply, 404, 'Repo not found', {});
      return reply;
    }
    return reply.send(map);
  });
}
