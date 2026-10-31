import { eq } from 'drizzle-orm';
import { security, type Database, safeErrorText } from '@repopulse/shared';
import { persistFindings, type IncomingFinding } from '@repopulse/insights';
import type { ForgeProvider } from '@repopulse/forge';
import { snapshotForScan } from '../../snapshot/fetch.js';
import {
  commitTreeSha,
  recordGatedRun,
  stampInputs,
  toolLabel,
  toolsMatch,
  UP_TO_DATE_NOTE,
  type BaseRun,
} from '../../framework/input-hash.js';
import { runArchitectureTools, ARCHITECTURE_SCANNER_KEY } from './tools.js';
import type { ArchitectureFinding } from './graph.js';

// The architecture-drift register pass (W10-03, FR-REG-5).

const DEFAULT_IMAGE = process.env.SCAN_IMAGE ?? 'localhost/repopulse/scan:dev';
const DEFAULT_WALL_CLOCK_MS = 10 * 60_000;

export interface ArchitectureRunDeps {
  db: Database;
  provider: ForgeProvider;
  workspaceId: number;
  repoId: number;
  repo: string;
  commitSha: string;
  image?: string;
  wallClockMs?: number;
  trigger?: 'schedule' | 'manual';
  /**
   * W23-04. The newest real run for this repo (`latestBaseRun`). When given, the
   * run first asks `architectureScanDecision` and records a `skipped` row when
   * the commit's tree is the one that run read. Omit to force a full scan.
   */
  baseRun?: BaseRun | null | undefined;
}

// ---- W23-04: the tree gate ------------------------------------------------------
//
// The register is a pure function of the source tree and of the adapters'
// versions, and a commit's TREE sha is the forge's own hash of the former: an
// empty commit, a merge that lands no change, a revert-of-a-revert all move the
// head and leave the tree. Needs the forge to report the tree sha
// (`commitTreeSha`); a forge that does not answers null and the scan runs.

export type ArchitectureScanDecision = 'up_to_date' | 'full';

export interface ArchitectureGateArgs {
  provider: ForgeProvider;
  repo: string;
  sha: string;
  baseRun: BaseRun | null;
  /** Resolved tree sha when the caller already has it (saves a forge call). */
  treeSha?: string | null;
  toolVersions?: Record<string, string> | null;
}

export async function architectureScanDecision(
  args: ArchitectureGateArgs,
): Promise<ArchitectureScanDecision> {
  const base = args.baseRun;
  if (!base || base.inputHash === null) return 'full';
  if (!toolsMatch(base, args.toolVersions)) return 'full';
  try {
    const tree =
      args.treeSha !== undefined
        ? args.treeSha
        : await commitTreeSha(args.provider, args.repo, args.sha);
    return tree !== null && tree === base.inputHash ? 'up_to_date' : 'full';
  } catch {
    return 'full';
  }
}

export interface ArchitectureRunResult {
  status: 'succeeded' | 'failed' | 'skipped';
  scanRunId: number;
  findingsCreated: number;
  findingsTotal: number;
  moduleCount: number;
  /** Adapters that did not apply — a Go repo is not a broken scan. */
  notApplicable: string[];
  /** Detections that could not run, e.g. too few modules for a distribution. */
  notRun: { ruleId: string; reason: string }[];
  /** W23-04: which way the tree gate went. Absent = no baseline was offered. */
  gate?: ArchitectureScanDecision;
  error?: string;
}

export function toIncoming(findings: readonly ArchitectureFinding[]): IncomingFinding[] {
  return findings.map((finding) => ({
    dimension: 'architecture',
    severity: finding.severity,
    // 5: a cycle is a fact about the graph, not an opinion about it. What is
    // arguable is the threshold, and the evidence states what it crossed.
    confidence: 5,
    file: finding.file,
    lineStart: null,
    lineEnd: null,
    title: finding.title,
    evidenceQuote: finding.evidence,
    rationale: finding.recommendation,
    suggestedFix: null,
    scannerKey: ARCHITECTURE_SCANNER_KEY,
    ruleId: finding.ruleId,
    yields: null,
  }));
}

