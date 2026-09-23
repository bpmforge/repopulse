import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { core, plans as plansSchema, read, type Database } from '@repopulse/shared';
import {
  selectTopActions,
  summarizeCoverage,
  type CoverageState,
  type FindingActionCandidate,
  type PlanItemActionCandidate,
  type RepoCoverageInput,
  type TopAction,
} from '@repopulse/insights';
import { repoCapabilities } from '../../lib/capability.js';

// The deterministic top-actions data source (W17-16).
//
// Warehouse-only, like every other org composite: three bounded queries and,
// when there is nothing to do, a capability read. The ranking itself is pure and
// lives in @repopulse/insights — this file is the part that has to know about
// tenancy, statuses and SQL.
//
// BOUNDED ON PURPOSE. /org/attention loops over every repository calling
// repoHealth, which is a query fan-out that grows with the workspace. This card
// sits at the top of the overview, so it reads a fixed number of candidate rows
// and ranks them in memory.

/**
 * How many candidates each side contributes before ranking.
 *
 * Larger than the three we show, because dedup can knock rows out: a plan item
 * about a finding already on the card takes no slot, and without slack a card
 * that should show three would show two.
 */
export const CANDIDATE_LIMIT = 20;

/**
 * Repositories inspected for coverage state on the EMPTY path.
 *
 * repoCapabilities is several queries per repository, so this is capped and the
 * summary reports the count it actually looked at rather than implying it
 * covered the whole workspace.
 */
export const COVERAGE_REPO_LIMIT = 10;

/**
 * Statuses a finding must be in to be worth acting on.
 *
 * An ALLOWLIST, not a denylist of the two the ticket names. The column check
 * permits open | confirmed | dismissed | resolved | wont_fix, and `wont_fix` is
 * exactly as settled as `dismissed` — a denylist would have surfaced it, and
 * would surface whatever status is added next.
 */
export const ACTIONABLE_FINDING_STATUSES = ['open', 'confirmed'] as const;

/**
 * Plan item statuses that still represent work.
 *
 * `done` and `dismissed` are decided. `regressed` is included deliberately:
 * something that came undone is the most actionable thing on a plan.
 */
export const ACTIONABLE_PLAN_ITEM_STATUSES = [
  'proposed',
  'accepted',
  'in_progress',
  'regressed',
] as const;

export interface TopActionsResult {
  actions: TopAction[];
  /**
   * Present ONLY when `actions` is empty.
   *
   * An empty card must say what has and has not been measured (W17-16): "we
   * looked at nine repositories and nothing is pressing" and "we have never
   * successfully measured anything" render identically otherwise, and the
   * second wearing the first's clothes is the product telling a team their code
   * is fine when it has not looked. Non-empty responses leave it null rather
   * than paying for a capability fan-out nobody reads.
   */
  coverage: CoverageState | null;
  generatedAt: string;
}

export interface TopActionsOptions {
  now?: Date;
  candidateLimit?: number;
  coverageRepoLimit?: number;
}

async function findingCandidates(
  db: Database,
  workspaceId: number,
  limit: number,
): Promise<FindingActionCandidate[]> {
  const rows = await db
    .select({
      id: read.findings.id,
      repoId: read.findings.repoId,
      repoName: core.repos.name,
      title: read.findings.title,
      dimension: read.findings.dimension,
      severity: read.findings.severity,
      effectiveRisk: read.findings.effectiveRisk,
      riskBand: read.findings.riskBand,
    })
    .from(read.findings)
    .innerJoin(core.repos, eq(core.repos.id, read.findings.repoId))
    .where(
      and(
        eq(read.findings.workspaceId, workspaceId),
        // Belt and braces on the join: a repository row from another tenant can
        // never contribute a name to this card.
        eq(core.repos.workspaceId, workspaceId),
        inArray(read.findings.status, [...ACTIONABLE_FINDING_STATUSES]),
        // W9-07 shadow mode: a candidate rule's findings are excluded from org
        // banners, and this card is an org banner.
        eq(read.findings.experimental, false),
      ),
    )
    // NULLS LAST so an unpriced finding cannot outrank a priced one in SQL and
    // then be re-sorted anyway. The in-memory comparator agrees with this.
    .orderBy(
      sql`${read.findings.effectiveRisk} desc nulls last`,
      desc(read.findings.severity),
      asc(read.findings.id),
    )
    .limit(limit);

  return rows.map((row) => ({
    kind: 'finding',
    findingId: row.id,
    repoId: row.repoId,
    repoName: row.repoName,
    title: row.title,
    dimension: row.dimension,
    severity: row.severity,
    // COERCED. effective_risk is `numeric`, and drizzle returns numerics as
    // strings — comparing '9.00' with '80.00' as strings sorts the smaller risk
    // first, and every fixture built from JS numbers would still pass.
    effectiveRisk: row.effectiveRisk === null ? null : Number(row.effectiveRisk),
    riskBand: row.riskBand,
  }));
}

/** Finding ids named by a plan item's evidence, if any. */
function evidenceFindingIds(evidence: Record<string, unknown> | null): number[] {
  const ids = evidence?.findingIds;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is number => typeof id === 'number');
}

