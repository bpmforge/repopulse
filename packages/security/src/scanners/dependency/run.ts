import { eq } from 'drizzle-orm';
import { security, type Database } from '@repopulse/shared';
import { persistFindings } from '@repopulse/insights';
import type { ForgeProvider } from '@repopulse/forge';
import { snapshotForScan } from '../../snapshot/index.js';
import { runDependencyTools, vulnDbDir } from './tools.js';
import { dependencyFindings, DEPENDENCY_SCANNER_KEY, type FindingFunnel } from './findings.js';
import type { MatchFunnel } from './matches.js';

// The dependency scanner, end to end (W8-06, SECURITY_SUITE.md §3.2, FR-SEC-5).
//
// syft over the C1a snapshot produces a CycloneDX SBOM, the SBOM is STORED, and
// grype matches it against the mounted database. The store is not incidental:
// security.sboms has been empty since W8-02 built it, so owasp_llm reports
// 'no_sbom' for every repository and the supply-chain registers skip every run.
// This is the producer both of them were waiting for.
//
// WHAT THIS DELIBERATELY DOES NOT CLAIM: reachability is 'manifest_only' on
// every finding. See findings.ts — an SBOM cannot support more.

export interface DependencyRunDeps {
  db: Database;
  provider: ForgeProvider;
  workspaceId: number;
  repoId: number;
  repo: string;
  commitSha: string;
  image?: string;
  /** Host directory holding the grype database. Defaults to vulnDbDir(). */
  vulnDb?: string;
  trigger?: 'schedule' | 'manual' | 'push';
  wallClockMs?: number;
}

/**
 * The funnel, reported rather than summarised.
 *
 * Every number a reader would need to tell "nothing is wrong here" from "the
 * scan lost things on the way". A scanner that returned only a finding count
 * could hide a database that matched nothing, a tool that emitted half its
 * output, or an ecosystem we silently cannot scope.
 */
export interface DependencyRunResult {
  status: 'succeeded' | 'failed';
  scanRunId: number | null;
  /** Components in the stored SBOM. */
  componentsScanned: number;
  /** Raw grype matches, before de-duplication. */
  matchesFound: number;
  /** (package, CVE) rows collapsed because two providers reported the same one. */
  duplicatesCollapsed: number;
  /** Matches kept with no resolvable CVE id — reported, never dropped. */
  withoutCveId: number;
  /** Matches whose severity grype could not score; filed at 3, not at 1. */
  unknownSeverity: number;
  /** Matches whose package the SBOM scope index does not cover (non-npm/pypi). */
  withoutScope: number;
  /** KEV matches whose severity was floored to 4. */
  kevFloored: number;
  findingsCreated: number;
  findingsTotal: number;
  sbomStored: boolean;
  error?: string;
}

const DEFAULT_IMAGE = process.env.SCAN_IMAGE ?? 'localhost/repopulse/scan:dev';
const DEFAULT_WALL_CLOCK_MS = 15 * 60 * 1000;

const emptyFunnel = {
  componentsScanned: 0,
  matchesFound: 0,
  duplicatesCollapsed: 0,
  withoutCveId: 0,
  unknownSeverity: 0,
  withoutScope: 0,
  kevFloored: 0,
  findingsCreated: 0,
  findingsTotal: 0,
  sbomStored: false,
};

