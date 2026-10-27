import { and, desc, eq, gte, lt, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { auditLog, core, read, type Database } from '@repopulse/shared';
import { requireAdmin } from '../../../lib/rbac.js';
import { sendProblem } from '../../../lib/problem.js';
import { describeEndpoint } from '../../../lib/llm-routing.js';
import { hostsFromEnv } from '../../../workers/gateway.js';

// Settings → Analysis (W7-08, UX_SPEC §4.i).
//
// The consequential control here is the per-repo Tier-3 opt-in: turning it on
// means this repository's diffs may be sent to a third party. Admin-only, and
// every toggle is audited — a change to where code goes is not a preference.

export interface AnalysisAdminRoutesOptions {
  db: Database;
}

/**
 * Admin-entered prices per million tokens, by the model id the egress audit
 * records (W20-16, UX_TODO AI-08). Kept in workspaces.settings — no vendor
 * price list ships with RepoPulse (it would be stale the day it shipped), so
 * a figure is only shown for a model someone priced.
 */
export interface ModelPrice {
  input_per_mtok: number;
  output_per_mtok: number;
}
export const PRICES_KEY = 'llm_prices';

export function pricesOf(
  settings: Record<string, unknown> | null | undefined,
): Record<string, ModelPrice> {
  const raw = settings?.[PRICES_KEY];
  if (!raw || typeof raw !== 'object') return {};
  const out: Record<string, ModelPrice> = {};
  for (const [model, v] of Object.entries(raw as Record<string, unknown>)) {
    const p = v as Partial<ModelPrice> | null;
    if (
      p &&
      typeof p.input_per_mtok === 'number' &&
      typeof p.output_per_mtok === 'number' &&
      Number.isFinite(p.input_per_mtok) &&
      Number.isFinite(p.output_per_mtok)
    ) {
      out[model] = { input_per_mtok: p.input_per_mtok, output_per_mtok: p.output_per_mtok };
    }
  }
  return out;
}

/** Estimated US dollars, or null when the model has no price or no tokens were measured. */
export function estimateUsd(
  price: ModelPrice | undefined,
  tokensSent: number,
  tokensReceived: number,
): number | null {
  if (!price) return null;
  return (
    Math.round(
      ((tokensSent / 1_000_000) * price.input_per_mtok +
        (tokensReceived / 1_000_000) * price.output_per_mtok) *
        100,
    ) / 100
  );
}

/** How many calendar months the spend table covers, this one included. */
const SPEND_MONTHS = 6;

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

/** The most rows one egress CSV export holds (W20-21, UX_TODO AI-80). */
export const EGRESS_EXPORT_CAP = 10_000;

/**
 * The egress log's date range, inclusive, as YYYY-MM-DD in UTC (W20-21,
 * UX_TODO AI-80). Absent ends are open. Null when a given end is not a date,
 * or the range is backwards.
 */
export function egressRange(
  from: string | undefined,
  to: string | undefined,
): { from: Date | null; to: Date | null } | null {
  const day = (v: string | undefined): Date | null | undefined => {
    if (v === undefined || v === '') return null;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return undefined;
    const d = new Date(`${v}T00:00:00Z`);
    return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== v ? undefined : d;
  };
  const f = day(from);
  const t = day(to);
  if (f === undefined || t === undefined) return null;
  // `to` is inclusive: everything before the start of the next day.
  const end = t === null ? null : new Date(t.getTime() + 86_400_000);
  if (f !== null && end !== null && f.getTime() >= end.getTime()) return null;
  return { from: f, to: end };
}

/** The rows the egress log lists: one per attempt (and each refusal), filtered. */
function egressListed(
  workspaceId: number,
  repoFilter: number | null,
  range: { from: Date | null; to: Date | null },
) {
  return and(
    eq(read.egressAudit.workspaceId, workspaceId),
    sql`(${read.egressAudit.outcome} is null or ${read.egressAudit.outcome} in ('attempted', 'denied'))`,
    ...(repoFilter !== null ? [eq(read.egressAudit.repoId, repoFilter)] : []),
    ...(range.from !== null ? [gte(read.egressAudit.sentAt, range.from)] : []),
    ...(range.to !== null ? [lt(read.egressAudit.sentAt, range.to)] : []),
  );
}

/** One CSV cell, quoted, and never read as a formula by a spreadsheet. */
function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

export default async function analysisAdminRoutes(
  app: FastifyInstance,
  opts: AnalysisAdminRoutesOptions,
): Promise<void> {
  const { db } = opts;

  /**
   * GET /admin/analysis/egress.csv — the egress log under its filters, as a
   * file (W20-21, UX_TODO AI-80): "what was sent off-network last month, and
   * for which repository" answered outside the product. One row per attempt
   * with its outcome, up to EGRESS_EXPORT_CAP (the cut is said in the file and
   * a header). The digest, never content. Admin-only and audited.
   */
  app.get<{ Querystring: { repo_id?: string; from?: string; to?: string } }>(
    '/admin/analysis/egress.csv',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
      const repoFilter =
        request.query?.repo_id !== undefined && request.query.repo_id !== ''
          ? Number(request.query.repo_id)
          : null;
      const range = egressRange(request.query?.from, request.query?.to);
      if ((repoFilter !== null && !Number.isInteger(repoFilter)) || range === null) {
        return fail(request, reply, 400, 'Invalid filter');
      }
      const settled = sql`(select o.outcome from egress_audit o where o.workspace_id = ${read.egressAudit.workspaceId} and o.attempt_id = ${read.egressAudit.attemptId} and o.outcome <> 'attempted' limit 1)`;
      const rows = await db
        .select({
          id: read.egressAudit.id,
          sentAt: read.egressAudit.sentAt,
          org: core.repos.org,
          name: core.repos.name,
          host: read.egressAudit.destinationHost,
          model: read.egressAudit.modelId,
          tier: read.egressAudit.tier,
          role: read.egressAudit.role,
          aiPassRunId: read.egressAudit.aiPassRunId,
          initiator: read.egressAudit.initiatorLogin,
          outcome: read.egressAudit.outcome,
          settledOutcome: sql<string | null>`${settled}`,
          bytesSent: read.egressAudit.bytesSent,
          contentSha256: read.egressAudit.contentSha256,
        })
        .from(read.egressAudit)
        .innerJoin(
          core.repos,
          and(eq(core.repos.id, read.egressAudit.repoId), eq(core.repos.workspaceId, workspaceId)),
        )
        .where(egressListed(workspaceId, repoFilter, range))
        .orderBy(desc(read.egressAudit.id))
        .limit(EGRESS_EXPORT_CAP + 1);
      const truncated = rows.length > EGRESS_EXPORT_CAP;
      const page = rows.slice(0, EGRESS_EXPORT_CAP);
      const header = [
        'id',
        'sent_at',
        'repository',
        'destination_host',
        'model',
        'tier',
        'role',
        'ai_pass_run_id',
        'initiator',
        'outcome',
        'bytes_sent',
        'content_sha256',
      ];
      const lines = [
        header.join(','),
        ...page.map((r) =>
          [
            r.id,
            r.sentAt.toISOString(),
            `${r.org}/${r.name}`,
            r.host,
            r.model,
            r.tier,
            r.role,
            r.aiPassRunId,
            r.initiator,
            r.outcome === 'denied'
              ? 'denied'
              : r.outcome === null
                ? 'succeeded'
                : (r.settledOutcome ?? 'pending'),
            r.bytesSent,
            r.contentSha256,
          ]
            .map(csvCell)
            .join(','),
        ),
        ...(truncated
          ? [
              csvCell(
                `Cut at ${EGRESS_EXPORT_CAP} rows, newest first. Narrow the dates or the repository for the rest.`,
              ),
            ]
          : []),
      ];
      auditLog(request.log, {
        event: 'egress_audit.exported',
        actorUserId: request.session?.get('userId') ?? null,
        workspaceId,
        ip: request.ip,
        ua: request.headers['user-agent'] ?? null,
        detail: {
          count: page.length,
          truncated,
          repo_id: repoFilter,
          from: request.query?.from ?? null,
          to: request.query?.to ?? null,
        },
      });
      const day = new Date().toISOString().slice(0, 10);
      return reply
        .header('Content-Disposition', `attachment; filename="repopulse-egress-${day}.csv"`)
        .header('X-RepoPulse-Count', String(page.length))
        .header('X-RepoPulse-Truncated', truncated ? 'true' : 'false')
        .header('Cache-Control', 'no-store')
        .type('text/csv; charset=utf-8')
        .send(`${lines.join('\n')}\n`);
    },
  );

  /** GET /admin/analysis — policy, per-repo opt-in, and the cost rollup. */
  app.get<{
    Querystring: { before?: string; repo_id?: string; from?: string; to?: string };
  }>('/admin/analysis', { preHandler: requireAdmin }, async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
    const before = request.query?.before !== undefined ? Number(request.query.before) : null;
    const repoFilter = request.query?.repo_id !== undefined ? Number(request.query.repo_id) : null;
    const range = egressRange(request.query?.from, request.query?.to);
    if (
      (before !== null && !Number.isInteger(before)) ||
      (repoFilter !== null && !Number.isInteger(repoFilter)) ||
      range === null
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
    const listed = egressListed(workspaceId, repoFilter, range);
    const recent = await db
      .select({
        id: read.egressAudit.id,
        role: read.egressAudit.role,
        aiPassRunId: read.egressAudit.aiPassRunId,
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
    // W20-21 (UX_TODO AI-78): with no connection rows at all, the worker
    // still falls back to the deprecated LMSTUDIO_* variables. Said here,
    // instead of "No model is configured" over passes that keep running.
    const envHosts = providers.length === 0 ? hostsFromEnv() : [];
    const gateway = {
      configured: usable.length > 0 || envHosts.length > 0,
      provider_count: usable.length,
      off_network: offNetwork.length > 0,
      off_network_names: offNetwork,
      env_fallback: envHosts.length > 0,
      // The same sentence the worker logs, so the two cannot describe the same
      // state differently.
      reason:
        usable.length > 0
          ? null
          : envHosts.length > 0
            ? `Using LMSTUDIO_BASE_URLS / LMSTUDIO_MODEL from .env (model ${envHosts[0]!.modelSlot}), a deprecated route. Add the model in Settings → Models to replace it, or remove both lines from .env and restart the worker to turn AI off.`
            : providers.length > 0
              ? 'Every configured model is disabled, so scheduled passes will skip and say so.'
              : 'No model is configured, so scheduled passes will skip and say so. Add one in Settings → Models.',
    };

    // W20-16 (UX_TODO AI-08): spend per month and model, from the same
    // audit. Calls are counted on the attempt row; tokens on the outcome
    // row (or the single pre-W17-11 row). Calls that left with no token
    // count reported are counted apart, so an estimate never pretends to
    // cover them.
    const [ws] = await db
      .select({ settings: core.workspaces.settings })
      .from(core.workspaces)
      .where(eq(core.workspaces.id, workspaceId))
      .limit(1);
    const prices = pricesOf(ws?.settings);
    const isOutcome = sql`(${read.egressAudit.outcome} is null or ${read.egressAudit.outcome} in ('succeeded', 'failed'))`;
    const month = sql<string>`to_char(date_trunc('month', ${read.egressAudit.sentAt} at time zone 'UTC'), 'YYYY-MM')`;
    const spendRows = await db
      .select({
        month,
        model: read.egressAudit.modelId,
        host: read.egressAudit.destinationHost,
        calls: sql<number>`(count(*) filter (where ${isAttempt}))::int`,
        tokensSent: sql<number>`coalesce(sum(${read.egressAudit.tokensSent}) filter (where ${isOutcome}), 0)::bigint`,
        tokensReceived: sql<number>`coalesce(sum(${read.egressAudit.tokensReceived}) filter (where ${isOutcome}), 0)::bigint`,
        unmeasured: sql<number>`(count(*) filter (where ${isOutcome} and ${read.egressAudit.tokensSent} is null))::int`,
      })
      .from(read.egressAudit)
      .where(
        and(
          eq(read.egressAudit.workspaceId, workspaceId),
          sql`${read.egressAudit.sentAt} >= date_trunc('month', now() at time zone 'UTC') - make_interval(months => ${SPEND_MONTHS - 1})`,
        ),
      )
      .groupBy(month, read.egressAudit.modelId, read.egressAudit.destinationHost)
      .orderBy(desc(month), read.egressAudit.modelId);
    const spend = {
      months: SPEND_MONTHS,
      prices,
      rows: spendRows
        .filter((r) => Number(r.calls) > 0 || Number(r.tokensSent) > 0)
        .map((r) => {
          const sent = Number(r.tokensSent);
          const received = Number(r.tokensReceived);
          return {
            month: r.month,
            model: r.model,
            host: r.host,
            calls: Number(r.calls),
            tokens_sent: sent,
            tokens_received: received,
            unmeasured_calls: Number(r.unmeasured),
            estimated_usd: estimateUsd(prices[r.model], sent, received),
          };
        }),
    };

    return reply.send({
      gateway,
      spend,
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
        // W20-21 (UX_TODO AI-29): what the call was for, and the AI pass that
        // made it. Null on rows written before these were recorded.
        role: e.role,
        ai_pass_run_id: e.aiPassRunId,
        // The digest, never the content — the audit must not become a second
        // copy of the customer's code.
        content_sha256: e.contentSha256,
        sent_at: e.sentAt.toISOString(),
      })),
      egress_total: total,
      egress_next_cursor: recent.length > PAGE ? String(recent[PAGE - 1]!.id) : null,
    });
  });

  /**
   * PUT /admin/analysis/prices — set or clear one model's price (W20-16,
   * UX_TODO AI-08). `{ model, input_per_mtok, output_per_mtok }` sets it;
   * `{ model, clear: true }` removes it. Audited: the figures decide what
   * the spend table tells whoever approves the bill.
   */
  app.put<{
    Body: { model?: unknown; input_per_mtok?: unknown; output_per_mtok?: unknown; clear?: unknown };
  }>('/admin/analysis/prices', { preHandler: requireAdmin }, async (request, reply) => {
    const workspaceId = request.workspace?.id;
    const userId = request.session.get('userId');
    if (workspaceId === undefined || userId === undefined) {
      return fail(request, reply, 401, 'No active session');
    }
    const body = request.body ?? {};
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    if (model.length === 0 || model.length > 200) {
      return fail(
        request,
        reply,
        400,
        'A model id is required',
        'Use the model id the egress audit shows.',
      );
    }
    const okPrice = (v: unknown): v is number =>
      typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 10_000;
    const clear = body.clear === true;
    if (!clear && (!okPrice(body.input_per_mtok) || !okPrice(body.output_per_mtok))) {
      return fail(
        request,
        reply,
        400,
        'Invalid price',
        'Give input and output prices in US dollars per million tokens, from 0 to 10000.',
      );
    }

    const next = await db.transaction(async (tx) => {
      const [ws] = await tx
        .select({ settings: core.workspaces.settings })
        .from(core.workspaces)
        .where(eq(core.workspaces.id, workspaceId))
        .for('update')
        .limit(1);
      const settings = (ws?.settings ?? {}) as Record<string, unknown>;
      const prices = pricesOf(settings);
      if (clear) delete prices[model];
      else
        prices[model] = {
          input_per_mtok: body.input_per_mtok as number,
          output_per_mtok: body.output_per_mtok as number,
        };
      await tx
        .update(core.workspaces)
        .set({ settings: { ...settings, [PRICES_KEY]: prices } })
        .where(eq(core.workspaces.id, workspaceId));
      return prices;
    });

    auditLog(request.log, {
      event: 'ai_pass_settings.updated',
      actorUserId: userId,
      workspaceId,
      ip: request.ip,
      ua: request.headers['user-agent'] ?? null,
      priceModel: model,
      price: clear ? null : next[model],
    });
    return reply.send({ prices: next });
  });

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
