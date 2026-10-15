import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { core, facts, read, security, type Database } from '@repopulse/shared';
import { RADAR_RULES, SENSITIVE_CHANGE_SCANNER_KEY, isEnabled } from '@repopulse/security';
import { sendProblem } from '../../lib/problem.js';

// Sensitive-change radar screen (W18-29, over W18-21's findings).
//
// One read that says everything the screen needs to tell "nothing loosened"
// apart from "nothing looked". The radar only reads diffs as they ARRIVE (it
// rides the secrets stream on pr_synced/push), never history — so an empty
// list on an install that has not seen a push since the radar shipped is not a
// clean bill of health, and the screen must be able to say which it is. Hence
// enablement and run counts travel with the findings rather than being left
// for the browser to guess.

export interface SensitiveChangesRoutesOptions {
  db: Database;
}

function fail(req: FastifyRequest, reply: FastifyReply, status: number, title: string) {
  sendProblem(req, reply, status, title, {});
  return reply;
}

/** Findings shown per section. The list is a review queue, not an archive. */
const LIMIT = 200;

/** Run counts look back this far; older runs say nothing about today's diffs. */
const RUN_WINDOW_DAYS = 30;

export default async function sensitiveChangesRoutes(
  app: FastifyInstance,
  opts: SensitiveChangesRoutesOptions,
): Promise<void> {
  const { db } = opts;

  app.get<{ Querystring: { repos?: string } }>(
    '/security/sensitive-changes',
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');

      // The global repository filter, as every org screen reads it.
      const repoFilter = (request.query.repos ?? '')
        .split(',')
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0);

      const repos = await db
        .select({ id: core.repos.id, org: core.repos.org, name: core.repos.name })
        .from(core.repos)
        .where(
          and(
            eq(core.repos.workspaceId, workspaceId),
            eq(core.repos.isArchived, false),
            ...(repoFilter.length > 0 ? [inArray(core.repos.id, repoFilter)] : []),
          ),
        )
        .orderBy(core.repos.org, core.repos.name);
      const repoIds = repos.map((r) => r.id);

      const config =
        repoIds.length === 0
          ? []
          : await db
              .select({
                repoId: security.repoScannerConfig.repoId,
                enabled: security.repoScannerConfig.enabled,
              })
              .from(security.repoScannerConfig)
              .where(
                and(
                  eq(security.repoScannerConfig.workspaceId, workspaceId),
                  eq(security.repoScannerConfig.scannerKey, SENSITIVE_CHANGE_SCANNER_KEY),
                  inArray(security.repoScannerConfig.repoId, repoIds),
                ),
              );
      const stored = new Map(config.map((c) => [c.repoId, c]));
      const disabled = repos.filter(
        (r) => !isEnabled(SENSITIVE_CHANGE_SCANNER_KEY, stored.get(r.id)),
      );

      const since = new Date(Date.now() - RUN_WINDOW_DAYS * 86_400_000);
      const runScope = and(
        eq(security.scanRuns.workspaceId, workspaceId),
        eq(security.scanRuns.scannerKey, SENSITIVE_CHANGE_SCANNER_KEY),
        inArray(security.scanRuns.repoId, repoIds),
      );
      const [runs] =
        repoIds.length === 0
          ? [undefined]
          : await db
              .select({
                ever: sql<number>`count(*)::int`,
                recent: sql<number>`count(*) filter (where ${security.scanRuns.startedAt} >= ${since.toISOString()})::int`,
                failed: sql<number>`count(*) filter (where ${security.scanRuns.startedAt} >= ${since.toISOString()} and ${security.scanRuns.status} = 'failed')::int`,
                lastAt: sql<string | null>`max(${security.scanRuns.finishedAt})`,
              })
              .from(security.scanRuns)
              .where(runScope);

      // Per-rule counts over every open signal, not just the page shown.
      const counts =
        repoIds.length === 0
          ? []
          : await db
              .select({
                ruleId: read.findings.ruleId,
                experimental: read.findings.experimental,
                n: sql<number>`count(*)::int`,
              })
              .from(read.findings)
              .where(
                and(
                  eq(read.findings.workspaceId, workspaceId),
                  eq(read.findings.scannerKey, SENSITIVE_CHANGE_SCANNER_KEY),
                  inArray(read.findings.status, ['open', 'confirmed']),
                  inArray(read.findings.repoId, repoIds),
                ),
              )
              .groupBy(read.findings.ruleId, read.findings.experimental);
      const countOf = (ruleId: string, experimental: boolean) =>
        counts.find((c) => c.ruleId === ruleId && c.experimental === experimental)?.n ?? 0;

      // One query per section, each with its own limit, so a flood of shadow
      // signals from a noisy candidate rule can never push an active one off
      // the page (or the reverse).
      const section = (experimental: boolean) =>
        repoIds.length === 0
          ? Promise.resolve([])
          : db
              .select({
                id: read.findings.id,
                repoId: read.findings.repoId,
                severity: read.findings.severity,
                title: read.findings.title,
                file: read.findings.file,
                lineStart: read.findings.lineStart,
                ruleId: read.findings.ruleId,
                status: read.findings.status,
                firstSeenAt: read.findings.firstSeenAt,
                prNumber: facts.pullRequests.number,
              })
              .from(read.findings)
              .leftJoin(
                facts.pullRequests,
                and(
                  eq(facts.pullRequests.id, read.findings.pullRequestId),
                  eq(facts.pullRequests.workspaceId, workspaceId),
                ),
              )
              .where(
                and(
                  eq(read.findings.workspaceId, workspaceId),
                  eq(read.findings.scannerKey, SENSITIVE_CHANGE_SCANNER_KEY),
                  eq(read.findings.experimental, experimental),
                  inArray(read.findings.status, ['open', 'confirmed']),
                  inArray(read.findings.repoId, repoIds),
                ),
              )
              .orderBy(desc(read.findings.firstSeenAt), desc(read.findings.id))
              .limit(LIMIT);
      const [active, shadow] = await Promise.all([section(false), section(true)]);

      const ruleIds = [...new Set(RADAR_RULES.map((r) => r.id))];
      const registry = await db
        .select({ ruleId: security.ruleRegistry.ruleId, status: security.ruleRegistry.status })
        .from(security.ruleRegistry)
        .where(
          and(
            eq(security.ruleRegistry.workspaceId, workspaceId),
            inArray(security.ruleRegistry.ruleId, ruleIds),
          ),
        );
      const lifecycle = new Map(registry.map((r) => [r.ruleId, r.status]));

      const repoById = new Map(repos.map((r) => [r.id, r]));
      const item = (r: (typeof active)[number]) => ({
        id: r.id,
        repo: {
          id: r.repoId,
          org: repoById.get(r.repoId)?.org ?? '',
          name: repoById.get(r.repoId)?.name ?? '',
        },
        severity: r.severity,
        title: r.title,
        file: r.file,
        line: r.lineStart,
        rule_id: r.ruleId,
        status: r.status,
        pr_number: r.prNumber,
        first_seen_at: r.firstSeenAt.toISOString(),
      });

      return reply.send({
        repos: {
          total: repos.length,
          enabled: repos.length - disabled.length,
          disabled: disabled.map((r) => ({ id: r.id, org: r.org, name: r.name })),
        },
        runs: {
          window_days: RUN_WINDOW_DAYS,
          recent: runs?.recent ?? 0,
          failed: runs?.failed ?? 0,
          ever: runs?.ever ?? 0,
          last_finished_at: runs?.lastAt ? new Date(runs.lastAt).toISOString() : null,
        },
        rules: ruleIds.map((id) => {
          const rule = RADAR_RULES.find((r) => r.id === id)!;
          const state = lifecycle.get(id);
          return {
            rule_id: id,
            what: rule.what,
            category: rule.category,
            // No registry row = the shipped default: a candidate, in shadow.
            lifecycle: state === 'active' || state === 'deprecated' ? state : 'candidate',
            open_active: countOf(id, false),
            open_shadow: countOf(id, true),
          };
        }),
        totals: {
          active: counts.filter((c) => !c.experimental).reduce((a, c) => a + c.n, 0),
          shadow: counts.filter((c) => c.experimental).reduce((a, c) => a + c.n, 0),
        },
        active: active.map(item),
        shadow: shadow.map(item),
      });
    },
  );
}
