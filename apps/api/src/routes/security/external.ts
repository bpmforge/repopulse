import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { auditLog, core, type Database } from '@repopulse/shared';
import { ingestSarifUpload } from '@repopulse/security';
import { requireAdmin } from '../../lib/rbac.js';
import { sendProblem } from '../../lib/problem.js';

// SARIF upload (W18-24): another scanner's results into the findings store.
//
// ADMIN-ONLY. RBAC is binary (admin | member, lib/rbac.ts), so the
// "admin/maintainer" the ticket names is admin here. It has to be: an upload
// writes findings under a tool's name AND closes that tool's findings it no
// longer reports, so a member able to upload could empty a repository's
// security list by posting an empty run.
//
// The body is untrusted data, never instructions. It is size-capped before it
// is parsed, schema-validated before anything is stored, and nothing in it is
// executed, fetched or resolved against a filesystem (see
// packages/security/src/external/sarif.ts). No forge call is made (FR-API-2).

export interface ExternalRoutesOptions {
  db: Database;
}

/**
 * 10 MiB. Fastify's default (1 MiB) is too small for a real CodeQL run, and
 * an unbounded body is a memory-exhaustion endpoint. Over it is a 413 before a
 * byte is parsed. A larger file is a sign to upload per category (sweep=false).
 */
export const SARIF_MAX_BYTES = 10 * 1024 * 1024;

const SHA = /^[0-9a-f]{7,40}$/i;

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

export default async function externalFindingsRoutes(
  app: FastifyInstance,
  opts: ExternalRoutesOptions,
): Promise<void> {
  const { db } = opts;

  // SARIF's registered media type (OASIS SARIF 2.1.0 §3.1). Parsed by the
  // same hardened JSON parser as application/json — prototype-poisoning keys
  // are refused, not merged — and only inside this plugin's scope.
  app.addContentTypeParser(
    'application/sarif+json',
    { parseAs: 'string', bodyLimit: SARIF_MAX_BYTES },
    app.getDefaultJsonParser('error', 'error'),
  );

  /** POST /repos/:repoId/external-findings/sarif — 👑 upload one SARIF log. */
  app.post<{
    Params: { repoId: string };
    Querystring: { commit_sha?: string; sweep?: string; source_root?: string };
  }>(
    '/repos/:repoId/external-findings/sarif',
    { preHandler: requireAdmin, bodyLimit: SARIF_MAX_BYTES },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
      const repoId = Number(request.params.repoId);
      if (!Number.isInteger(repoId)) return fail(request, reply, 400, 'Invalid repo id');

      const { commit_sha: commitSha, sweep, source_root: sourceRoot } = request.query;
      if (commitSha !== undefined && !SHA.test(commitSha)) {
        return fail(request, reply, 400, 'commit_sha must be a hex commit id');
      }
      if (sweep !== undefined && sweep !== 'true' && sweep !== 'false') {
        return fail(request, reply, 400, 'sweep must be true or false');
      }
      if (sourceRoot !== undefined && (!sourceRoot.startsWith('/') || sourceRoot.length > 1000)) {
        return fail(request, reply, 400, 'source_root must be an absolute path');
      }

      const [repo] = await db
        .select({ id: core.repos.id })
        .from(core.repos)
        .where(and(eq(core.repos.id, repoId), eq(core.repos.workspaceId, workspaceId)))
        .limit(1);
      // Tenancy (Law 5): another workspace's repo is a 404, never a 403.
      if (!repo) return fail(request, reply, 404, 'Not Found');

      const result = await ingestSarifUpload({
        db,
        workspaceId,
        repoId,
        document: request.body,
        commitSha: commitSha ?? null,
        sweep: sweep !== 'false',
        sourceRoot: sourceRoot ?? null,
      });
      if (!result.ok) {
        sendProblem(request, reply, 400, 'Not a valid SARIF 2.1.0 log', {
          detail: 'The file was rejected before anything was stored.',
          errors: result.errors,
        });
        return reply;
      }

      const userId = request.session?.get('userId') ?? null;
      auditLog(request.log, {
        event: 'external_findings.sarif_uploaded',
        actorUserId: userId,
        workspaceId,
        ip: request.ip,
        ua: request.headers['user-agent'] ?? null,
        repoId,
        tools: result.tools.map((t) => t.scannerKey),
        results: result.results,
        sweep: sweep !== 'false',
      });

      return reply.code(201).send({
        repo_id: repoId,
        // '' when neither the caller nor the file named a commit: the findings
        // then link to the default branch, which is what they were not pinned to.
        commit_sha: result.commitSha || null,
        results: result.results,
        skipped: result.skipped,
        tools: result.tools.map((t) => ({
          scanner_key: t.scannerKey,
          tool: t.tool,
          tool_version: t.toolVersion,
          scan_run_id: t.scanRunId,
          results: t.results,
          created: t.created,
          updated: t.updated,
          reopened: t.reopened,
          folded: t.folded,
          auto_resolved: t.autoResolved,
          superseded_by_pack: t.supersededByPack.map((s) => ({
            rule_id: s.ruleId,
            pack_rule: s.packRule,
            file: s.file,
            line: s.line,
          })),
        })),
      });
    },
  );
}
