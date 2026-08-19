import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { auditLog, core, security, type Database } from '@repopulse/shared';
import { SCANNER_DEFAULTS, isEnabled, listScanners } from '@repopulse/security';
import { requireAdmin } from '../../lib/rbac.js';
import { sendProblem } from '../../lib/problem.js';

// Scanner enablement API (W8-01, FR-SEC-11 / FR-AUTH-4).

export interface ScannersRoutesOptions {
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

export default async function scannersRoutes(
  app: FastifyInstance,
  opts: ScannersRoutesOptions,
): Promise<void> {
  const { db } = opts;

  /** GET /scanners — the catalog with per-repo enablement resolved. */
  app.get<{ Querystring: { repo_id?: string } }>('/scanners', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
    const repoId = Number(request.query.repo_id);

    const stored = Number.isInteger(repoId)
      ? await db
          .select()
          .from(security.repoScannerConfig)
          .where(
            and(
              eq(security.repoScannerConfig.workspaceId, workspaceId),
              eq(security.repoScannerConfig.repoId, repoId),
            ),
          )
      : [];
    const byKey = new Map(stored.map((row) => [row.scannerKey, row]));

    // The catalog is the union of REGISTERED scanners and DOCUMENTED defaults.
    // A default with no registered scanner still appears, marked unavailable —
    // otherwise a scanner that failed to register would silently vanish from
    // the admin screen and look like it was never meant to exist.
    const keys = [...new Set([...listScanners().map((s) => s.key), ...SCANNER_DEFAULTS.map((d) => d.key)])];
    const registered = new Map(listScanners().map((s) => [s.key, s]));

    return reply.send({
      items: keys.sort().map((key) => {
        const scanner = registered.get(key);
        const def = SCANNER_DEFAULTS.find((d) => d.key === key);
        return {
          key,
          display_name: scanner?.displayName ?? key,
          version: scanner?.version ?? null,
          registered: scanner !== undefined,
          required_tools: scanner?.requiredTools ?? [],
          triggers: scanner?.triggers ?? [],
          enabled: isEnabled(key, byKey.get(key)),
          // The reason travels to the UI: a default is a security posture, and
          // an admin changing one deserves to see what it was for.
          rationale: def?.rationale ?? null,
          source: byKey.has(key) ? 'repo' : 'workspace default',
        };
      }),
    });
  });

  /** PUT /scanners/:key — admin-only enablement for one repo. */
  app.put<{ Params: { key: string }; Body: { repo_id?: unknown; enabled?: unknown } }>(
    '/scanners/:key',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      const userId = request.session.get('userId');
      if (workspaceId === undefined || userId === undefined) {
        return fail(request, reply, 401, 'No active session');
      }
      const repoId = Number(request.body?.repo_id);
      const enabled = request.body?.enabled;
      if (!Number.isInteger(repoId)) return fail(request, reply, 400, 'repo_id is required');
      if (typeof enabled !== 'boolean') return fail(request, reply, 400, 'enabled must be a boolean');

      const [repo] = await db
        .select({ id: core.repos.id })
        .from(core.repos)
        .where(and(eq(core.repos.id, repoId), eq(core.repos.workspaceId, workspaceId)))
        .limit(1);
      // Tenancy (Law 5): another workspace's repo is a 404, never a 403.
      if (!repo) return fail(request, reply, 404, 'Not Found');

      await db
        .insert(security.repoScannerConfig)
        .values({ workspaceId, repoId, scannerKey: request.params.key, enabled, updatedBy: userId })
        .onConflictDoUpdate({
          target: [
            security.repoScannerConfig.workspaceId,
            security.repoScannerConfig.repoId,
            security.repoScannerConfig.scannerKey,
          ],
          set: { enabled, updatedBy: userId, updatedAt: new Date() },
        });

      auditLog(request.log, {
        event: 'scanner.enablement_changed',
        actorUserId: userId,
        workspaceId,
        ip: request.ip,
        ua: request.headers['user-agent'] ?? null,
        repoId,
        scannerKey: request.params.key,
        enabled,
      });

      return reply.send({ scanner_key: request.params.key, repo_id: repoId, enabled });
    },
  );

  /** GET /scanners/runs — recent scan runs, newest first. */
  app.get('/scanners/runs', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
    const rows = await db
      .select()
      .from(security.scanRuns)
      .where(eq(security.scanRuns.workspaceId, workspaceId))
      .orderBy(desc(security.scanRuns.startedAt))
      .limit(50);
    return reply.send({
      items: rows.map((r) => ({
        id: r.id,
        repo_id: r.repoId,
        scanner_key: r.scannerKey,
        scanner_version: r.scannerVersion,
        commit_sha: r.commitSha,
        trigger: r.trigger,
        status: r.status,
        // A partial run's findings are real but incomplete — flagged so a
        // reader never mistakes a cut-short scan for a clean one.
        partial: r.partial,
        finding_count: r.findingCount,
        error: r.error,
        started_at: r.startedAt.toISOString(),
      })),
    });
  });
}
