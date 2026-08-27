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
  /**
   * W8-05. A `history` job sweeps warehoused history for one repo instead of
   * scanning one pinned SHA — same scanner, different question about which
   * commits to look at. `history_sweep` is the monthly fan-out that enqueues
   * one `history` job per repo.
   */
  mode?: 'sha' | 'history' | 'history_sweep' | 'weekly' | 'weekly_sweep';
}

export interface HistoryRunner {
  (args: { workspaceId: number; repoId: number }): Promise<{
    scanned: number;
    findingsCreated: number;
    deferred: number;
    skipped?: string;
  }>;
}

export interface ScanProcessorDeps {
  db: Database;
  /** Injectable so tests exercise the whole path without a real scanner. */
  buildContext?: (data: ScanJobData) => ScannerContext;
  /**
   * History sweepers BY SCANNER KEY, injected by the worker entrypoint (W8-05).
   *
   * A map rather than a `switch (scannerKey)`: FR-SEC-1's claim is that the
   * framework never branches on a scanner key, and a lookup in an injected
   * registry keeps that true — a scanner that gains a history mode adds one
   * entry at the entrypoint and changes nothing here.
   */
  historyRunners?: Record<string, HistoryRunner>;
  /**
   * The monthly fan-out (W8-05): lists repos and enqueues one history job each.
   * Injected because listing live repos and enqueueing are the entrypoint's
   * job, not this processor's — the same split the nightly reconcile sweep uses.
   */
  historySweep?: (scannerKey: string) => Promise<{ enqueued: number }>;
  /**
   * The WEEKLY pass (W8-07 full semgrep scan + W8-09 chain recompute), by
   * scanner key, and its fan-out. Same injected-map shape as the history
   * runners for the same reason: the framework must not learn scanner names.
   */
  weeklyRunners?: Record<string, HistoryRunner>;
  weeklySweep?: (scannerKey: string) => Promise<{ enqueued: number }>;
}

export function scanProcessor(deps: ScanProcessorDeps) {
  return async function process(job: Job<ScanJobData>): Promise<void> {
    const data = job.data;

    if (data.mode === 'weekly_sweep') {
      await deps.weeklySweep?.(data.scannerKey);
      return;
    }

    if (data.mode === 'weekly') {
      const runner = deps.weeklyRunners?.[data.scannerKey];
      if (!runner) return;
      await runner({ workspaceId: data.workspaceId, repoId: data.repoId });
      return;
    }

    if (data.mode === 'history_sweep') {
      await deps.historySweep?.(data.scannerKey);
      return;
    }

    if (data.mode === 'history') {
      // The sweeper writes its OWN scan_run rows, one per commit it covers, so
      // this path deliberately does not open one here: a single run row over a
      // 200-commit sweep could not say which commits were actually scanned,
      // and "which commits has this repo been swept for" is the question the
      // next sweep asks.
      const runner = deps.historyRunners?.[data.scannerKey];
      if (!runner) {
        // NOT a silent return (W16-20).
        //
        // Only a subset of scanners has a history runner wired in the worker.
        // Returning quietly meant a job could be enqueued, consume its turn and
        // finish "successfully" having done nothing — and the coverage table
        // would still say "never run", with nothing anywhere saying why. That
        // is the exact shape of failure this product's copy is otherwise very
        // careful about: an absence that looks like a measurement.
        //
        // It is not an exception either: an unwired scanner is a deployment
        // fact, not a fault, so it records a run that says so and returns.
        await deps.db.insert(security.scanRuns).values({
          workspaceId: data.workspaceId,
          repoId: data.repoId,
          scannerKey: data.scannerKey,
          scannerVersion: 'unregistered',
          commitSha: data.commitSha,
          trigger: data.trigger,
          status: 'failed',
          startedAt: new Date(),
          finishedAt: new Date(),
          error: `No history runner is wired for "${data.scannerKey}" on this server, so nothing was scanned.`,
        });
        return;
      }
      await runner({ workspaceId: data.workspaceId, repoId: data.repoId });
      return;
    }

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
