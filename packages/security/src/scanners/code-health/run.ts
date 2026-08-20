import { eq } from 'drizzle-orm';
import { read, security, type Database } from '@repopulse/shared';
import { persistFindings, type IncomingFinding } from '@repopulse/insights';
import type { ForgeProvider } from '@repopulse/forge';
import { snapshotForScan } from '../../snapshot/index.js';
import { runCodeHealthTools, CODE_HEALTH_SCANNER_KEY, type CodeHealthFinding } from './tools.js';
import { dedupeAgainstPack } from './adapters/registry.js';
import type { AdapterFinding } from './adapters/types.js';
import type { CodeHealthThresholds } from './thresholds.js';

// code_health_tools run modes (W9-02, FR-CH-2, FR-SEC-9).
//
// Weekly over a snapshot, or on demand. Not on pull requests: complexity and
// duplication are properties of a codebase, not of a change, and a per-PR run
// would report the same 400 findings on every branch until people filtered the
// scanner out of their view entirely.

export interface CodeHealthRunDeps {
  db: Database;
  provider: ForgeProvider;
  workspaceId: number;
  repoId: number;
  repo: string;
  commitSha: string;
  image?: string;
  thresholds?: Partial<CodeHealthThresholds>;
  trigger?: 'schedule' | 'manual';
  wallClockMs?: number;
}

export interface CodeHealthRunResult {
  status: 'succeeded' | 'failed';
  scanRunId: number | null;
  findingsCreated: number;
  findingsTotal: number;
  metricsWritten: number;
  /** Tool-adapter findings kept after dedup, and those a pack rule already had. */
  adapterFindings?: number;
  adapterDropped?: number;
  /** Adapters that applied but could not be read — surfaced, never swallowed. */
  adapterErrors?: { adapter: string; reason: string }[];
  error?: string;
}

const DEFAULT_IMAGE = process.env.SCAN_IMAGE ?? 'localhost/repopulse/scan:dev';
const DEFAULT_WALL_CLOCK_MS = 15 * 60 * 1000;

function toIncoming(findings: readonly CodeHealthFinding[]): IncomingFinding[] {
  return findings.map((f) => ({
    dimension: 'code_health',
    severity: f.severity,
    // 5: these are MEASUREMENTS. A cyclomatic complexity of 23 is not an
    // opinion, and the confidence should say so — what is arguable is the
    // threshold, which the finding states alongside the number.
    confidence: 5,
    file: f.file,
    lineStart: f.lineStart,
    lineEnd: f.lineEnd,
    title: f.title,
    evidenceQuote: `${f.file}:${f.lineStart} — measured ${f.measured}, threshold ${f.threshold}`,
    rationale: f.message,
    suggestedFix: null,
    scannerKey: CODE_HEALTH_SCANNER_KEY,
    ruleId: f.ruleId,
    // No yields: complexity hands an attacker nothing. A rule that claimed
    // otherwise would put noise into the chainer, and a chain built on
    // "this function is long" is the kind nobody believes twice.
    yields: null,
  }));
}

/**
 * Tool-adapter findings, as stored findings (W9-08 wiring).
 *
 * CONFIDENCE 4, not the 5 our own measurements carry: a lint rule is a
 * heuristic about a pattern, where a cyclomatic complexity of 23 is a count.
 * The rule id keeps the tool's namespace (`tool.ruff.E722`) so a reader can
 * tell whose opinion they are reading, and so the FP rate accumulates against
 * the tool rather than against us.
 */
export function adapterToIncoming(findings: readonly AdapterFinding[]): IncomingFinding[] {
  return findings.map((f) => ({
    dimension: f.dimension === 'correctness' ? 'code_health' : f.dimension,
    severity: f.severity,
    confidence: 4,
    file: f.file,
    lineStart: f.lineStart,
    lineEnd: f.lineEnd,
    title: f.title,
    evidenceQuote: `${f.file}:${f.lineStart} — ${f.message}`,
    rationale: f.message,
    suggestedFix: null,
    scannerKey: CODE_HEALTH_SCANNER_KEY,
    ruleId: f.ruleId,
    yields: null,
  }));
}

