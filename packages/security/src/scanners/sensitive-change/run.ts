import { and, eq, inArray } from 'drizzle-orm';
import { security, type Database } from '@repopulse/shared';
import { persistFindings, type IncomingFinding } from '@repopulse/insights';
import { isEnabled } from '../../config/defaults.js';
import { sensitiveChanges, type RadarDiffFile, type RadarSignal } from './radar.js';
import { RADAR_RULES, type RadarRule } from './rules.js';

// The sensitive_change scanner (W18-21): the radar, wired to the store.
//
// IT RIDES THE SECRETS STREAM. Secrets stream mode already fetches the diff of
// every new PR head and pushed commit, on the scan lane, idempotently keyed by
// head SHA (stream.ts). The radar reads that same patch list, so it adds no
// forge call, no snapshot and no queue hop — and a PR that loosens auth is
// flagged in the same minute its leaked key would be.
//
// SIGNALS, NOT GRADES (N-9). A finding here says "a person should look at this
// change", never "this change is a vulnerability" and never who made it. It is
// deterministic and never passes through a model, so the verify pass has
// nothing to refute — and by construction (RADAR_SEVERITY_CAP) it never needs a
// verifier's confirmation to be shown.

export const SENSITIVE_CHANGE_SCANNER_KEY = 'sensitive_change';
export const SENSITIVE_CHANGE_VERSION = 'sensitive_change.v1';

/** Prefixed to every title, so the list says what the finding asks for. */
export const HUMAN_REVIEW_PREFIX = 'Needs human review';

export interface SensitiveChangeDeps {
  db: Database;
  workspaceId: number;
  repoId: number;
  commitSha: string;
  /** The radar is about changes arriving, so only the arrival triggers run it. */
  trigger: 'pr_synced' | 'push';
  pullRequestId?: number | null;
  files: readonly RadarDiffFile[];
  rules?: readonly RadarRule[];
}

export interface SensitiveChangeResult {
  status: 'succeeded' | 'failed' | 'disabled';
  scanRunId: number | null;
  signals: number;
  findingsCreated: number;
  /** Rules switched off (`deprecated`) in this workspace, and so not run. */
  deprecatedRules: string[];
  error?: string;
}

export async function sensitiveChangeEnabled(
  db: Database,
  workspaceId: number,
  repoId: number,
): Promise<boolean> {
  const [row] = await db
    .select({ enabled: security.repoScannerConfig.enabled })
    .from(security.repoScannerConfig)
    .where(
      and(
        eq(security.repoScannerConfig.workspaceId, workspaceId),
        eq(security.repoScannerConfig.repoId, repoId),
        eq(security.repoScannerConfig.scannerKey, SENSITIVE_CHANGE_SCANNER_KEY),
      ),
    );
  return isEnabled(SENSITIVE_CHANGE_SCANNER_KEY, row ? { enabled: row.enabled } : undefined);
}

/**
 * Each rule's lifecycle state in this workspace (CODE_HEALTH_SUITE §8.2).
 *
 * No row is the shipped default — candidate, so the rule runs in SHADOW and
 * its findings are stamped experimental until an admin promotes it on
 * evidence. One query for all rules: this runs on every PR head.
 */
async function ruleStatuses(
  db: Database,
  workspaceId: number,
  ruleIds: readonly string[],
): Promise<Map<string, 'candidate' | 'active' | 'deprecated'>> {
  const rows = await db
    .select({ ruleId: security.ruleRegistry.ruleId, status: security.ruleRegistry.status })
    .from(security.ruleRegistry)
    .where(
      and(
        eq(security.ruleRegistry.workspaceId, workspaceId),
        inArray(security.ruleRegistry.ruleId, [...ruleIds]),
      ),
    );
  const out = new Map<string, 'candidate' | 'active' | 'deprecated'>();
  for (const id of ruleIds) out.set(id, 'candidate');
  for (const row of rows) {
    if (row.status === 'active' || row.status === 'deprecated') out.set(row.ruleId, row.status);
  }
  return out;
}

