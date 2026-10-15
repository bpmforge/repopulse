import { eq } from 'drizzle-orm';
import { security, type Database, safeErrorText } from '@repopulse/shared';
import { persistFindings, type IncomingFinding } from '@repopulse/insights';
import { shadowFindings } from '../../rules/shadow.js';
import { runSemgrepScan, SEMGREP_RULEPACK_DIR } from '../semgrep/scanner.js';
import { DEFAULT_EXCLUDED_GLOBS, isExcluded } from '../logging/run.js';
import path from 'node:path';

// performance (W9-13, CODE_HEALTH_SUITE.md §9.1, closing W9-08's fourth
// acceptance criterion).
//
// W9-08 wrote eight bpm-perf-* rules and nothing ran them. The pack lives in
// rulepacks/code-health/perf/, and `readRulepack` is NOT recursive — it lists a
// directory and keeps the .yaml files — so the one runner that pointed at
// `code-health/` (the logging scanner) loaded anti-slop.v1.yaml and
// logging.v1.yaml and never saw the perf SUBDIRECTORY at all. The rules were
// not evaluated and dropped; they were never loaded. The only reference to
// `bpm-perf-` anywhere in the workspace was a test that read the YAML off disk.
//
// The visible cost: no scanner emitted dimension `performance`, so the Findings
// Explorer's performance facet was permanently empty and the performance risk
// axis could never grade. VISION.md names performance as one of four review
// dimensions and three of the four shipped.
//
// This scanner owns the pack. It is DETERMINISTIC ONLY, deliberately: the pack
// header is explicit that these are structural shapes and that no rule can know
// an engine version or claim a speedup, and the performance checklist (W9-05,
// performance.v2) is a separate judgement layer with its own verify gate. One
// of those is a pattern match and the other is an opinion about someone's code;
// mixing them under one scanner key would blur which is which on the finding.

export const PERF_SCANNER_KEY = 'performance';

/**
 * The perf pack, addressed directly rather than through its parent.
 *
 * Pointing at `code-health/` would pick up the logging and anti-slop rules too
 * and this scanner would have to filter them out — which is how the logging
 * scanner ended up evaluating rules it discards. Each scanner pays for its own
 * rules and no others.
 */
export const PERF_PACK_DIR = path.resolve(SEMGREP_RULEPACK_DIR, '../code-health/perf');

/** The pack's id prefix. Every rule in it carries this (perf-pack.test.ts pins it). */
const PERF_RULE_PREFIX = 'bpm-perf-';

export interface PerfRunDeps {
  db: Database;
  workspaceId: number;
  repoId: number;
  commitSha: string;
  /** A directory to run the pack over. Absent = nothing to do, and it says so. */
  targetDir?: string;
  image?: string;
  trigger?: 'pr_synced' | 'schedule' | 'manual';
  pullRequestId?: number | null;
  excludedGlobs?: readonly string[];
}

export interface PerfRunResult {
  status: 'succeeded' | 'failed' | 'skipped';
  scanRunId: number | null;
  deterministic: number;
  excluded: number;
  findingsCreated: number;
  /** Rules the engine could not load — surfaced, never swallowed (W8-07). */
  toolErrors: number;
  skippedReason?: string;
  error?: string;
}

