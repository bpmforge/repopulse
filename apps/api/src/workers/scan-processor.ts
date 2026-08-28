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
    /**
     * A BENIGN reason there was nothing to do: `no_connection`, `no_head_sha`,
     * `no_sbom`, `no_targets`, `no_diff`. Not a fault.
     */
    skipped?: string;
    /**
     * A FAULT, verbatim (W16-35).
     *
     * Separate from `skipped` because they were the same field and the
     * difference is the difference between "nobody looked" and "we tried and
     * it broke". Runners that wrap a result rather than throwing were putting
     * their real error into `skipped`, and this processor rendered every
     * non-`no_connection` value as "No commits in range to sweep" on a
     * SUCCEEDED row — so a semgrep run that failed on a 404 read as a clean
     * sweep, with the error thrown away.
     */
    error?: string;
  }>;
}

/**
 * What a zero-work sweep should SAY, by the reason it gave (W16-35).
 *
 * A map rather than a ternary because there are at least six reasons and the
 * ternary had two: everything that was not `no_connection` claimed "no commits
 * in range", including `no_sbom` and `no_head_sha`, which are not claims about
 * commits at all.
 *
 * The fallback QUOTES the reason instead of inventing a sentence for it. A
 * reason this processor has not been taught is still the runner's answer, and
 * printing it beats asserting something plausible and wrong — which is the
 * whole failure this file keeps being about. It earned its place immediately:
 * the first run against a broken scan image produced `no_clusters`, which was
 * not in the map, and the row read "the scanner gave: no_clusters" instead of
 * a confident sentence about commits.
 *
 * The keys are every value the codebase actually emits — checked by grepping
 * for `skipped:` and `skippedReason:` rather than remembered.
 */
const NOTHING_SCANNED: Record<string, string> = {
  no_connection: 'No forge connection for this repository, so there were no patches to read.',
  no_head_sha:
    'No ingested commit to pin this scan to, so there was nothing to scan — ingest history first.',
  no_sbom:
    'No SBOM has been built for this repository yet, so there was nothing for the register to read.',
  no_targets:
    'No commits in range to sweep — nothing was scanned, which is not the same as nothing being found.',
  no_diff: 'No changed files to review, so the checklist had nothing to read.',
  no_llm_packages:
    'No LLM client is a dependency of this repository, so the OWASP LLM checklist does not apply.',
  disabled: 'This scanner is switched off for this repository, so nothing looked.',
  no_gateway:
    'No model is configured for this workspace, so the judgement half could not run — add one in Admin → Models.',
  no_snapshot: 'The source archive could not be read, so there was no tree to scan.',
  no_clusters:
    'No cluster of dismissals large enough to draft a rule from — the pass ran and found no pattern.',
  no_candidates: 'Nothing met the bar to be considered, so there was nothing to judge.',
  source_cap_reached:
    'The source cap was reached before anything was scanned — the repository is larger than one pass covers.',
};

