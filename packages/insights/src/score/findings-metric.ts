import { and, eq, inArray, sql } from 'drizzle-orm';
import { read, type Database } from '@repopulse/shared';

// The FINDINGS metric row (W10-05, FR-REG-7).
//
// EVERY finding-sourced plan-catalog entry reads `metrics.FINDINGS.dims.*` —
// the W5 clusters, W8's KEV entry, W9's slop and logging entries, and all four
// W10 registers. Nothing wrote that row until now, so all of them were inert
// in production while their own unit tests passed against hand-built metric
// sets. This is the producer.
//
// It runs in the snapshot job AFTER the reprice, because half of what it
// summarises is effective_risk — a version that ran first would publish
// yesterday's risk under today's timestamp.

export const FINDINGS_METRIC_KEY = 'FINDINGS';

/** Dimensions that roll into each catalog cluster (kept beside the reader). */
const SLOP_DIMENSIONS = ['slop'];
const LOGGING_DIMENSIONS = ['logging'];

export interface FindingsMetricDims {
  openCount: number;
  riskSum: number;
  actBandCount: number;
  actBandRiskSum: number;
  actBandClusterCount: number;
  actBandFindingIds: number[];
  clusterRiskSum: number;
  clusterFindingIds: number[];
  sevClusterCount: number;
  kevOrChainOpen: number;
  kevFindingIds: number[];
  slopDensity: number | null;
  slopRiskSum: number;
  slopFindingIds: number[];
  loggingFindingCount: number;
  loggingRiskSum: number;
  loggingFindingIds: number[];
  knowledgeFindingCount: number;
  knowledgeFindingIds: number[];
  dependencyHealthFindingCount: number;
  dependencyHealthFindingIds: number[];
  /** Risk-weighted supply-chain load — the Supply Chain axis input. */
  dependencyHealthRiskSum: number;
  /** Runtimes past end-of-life. A count: one is already too many. */
  eolRuntimeCount: number;
  architectureFindingCount: number;
  architectureFindingIds: number[];
  testGapFindingCount: number;
  testGapFindingIds: number[];
}

interface FindingRow {
  id: number;
  dimension: string;
  ruleId: string | null;
  severity: number;
  file: string | null;
  riskBand: string | null;
  effectiveRisk: string | null;
  yields: Record<string, unknown> | null;
}

const risk = (row: FindingRow): number =>
  row.effectiveRisk === null ? 0 : Number(row.effectiveRisk);

const idsOf = (rows: FindingRow[]): number[] => rows.map((r) => r.id).slice(0, 50);
const sumOf = (rows: FindingRow[]): number =>
  Math.round(rows.reduce((total, row) => total + risk(row), 0) * 100) / 100;

/**
 * Summarises open findings for one repo.
 *
 * `slopDensity` is NULL rather than 0 when no anti-slop scan has run: a repo
 * nobody measured is not a repo with no slop, and a zero here would silence
 * the catalog entry that exists to notice it.
 */
