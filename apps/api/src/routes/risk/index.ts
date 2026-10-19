import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { core, read, type Database } from '@repopulse/shared';
import { SECURITY_DIMENSIONS, scoreLetter } from '@repopulse/insights';
import { healthBand } from '@repopulse/shared/health-band';
import { sendProblem } from '../../lib/problem.js';
import { repoHealthMany } from '../org/health.js';

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
  // The same set the Security sub-score is computed from (W20-09, DSH-73).
  security: SECURITY_DIMENSIONS,
  // W10-05: the three warehouse registers roll into Code Health rather than
  // getting axes of their own. A bus factor, an import cycle and a test gap
  // are all statements about how maintainable this code is, and six axes of
  // one finding each is a dashboard nobody reads.
  codeHealth: ['code_health', 'logging', 'slop', 'knowledge', 'architecture', 'test_gap'],
  // Supply Chain is its own axis because its inputs come from outside the
  // repository — a registry and an EOL calendar — and it moves on days when
  // nobody committed anything.
  supplyChain: ['dependency_health'],
  // NO PERFORMANCE AXIS (W20-09, UX_TODO DSH-73). It had no health sub-score
  // behind it, so it read "not measured" in every workspace for ever, however
  // many performance findings existed. Those findings stay on the findings
  // screens and in Top risks; an axis comes back when a sub-score exists.
};

/**
 * The view's repositories, from `repo_id` (one) or `repos` (a csv, W20-09,
 * UX_TODO DSH-02). Non-numeric parts are dropped rather than 400ing a tile.
 */
function scopeOf(query: { repo_id?: string; repos?: string }): number[] {
  const one = Number(query.repo_id);
  if (Number.isInteger(one) && one > 0) return [one];
  if (!query.repos || query.repos === 'all') return [];
  return [
    ...new Set(
      query.repos
        .split(',')
        .map(Number)
        .filter((n) => Number.isInteger(n) && n > 0),
    ),
  ];
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

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
  app.get<{ Querystring: { repo_id?: string; repos?: string; limit?: string } }>(
    '/risk/top',
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
      const repoIds = scopeOf(request.query);
      const limit = Math.min(20, Number(request.query.limit) || 5);

      const scope = [
        eq(read.findings.workspaceId, workspaceId),
        inArray(read.findings.status, ['open', 'confirmed']),
        // Shadow findings are excluded from anything that carries weight
        // (W9-07). They are visible in the explorer's own facet instead.
        eq(read.findings.experimental, false),
        ...(repoIds.length > 0 ? [inArray(read.findings.repoId, repoIds)] : []),
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

  /**
   * GET /risk/axes — each axis as its 0-100 sub-score and band word, with its
   * top contributors.
   *
   * NO LETTERS (W20-09, UX_TODO DSH-11). The axes were served and shown as A–E
   * grades, and a screen reader announced "Security grade B" — against UX_SPEC
   * principle 4 and the no-letter-grades decision (N-9). An axis is now its
   * number and the same 3-band word the health badge uses.
   *
   * ONE REPOSITORY OR MANY (W20-09, UX_TODO DSH-72). Without a repo_id this
   * computed no sub-scores at all, so the Overview card read "not measured" on
   * every axis in every workspace. A set of repositories (or the whole
   * workspace) now rolls the repositories' own sub-scores up: the MEDIAN is the
   * axis score and the WORST repository is named beside it, because a median
   * alone would hide the one repository that needs the work.
   */
  app.get<{ Querystring: { repo_id?: string; repos?: string } }>(
    '/risk/axes',
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
      const repoIds = scopeOf(request.query);

      const scope = [
        eq(read.findings.workspaceId, workspaceId),
        inArray(read.findings.status, ['open', 'confirmed']),
        eq(read.findings.experimental, false),
        ...(repoIds.length > 0 ? [inArray(read.findings.repoId, repoIds)] : []),
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

      // The sub-scores come from the health score — the same numbers the repo
      // screen shows — rather than being derived from findings here, which
      // would be a second scoring system wearing the first one's name. An
      // absent sub-score is an absent axis with a basis line saying why;
      // FR-INSIGHTS-3 forbids showing a score nobody measured.
      const repos = await db
        .select({
          id: core.repos.id,
          org: core.repos.org,
          name: core.repos.name,
          pushedAt: core.repos.pushedAt,
        })
        .from(core.repos)
        .where(
          and(
            eq(core.repos.workspaceId, workspaceId),
            repoIds.length > 0 ? inArray(core.repos.id, repoIds) : undefined,
          ),
        );
      const healths = await repoHealthMany(db, workspaceId, repos, '30d', Date.now());
      const single = repoIds.length === 1;

      const axes = Object.entries(AXIS_DIMENSIONS).map(([axis, dimensions]) => {
        const mine = findings.filter((f) => dimensions.includes(f.dimension));
        const measured = repos
          .map((repo) => ({
            repo,
            normalized: healths.get(repo.id)?.subScores.find((s) => s.key === axis)?.normalized,
          }))
          .filter(
            (m): m is { repo: (typeof repos)[number]; normalized: number } =>
              typeof m.normalized === 'number',
          );
        const score = measured.length === 0 ? null : median(measured.map((m) => m.normalized));
        const worst =
          measured.length === 0
            ? null
            : measured.reduce((w, m) => (m.normalized < w.normalized ? m : w));
        const rounded = score === null ? null : Math.round(score);
        const findingsText = `${mine.length} open finding${mine.length === 1 ? '' : 's'}`;

        let basis: string;
        if (score === null) {
          // The REAL reason, so the next step can be right (DSH-72): nothing
          // examined, or findings without a sub-score.
          basis =
            mine.length === 0
              ? repos.length === 0
                ? 'not measured — no repositories in this scope'
                : 'not measured — no scanner or analysis run has examined this scope yet'
              : `${findingsText}, but no sub-score could be computed for this axis`;
        } else if (single || measured.length === 1) {
          basis = `${findingsText}, sub-score ${rounded}`;
        } else {
          basis =
            `median of ${measured.length} measured repositories; lowest ` +
            `${worst!.repo.org}/${worst!.repo.name} at ${Math.round(worst!.normalized)} · ${findingsText}`;
        }

        return {
          axis,
          dimensions,
          score: rounded,
          // The health badge's 3-band word, never a letter (DSH-11).
          band: rounded === null ? null : healthBand(rounded),
          measured_repos: measured.length,
          worst:
            worst === null || single
              ? null
              : {
                  repo_id: worst.repo.id,
                  name: `${worst.repo.org}/${worst.repo.name}`,
                  score: Math.round(worst.normalized),
                },
          basis,
          top: mine.slice(0, 3).map((f) => ({
            finding_id: f.id,
            title: f.title,
            severity: f.severity,
            effective_risk: f.effectiveRisk === null ? null : Number(f.effectiveRisk),
          })),
        };
      });

      return reply.send({ axes, repos_in_scope: repos.length });
    },
  );

  /** The letter for a sub-score, exposed so the UI never re-derives it. */
  app.get<{ Params: { score: string } }>('/risk/letter/:score', async (request, reply) => {
    const score = Number(request.params.score);
    if (!Number.isFinite(score)) return fail(request, reply, 400, 'Invalid score');
    return reply.send({ score, letter: scoreLetter(score) });
  });
}
