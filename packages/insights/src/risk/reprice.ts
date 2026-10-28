import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import { read, type Database } from '@repopulse/shared';
import { priceFinding, type PricingInput, type FindingDimension } from './price.js';
import { RISK_MODEL_V4, type RiskModelConstants } from './model.js';
import {
  importExposureFor,
  indexImportGraph,
  readImportGraph,
  type ImportGraphIndex,
} from './import-graph.js';

// Nightly reprice (W9-09, RISK_MODEL.md §3, FR-RISK-4).
//
// A finding's score moves without the finding changing: EPSS updates, the file
// it sits in cools off, the rule that found it accumulates false positives.
// This runs after metrics.snapshot so the hotspot numbers it reads are today's.
//
// BAND CROSSINGS ARE AUDITED, score changes are not. "This climbed into Act
// overnight" is a question someone will ask; "this went from 41.2 to 41.7" is
// noise, and writing an event for it would bury the transitions that matter.

export interface RepriceDeps {
  db: Database;
  workspaceId: number;
  repoId?: number;
  constants?: RiskModelConstants;
  /** Rule fp_rates by rule id, from the W9-07 lifecycle stats. */
  ruleFpRates?: Map<string, number | null>;
  /** Hotspot percentile by file path, from the latest M2 snapshot. */
  hotspots?: Map<string, number>;
  /**
   * The import graph to price exposure with (W18-25). Absent = read each
   * repo's latest from the store, which is what the nightly job wants: the
   * graph comes from the weekly snapshot pass, not from anything the caller
   * holds. null = price without a graph (neutral).
   */
  importGraph?: ImportGraphIndex | null;
}

export interface RepriceResult {
  priced: number;
  /** Findings whose BAND changed — one finding_events row each. */
  bandChanges: { findingId: number; from: string | null; to: string }[];
}

/** Prices every open finding in scope, and audits band crossings only. */
export async function repriceFindings(deps: RepriceDeps): Promise<RepriceResult> {
  const constants = deps.constants ?? RISK_MODEL_V4;
  const scope = [
    eq(read.findings.workspaceId, deps.workspaceId),
    inArray(read.findings.status, ['open', 'confirmed']),
    ...(deps.repoId !== undefined ? [eq(read.findings.repoId, deps.repoId)] : []),
  ];

  const rows = await db_select(deps.db, scope);
  const bandChanges: RepriceResult['bandChanges'] = [];
  let priced = 0;
  // One read per repo, not per finding: a workspace-wide reprice walks every
  // repo's findings, and each repo has its own graph.
  const graphs = new Map<number, ImportGraphIndex | null>();
  const graphFor = async (repoId: number): Promise<ImportGraphIndex | null> => {
    if (deps.importGraph !== undefined) return deps.importGraph;
    if (!graphs.has(repoId)) {
      const snapshot = await readImportGraph(deps.db, deps.workspaceId, repoId);
      graphs.set(repoId, snapshot ? indexImportGraph(snapshot) : null);
    }
    return graphs.get(repoId) ?? null;
  };

  for (const row of rows) {
    const yields = (row.yields ?? {}) as Record<string, unknown>;
    const input: PricingInput = {
      dimension: row.dimension as FindingDimension,
      severity: row.severity,
      confidence: row.confidence,
      verifyStatus: (row.verifyStatus as PricingInput['verifyStatus']) ?? 'unverified',
      ruleFpRate: row.ruleId ? (deps.ruleFpRates?.get(row.ruleId) ?? null) : null,
      kev: yields['kev'] === true,
      // 2026-10-28: the dependency scan stores reachability, EPSS and the
      // malicious flag on the finding; the reprice dropped all three, so a CVE
      // priced "imported" at insert fell back to manifest_only overnight.
      reachability: readReachability(yields),
      epss: typeof yields['epss'] === 'number' ? yields['epss'] : null,
      maliciousPackage: yields['malicious_package'] === true,
      compoundDimensions: Array.isArray(yields['dimensions'])
        ? (yields['dimensions'] as unknown[]).filter((d): d is string => typeof d === 'string')
        : null,
      // The dependency registers record which scope a component sits in, and
      // the D12 exposure factors ramp on exactly that (W10-02). Absent means
      // absent: exposureFor defaults to prod-direct rather than guessing dev,
      // which would silently discount a shipped dependency.
      depScope: readDepScope(yields),
      // A repo-level finding has no file; a file-bound one with no hotspot
      // snapshot yet is priced at the top of the file range rather than the
      // bottom, because "we have not measured this file" must not quietly
      // discount a real finding.
      repoScoped: row.file === null,
      hotspotPercentile: row.file ? (deps.hotspots?.get(row.file) ?? null) : null,
      importGraph: row.file ? importExposureFor(await graphFor(row.repoId), row.file) : null,
    };

    const { effectiveRisk, band, riskFactors } = priceFinding(input, constants);
    priced += 1;

    if (row.riskBand !== band) {
      bandChanges.push({ findingId: row.id, from: row.riskBand, to: band });
    }

    await deps.db
      .update(read.findings)
      .set({
        effectiveRisk: String(effectiveRisk),
        riskBand: band,
        riskFactors: riskFactors as unknown as Record<string, unknown>,
      })
      .where(eq(read.findings.id, row.id));
  }

  for (const change of bandChanges) {
    await deps.db.insert(read.findingEvents).values({
      workspaceId: deps.workspaceId,
      findingId: change.findingId,
      // The STATUS did not change — only the band. Recorded as a same-status
      // event so the timeline reads "still open, moved to act" rather than
      // implying someone reopened it.
      fromStatus: 'open',
      toStatus: 'open',
      actor: null,
      reason: `reprice: risk band ${change.from ?? 'unpriced'} → ${change.to}`,
    });
  }

  return { priced, bandChanges };
}