export function summariseFindings(
  rows: readonly FindingRow[],
  slopDensity: number | null,
): FindingsMetricDims {
  const all = [...rows];
  const byDimension = (dimensions: readonly string[]): FindingRow[] =>
    all.filter((row) => dimensions.includes(row.dimension));

  const actBand = all.filter((row) => row.riskBand === 'act');
  // A CLUSTER is several findings in one file — the shape a catalog entry can
  // recommend a single piece of work for.
  const clusterOf = (rows2: FindingRow[]): Map<string, FindingRow[]> => {
    const byFile = new Map<string, FindingRow[]>();
    for (const row of rows2) {
      if (!row.file) continue;
      byFile.set(row.file, [...(byFile.get(row.file) ?? []), row]);
    }
    return new Map([...byFile].filter(([, group]) => group.length >= 3));
  };

  const severeClusters = clusterOf(all.filter((row) => row.severity >= 3));
  const actClusters = clusterOf(actBand);
  const kevOrChain = all.filter(
    (row) =>
      row.dimension === 'chain' ||
      (row.yields !== null && (row.yields as Record<string, unknown>)['kev'] === true),
  );

  const slop = byDimension(SLOP_DIMENSIONS);
  const logging = byDimension(LOGGING_DIMENSIONS);
  const knowledge = byDimension(['knowledge']);
  const dependencyHealth = byDimension(['dependency_health']);
  const architecture = byDimension(['architecture']);
  const testGap = byDimension(['test_gap']);

  return {
    openCount: all.length,
    riskSum: sumOf(all),
    actBandCount: actBand.length,
    actBandRiskSum: sumOf(actBand),
    actBandClusterCount: actClusters.size,
    actBandFindingIds: idsOf([...actClusters.values()].flat()),
    clusterRiskSum: sumOf([...severeClusters.values()].flat()),
    clusterFindingIds: idsOf([...severeClusters.values()].flat()),
    sevClusterCount: severeClusters.size,
    kevOrChainOpen: kevOrChain.length,
    kevFindingIds: idsOf(kevOrChain),
    slopDensity,
    slopRiskSum: sumOf(slop),
    slopFindingIds: idsOf(slop),
    loggingFindingCount: logging.length,
    loggingRiskSum: sumOf(logging),
    loggingFindingIds: idsOf(logging),
    knowledgeFindingCount: knowledge.length,
    knowledgeFindingIds: idsOf(knowledge),
    dependencyHealthFindingCount: dependencyHealth.length,
    dependencyHealthFindingIds: idsOf(dependencyHealth),
    dependencyHealthRiskSum: sumOf(dependencyHealth),
    eolRuntimeCount: all.filter((row) => row.ruleId === 'eol.past').length,
    architectureFindingCount: architecture.length,
    architectureFindingIds: idsOf(architecture),
    testGapFindingCount: testGap.length,
    testGapFindingIds: idsOf(testGap),
  };
}

export interface FindingsMetricResult {
  dims: FindingsMetricDims;
  /** The metric's own value: open findings weighted by risk (the axis input). */
  value: number;
}

/** Reads, summarises and WRITES the FINDINGS row for one repo. */
export async function writeFindingsMetric(
  db: Database,
  workspaceId: number,
  repoId: number,
  window = '30d',
): Promise<FindingsMetricResult> {
  const rows = (await db
    .select({
      id: read.findings.id,
      dimension: read.findings.dimension,
      ruleId: read.findings.ruleId,
      severity: read.findings.severity,
      file: read.findings.file,
      riskBand: read.findings.riskBand,
      effectiveRisk: read.findings.effectiveRisk,
      yields: read.findings.yields,
    })
    .from(read.findings)
    .where(
      and(
        eq(read.findings.workspaceId, workspaceId),
        eq(read.findings.repoId, repoId),
        inArray(read.findings.status, ['open', 'confirmed']),
        // Shadow-mode rules never carry weight (W9-07).
        eq(read.findings.experimental, false),
      ),
    )) as unknown as FindingRow[];

  const [slopRow] = await db
    .select({ value: read.metricSnapshots.value })
    .from(read.metricSnapshots)
    .where(
      and(
        eq(read.metricSnapshots.workspaceId, workspaceId),
        eq(read.metricSnapshots.repoId, repoId),
        eq(read.metricSnapshots.metricKey, 'ch_slop_density'),
      ),
    )
    .orderBy(sql`${read.metricSnapshots.computedAt} desc`)
    .limit(1);

  const dims = summariseFindings(rows, slopRow?.value === undefined ? null : Number(slopRow.value));

  await db.insert(read.metricSnapshots).values({
    workspaceId,
    repoId,
    metricKey: FINDINGS_METRIC_KEY,
    window,
    dims: dims as unknown as Record<string, unknown>,
    value: String(dims.riskSum),
    numerator: String(dims.openCount),
    denominator: null,
  });

  return { dims, value: dims.riskSum };
}