async function planItemCandidates(
  db: Database,
  workspaceId: number,
  limit: number,
): Promise<PlanItemActionCandidate[]> {
  const rows = await db
    .select({
      id: plansSchema.planItems.id,
      planId: plansSchema.planItems.planId,
      catalogId: plansSchema.planItems.catalogId,
      recommendation: plansSchema.planItems.recommendation,
      effort: plansSchema.planItems.effort,
      rank: plansSchema.planItems.rank,
      evidence: plansSchema.planItems.evidence,
    })
    .from(plansSchema.planItems)
    .innerJoin(
      plansSchema.improvementPlans,
      eq(plansSchema.improvementPlans.id, plansSchema.planItems.planId),
    )
    .where(
      and(
        eq(plansSchema.planItems.workspaceId, workspaceId),
        eq(plansSchema.improvementPlans.workspaceId, workspaceId),
        // An archived plan is history. Proposing work from one would resurrect
        // decisions a team already closed.
        eq(plansSchema.improvementPlans.status, 'active'),
        inArray(plansSchema.planItems.status, [...ACTIONABLE_PLAN_ITEM_STATUSES]),
      ),
    )
    // The plan's OWN rank — generatePlanItems() produced it from rankInputFor(),
    // so this reuses that arithmetic rather than recomputing (or inventing) it.
    .orderBy(asc(plansSchema.planItems.rank), asc(plansSchema.planItems.id))
    .limit(limit);

  return rows.map((row) => ({
    kind: 'plan_item',
    planItemId: row.id,
    planId: row.planId,
    catalogId: row.catalogId,
    recommendation: row.recommendation,
    effort: row.effort,
    rank: row.rank,
    findingIds: evidenceFindingIds(row.evidence),
  }));
}

async function coverageFor(
  db: Database,
  workspaceId: number,
  limit: number,
  now: Date,
): Promise<CoverageState> {
  const repos = await db
    .select({ id: core.repos.id, name: core.repos.name })
    .from(core.repos)
    .where(eq(core.repos.workspaceId, workspaceId))
    .orderBy(asc(core.repos.name), asc(core.repos.id))
    .limit(limit);

  const inputs: RepoCoverageInput[] = [];
  for (const repo of repos) {
    // The ONE canonical producer (W17-10). Re-deriving freshness here would be
    // the second parallel status system that ticket exists to prevent.
    const capabilities = await repoCapabilities(db, workspaceId, repo.id, { now });
    if (!capabilities) continue;
    inputs.push({
      repoId: repo.id,
      repoName: repo.name,
      capabilities: capabilities.capabilities,
    });
  }
  return summarizeCoverage(inputs);
}

/**
 * At most three things worth doing next, workspace-scoped.
 *
 * Every query filters on workspace_id, so a workspace with no rows gets an
 * empty list and a coverage state — never another tenant's work.
 */
export async function collectTopActions(
  db: Database,
  workspaceId: number,
  opts: TopActionsOptions = {},
): Promise<TopActionsResult> {
  const now = opts.now ?? new Date();
  const candidateLimit = opts.candidateLimit ?? CANDIDATE_LIMIT;

  const [findings, planItems] = await Promise.all([
    findingCandidates(db, workspaceId, candidateLimit),
    planItemCandidates(db, workspaceId, candidateLimit),
  ]);

  const actions = selectTopActions({ findings, planItems });

  return {
    actions,
    coverage:
      actions.length === 0
        ? await coverageFor(db, workspaceId, opts.coverageRepoLimit ?? COVERAGE_REPO_LIMIT, now)
        : null,
    generatedAt: now.toISOString(),
  };
}

/** The wire shape. snake_case, like the rest of the org composites. */
export function serializeTopActions(result: TopActionsResult): Record<string, unknown> {
  return {
    actions: result.actions.map((action) => ({
      id: action.id,
      kind: action.kind,
      title: action.title,
      reason: action.reason,
      repo_id: action.repoId,
      repo_name: action.repoName,
      effort: action.effort,
      target:
        action.target.kind === 'finding'
          ? {
              kind: 'finding',
              finding_id: action.target.findingId,
              repo_id: action.target.repoId,
            }
          : {
              kind: 'plan_item',
              plan_id: action.target.planId,
              plan_item_id: action.target.planItemId,
            },
      href: action.href,
    })),
    coverage:
      result.coverage === null
        ? null
        : {
            basis: result.coverage.basis,
            repos_total: result.coverage.reposTotal,
            repos_measured: result.coverage.reposMeasured,
            repos_never_measured: result.coverage.reposNeverMeasured,
            repos_stale: result.coverage.reposStale,
            notices: result.coverage.notices.map((n) => ({
              repo_id: n.repoId,
              repo_name: n.repoName,
              capability: n.capability,
              state: n.state,
              detail: n.detail,
            })),
            unsupported: result.coverage.unsupported,
            summary: result.coverage.summary,
          },
    generated_at: result.generatedAt,
  };
}