function nothingScannedMessage(reason: string | undefined): string {
  if (reason === undefined) return NOTHING_SCANNED['no_targets']!;
  return NOTHING_SCANNED[reason] ?? `Nothing was scanned, and the scanner gave: ${reason}`;
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

/**
 * One sweep, and a scan_run row whatever it does (W16-28).
 *
 * The weekly and history branches ran byte-identical bodies, which is how the
 * throw case came to be handled in one and not the other. Both call this.
 *
 * The sweeper writes its OWN scan_run rows, one per commit it covers, so the
 * happy path deliberately writes nothing here: a single summary row over a
 * 200-commit sweep could not say which commits were scanned, and "which
 * commits has this repo been swept for" is the question the next sweep asks.
 * Only the two cases the sweeper cannot record for itself are written.
 */
async function runSweep(
  deps: ScanProcessorDeps,
  data: ScanJobData,
  runner: HistoryRunner,
): Promise<void> {
  const row = {
    workspaceId: data.workspaceId,
    repoId: data.repoId,
    scannerKey: data.scannerKey,
    scannerVersion: getScanner(data.scannerKey)?.version ?? 'unregistered',
    commitSha: data.commitSha,
    trigger: data.trigger,
    findingCount: 0,
  };

  let outcome;
  try {
    outcome = await runner({ workspaceId: data.workspaceId, repoId: data.repoId });
  } catch (err) {
    // A THROW MUST REACH THE SCREEN (W16-28).
    //
    // Without this a runner that raises leaves no scan_run at all: the job
    // lands in job_failure, which only an admin looking at the dead-letter
    // queue ever sees, while the repository's coverage table goes on saying
    // "has never run" to the person who pressed the button.
    //
    // Found with a real one — the demo's seeded forge connection carried a
    // credential the vault could not decrypt, so every secrets scan died with
    // "ciphertext too short" and the screen showed nothing at all.
    //
    // Recorded, then RETHROWN: the retry and dead-letter behaviour is
    // deliberate (NFR-11) and swallowing the error here would trade one silent
    // failure for another.
    await deps.db.insert(security.scanRuns).values({
      ...row,
      status: 'failed',
      startedAt: new Date(),
      finishedAt: new Date(),
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  // A RUNNER THAT FAILED BY RETURNING (W16-35).
  //
  // Most runners here wrap a result instead of throwing, so a semgrep or
  // code-health run that failed came back as `scanned: 0` with its real error
  // in `skipped` — and the branch below recorded it as SUCCEEDED with the
  // sentence "No commits in range to sweep". The W16-29 screenshot has both on
  // one screen: anti-slop threw and read "last run failed — archive request
  // returned 401", while code health returned and read "ran clean" from the
  // same 401.
  //
  // Not rethrown, unlike the catch above: this runner has already handled its
  // own failure and returned, so the queue's retry would repeat work the
  // runner decided not to raise on. The ROW is what was missing.
  if (outcome.error) {
    await deps.db.insert(security.scanRuns).values({
      ...row,
      status: 'failed',
      startedAt: new Date(),
      finishedAt: new Date(),
      error: outcome.error,
    });
    return;
  }

  // A RUNNER THAT DID NOTHING MUST SAY SO (W16-28).
  //
  // A sweep covering zero commits writes no rows of its own, so the coverage
  // table went on reading "has never run" after someone pressed Run scans now
  // and was told it had started — the same silent nothing W16-20 fixed for the
  // unwired branch, arriving by a different route.
  if (outcome.scanned === 0) {
    await deps.db.insert(security.scanRuns).values({
      ...row,
      status: 'succeeded',
      startedAt: new Date(),
      finishedAt: new Date(),
      error: nothingScannedMessage(outcome.skipped),
    });
  }
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
      await runSweep(deps, data, runner);
      return;
    }

    if (data.mode === 'history_sweep') {
      await deps.historySweep?.(data.scannerKey);
      return;
    }

    if (data.mode === 'history') {
      // A MANUAL RUN REACHES THE WEEKLY RUNNERS TOO (W16-28).
      //
      // "Run scans now" enqueues mode:'history' for every enabled scanner, and
      // only `secrets` has a history runner — so pressing the button on a repo
      // with the default posture reached real work for exactly one scanner and
      // recorded "no history runner is wired" for the rest, which is honest and
      // useless. The weekly runners answer the same question (sweep this repo)
      // on a schedule instead of on a keypress; a person asking for it now is
      // asking for that work, not for a different kind of it.
      //
      // Still a lookup rather than a branch on the key, so FR-SEC-1 holds.
      const runner = deps.historyRunners?.[data.scannerKey] ?? deps.weeklyRunners?.[data.scannerKey];
      if (!runner) {
        // NOT a silent return (W16-20).
        //
        // Only a subset of scanners has a runner wired in the worker. Returning
        // quietly meant a job could be enqueued, consume its turn and finish
        // "successfully" having done nothing — and the coverage table would
        // still say "never run", with nothing anywhere saying why. That is the
        // exact shape of failure this product's copy is otherwise very careful
        // about: an absence that looks like a measurement.
        //
        // It is not an exception either: an unwired scanner is a deployment
        // fact, not a fault, so it records a run that says so and returns.
        await deps.db.insert(security.scanRuns).values({
          workspaceId: data.workspaceId,
          repoId: data.repoId,
          scannerKey: data.scannerKey,
          scannerVersion: getScanner(data.scannerKey)?.version ?? 'unregistered',
          commitSha: data.commitSha,
          trigger: data.trigger,
          status: 'failed',
          startedAt: new Date(),
          finishedAt: new Date(),
          error: `No history runner is wired for "${data.scannerKey}" on this server, so nothing was scanned.`,
        });
        return;
      }
      await runSweep(deps, data, runner);
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
