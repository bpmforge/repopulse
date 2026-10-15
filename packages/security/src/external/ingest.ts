import { and, eq, inArray, isNotNull, like, notLike, or, isNull } from 'drizzle-orm';
import { read, security, type Database } from '@repopulse/shared';
import { persistFindings, type IncomingFinding } from '@repopulse/insights';
import { packRuleSupersedingExternal } from '../scanners/code-health/adapters/registry.js';
import { EXTERNAL_KEY_PREFIX, externalScannerKey, toolSlug, type ExternalSource } from './keys.js';
import { toIncomingFinding, type ExternalResult } from './map.js';

// External findings into the ONE findings store (W18-24).
//
// Everything a SARIF upload or a code-scanning pull produces goes through
// here, so the guarantees are written once:
//
//   ONE scan_run PER TOOL, under the tool's external key, carrying the tool's
//   version — "which engine, which version" is the first question asked of a
//   security finding, and a run row is where every other scanner answers it.
//
//   THE SWEEP IS THE TOOL'S OWN. A result set from eslint can close eslint's
//   findings that it no longer reports and nothing else: the sweep is scoped by
//   scanner key, which is also what keeps OUR sweeps (each scoped to its own
//   key) from ever closing an external finding.
//
//   OUR RULE WINS WHERE THE DEDUP MAP SAYS SO. An external result that the
//   map (or identity: a `bpm-*` id) says one of our pack rules already covers,
//   at the same place, is dropped and counted — not stored twice.
//
// Pricing is not done here: the nightly reprice (metrics.snapshot) prices every
// open finding by dimension, severity, confidence, rule FP rate and file
// exposure, and an external finding is a finding like any other to it. A
// second pricing path for external findings would be a second model.

/** Every dimension the external mapper can emit — the sweep's scope. */
export const EXTERNAL_DIMENSIONS = [
  'sast',
  'code_health',
  'performance',
  'secrets',
  'iac',
  'dependency',
] as const;

/** How close (in lines) two findings must be to be the same defect. */
const SAME_PLACE_LINES = 3;

export interface ExternalIngestParams {
  db: Database;
  workspaceId: number;
  repoId: number;
  source: ExternalSource;
  results: readonly ExternalResult[];
  /** '' when unknown — the forge link then falls back to the default branch. */
  commitSha: string;
  trigger: 'manual' | 'schedule';
  /**
   * Treat this batch as the COMPLETE current result set of each tool in it,
   * closing that tool's findings it no longer reports. False for a partial
   * upload (one language of a multi-language CodeQL run) or a pull a budget
   * cut short — a sweep over half a result set closes the other half.
   */
  sweep: boolean;
  /**
   * Tools to sweep even though they have NO result in this batch — the pull
   * passes every code-scanning tool it has open findings from, because a tool
   * whose alerts were all fixed simply vanishes from the alert list.
   */
  sweepAbsentTools?: readonly string[];
}

export interface ToolIngestSummary {
  scannerKey: string;
  tool: string;
  toolVersion: string | null;
  scanRunId: number;
  results: number;
  created: number;
  updated: number;
  reopened: number;
  folded: number;
  autoResolved: number;
  /** External results dropped because our pack rule already reports them there. */
  supersededByPack: {
    ruleId: string;
    packRule: string;
    file: string | null;
    line: number | null;
  }[];
}

interface PackHit {
  ruleId: string;
  file: string | null;
  lineStart: number | null;
}

/** Our own open findings for the pack rules this batch could yield to. */
async function packFindingsFor(
  db: Database,
  workspaceId: number,
  repoId: number,
  packRules: readonly string[],
): Promise<PackHit[]> {
  if (packRules.length === 0) return [];
  const rows = await db
    .select({
      ruleId: read.findings.ruleId,
      file: read.findings.file,
      lineStart: read.findings.lineStart,
    })
    .from(read.findings)
    .where(
      and(
        eq(read.findings.workspaceId, workspaceId),
        eq(read.findings.repoId, repoId),
        inArray(read.findings.ruleId, [...packRules]),
        inArray(read.findings.status, ['open', 'confirmed']),
        // Ours only: an external finding cannot supersede another one.
        or(
          isNull(read.findings.scannerKey),
          notLike(read.findings.scannerKey, `${EXTERNAL_KEY_PREFIX}%`),
        ),
      ),
    );
  return rows.filter((r): r is PackHit => r.ruleId !== null);
}

function samePlace(a: { file: string | null; lineStart: number | null }, b: PackHit): boolean {
  if (a.file !== b.file) return false;
  if (a.lineStart === null || b.lineStart === null) return a.lineStart === b.lineStart;
  return Math.abs(a.lineStart - b.lineStart) <= SAME_PLACE_LINES;
}

/**
 * Splits a batch into what is stored and what our pack already reports.
 *
 * Matched on rule identity (via the map) AND place. Identity alone would drop
 * every eslint `no-empty` in the repository because our empty-catch rule fired
 * once somewhere; place alone would merge two different defects that share a
 * line. Both together is "the same defect, reported twice".
 */
export function dedupeExternalAgainstPack(
  results: readonly ExternalResult[],
  packHits: readonly PackHit[],
): { kept: ExternalResult[]; superseded: ToolIngestSummary['supersededByPack'] } {
  const kept: ExternalResult[] = [];
  const superseded: ToolIngestSummary['supersededByPack'] = [];
  for (const r of results) {
    const packRule = packRuleSupersedingExternal(toolSlug(r.tool), r.ruleId);
    if (packRule && packHits.some((hit) => hit.ruleId === packRule && samePlace(r, hit))) {
      superseded.push({ ruleId: r.ruleId, packRule, file: r.file, line: r.lineStart });
      continue;
    }
    kept.push(r);
  }
  return { kept, superseded };
}

