import { eq } from 'drizzle-orm';
import { security, type Database, safeErrorText } from '@repopulse/shared';
import { persistFindings, type IncomingFinding } from '../../findings/store.js';
import {
  KNOWLEDGE_DEFAULTS,
  KNOWLEDGE_WINDOW_DAYS,
  knowledgeFindings,
  moduleConcentration,
  type KnowledgeThresholds,
} from './register.js';

// The nightly knowledge register pass (W10-01, FR-REG-1).

export const KNOWLEDGE_REGISTER_KEY = 'knowledge_register';

export interface KnowledgeRunDeps {
  db: Database;
  workspaceId: number;
  repoId: number;
  thresholds?: KnowledgeThresholds;
  now?: Date;
}

export interface KnowledgeRunResult {
  status: 'succeeded' | 'failed';
  scanRunId: number | null;
  modules: number;
  findings: number;
  created: number;
  error?: string;
}

export async function runKnowledgeRegister(
  deps: KnowledgeRunDeps,
): Promise<KnowledgeRunResult> {
  const now = deps.now ?? new Date();
  const windowStart = new Date(now.getTime() - KNOWLEDGE_WINDOW_DAYS * 86_400_000);

  const [run] = await deps.db
    .insert(security.scanRuns)
    .values({
      workspaceId: deps.workspaceId,
      repoId: deps.repoId,
      scannerKey: KNOWLEDGE_REGISTER_KEY,
      scannerVersion: 'knowledge.v1',
      // No commit: this register reads a WINDOW of history, not a tree at a
      // point. Recording a SHA would imply a reproducibility it does not have.
      commitSha: '',
      trigger: 'schedule',
      status: 'running',
    })
    .returning();
  const runId = run!.id;

  try {
    const modules = await moduleConcentration(deps.db, deps.repoId, windowStart);
    const found = knowledgeFindings(modules, deps.thresholds ?? KNOWLEDGE_DEFAULTS);

    const incoming: IncomingFinding[] = found.map((f) => ({
      dimension: 'knowledge',
      severity: f.severity,
      // 5: these are counts from the warehouse. What is arguable is the
      // threshold, and the evidence states the numbers it crossed.
      confidence: 5,
      // The MODULE is the location. A directory is not a file, and pointing at
      // one file inside it would send a reader somewhere arbitrary.
      file: f.module,
      lineStart: null,
      lineEnd: null,
      title: f.title,
      evidenceQuote: f.evidence,
      rationale: f.recommendation,
      suggestedFix: null,
      scannerKey: KNOWLEDGE_REGISTER_KEY,
      ruleId: 'knowledge.concentration',
      yields: null,
    }));

    const persisted = await persistFindings(deps.db, {
      workspaceId: deps.workspaceId,
      repoId: deps.repoId,
      scanRunId: runId,
      pullRequestId: null,
      tier: 1,
      findings: incoming,
      // The register has seen every module in the window, so it may close what
      // it no longer reports — its own findings only.
      reviewedFiles: modules.map((m) => m.module),
      sweepScannerKey: KNOWLEDGE_REGISTER_KEY,
    });

    await deps.db
      .update(security.scanRuns)
      .set({ status: 'succeeded', findingCount: incoming.length, finishedAt: new Date() })
      .where(eq(security.scanRuns.id, runId));

    return {
      status: 'succeeded',
      scanRunId: runId,
      modules: modules.length,
      findings: incoming.length,
      created: persisted.created,
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
      modules: 0,
      findings: 0,
      created: 0,
      error: safeErrorText(err),
    };
  }
}
