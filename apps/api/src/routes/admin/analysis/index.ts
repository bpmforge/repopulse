import { and, desc, eq, lt, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { auditLog, core, read, type Database } from '@repopulse/shared';
import { requireAdmin } from '../../../lib/rbac.js';
import { sendProblem } from '../../../lib/problem.js';
import { describeEndpoint } from '../../../lib/llm-routing.js';

// Admin → Analysis (W7-08, UX_SPEC §4.i).
//
// The consequential control here is the per-repo Tier-3 opt-in: turning it on
// means this repository's diffs may be sent to a third party. Admin-only, and
// every toggle is audited — a change to where code goes is not a preference.

export interface AnalysisAdminRoutesOptions {
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

export default async function analysisAdminRoutes(
  app: FastifyInstance,
  opts: AnalysisAdminRoutesOptions,
): Promise<void> {
  const { db } = opts;

  /** GET /admin/analysis — policy, per-repo opt-in, and the cost rollup. */
  app.get<{ Querystring: { before?: string; repo_id?: string } }>(
    '/admin/analysis',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
      const before = request.query?.before !== undefined ? Number(request.query.before) : null;
      const repoFilter =
        request.query?.repo_id !== undefined ? Number(request.query.repo_id) : null;
      if (
        (before !== null && !Number.isInteger(before)) ||
        (repoFilter !== null && !Number.isInteger(repoFilter))
      ) {
        return fail(request, reply, 400, 'Invalid filter');
      }

      const repos = await db
        .select({
          id: core.repos.id,
          org: core.repos.org,
          name: core.repos.name,
          tier2Auto: core.repos.tier2Auto,
          tier3OptIn: core.repos.tier3OptIn,
        })
        .from(core.repos)
        .where(eq(core.repos.workspaceId, workspaceId))
        .orderBy(core.repos.org, core.repos.name);

      // Cost rollup per repo (NFR-12). Reported from the egress audit rather
      // than a counter: the audit is written before every call, so it cannot
      // undercount a call that failed after sending.
      //
      // W20-11 (UX_TODO AI-79): ONE ROW PER ATTEMPT. Since W17-11 a call writes an
      // `attempted` row before it is sent and an outcome row after, both carrying
      // the full bytes, so counting every row doubled the calls and the KB. The
      // attempt row (or a pre-W17-11 row, outcome NULL) is the one that counts;
      // tokens live on the outcome row. A `denied` row sent nothing and is
      // counted apart, never as a call.
      const isAttempt = sql`(${read.egressAudit.outcome} is null or ${read.egressAudit.outcome} = 'attempted')`;
      const rollup = await db
        .select({
          repoId: read.egressAudit.repoId,
          calls: sql<number>`(count(*) filter (where ${isAttempt}))::int`,
          bytes: sql<number>`coalesce(sum(${read.egressAudit.bytesSent}) filter (where ${isAttempt}), 0)::int`,
          tokensSent: sql<number>`coalesce(sum(${read.egressAudit.tokensSent}), 0)::int`,
          refused: sql<number>`(count(*) filter (where ${read.egressAudit.outcome} = 'denied'))::int`,
        })
        .from(read.egressAudit)
        .where(eq(read.egressAudit.workspaceId, workspaceId))
        .groupBy(read.egressAudit.repoId);
      const byRepo = new Map(rollup.map((r) => [r.repoId, r]));

      // W20-11 (UX_TODO AI-29, AI-80): the log lists each attempt once, with its
      // outcome, repository, destination and who started it; pages back with
      // `before` and narrows with `repo_id`, and says how many there are.
      const PAGE = 50;
      const settled = sql`(select o.outcome from egress_audit o where o.workspace_id = ${read.egressAudit.workspaceId} and o.attempt_id = ${read.egressAudit.attemptId} and o.outcome <> 'attempted' limit 1)`;
      const settledTokens = (col: string) =>
        sql`(select o.${sql.raw(col)} from egress_audit o where o.workspace_id = ${read.egressAudit.workspaceId} and o.attempt_id = ${read.egressAudit.attemptId} and o.outcome <> 'attempted' limit 1)`;
      const listed = and(
        eq(read.egressAudit.workspaceId, workspaceId),
        sql`(${read.egressAudit.outcome} is null or ${read.egressAudit.outcome} in ('attempted', 'denied'))`,
        ...(repoFilter !== null ? [eq(read.egressAudit.repoId, repoFilter)] : []),
      );
      const recent = await db
        .select({
          id: read.egressAudit.id,
          repoId: read.egressAudit.repoId,
          modelId: read.egressAudit.modelId,
          bytesSent: read.egressAudit.bytesSent,
          tokensSent: sql<
            number | null
          >`coalesce(${read.egressAudit.tokensSent}, ${settledTokens('tokens_sent')})`,
          tokensReceived: sql<
            number | null
          >`coalesce(${read.egressAudit.tokensReceived}, ${settledTokens('tokens_received')})`,
          contentSha256: read.egressAudit.contentSha256,
          sentAt: read.egressAudit.sentAt,
          outcome: read.egressAudit.outcome,
          settledOutcome: sql<string | null>`${settled}`,
          host: read.egressAudit.destinationHost,
          tier: read.egressAudit.tier,
          initiator: read.egressAudit.initiatorLogin,
        })
        .from(read.egressAudit)
        .where(and(listed, ...(before !== null ? [lt(read.egressAudit.id, before)] : [])))
        .orderBy(desc(read.egressAudit.id))
        .limit(PAGE + 1);
      const [{ total } = { total: 0 }] = await db
        .select({ total: sql<number>`count(*)::int` })
        .from(read.egressAudit)
        .where(listed);
      const repoName = new Map(repos.map((r) => [r.id, `${r.org}/${r.name}`]));

      // W16-08 (F8). Whether analysis can actually run, on the one screen that is
      // about analysis. The worker already logs an excellent line — "analysis
      // gateway: NOT CONFIGURED (LMSTUDIO_BASE_URLS is set but LMSTUDIO_MODEL is
      // not) — scheduled judgement passes will skip and say so" — and it appears
      // only in a terminal, while these Tier-2 checkboxes sit here looking ready
      // to arm. A toggle that cannot do anything must say so next to itself.
      const providers = await db
        .select({
          name: core.llmProviders.name,
          kind: core.llmProviders.kind,
          baseUrl: core.llmProviders.baseUrl,
          model: core.llmProviders.model,
          enabled: core.llmProviders.enabled,
        })
        .from(core.llmProviders)
        .where(eq(core.llmProviders.workspaceId, workspaceId));

      const usable = providers.filter((p) => p.enabled);
      // W20-06 (UX_TODO AI-86): decided by WHERE each endpoint is, with the rule
      // the egress audit, local-only and scheduled passes use (describeEndpoint),
      // not by the allow_public_host flag. The flag is false for a Claude Code CLI
      // connection that sends source to Anthropic, so the old line told such a
      // workspace "all on your own network".
      const offNetwork = usable
        .filter((p) => describeEndpoint(p.kind, p.baseUrl).leavesNetwork)
        .map((p) => p.name)
        .sort();
      const gateway = {
        configured: usable.length > 0,
        provider_count: usable.length,
        off_network: offNetwork.length > 0,
        off_network_names: offNetwork,
        // The same sentence the worker logs, so the two cannot describe the same
        // state differently.
        reason:
          usable.length > 0
            ? null
            : providers.length > 0
              ? 'Every configured model is disabled, so scheduled passes will skip and say so.'
              : 'No model is configured, so scheduled passes will skip and say so. Add one in Admin → Models.',
      };

      return reply.send({
        gateway,
        repos: repos.map((r) => ({
          id: r.id,
          name: `${r.org}/${r.name}`,
          tier2_auto: r.tier2Auto,
          tier3_opt_in: r.tier3OptIn,
          egress: {
            calls: byRepo.get(r.id)?.calls ?? 0,
            bytes: byRepo.get(r.id)?.bytes ?? 0,
            tokens_sent: byRepo.get(r.id)?.tokensSent ?? 0,
            refused: byRepo.get(r.id)?.refused ?? 0,
          },
        })),
        egress_log: recent.slice(0, PAGE).map((e) => ({
          id: e.id,
          repo_id: e.repoId,
          repo: repoName.get(e.repoId) ?? null,
          model: e.modelId,
          bytes_sent: e.bytesSent,
          tokens_sent: e.tokensSent === null ? null : Number(e.tokensSent),
          tokens_received: e.tokensReceived === null ? null : Number(e.tokensReceived),
          // attempted rows take their outcome row's word; no outcome yet is "pending",
          // a pre-W17-11 row (outcome NULL) was written after a successful call.
          outcome:
            e.outcome === 'denied'
              ? 'denied'
              : e.outcome === null
                ? 'succeeded'
                : (e.settledOutcome ?? 'pending'),
          host: e.host,
          tier: e.tier,
          initiator: e.initiator,
          // The digest, never the content — the audit must not become a second
          // copy of the customer's code.
          content_sha256: e.contentSha256,
          sent_at: e.sentAt.toISOString(),
        })),
        egress_total: total,
        egress_next_cursor: recent.length > PAGE ? String(recent[PAGE - 1]!.id) : null,
      });
    },
  );

  /** PATCH /admin/analysis/repos/:id — the opt-in toggle. Audited. */
  app.patch<{ Params: { id: string }; Body: { tier3_opt_in?: unknown; tier2_auto?: unknown } }>(
    '/admin/analysis/repos/:id',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      const userId = request.session.get('userId');
      if (workspaceId === undefined || userId === undefined) {
        return fail(request, reply, 401, 'No active session');
      }
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) return fail(request, reply, 400, 'Invalid repo id');

      const [repo] = await db
        .select({
          id: core.repos.id,
          tier3OptIn: core.repos.tier3OptIn,
          tier2Auto: core.repos.tier2Auto,
        })
        .from(core.repos)
        .where(and(eq(core.repos.id, id), eq(core.repos.workspaceId, workspaceId)))
        .limit(1);
      // Tenancy (Law 5): another workspace's repo is a 404, never a 403.
      if (!repo) return fail(request, reply, 404, 'Not Found');

      const patch: { tier3OptIn?: boolean; tier2Auto?: boolean } = {};
      if (typeof request.body?.tier3_opt_in === 'boolean')
        patch.tier3OptIn = request.body.tier3_opt_in;
      if (typeof request.body?.tier2_auto === 'boolean') patch.tier2Auto = request.body.tier2_auto;
      if (Object.keys(patch).length === 0) {
        return fail(request, reply, 400, 'Invalid body', 'tier3_opt_in or tier2_auto is required');
      }

      await db.update(core.repos).set(patch).where(eq(core.repos.id, id));

      if (patch.tier3OptIn !== undefined) {
        auditLog(request.log, {
          event: 'repo.tier3_opt_in_changed',
          actorUserId: userId,
          workspaceId,
          ip: request.ip,
          ua: request.headers['user-agent'] ?? null,
          repoId: id,
          fromOptIn: repo.tier3OptIn,
          toOptIn: patch.tier3OptIn,
        });
      }

      return reply.send({ id, ...patch });
    },
  );
}
