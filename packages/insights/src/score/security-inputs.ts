import { and, eq, inArray, lte, sql } from 'drizzle-orm';
import { read, security, type Database } from '@repopulse/shared';

// The Security sub-score's inputs (W20-09, UX_TODO DSH-73). Here, in the
// package that owns the score, so the dashboard (apps/api org/health) and the
// report assembler feed the score the same numbers — two copies would let a
// report and the Overview disagree about one repository (UX_TODO ADM-71).

/**
 * Finding dimensions that make up the Security sub-score and the Security risk
 * axis (RISK_MODEL §4). Declared here, beside the score, so the axis route and
 * the health score cannot name two different sets.
 */
export const SECURITY_DIMENSIONS = [
  'security',
  'secrets',
  'sast',
  'iac',
  'dependency',
  'chain',
  'compound',
];

export interface SecurityInputs {
  openFindingDensity: number | null;
  worstOpenSeverity: number | null;
}

/**
 * The Security sub-score's inputs for many repositories, in two statements
 * (W20-09, UX_TODO DSH-73).
 *
 * repoHealthMany passed `null` for both, every time, so no repository ever had
 * a Security sub-score: a repository with open critical findings could wear a
 * green "good" badge, and the repo header's Security axis always said "no
 * sub-score could be computed". METRICS.md §3 defines the input — open
 * security findings weighted by severity, ramped 0 → 10 — and the worst open
 * severity rides beside it so one critical finding moves the score on its own.
 *
 * NULL, not zero, for a repository nothing has examined: "no findings because
 * nobody looked" must drop the sub-score (FR-INSIGHTS-3), never score it clean.
 * Examined means a scanner or analysis run succeeded, or a security finding
 * was ever recorded, whatever its status now. Shadow findings never count
 * (W9-07).
 */
export async function securityInputsMany(
  db: Database,
  workspaceId: number,
  repoIds: readonly number[],
  /**
   * A report's pin: only findings first seen and runs started at or before
   * it. Statuses are today's — finding status history is not snapshotted —
   * which is the same basis the report's own findings table already has.
   */
  asOf?: Date,
  /**
   * W20-24: read each finding's status AS IT WAS at `asOf`, from its history
   * (finding_events), instead of today's. The health tile's change compares
   * the score now with the score one window ago; with today's statuses in both
   * readings, a finding fixed this week lowered the score "a window ago" too
   * and the change could never show it. Ignored without `asOf`.
   */
  opts: { statusAtAsOf?: boolean } = {},
): Promise<Map<number, SecurityInputs>> {
  const out = new Map<number, SecurityInputs>();
  if (repoIds.length === 0) return out;
  const ids = [...repoIds];
  // The status at `asOf`: the newest event at or before it, else the status
  // the earliest later event moved it FROM, else today's (no history at all).
  const statusExpr =
    asOf && opts.statusAtAsOf
      ? sql`coalesce(
          (select fe.to_status from ${read.findingEvents} fe
            where fe.finding_id = ${read.findings.id} and fe.workspace_id = ${workspaceId}
              and fe.at <= ${asOf.toISOString()}
            order by fe.at desc, fe.id desc limit 1),
          (select fe.from_status from ${read.findingEvents} fe
            where fe.finding_id = ${read.findings.id} and fe.workspace_id = ${workspaceId}
              and fe.at > ${asOf.toISOString()}
            order by fe.at asc, fe.id asc limit 1),
          ${read.findings.status})`
      : sql`${read.findings.status}`;

  const findingRows = await db
    .select({
      repoId: read.findings.repoId,
      everRecorded: sql<number>`count(*)::int`,
      weighted: sql<number>`coalesce(sum(${read.findings.severity}) filter (where ${statusExpr} in ('open','confirmed')), 0)::int`,
      worst: sql<
        number | null
      >`max(${read.findings.severity}) filter (where ${statusExpr} in ('open','confirmed'))`,
    })
    .from(read.findings)
    .where(
      and(
        eq(read.findings.workspaceId, workspaceId),
        inArray(read.findings.repoId, ids),
        inArray(read.findings.dimension, SECURITY_DIMENSIONS),
        eq(read.findings.experimental, false),
        asOf ? lte(read.findings.firstSeenAt, asOf) : undefined,
      ),
    )
    .groupBy(read.findings.repoId);

  const examined = new Set<number>();
  for (const row of findingRows) if (row.everRecorded > 0) examined.add(row.repoId);
  const scanned = await db
    .selectDistinct({ repoId: security.scanRuns.repoId })
    .from(security.scanRuns)
    .where(
      and(
        eq(security.scanRuns.workspaceId, workspaceId),
        inArray(security.scanRuns.repoId, ids),
        eq(security.scanRuns.status, 'succeeded'),
        asOf ? lte(security.scanRuns.startedAt, asOf) : undefined,
      ),
    );
  for (const row of scanned) examined.add(row.repoId);
  const analysed = await db
    .selectDistinct({ repoId: read.analysisRuns.repoId })
    .from(read.analysisRuns)
    .where(
      and(
        eq(read.analysisRuns.workspaceId, workspaceId),
        inArray(read.analysisRuns.repoId, ids),
        eq(read.analysisRuns.status, 'succeeded'),
        asOf ? lte(read.analysisRuns.startedAt, asOf) : undefined,
      ),
    );
  for (const row of analysed) examined.add(row.repoId);

  for (const repoId of examined) {
    const row = findingRows.find((r) => r.repoId === repoId);
    out.set(repoId, {
      openFindingDensity: row?.weighted ?? 0,
      // Nothing open is the ramp's good end (severity 1), not a missing input.
      worstOpenSeverity: row?.worst === null || row?.worst === undefined ? 1 : Number(row.worst),
    });
  }
  return out;
}