export async function runDependencyScan(deps: DependencyRunDeps): Promise<DependencyRunResult> {
  const [run] = await deps.db
    .insert(security.scanRuns)
    .values({
      workspaceId: deps.workspaceId,
      repoId: deps.repoId,
      scannerKey: DEPENDENCY_SCANNER_KEY,
      scannerVersion: 'pending',
      commitSha: deps.commitSha,
      trigger: deps.trigger ?? 'schedule',
      status: 'running',
    })
    .returning();
  const runId = run!.id;

  try {
    return await snapshotForScan(
      { provider: deps.provider, repo: deps.repo, commitSha: deps.commitSha },
      async (snapshot) => {
        const tools = await runDependencyTools({
          targetDir: snapshot.dir,
          image: deps.image ?? DEFAULT_IMAGE,
          vulnDb: deps.vulnDb ?? vulnDbDir(),
          budget: { wallClockMs: deps.wallClockMs ?? DEFAULT_WALL_CLOCK_MS },
        });

        if (tools.status !== 'succeeded' || tools.document === null) {
          // RETURN BEFORE persistFindings. A failed tool run reaching the store
          // with an empty findings list would auto-resolve every dependency
          // finding this repository has — a crashed scanner marking real CVEs
          // as fixed. The scan_run row is left failed with the tool's own
          // reason, so "grype found nothing" and "grype did not run" are two
          // visibly different states.
          await closeRun(
            deps.db,
            runId,
            'failed',
            0,
            tools.error ?? 'tool run failed',
            tools.toolVersions,
          );
          return {
            status: 'failed' as const,
            scanRunId: runId,
            ...emptyFunnel,
            ...(tools.error ? { error: tools.error } : {}),
          };
        }

        // The SBOM is stored BEFORE the findings, and stored even when there
        // are none: an empty findings list against a real component list is
        // the good result, and it is only legible if the component list is
        // there to read. Upserted because sboms is unique on
        // (workspace, repo, commit) and a re-scan of the same commit is
        // ordinary — the document is regenerated, not accumulated.
        await deps.db
          .insert(security.sboms)
          .values({
            workspaceId: deps.workspaceId,
            repoId: deps.repoId,
            commitSha: snapshot.commitSha,
            format: 'cyclonedx',
            document: tools.document,
            componentCount: tools.componentCount,
            generatedBy: `syft@${tools.toolVersions['syft'] ?? 'unknown'}`,
          })
          .onConflictDoUpdate({
            target: [security.sboms.workspaceId, security.sboms.repoId, security.sboms.commitSha],
            set: {
              document: tools.document,
              componentCount: tools.componentCount,
              generatedBy: `syft@${tools.toolVersions['syft'] ?? 'unknown'}`,
            },
          });

        const mapped = dependencyFindings(tools.matches, tools.document);

        const persisted = await persistFindings(deps.db, {
          workspaceId: deps.workspaceId,
          repoId: deps.repoId,
          scanRunId: runId,
          pullRequestId: null,
          tier: 1,
          findings: mapped.findings,
          // The manifests this scan read. A CVE that a later scan of the same
          // manifests no longer reports has been upgraded away, and this is
          // the only signal persistFindings has for closing it — without it a
          // patched dependency stays open forever.
          reviewedFiles: mapped.reviewedFiles,
          sweepDimensions: ['dependency'],
          sweepScannerKey: DEPENDENCY_SCANNER_KEY,
        });

        await closeRun(
          deps.db,
          runId,
          'succeeded',
          mapped.findings.length,
          null,
          tools.toolVersions,
        );

        return {
          status: 'succeeded' as const,
          scanRunId: runId,
          sbomStored: true,
          componentsScanned: tools.componentCount,
          ...funnelNumbers(tools.matchFunnel, mapped.funnel),
          findingsCreated: persisted.created,
          findingsTotal: mapped.findings.length,
        };
      },
    );
  } catch (err) {
    await closeRun(deps.db, runId, 'failed', 0, (err as Error).message.slice(0, 500), null);
    return {
      status: 'failed',
      scanRunId: runId,
      ...emptyFunnel,
      error: (err as Error).message,
    };
  }
}

function funnelNumbers(
  match: MatchFunnel | null,
  findings: FindingFunnel,
): Pick<
  DependencyRunResult,
  | 'matchesFound'
  | 'duplicatesCollapsed'
  | 'withoutCveId'
  | 'unknownSeverity'
  | 'withoutScope'
  | 'kevFloored'
> {
  return {
    matchesFound: match?.rawMatches ?? 0,
    duplicatesCollapsed: match?.duplicatesCollapsed ?? 0,
    withoutCveId: match?.withoutCveId ?? 0,
    unknownSeverity: match?.unknownSeverity ?? 0,
    withoutScope: findings.withoutScope,
    kevFloored: findings.kevFloored,
  };
}

async function closeRun(
  db: Database,
  runId: number,
  status: 'succeeded' | 'failed',
  findingCount: number,
  error: string | null,
  toolVersions: Record<string, string> | null,
): Promise<void> {
  await db
    .update(security.scanRuns)
    .set({
      status,
      findingCount,
      error,
      finishedAt: new Date(),
      ...(toolVersions
        ? {
            toolVersions,
            scannerVersion: Object.entries(toolVersions)
              .map(([k, v]) => `${k}@${v}`)
              .join(' '),
          }
        : {}),
    })
    .where(eq(security.scanRuns.id, runId));
}
