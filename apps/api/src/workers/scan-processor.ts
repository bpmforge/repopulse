import { eq } from 'drizzle-orm';
import { security, type Database } from '@repopulse/shared';
import { DEFAULT_BUDGET, getScanner, runScanner, type ScanTrigger, type ScannerContext } from '@repopulse/security';
import type { Job } from 'bullmq';

// security.scan processor (W8-01, NFR-15).
//
// Every scanner runs through runScanner(), which never rethrows — so this
// processor's job is to record what happened, not to survive it. A scan that
// crashes leaves a failed scan_run and the queue moves on; ingestion and the
// Tier-1 dashboards never learn it happened.

export interface ScanJobData {
  workspaceId: number;
  repoId: number;
  scannerKey: string;
  commitSha: string;
  trigger: ScanTrigger;
  prNumber?: number;
}

export interface ScanProcessorDeps {
  db: Database;
  /** Injectable so tests exercise the whole path without a real scanner. */
  buildContext?: (data: ScanJobData) => ScannerContext;
}

export function scanProcessor(deps: ScanProcessorDeps) {
  return async function process(job: Job<ScanJobData>): Promise<void> {
    const data = job.data;
    const scanner = getScanner(data.scannerKey);

    const [run] = await deps.db
      .insert(security.scanRuns)
      .values({
        workspaceId: data.workspaceId,
        repoId: data.repoId,
        scannerKey: data.scannerKey,
        // Recorded even when the scanner is unknown: a run row that cannot say
        // which version produced it is not reproducible, and "unregistered" is
        // the honest answer rather than a blank.
        scannerVersion: scanner?.version ?? 'unregistered',
        commitSha: data.commitSha,
        trigger: data.trigger,
        status: 'running',
      })
      .returning();

    if (!scanner) {
      await deps.db
        .update(security.scanRuns)
        .set({
          status: 'failed',
          error: `No scanner registered under key "${data.scannerKey}"`,
          finishedAt: new Date(),
        })
        .where(eq(security.scanRuns.id, run!.id));
      // Not rethrown: an unregistered key is a config problem, and retrying it
      // twice with backoff would only produce the same row again.
      return;
    }

    const ctx = deps.buildContext?.(data);
    if (!ctx) {
      await deps.db
        .update(security.scanRuns)
        .set({ status: 'failed', error: 'No scanner context available', finishedAt: new Date() })
        .where(eq(security.scanRuns.id, run!.id));
      return;
    }

    const result = await runScanner(scanner, { ...ctx, budget: ctx.budget ?? DEFAULT_BUDGET });

    await deps.db
      .update(security.scanRuns)
      .set({
        status: result.status,
        partial: result.partial,
        findingCount: result.findings.length,
        error: result.error ?? null,
        finishedAt: new Date(),
      })
      .where(eq(security.scanRuns.id, run!.id));
  };
}