export async function runPerfScan(deps: PerfRunDeps): Promise<PerfRunResult> {
  // No snapshot, nothing to match against. Reported as `skipped` with a reason
  // rather than `succeeded` with zero findings: a scan that never ran and a
  // repository with no performance defects are different facts, and this suite
  // exists because the second one was being claimed for the first.
  if (!deps.targetDir) {
    return {
      status: 'skipped',
      scanRunId: null,
      deterministic: 0,
      excluded: 0,
      findingsCreated: 0,
      toolErrors: 0,
      skippedReason: 'no_snapshot',
    };
  }

  const [run] = await deps.db
    .insert(security.scanRuns)
    .values({
      workspaceId: deps.workspaceId,
      repoId: deps.repoId,
      scannerKey: PERF_SCANNER_KEY,
      scannerVersion: 'perf.v1',
      commitSha: deps.commitSha,
      trigger: deps.trigger ?? 'manual',
      status: 'running',
    })
    .returning();
  const runId = run!.id;

  const findings: IncomingFinding[] = [];
  const globs = deps.excludedGlobs ?? DEFAULT_EXCLUDED_GLOBS;
  let excluded = 0;
  let deterministic = 0;

  try {
    const pack = await runSemgrepScan({
      targetDir: deps.targetDir,
      rulepackDir: PERF_PACK_DIR,
      budget: { wallClockMs: 10 * 60 * 1000 },
      ...(deps.image ? { image: deps.image } : {}),
    });

    if (pack.status !== 'succeeded') {
      throw new Error(`perf pack run failed: ${pack.error ?? pack.status}`);
    }

    // The pack dir holds only perf rules, so this filter should never drop
    // anything. It is here because the directory is the kind of place a later
    // rule file gets added to, and a finding under the wrong dimension is
    // harder to notice than one that is missing. Candidate rules land in
    // shadow and deprecated ones drop out (rules/shadow.ts).
    const perf = await shadowFindings(
      deps.db,
      deps.workspaceId,
      pack.findings.filter((f) => f.ruleId.startsWith(PERF_RULE_PREFIX)),
    );
    for (const finding of perf) {
      if (isExcluded(finding.file, globs)) {
        excluded += 1;
        continue;
      }
      deterministic += 1;
      findings.push({
        dimension: 'performance',
        // Capped at 3 to match the pack, which tops out at WARNING on purpose:
        // a performance shape is not exploitable, and a rule that outranks a
        // real vulnerability in a sorted list makes the list wrong.
        severity: Math.min(3, finding.severity),
        // 4, not 5: the SHAPE is matched deterministically, but whether it
        // costs anything here depends on data volume the rule cannot see. The
        // pack's own messages say the same thing in words.
        confidence: 4,
        file: finding.file,
        lineStart: finding.lineStart,
        lineEnd: finding.lineEnd,
        title: finding.title,
        evidenceQuote: `${finding.file}:${finding.lineStart} — ${finding.ruleId}`,
        rationale: finding.message,
        // No suggested fix. Every one of these rules has more than one correct
        // remedy (batch it, hoist it, bound it) and which applies depends on
        // code the rule did not read. A confident wrong fix on a performance
        // finding is how people make things slower.
        suggestedFix: null,
        scannerKey: PERF_SCANNER_KEY,
        ruleId: finding.ruleId,
        yields:
          finding.yields.length > 0
            ? Object.fromEntries(finding.yields.map((y) => [y, true]))
            : null,
        ...(finding.experimental !== undefined ? { experimental: finding.experimental } : {}),
      });
    }

    const persisted = await persistFindings(deps.db, {
      workspaceId: deps.workspaceId,
      repoId: deps.repoId,
      scanRunId: runId,
      pullRequestId: deps.pullRequestId ?? null,
      tier: 1,
      findings,
      sweepScannerKey: PERF_SCANNER_KEY,
    });

    await deps.db
      .update(security.scanRuns)
      .set({ status: 'succeeded', findingCount: findings.length, finishedAt: new Date() })
      .where(eq(security.scanRuns.id, runId));

    return {
      status: 'succeeded',
      scanRunId: runId,
      deterministic,
      excluded,
      findingsCreated: persisted.created,
      toolErrors: pack.toolErrors.length,
    };
  } catch (err) {
    await deps.db
      .update(security.scanRuns)
      .set({
        status: 'failed',
        error: safeErrorText(err).slice(0, 500),
        finishedAt: new Date(),
      })
      .where(eq(security.scanRuns.id, runId));
    return {
      status: 'failed',
      scanRunId: runId,
      deterministic: 0,
      excluded,
      findingsCreated: 0,
      toolErrors: 0,
      error: safeErrorText(err),
    };
  }
}
