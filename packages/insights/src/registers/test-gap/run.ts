import { eq } from 'drizzle-orm';
import { security, type Database, safeErrorText } from '@repopulse/shared';
import { persistFindings, type IncomingFinding } from '../../findings/store.js';
import {
  TEST_GAP_DEFAULTS,
  TEST_GAP_WINDOW_DAYS,
  fileChangeStats,
  testGapFindings,
  type TestGapThresholds,
} from './register.js';

// The nightly test-gap register pass (W10-04, FR-REG-6).

export const TEST_GAP_REGISTER_KEY = 'test_gap_register';

export interface TestGapRunDeps {
  db: Database;
  workspaceId: number;
  repoId: number;
  thresholds?: TestGapThresholds;
  now?: Date;
}

export interface TestGapRunResult {
  status: 'succeeded' | 'failed';
  scanRunId: number | null;
  files: number;
  findings: number;
  created: number;
  /** Detections that could not run — reported, never a silent zero. */
  notRun: { ruleId: string; reason: string }[];
  error?: string;
}

export async function runTestGapRegister(deps: TestGapRunDeps): Promise<TestGapRunResult> {
  const now = deps.now ?? new Date();
  const windowStart = new Date(now.getTime() - TEST_GAP_WINDOW_DAYS * 86_400_000);

  const [run] = await deps.db
    .insert(security.scanRuns)
    .values({
      workspaceId: deps.workspaceId,
      repoId: deps.repoId,
      scannerKey: TEST_GAP_REGISTER_KEY,
      scannerVersion: 'test_gap.v1',
      // No commit: this register reads a WINDOW of history rather than a tree
      // at a point, and a SHA here would imply a reproducibility it lacks.
      commitSha: '',
      trigger: 'schedule',
      status: 'running',
    })
    .returning();
  const runId = run!.id;

  try {
    const state = await fileChangeStats(deps.db, deps.repoId, windowStart);
    const result = testGapFindings(state, deps.thresholds ?? TEST_GAP_DEFAULTS);

    const incoming: IncomingFinding[] = result.findings.map((finding) => ({
      dimension: 'test_gap',
      severity: finding.severity,
      // 4, not 5: the counts are exact but co-change is a PROXY for testing.
      // A file tested thoroughly by a suite nobody edits looks the same here,
      // and the confidence should say so rather than the evidence alone.
      confidence: 4,
      file: finding.file,
      lineStart: null,
      lineEnd: null,
      title: finding.title,
      evidenceQuote: finding.evidence,
      rationale: finding.recommendation,
      suggestedFix: null,
      scannerKey: TEST_GAP_REGISTER_KEY,
      ruleId: finding.ruleId,
      yields: null,
    }));

    const persisted = await persistFindings(deps.db, {
      workspaceId: deps.workspaceId,
      repoId: deps.repoId,
      scanRunId: runId,
      pullRequestId: null,
      tier: 1,
      findings: incoming,
      // The pass has seen every file changed in the window, so it may close
      // what it no longer reports — its own dimension and scanner only.
      reviewedFiles: state.files.map((file) => file.path),
      sweepDimensions: ['test_gap'],
      sweepScannerKey: TEST_GAP_REGISTER_KEY,
    });

    await deps.db
      .update(security.scanRuns)
      .set({ status: 'succeeded', findingCount: incoming.length, finishedAt: new Date() })
      .where(eq(security.scanRuns.id, runId));

    return {
      status: 'succeeded',
      scanRunId: runId,
      files: state.files.length,
      findings: incoming.length,
      created: persisted.created,
      notRun: result.notRun,
    };
  } catch (error) {
    const message = safeErrorText(error);
    await deps.db
      .update(security.scanRuns)
      .set({ status: 'failed', error: message.slice(0, 500), finishedAt: new Date() })
      .where(eq(security.scanRuns.id, runId));
    return {
      status: 'failed',
      scanRunId: runId,
      files: 0,
      findings: 0,
      created: 0,
      notRun: [],
      error: message,
    };
  }
}