/** `{kind, depth}` out of a finding's yields, defensively. */
const REACHABILITY = [
  'symbol_reachable',
  'imported',
  'manifest_only',
  'proven_unreachable',
] as const;
function readReachability(yields: Record<string, unknown>): (typeof REACHABILITY)[number] | null {
  const raw = yields['reachability'];
  return REACHABILITY.find((r) => r === raw) ?? null;
}

function readDepScope(
  yields: Record<string, unknown>,
): { kind: 'prod-direct' | 'prod-transitive' | 'dev'; depth?: number } | null {
  const raw = yields['dep_scope'];
  if (raw === null || typeof raw !== 'object') return null;
  const record = raw as { kind?: unknown; depth?: unknown };
  if (record.kind !== 'prod-direct' && record.kind !== 'prod-transitive' && record.kind !== 'dev') {
    return null;
  }
  return {
    kind: record.kind,
    ...(typeof record.depth === 'number' ? { depth: record.depth } : {}),
  };
}

async function db_select(db: Database, scope: ReturnType<typeof eq>[]) {
  return db
    .select({
      id: read.findings.id,
      repoId: read.findings.repoId,
      dimension: read.findings.dimension,
      severity: read.findings.severity,
      confidence: read.findings.confidence,
      verifyStatus: read.findings.verifyStatus,
      ruleId: read.findings.ruleId,
      file: read.findings.file,
      yields: read.findings.yields,
      riskBand: read.findings.riskBand,
    })
    .from(read.findings)
    .where(and(...scope));
}

/** Hotspot percentiles by file, from the latest M2 snapshot for a repo. */
export async function hotspotPercentiles(
  db: Database,
  workspaceId: number,
  repoId: number,
): Promise<Map<string, number>> {
  const [row] = await db
    .select({ dims: read.metricSnapshots.dims })
    .from(read.metricSnapshots)
    .where(
      and(
        eq(read.metricSnapshots.workspaceId, workspaceId),
        eq(read.metricSnapshots.repoId, repoId),
        eq(read.metricSnapshots.metricKey, 'M2'),
        isNotNull(read.metricSnapshots.dims),
      ),
    )
    .orderBy(sql`${read.metricSnapshots.computedAt} desc`)
    .limit(1);

  const files = (row?.dims as { files?: { path?: string; score?: number }[] } | undefined)?.files;
  if (!Array.isArray(files) || files.length === 0) return new Map();

  // Percentile WITHIN the repo, which is what §2 asks for: a file's hotspot
  // score means nothing across repositories of different sizes.
  const scored = files
    .filter(
      (f): f is { path: string; score: number } =>
        typeof f.path === 'string' && typeof f.score === 'number',
    )
    .sort((a, b) => a.score - b.score);
  const out = new Map<string, number>();
  scored.forEach((file, index) => {
    out.set(file.path, scored.length === 1 ? 1 : index / (scored.length - 1));
  });
  return out;
}