/** Weekly/manual pass over a snapshot. */
export async function runCodeHealthScan(deps: CodeHealthRunDeps): Promise<CodeHealthRunResult> {
  const [run] = await deps.db
    .insert(security.scanRuns)
    .values({
      workspaceId: deps.workspaceId,
      repoId: deps.repoId,
      scannerKey: CODE_HEALTH_SCANNER_KEY,
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
        const tools = await runCodeHealthTools({
          targetDir: snapshot.dir,
          image: deps.image ?? DEFAULT_IMAGE,
          budget: { wallClockMs: deps.wallClockMs ?? DEFAULT_WALL_CLOCK_MS },
          ...(deps.thresholds ? { thresholds: deps.thresholds } : {}),
        });

        if (tools.status !== 'succeeded') {
          await closeRun(deps.db, runId, 'failed', 0, tools.error ?? null, tools.toolVersions);
          return {
            status: 'failed' as const,
            scanRunId: runId,
            findingsCreated: 0,
            findingsTotal: 0,
            metricsWritten: 0,
            ...(tools.error ? { error: tools.error } : {}),
          };
        }

        // DEDUPE AGAINST THE PACK RULES ALREADY OPEN FOR THIS REPO, not just
        // against this run: the mapping that matters is ruff's E722 losing to
        // our bpm-ch-empty-catch, and that rule belongs to a different scanner
        // whose findings are already stored. Deduping against this run alone
        // would keep both and hand a reader two rows for one defect.
        const openRuleIds = (
          await deps.db
            .select({ ruleId: read.findings.ruleId })
            .from(read.findings)
            .where(eq(read.findings.repoId, deps.repoId))
        )
          .map((row) => row.ruleId)
          .filter((id): id is string => id !== null);

        const { kept, dropped } = dedupeAgainstPack(tools.adapterFindings, openRuleIds);
        const findings = [...toIncoming(tools.findings), ...adapterToIncoming(kept)];
        const persisted = await persistFindings(deps.db, {
          workspaceId: deps.workspaceId,
          repoId: deps.repoId,
          scanRunId: runId,
          pullRequestId: null,
          tier: 1,
          findings,
          // A snapshot run has seen the whole tree, so it may close what it no
          // longer reports — its own findings only.
          reviewedFiles: [...new Set(findings.map((f) => f.file).filter((f): f is string => !!f))],
          sweepScannerKey: CODE_HEALTH_SCANNER_KEY,
        });

        // Posture metrics onto the SAME series table every other metric uses,
        // so trends need no new endpoint and no new chart component.
        const metricRows = [
          { key: 'ch_duplication_pct', value: tools.metrics.ch_duplication_pct },
          { key: 'ch_complexity_p90', value: tools.metrics.ch_complexity_p90 },
          { key: 'ch_worst_fn_count', value: tools.metrics.ch_worst_fn_count },
        ].filter((row): row is { key: string; value: number } => row.value !== null);

        if (metricRows.length > 0) {
          await deps.db.insert(read.metricSnapshots).values(
            metricRows.map((row) => ({
              workspaceId: deps.workspaceId,
              repoId: deps.repoId,
              metricKey: row.key,
              // Snapshot metrics describe the tree at one commit, not a
              // window of activity — 'all' says that rather than implying a
              // 30-day measurement nobody made.
              window: 'all',
              value: String(row.value),
              dims: { commit_sha: deps.commitSha, scanner: CODE_HEALTH_SCANNER_KEY },
            })),
          );
        }

        await closeRun(deps.db, runId, 'succeeded', findings.length, null, tools.toolVersions);

        return {
          status: 'succeeded' as const,
          scanRunId: runId,
          findingsCreated: persisted.created,
          findingsTotal: findings.length,
          metricsWritten: metricRows.length,
          adapterFindings: kept.length,
          adapterDropped: dropped.length,
          adapterErrors: tools.adapterErrors,
        };
      },
    );
  } catch (err) {
    await closeRun(deps.db, runId, 'failed', 0, (err as Error).message.slice(0, 500), null);
    return {
      status: 'failed',
      scanRunId: runId,
      findingsCreated: 0,
      findingsTotal: 0,
      metricsWritten: 0,
      error: (err as Error).message,
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
