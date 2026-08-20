import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { core, read, type Database } from '@repopulse/shared';
import { scoreLetter } from '@repopulse/insights';
import { sendProblem } from '../../lib/problem.js';

// Risk surfaces API (W9-11, RISK_MODEL.md §4/§5, FR-RISK-5/6).
//
// Two honesty rules govern every payload here, both carried from the metrics
// presentation rule: RAW COUNTS ARE NEVER HIDDEN ("200 findings → 12 act" is
// the credibility story), and an absent sub-score means an ABSENT AXIS with a
// basis label — never a fake grade.

export interface RiskRoutesOptions {
  db: Database;
}

/** RISK_MODEL §4: which finding dimensions roll up into which axis. */
export const AXIS_DIMENSIONS: Record<string, string[]> = {
  security: ['security', 'secrets', 'sast', 'iac', 'dependency', 'chain', 'compound'],
  codeHealth: ['code_health', 'logging'],
  performance: ['performance'],
};

function fail(
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  title: string,
): FastifyReply {
  sendProblem(req, reply, status, title, {});
  return reply;
}

export default async function riskRoutes(
  app: FastifyInstance,
  opts: RiskRoutesOptions,
): Promise<void> {
  const { db } = opts;

  /** GET /risk/top — the Top Risks card, org-wide or for one repo. */
  app.get<{ Querystring: { repo_id?: string; limit?: string } }>(
    '/risk/top',
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
      const repoId = Number(request.query.repo_id);
      const limit = Math.min(20, Number(request.query.limit) || 5);

      const scope = [
        eq(read.findings.workspaceId, workspaceId),
        inArray(read.findings.status, ['open', 'confirmed']),
        // Shadow findings are excluded from anything that carries weight
        // (W9-07). They are visible in the explorer's own facet instead.
        eq(read.findings.experimental, false),
        ...(Number.isInteger(repoId) ? [eq(read.findings.repoId, repoId)] : []),
      ];

      const rows = await db
        .select({
          id: read.findings.id,
          repoId: read.findings.repoId,
          org: core.repos.org,
          repoName: core.repos.name,
          dimension: read.findings.dimension,
          severity: read.findings.severity,
          title: read.findings.title,
          file: read.findings.file,
          effectiveRisk: read.findings.effectiveRisk,
          riskBand: read.findings.riskBand,
          riskFactors: read.findings.riskFactors,
        })
        .from(read.findings)
        .innerJoin(core.repos, eq(core.repos.id, read.findings.repoId))
        .where(and(...scope, isNotNull(read.findings.effectiveRisk)))
        .orderBy(desc(read.findings.effectiveRisk), desc(read.findings.id))
        .limit(limit);

      // The denominators. "12 act out of 200 open" is the same credibility
      // story as the CVE funnel, and hiding the 200 is what makes a security
      // number look invented.
      const [totals] = await db
        .select({
          open: sql<number>`count(*)::int`,
          act: sql<number>`count(*) filter (where ${read.findings.riskBand} = 'act')::int`,
          schedule: sql<number>`count(*) filter (where ${read.findings.riskBand} = 'schedule')::int`,
          track: sql<number>`count(*) filter (where ${read.findings.riskBand} = 'track')::int`,
          unpriced: sql<number>`count(*) filter (where ${read.findings.effectiveRisk} is null)::int`,
        })
        .from(read.findings)
        .where(and(...scope));

      return reply.send({
        items: rows.map((r) => ({
          finding_id: r.id,
          repo: { id: r.repoId, org: r.org, name: r.repoName },
          dimension: r.dimension,
          // Raw severity travels beside every risk number, always.
          severity: r.severity,
          title: r.title,
          file: r.file,
          effective_risk: r.effectiveRisk === null ? null : Number(r.effectiveRisk),
          risk_band: r.riskBand,
          // The arithmetic, so the popover shows its working rather than a
          // number to be taken on trust.
          risk_factors: r.riskFactors,
        })),
        counts: {
          open: totals?.open ?? 0,
          act: totals?.act ?? 0,
          schedule: totals?.schedule ?? 0,
          track: totals?.track ?? 0,
          // Findings the nightly reprice has not reached yet. Reported rather
          // than folded into `track`, which would claim they are low risk.
          unpriced: totals?.unpriced ?? 0,
        },
      });
    },
  );

  /** GET /risk/axes — A–E letters per axis, with their top contributors. */
  app.get<{ Querystring: { repo_id?: string } }>('/risk/axes', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
    const repoId = Number(request.query.repo_id);

    const scope = [
      eq(read.findings.workspaceId, workspaceId),
      inArray(read.findings.status, ['open', 'confirmed']),
      eq(read.findings.experimental, false),
      ...(Number.isInteger(repoId) ? [eq(read.findings.repoId, repoId)] : []),
    ];

    const findings = await db
      .select({
        id: read.findings.id,
        dimension: read.findings.dimension,
        title: read.findings.title,
        severity: read.findings.severity,
        effectiveRisk: read.findings.effectiveRisk,
      })
      .from(read.findings)
      .where(and(...scope, isNotNull(read.findings.effectiveRisk)))
      .orderBy(desc(read.findings.effectiveRisk))
      .limit(500);

    const axes = Object.entries(AXIS_DIMENSIONS).map(([axis, dimensions]) => {
      const mine = findings.filter((f) => dimensions.includes(f.dimension));
      return {
        axis,
        dimensions,
        // The letter comes from the SUB-SCORE, which the caller supplies from
        // the health endpoint — an axis letter derived from findings alone
        // would be a second scoring system with the same name.
        letter: null as string | null,
        // Absent sub-score ⇒ absent axis ⇒ this basis line, never a grade.
        basis:
          mine.length === 0
            ? 'no findings in this axis — that is not a grade, and no scanner may have run'
            : `${mine.length} open findings`,
        top: mine.slice(0, 3).map((f) => ({
          finding_id: f.id,
          title: f.title,
          severity: f.severity,
          effective_risk: f.effectiveRisk === null ? null : Number(f.effectiveRisk),
        })),
      };
    });

    return reply.send({ axes, letter_bands: { A: 85, B: 70, C: 50, D: 30 } });
  });

  /** The letter for a sub-score, exposed so the UI never re-derives it. */
  app.get<{ Params: { score: string } }>('/risk/letter/:score', async (request, reply) => {
    const score = Number(request.params.score);
    if (!Number.isFinite(score)) return fail(request, reply, 400, 'Invalid score');
    return reply.send({ score, letter: scoreLetter(score) });
  });
}
