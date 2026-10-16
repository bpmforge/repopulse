import { and, desc, eq } from 'drizzle-orm';
import { core, security, type Database, safeErrorText } from '@repopulse/shared';
import { persistFindings, type IncomingFinding } from '@repopulse/insights';
import { dependencyHealthFindings, type ReleaseFactsRow } from './dependency-health.js';
import { eolFindings, type EolCycleRow } from './eol.js';
import { EOL_ATTRIBUTION } from '../sync/eol.js';
import { licenseFindings, DEFAULT_LICENSE_POLICY, type LicensePolicy } from './license.js';
import { LICENSE_CATEGORIES, type LicenseCategory } from './spdx.js';
import { readDeclaredRuntimes } from './manifests.js';
import { resolveScopes } from './sbom.js';

// The nightly supply-chain register pass (W10-02, FR-REG-2/3/4).
//
// One scan_run, three registers, one findings write. They share a run because
// they share an input — the SBOM at a commit — and splitting them would let a
// repo show a license posture computed from a different component list than
// its dependency health, which is the kind of inconsistency nobody can debug
// six weeks later.

export const SUPPLY_CHAIN_REGISTER_KEY = 'supply_chain_register';

export interface SupplyChainRunDeps {
  db: Database;
  workspaceId: number;
  repoId: number;
  /** Extracted C1a snapshot, for the EOL half. Absent = EOL is skipped, loudly. */
  snapshotDir?: string;
  now?: Date;
  policy?: LicensePolicy;
}

export interface SupplyChainRunResult {
  status: 'succeeded' | 'failed' | 'skipped';
  scanRunId: number | null;
  findings: number;
  created: number;
  /** Components with no release_meta row. The denominator, always reported. */
  unmeasured: number;
  measured: number;
  repoLibyear: number | null;
  /** Runtime declarations we had no EOL data for — silence with a count. */
  unknownRuntimes: number;
  skippedReason?: 'no_sbom' | 'no_snapshot';
  error?: string;
}

/** Workspace license policy, defaulted rather than required. */
export function policyFrom(settings: Record<string, unknown> | null): LicensePolicy {
  const configured = settings?.['licensePolicy'];
  if (configured === null || typeof configured !== 'object') return DEFAULT_LICENSE_POLICY;
  const record = configured as Partial<LicensePolicy>;
  return {
    allow: Array.isArray(record.allow) ? record.allow : DEFAULT_LICENSE_POLICY.allow,
    flag: Array.isArray(record.flag) ? record.flag : DEFAULT_LICENSE_POLICY.flag,
    flagUnknown:
      typeof record.flagUnknown === 'boolean'
        ? record.flagUnknown
        : DEFAULT_LICENSE_POLICY.flagUnknown,
    flagCategories: Array.isArray(record.flagCategories)
      ? record.flagCategories.filter((c): c is LicenseCategory => LICENSE_CATEGORIES.includes(c))
      : DEFAULT_LICENSE_POLICY.flagCategories,
  };
}