/** Files this tool's open findings sit on — the sweep has to look at them. */
async function openFilesFor(
  db: Database,
  workspaceId: number,
  repoId: number,
  scannerKey: string,
): Promise<string[]> {
  const rows = await db
    .select({ file: read.findings.file })
    .from(read.findings)
    .where(
      and(
        eq(read.findings.workspaceId, workspaceId),
        eq(read.findings.repoId, repoId),
        eq(read.findings.scannerKey, scannerKey),
        inArray(read.findings.status, ['open', 'confirmed']),
        isNotNull(read.findings.file),
      ),
    );
  return [...new Set(rows.map((r) => r.file).filter((f): f is string => f !== null))];
}

/** Tool slugs with open findings under one source, for the absent-tool sweep. */
export async function toolsWithOpenFindings(
  db: Database,
  workspaceId: number,
  repoId: number,
  source: ExternalSource,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ key: read.findings.scannerKey })
    .from(read.findings)
    .where(
      and(
        eq(read.findings.workspaceId, workspaceId),
        eq(read.findings.repoId, repoId),
        like(read.findings.scannerKey, `${EXTERNAL_KEY_PREFIX}%`),
        inArray(read.findings.status, ['open', 'confirmed']),
      ),
    );
  const tools: string[] = [];
  for (const { key } of rows) {
    if (!key) continue;
    const rest = key.slice(EXTERNAL_KEY_PREFIX.length);
    const isPull = rest.endsWith(':code-scanning');
    if ((source === 'code_scanning') !== isPull) continue;
    tools.push(isPull ? rest.slice(0, -':code-scanning'.length) : rest);
  }
  return tools;
}

/** Persists one batch of external results, one scan_run per tool. */
export async function ingestExternalResults(
  params: ExternalIngestParams,
): Promise<ToolIngestSummary[]> {
  const { db, workspaceId, repoId } = params;
  const byTool = new Map<
    string,
    { name: string; version: string | null; results: ExternalResult[] }
  >();
  for (const r of params.results) {
    const slug = toolSlug(r.tool);
    const group = byTool.get(slug) ?? { name: r.tool, version: r.toolVersion, results: [] };
    group.results.push(r);
    byTool.set(slug, group);
  }
  if (params.sweep) {
    for (const slug of params.sweepAbsentTools ?? []) {
      if (!byTool.has(slug)) byTool.set(slug, { name: slug, version: null, results: [] });
    }
  }

  const packRules = [
    ...new Set(
      params.results
        .map((r) => packRuleSupersedingExternal(toolSlug(r.tool), r.ruleId))
        .filter((p): p is string => p !== null),
    ),
  ];
  const packHits = await packFindingsFor(db, workspaceId, repoId, packRules);

  const summaries: ToolIngestSummary[] = [];
  for (const [slug, group] of [...byTool.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const scannerKey = externalScannerKey(slug, params.source);
    const [run] = await db
      .insert(security.scanRuns)
      .values({
        workspaceId,
        repoId,
        scannerKey,
        scannerVersion: `${slug}@${group.version ?? 'unknown'}`,
        commitSha: params.commitSha,
        trigger: params.trigger,
        status: 'running',
        toolVersions: {
          [slug]: group.version ?? 'unknown',
          intake: params.source === 'sarif' ? 'sarif-2.1.0' : 'github-code-scanning',
        },
      })
      .returning({ id: security.scanRuns.id });
    const runId = run!.id;

    try {
      const { kept, superseded } = dedupeExternalAgainstPack(group.results, packHits);
      const findings: IncomingFinding[] = kept.map((r) => toIncomingFinding(r, params.source));
      const reviewedFiles = params.sweep
        ? [
            ...new Set([
              ...findings.map((f) => f.file).filter((f): f is string => f !== null),
              ...(await openFilesFor(db, workspaceId, repoId, scannerKey)),
            ]),
          ]
        : undefined;

      const persisted = await persistFindings(db, {
        workspaceId,
        repoId,
        scanRunId: runId,
        pullRequestId: null,
        tier: 1,
        findings,
        ...(reviewedFiles ? { reviewedFiles } : {}),
        sweepDimensions: EXTERNAL_DIMENSIONS,
        sweepScannerKey: scannerKey,
      });

      await db
        .update(security.scanRuns)
        .set({ status: 'succeeded', findingCount: findings.length, finishedAt: new Date() })
        .where(eq(security.scanRuns.id, runId));

      summaries.push({
        scannerKey,
        tool: group.name,
        toolVersion: group.version,
        scanRunId: runId,
        results: group.results.length,
        created: persisted.created,
        updated: persisted.updated,
        reopened: persisted.reopened,
        folded: persisted.foldedDuplicates,
        autoResolved: persisted.autoResolved,
        supersededByPack: superseded,
      });
    } catch (err) {
      // The run row says what broke; the caller decides whether the whole
      // request fails. Never left 'running' — that reads as "in progress" for
      // an hour and then as abandoned, neither of which is what happened.
      await db
        .update(security.scanRuns)
        .set({
          status: 'failed',
          error: err instanceof Error ? err.message : String(err),
          finishedAt: new Date(),
        })
        .where(eq(security.scanRuns.id, runId));
      throw err;
    }
  }
  return summaries;
}
