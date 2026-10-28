import { and, desc, eq, lte, ne } from 'drizzle-orm';
import { read, security, type Database } from '@repopulse/shared';
import { SEMGREP_SCANNER_KEY } from '../scanners/semgrep/scanner.js';
import { LOGGING_SCANNER_KEY } from '../scanners/logging/run.js';
import { PERF_SCANNER_KEY } from '../scanners/perf/run.js';
import { ANTI_SLOP_SCANNER_KEY } from '../scanners/anti-slop/run.js';
import { UNUSED_EXPORT_RULE_ID } from '../scanners/anti-slop/unused-exports.js';
import {
  PHANTOM_MODULE_RULE_ID,
  PHANTOM_SYMBOL_RULE_ID,
} from '../scanners/anti-slop/phantom-refs.js';

// Which findings a verified patch can be drafted for, and at which snapshot
// (W18-19). Shared by the API (which refuses before a model is called) and the
// worker (which must not trust that the API checked).

const SLOP_DETERMINISTIC = new Set([
  'slop.low_logic_density',
  'slop.docstring_inflation',
  UNUSED_EXPORT_RULE_ID,
  PHANTOM_SYMBOL_RULE_ID,
  PHANTOM_MODULE_RULE_ID,
]);

/**
 * True when a deterministic rule set in runners.ts reproduces this finding.
 *
 * By scanner AND rule: the logging and anti_slop scanners store model
 * judgement findings under the same scanner key as their pattern findings,
 * and "the model no longer thinks so" is not a verification.
 */
export function isRerunnable(scannerKey: string | null, ruleId: string | null): boolean {
  if (scannerKey === null || ruleId === null) return false;
  if (scannerKey === SEMGREP_SCANNER_KEY) return true;
  if (scannerKey === LOGGING_SCANNER_KEY) return ruleId.startsWith('bpm-log-');
  if (scannerKey === PERF_SCANNER_KEY) return ruleId.startsWith('bpm-perf-');
  // bpm-ch-*: a model chooses which pattern hits to raise, but the pattern is an
  // Opengrep rule the anti_slop_pack runner re-runs (2026-10-28) — the same
  // standing logging's bpm-log-* rules have.
  if (scannerKey === ANTI_SLOP_SCANNER_KEY) {
    return SLOP_DETERMINISTIC.has(ruleId) || ruleId.startsWith('bpm-ch-');
  }
  return false;
}

export interface ResolvedTarget {
  ok: true;
  findingId: number;
  workspaceId: number;
  repoId: number;
  file: string;
  lineStart: number | null;
  lineEnd: number | null;
  title: string;
  evidence: string;
  recommendation: string;
  dimension: string;
  scannerKey: string;
  ruleId: string;
  dedupKey: string;
  commitSha: string;
}

export interface UnresolvedTarget {
  ok: false;
  /** 404 = no such finding here; 409 = it exists and cannot be patched. */
  status: 404 | 409;
  code: 'not_found' | 'no_file' | 'not_rerunnable' | 'not_open' | 'no_snapshot';
  reason: string;
}

/**
 * The finding and the snapshot a patch for it is applied to.
 *
 * The snapshot is the commit of the most recent successful run of the
 * finding's scanner that could have sighted it — not `findings.scan_run_id`,
 * which is the FIRST sighting and never moves (the store bumps a re-sighting's
 * counter, not its run). Patching the file as it was months ago would hand a
 * developer a diff for code that no longer exists.
 */
export async function resolvePatchTarget(
  db: Database,
  workspaceId: number,
  findingId: number,
): Promise<ResolvedTarget | UnresolvedTarget> {
  const [f] = await db
    .select({
      id: read.findings.id,
      workspaceId: read.findings.workspaceId,
      repoId: read.findings.repoId,
      file: read.findings.file,
      lineStart: read.findings.lineStart,
      lineEnd: read.findings.lineEnd,
      title: read.findings.title,
      evidence: read.findings.evidence,
      recommendation: read.findings.recommendation,
      dimension: read.findings.dimension,
      scannerKey: read.findings.scannerKey,
      ruleId: read.findings.ruleId,
      dedupKey: read.findings.dedupKey,
      status: read.findings.status,
      scanRunId: read.findings.scanRunId,
      lastSeenAt: read.findings.lastSeenAt,
    })
    .from(read.findings)
    .where(and(eq(read.findings.id, findingId), eq(read.findings.workspaceId, workspaceId)))
    .limit(1);
  if (!f) return { ok: false, status: 404, code: 'not_found', reason: 'No such finding.' };

  if (f.file === null) {
    return {
      ok: false,
      status: 409,
      code: 'no_file',
      reason:
        'This finding is about the repository, not a line of a file, so there is no file to patch.',
    };
  }
  if (!isRerunnable(f.scannerKey, f.ruleId)) {
    return {
      ok: false,
      status: 409,
      code: 'not_rerunnable',
      reason:
        'Only findings from a deterministic rule can get a verified fix: the rule is re-run on the patched file to prove it clears, and a model finding has no rule to re-run.',
    };
  }
  if (f.status !== 'open' && f.status !== 'confirmed') {
    return {
      ok: false,
      status: 409,
      code: 'not_open',
      reason: `This finding is ${f.status.replace('_', ' ')}; a fix is drafted only for open or confirmed findings.`,
    };
  }

  const [latest] = await db
    .select({ commitSha: security.scanRuns.commitSha })
    .from(security.scanRuns)
    .where(
      and(
        eq(security.scanRuns.workspaceId, workspaceId),
        eq(security.scanRuns.repoId, f.repoId),
        eq(security.scanRuns.scannerKey, f.scannerKey!),
        eq(security.scanRuns.status, 'succeeded'),
        ne(security.scanRuns.commitSha, ''),
        lte(security.scanRuns.startedAt, f.lastSeenAt),
      ),
    )
    .orderBy(desc(security.scanRuns.startedAt), desc(security.scanRuns.id))
    .limit(1);

  let commitSha = latest?.commitSha ?? null;
  if (commitSha === null && f.scanRunId !== null) {
    const [first] = await db
      .select({ commitSha: security.scanRuns.commitSha })
      .from(security.scanRuns)
      .where(
        and(eq(security.scanRuns.id, f.scanRunId), eq(security.scanRuns.workspaceId, workspaceId)),
      )
      .limit(1);
    commitSha = first?.commitSha && first.commitSha !== '' ? first.commitSha : null;
  }
  if (commitSha === null) {
    return {
      ok: false,
      status: 409,
      code: 'no_snapshot',
      reason:
        'No scan of this repository records the commit this finding was seen at, so there is no snapshot to apply a patch to.',
    };
  }

  return {
    ok: true,
    findingId: f.id,
    workspaceId: f.workspaceId,
    repoId: f.repoId,
    file: f.file,
    lineStart: f.lineStart,
    lineEnd: f.lineEnd,
    title: f.title,
    evidence: f.evidence,
    recommendation: f.recommendation,
    dimension: f.dimension,
    scannerKey: f.scannerKey!,
    ruleId: f.ruleId!,
    dedupKey: f.dedupKey,
    commitSha,
  };
}