export async function runSupplyChainRegisters(
  deps: SupplyChainRunDeps,
): Promise<SupplyChainRunResult> {
  const now = deps.now ?? new Date();
  const empty = {
    findings: 0,
    created: 0,
    unmeasured: 0,
    measured: 0,
    repoLibyear: null,
    unknownRuntimes: 0,
  };

  const [sbom] = await deps.db
    .select({ document: security.sboms.document, commitSha: security.sboms.commitSha })
    .from(security.sboms)
    .where(and(eq(security.sboms.workspaceId, deps.workspaceId), eq(security.sboms.repoId, deps.repoId)))
    .orderBy(desc(security.sboms.createdAt))
    .limit(1);

  if (!sbom) {
    // No scan_run row, and a NAMED reason: "no SBOM" is a fact about us — the
    // generator is W8-06, blocked for missing syft — and must never render as
    // "this repository has no dependency problems".
    return { status: 'skipped', scanRunId: null, skippedReason: 'no_sbom', ...empty };
  }

  const [run] = await deps.db
    .insert(security.scanRuns)
    .values({
      workspaceId: deps.workspaceId,
      repoId: deps.repoId,
      scannerKey: SUPPLY_CHAIN_REGISTER_KEY,
      scannerVersion: 'supply_chain.v1',
      commitSha: sbom.commitSha,
      trigger: 'schedule',
      status: 'running',
    })
    .returning();
  const scanRunId = run!.id;

  try {
    const components = resolveScopes(sbom.document);

    const releaseRows = (await deps.db
      .select()
      .from(security.releaseMeta)) as unknown as ReleaseFactsRow[];

    const health = dependencyHealthFindings({
      components,
      releaseMeta: releaseRows,
      now,
    });

    const [workspace] = await deps.db
      .select({ settings: core.workspaces.settings })
      .from(core.workspaces)
      .where(eq(core.workspaces.id, deps.workspaceId));
    const licenses = licenseFindings(components, deps.policy ?? policyFrom(workspace?.settings ?? null));

    const cycles = (await deps.db
      .select()
      .from(security.eolProducts)) as unknown as EolCycleRow[];
    const runtimes = deps.snapshotDir ? readDeclaredRuntimes(deps.snapshotDir) : null;
    const eol = runtimes
      ? eolFindings({ declared: runtimes.declared, cycles, now })
      : { findings: [], unknown: [] };

    const incoming: IncomingFinding[] = [
      ...health.findings.map((f) => ({
        dimension: 'dependency_health',
        severity: f.severity,
        // 5 for registry facts, 4 for the ones that read a threshold: a
        // deprecation notice is a statement upstream made; "12 months is
        // stale" is our judgement about it.
        confidence: f.signal === 'deprecated' || f.signal === 'yanked' ? 5 : 4,
        file: null,
        lineStart: null,
        lineEnd: null,
        title: f.title,
        evidenceQuote: f.evidence,
        rationale: `${f.signal} · scope ${f.scope ?? 'repo'}${f.depth ? ` · depth ${f.depth}` : ''}`,
        suggestedFix: f.recommendation,
        scannerKey: SUPPLY_CHAIN_REGISTER_KEY,
        ruleId: f.ruleId,
        // The scope travels with the finding because the nightly repricer
        // reads it back as the D12 exposure input — a dev-scoped abandoned
        // package must rank below the same package in the request path.
        yields: f.scope ? { dep_scope: { kind: f.scope, depth: f.depth ?? 1 } } : null,
      })),
      ...licenses.map((f) => ({
        dimension: 'dependency_health',
        severity: f.severity,
        confidence: f.license === null ? 4 : 5,
        file: null,
        lineStart: null,
        lineEnd: null,
        title: f.title,
        evidenceQuote: f.evidence,
        rationale: `license posture · ${f.scope}`,
        suggestedFix: f.recommendation,
        scannerKey: SUPPLY_CHAIN_REGISTER_KEY,
        ruleId: f.ruleId,
        yields: { dep_scope: { kind: f.scope, depth: 1 } },
      })),
      ...eol.findings.map((f) => ({
        dimension: 'dependency_health',
        severity: f.severity,
        confidence: 5,
        // EOL findings DO have a file — the manifest that declares the
        // runtime — and pointing at it is the difference between a report and
        // an errand.
        file: f.file,
        lineStart: null,
        lineEnd: null,
        title: f.title,
        evidenceQuote: `${f.evidence} ${EOL_ATTRIBUTION}`,
        rationale: `${f.product} ${f.cycle} · ${f.daysToEol ?? '?'} days to EOL`,
        suggestedFix: f.recommendation,
        scannerKey: SUPPLY_CHAIN_REGISTER_KEY,
        ruleId: f.ruleId,
      })),
    ];

    const persisted = await persistFindings(deps.db, {
      workspaceId: deps.workspaceId,
      repoId: deps.repoId,
      scanRunId,
      pullRequestId: null,
      tier: 1,
      findings: incoming,
      sweepDimensions: ['dependency_health'],
      sweepScannerKey: SUPPLY_CHAIN_REGISTER_KEY,
    });

    await deps.db
      .update(security.scanRuns)
      .set({ status: 'succeeded', findingCount: incoming.length, finishedAt: new Date() })
      .where(eq(security.scanRuns.id, scanRunId));

    return {
      status: 'succeeded',
      scanRunId,
      findings: incoming.length,
      created: persisted.created,
      unmeasured: health.unmeasured,
      measured: health.measured,
      repoLibyear: health.repoLibyear,
      unknownRuntimes: eol.unknown.length,
      ...(deps.snapshotDir ? {} : { skippedReason: 'no_snapshot' as const }),
    };
  } catch (error) {
    await deps.db
      .update(security.scanRuns)
      .set({
        status: 'failed',
        error: safeErrorText(error).slice(0, 500),
        finishedAt: new Date(),
      })
      .where(eq(security.scanRuns.id, scanRunId));
    return {
      status: 'failed',
      scanRunId,
      ...empty,
      error: safeErrorText(error),
    };
  }
}
