import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { core, read, security, type Database } from '@repopulse/shared';
import { sendProblem } from '../../lib/problem.js';

// Code Health API (W9-06, CODE_HEALTH_SUITE.md §6, FR-CH-6).
//
// Everything here reads snapshots and findings the W9 scanners wrote. The same
// rule as the Security tab governs every field: a scanner that has never run,
// one that is switched off, and one that ran and found nothing are three
// different answers, and a number on its own cannot tell them apart.

export interface CodeHealthRoutesOptions {
  db: Database;
}

/** Scanners this tab reports on. */
const CODE_HEALTH_SCANNERS = ['code_health_tools', 'anti_slop', 'logging_hygiene'] as const;

const CH_METRICS = ['ch_duplication_pct', 'ch_complexity_p90', 'ch_worst_fn_count'] as const;

function fail(
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  title: string,
): FastifyReply {
  sendProblem(req, reply, status, title, {});
  return reply;
}

export default async function codeHealthRoutes(
  app: FastifyInstance,
  opts: CodeHealthRoutesOptions,
): Promise<void> {
  const { db } = opts;

  /** GET /repos/:repoId/code-health — the tab's whole payload. */
  app.get<{ Params: { repoId: string } }>('/repos/:repoId/code-health', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
    const repoId = Number(request.params.repoId);
    if (!Number.isInteger(repoId)) return fail(request, reply, 400, 'Invalid repo id');

    const [repo] = await db
      .select({ id: core.repos.id, org: core.repos.org, name: core.repos.name })
      .from(core.repos)
      .where(and(eq(core.repos.id, repoId), eq(core.repos.workspaceId, workspaceId)))
      .limit(1);
    if (!repo) return fail(request, reply, 404, 'Repo not found');

    // Posture series: newest first, so the header reads the latest and the
    // sparkline reads the rest. One query for every ch_* and debt key.
    const snapshots = await db
      .select({
        metricKey: read.metricSnapshots.metricKey,
        value: read.metricSnapshots.value,
        computedAt: read.metricSnapshots.computedAt,
      })
      .from(read.metricSnapshots)
      .where(
        and(
          eq(read.metricSnapshots.workspaceId, workspaceId),
          eq(read.metricSnapshots.repoId, repoId),
          inArray(read.metricSnapshots.metricKey, [...CH_METRICS, 'M13', 'M14']),
        ),
      )
      .orderBy(desc(read.metricSnapshots.computedAt))
      .limit(500);

    const series: Record<string, { value: number; at: string }[]> = {};
    for (const row of snapshots) {
      const list = series[row.metricKey] ?? [];
      list.push({ value: Number(row.value), at: row.computedAt.toISOString() });
      series[row.metricKey] = list;
    }

    const runs = await db
      .select()
      .from(security.scanRuns)
      .where(
        and(
          eq(security.scanRuns.workspaceId, workspaceId),
          eq(security.scanRuns.repoId, repoId),
          inArray(security.scanRuns.scannerKey, [...CODE_HEALTH_SCANNERS]),
        ),
      )
      .orderBy(desc(security.scanRuns.startedAt))
      .limit(200);

    const latest = new Map<string, (typeof runs)[number]>();
    for (const run of runs) if (!latest.has(run.scannerKey)) latest.set(run.scannerKey, run);

    const findings = await db
      .select({
        id: read.findings.id,
        dimension: read.findings.dimension,
        ruleId: read.findings.ruleId,
        scannerKey: read.findings.scannerKey,
        severity: read.findings.severity,
        title: read.findings.title,
        file: read.findings.file,
        lineStart: read.findings.lineStart,
        evidence: read.findings.evidence,
      })
      .from(read.findings)
      .where(
        and(
          eq(read.findings.workspaceId, workspaceId),
          eq(read.findings.repoId, repoId),
          inArray(read.findings.dimension, ['code_health', 'logging']),
          inArray(read.findings.status, ['open', 'confirmed']),
        ),
      )
      .orderBy(desc(read.findings.severity))
      .limit(500);

    const byRule = new Map<string, number>();
    for (const finding of findings) {
      const key = finding.ruleId ?? 'unattributed';
      byRule.set(key, (byRule.get(key) ?? 0) + 1);
    }

    return reply.send({
      repo: { id: repo.id, org: repo.org, name: repo.name },
      // Oldest-first for charting; the API reversed it once rather than every
      // consumer reversing it differently.
      series: Object.fromEntries(
        Object.entries(series).map(([key, points]) => [key, [...points].reverse()]),
      ),
      scanners: CODE_HEALTH_SCANNERS.map((key) => {
        const run = latest.get(key);
        return {
          key,
          state: !run
            ? ('never_run' as const)
            : run.status === 'failed'
              ? ('error' as const)
              : run.partial
                ? ('partial' as const)
                : ('ok' as const),
          last_run_at: run?.finishedAt?.toISOString() ?? run?.startedAt.toISOString() ?? null,
          error: run?.error ?? null,
          tool_versions: run?.toolVersions ?? null,
          // A dash, not a zero, is the UI's job — but the API must not pretend
          // either: null means "nothing has looked".
          open_findings: run ? findings.filter((f) => f.scannerKey === key).length : null,
        };
      }),
      // Worst-10 by severity then line count, with the location the drill-down
      // needs. Complexity findings carry their measurement in the evidence.
      worst_complexity: findings
        .filter((f) => f.ruleId?.startsWith('complexity.'))
        .slice(0, 10)
        .map((f) => ({
          finding_id: f.id,
          rule_id: f.ruleId,
          file: f.file,
          line: f.lineStart,
          severity: f.severity,
          title: f.title,
          evidence: f.evidence,
        })),
      slop_by_rule: [...byRule.entries()]
        .filter(([rule]) => rule.startsWith('slop.') || rule.startsWith('bpm-ch-'))
        .map(([rule, count]) => ({ rule, count }))
        .sort((a, b) => b.count - a.count),
      logging_by_rule: [...byRule.entries()]
        .filter(([rule]) => rule.startsWith('bpm-log-') || rule === 'logging.judgment')
        .map(([rule, count]) => ({ rule, count }))
        .sort((a, b) => b.count - a.count),
      open_total: findings.length,
    });
  });

  /** GET /org/code-health — the org rollup tile. */
  app.get('/org/code-health', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');

    const [totals] = await db
      .select({
        open: sql<number>`count(*)::int`,
        repos: sql<number>`count(distinct ${read.findings.repoId})::int`,
      })
      .from(read.findings)
      .where(
        and(
          eq(read.findings.workspaceId, workspaceId),
          inArray(read.findings.dimension, ['code_health', 'logging']),
          inArray(read.findings.status, ['open', 'confirmed']),
        ),
      );

    const [scanned] = await db
      .select({ n: sql<number>`count(distinct ${security.scanRuns.repoId})::int` })
      .from(security.scanRuns)
      .where(
        and(
          eq(security.scanRuns.workspaceId, workspaceId),
          inArray(security.scanRuns.scannerKey, [...CODE_HEALTH_SCANNERS]),
          eq(security.scanRuns.status, 'succeeded'),
        ),
      );

    const [repoCount] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(core.repos)
      .where(eq(core.repos.workspaceId, workspaceId));

    return reply.send({
      open_findings: totals?.open ?? 0,
      repos_with_findings: totals?.repos ?? 0,
      repos_scanned: scanned?.n ?? 0,
      repos_total: repoCount?.n ?? 0,
      // The basis, same discipline as the security tile: "0 findings" across
      // 40 repositories means something very different when 2 were scanned.
      basis:
        (scanned?.n ?? 0) === 0
          ? 'no repository has been scanned yet'
          : `${scanned?.n ?? 0} of ${repoCount?.n ?? 0} repositories scanned`,
    });
  });
}