export function toRadarFinding(signal: RadarSignal, experimental: boolean): IncomingFinding {
  return {
    // `security`, not a new dimension: the radar is a security signal, and a
    // new value would need DDL in a table this ticket does not own.
    dimension: 'security',
    severity: signal.severity,
    confidence: signal.confidence,
    file: signal.file,
    lineStart: signal.line,
    lineEnd: signal.line,
    title: `${HUMAN_REVIEW_PREFIX}: ${signal.what}`,
    evidenceQuote: signal.evidence,
    rationale:
      `${signal.rationale} This is a change signal, not a verdict: it needs human review, ` +
      'and no automated pass will clear it.',
    // Advice only (D9a): the product never edits the repository.
    suggestedFix:
      'Confirm the change is intended and that the protection still holds somewhere else; ' +
      'if it is, dismiss with a reason so the rule learns.',
    scannerKey: SENSITIVE_CHANGE_SCANNER_KEY,
    ruleId: signal.ruleId,
    yields: null,
    experimental,
  };
}

/**
 * Runs the radar over one head's diff and stores what it finds.
 *
 * Never throws: it rides the secrets stream, which rides ingestion, and a
 * radar failure must not cost either of them (NFR-15). The scan_run row
 * carries the failure instead.
 */
export async function runSensitiveChangeScan(
  deps: SensitiveChangeDeps,
): Promise<SensitiveChangeResult> {
  if (!(await sensitiveChangeEnabled(deps.db, deps.workspaceId, deps.repoId))) {
    return {
      status: 'disabled',
      scanRunId: null,
      signals: 0,
      findingsCreated: 0,
      deprecatedRules: [],
    };
  }

  const [run] = await deps.db
    .insert(security.scanRuns)
    .values({
      workspaceId: deps.workspaceId,
      repoId: deps.repoId,
      scannerKey: SENSITIVE_CHANGE_SCANNER_KEY,
      scannerVersion: SENSITIVE_CHANGE_VERSION,
      commitSha: deps.commitSha,
      trigger: deps.trigger,
      status: 'running',
    })
    .returning();
  const runId = run!.id;

  try {
    const allRules = deps.rules ?? RADAR_RULES;
    const statuses = await ruleStatuses(
      deps.db,
      deps.workspaceId,
      allRules.map((r) => r.id),
    );
    const deprecatedRules = allRules
      .filter((r) => statuses.get(r.id) === 'deprecated')
      .map((r) => r.id);
    const rules = allRules.filter((r) => statuses.get(r.id) !== 'deprecated');

    const { signals } = sensitiveChanges(deps.files, { rules });
    const findings = signals.map((s) => toRadarFinding(s, statuses.get(s.ruleId) !== 'active'));

    const persisted = await persistFindings(deps.db, {
      workspaceId: deps.workspaceId,
      repoId: deps.repoId,
      scanRunId: runId,
      pullRequestId: deps.pullRequestId ?? null,
      // Tier 1: no model was involved, and none decides whether it stays.
      tier: 1,
      findings,
      // NO reviewedFiles: a diff is not the repository, and a later PR that
      // does not touch the file must not auto-resolve a signal nobody looked at.
      sweepScannerKey: SENSITIVE_CHANGE_SCANNER_KEY,
    });

    await deps.db
      .update(security.scanRuns)
      .set({ status: 'succeeded', findingCount: findings.length, finishedAt: new Date() })
      .where(eq(security.scanRuns.id, runId));

    return {
      status: 'succeeded',
      scanRunId: runId,
      signals: signals.length,
      findingsCreated: persisted.created,
      deprecatedRules,
    };
  } catch (err) {
    await deps.db
      .update(security.scanRuns)
      .set({
        status: 'failed',
        error: (err as Error).message.slice(0, 500),
        finishedAt: new Date(),
      })
      .where(eq(security.scanRuns.id, runId));
    return {
      status: 'failed',
      scanRunId: runId,
      signals: 0,
      findingsCreated: 0,
      deprecatedRules: [],
      error: (err as Error).message,
    };
  }
}