export async function runArchitectureScan(
  deps: ArchitectureRunDeps,
): Promise<ArchitectureRunResult> {
  // The tree sha is read once: it decides the gate AND is what this run stamps.
  const treeSha = await commitTreeSha(deps.provider, deps.repo, deps.commitSha).catch(() => null);
  if (deps.baseRun !== undefined) {
    const decision = await architectureScanDecision({
      provider: deps.provider,
      repo: deps.repo,
      sha: deps.commitSha,
      baseRun: deps.baseRun,
      treeSha,
    });
    if (decision === 'up_to_date') {
      const base = deps.baseRun!;
      const scanRunId = await recordGatedRun(deps.db, {
        workspaceId: deps.workspaceId,
        repoId: deps.repoId,
        scannerKey: ARCHITECTURE_SCANNER_KEY,
        commitSha: deps.commitSha,
        trigger: deps.trigger ?? 'schedule',
        base,
        scope: 'skipped',
        dataVersion: null,
        findingCount: base.findingCount,
        note: UP_TO_DATE_NOTE,
      });
      return {
        status: 'succeeded',
        scanRunId,
        findingsCreated: 0,
        findingsTotal: base.findingCount,
        moduleCount: 0,
        notApplicable: [],
        notRun: [],
        gate: 'up_to_date',
      };
    }
  }

  const [run] = await deps.db
    .insert(security.scanRuns)
    .values({
      workspaceId: deps.workspaceId,
      repoId: deps.repoId,
      scannerKey: ARCHITECTURE_SCANNER_KEY,
      scannerVersion: 'pending',
      commitSha: deps.commitSha,
      trigger: deps.trigger ?? 'schedule',
      status: 'running',
    })
    .returning();
  const runId = run!.id;

  const withTree = (versions: Record<string, string>): Record<string, string> | null =>
    stampInputs(versions, treeSha, []);

  try {
    return await snapshotForScan(
      { provider: deps.provider, repo: deps.repo, commitSha: deps.commitSha },
      async (snapshot) => {
        const tools = await runArchitectureTools({
          targetDir: snapshot.dir,
          image: deps.image ?? DEFAULT_IMAGE,
          budget: { wallClockMs: deps.wallClockMs ?? DEFAULT_WALL_CLOCK_MS },
        });

        if (tools.status !== 'succeeded') {
          await closeRun(
            deps.db,
            runId,
            tools.status === 'skipped' ? 'succeeded' : 'failed',
            0,
            tools.error ?? null,
            tools.status === 'skipped' ? withTree(tools.toolVersions) : tools.toolVersions,
          );
          return {
            status: tools.status,
            scanRunId: runId,
            findingsCreated: 0,
            findingsTotal: 0,
            moduleCount: tools.moduleCount,
            notApplicable: tools.notApplicable,
            notRun: tools.notRun,
            ...(tools.error ? { error: tools.error } : {}),
          };
        }

        const findings = toIncoming(tools.findings);
        const persisted = await persistFindings(deps.db, {
          workspaceId: deps.workspaceId,
          repoId: deps.repoId,
          scanRunId: runId,
          pullRequestId: null,
          tier: 1,
          findings,
          // The pass has seen the whole graph, so it may close what it no
          // longer reports — its own dimension and scanner only, so it never
          // resolves a code-health finding that happens to share a file.
          reviewedFiles: [...new Set(findings.map((f) => f.file).filter((f): f is string => !!f))],
          sweepDimensions: ['architecture'],
          sweepScannerKey: ARCHITECTURE_SCANNER_KEY,
        });

        await closeRun(deps.db, runId, 'succeeded', findings.length, null, withTree(tools.toolVersions));

        return {
          status: 'succeeded' as const,
          scanRunId: runId,
          findingsCreated: persisted.created,
          findingsTotal: findings.length,
          moduleCount: tools.moduleCount,
          notApplicable: tools.notApplicable,
          notRun: tools.notRun,
        };
      },
    );
  } catch (error) {
    const message = safeErrorText(error);
    await closeRun(deps.db, runId, 'failed', 0, message.slice(0, 500), null);
    return {
      status: 'failed',
      scanRunId: runId,
      findingsCreated: 0,
      findingsTotal: 0,
      moduleCount: 0,
      notApplicable: [],
      notRun: [],
      error: message,
    };
  }
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
      // The VERSIONS that produced these findings, stamped on the run: a
      // finding whose tool version is unknown cannot be compared with the same
      // finding next month (acceptance item 1).
      ...(toolVersions && toolLabel(toolVersions) !== ''
        ? { toolVersions, scannerVersion: toolLabel(toolVersions) }
        : {
            scannerVersion: 'no_adapter_applied',
            ...(toolVersions && Object.keys(toolVersions).length > 0 ? { toolVersions } : {}),
          }),
    })
    .where(eq(security.scanRuns.id, runId));
}
