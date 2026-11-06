import { eq } from 'drizzle-orm';
import { security, type Database, safeErrorText } from '@repopulse/shared';
import {
  DEFAULT_BUDGET,
  getScanner,
  isUpToDate,
  runScanner,
  type ScanProbe,
  type ScanTrigger,
  type ScannerContext,
  type SnapshotHandle,
} from '@repopulse/security';
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
  mode?: 'sha' | 'history' | 'history_sweep' | 'weekly' | 'weekly_sweep' | 'pr' | 'batch';
  /**
   * W23-02. `mode: 'batch'` only: every scanner one press (or one first scan)
   * asked for, run over ONE commit and ONE snapshot. `scannerKey` is '' on such
   * a job — the keys are here, and the job is about the repository.
   */
  scannerKeys?: string[];
  /**
   * W23-01 ("Full rescan"). Bypasses the up-to-date check: the runner is called
   * even when an earlier run at this commit with these tool and data versions
   * already answered the question. Only meaningful for `weekly` and `history`.
   */
  force?: boolean;
}

export interface HistoryRunner {
  (
    args: {
      workspaceId: number;
      repoId: number;
      /**
       * W23-09. Present (true) only on a forced job. The processor's own
       * up-to-date check is skipped for it, and a runner with its own "already
       * covered" memory (secrets history's `covered` filter) must ignore that too.
       */
      force?: boolean;
    },
    /**
     * W23-02. A tree the batch already fetched. A runner that scans a snapshot
     * uses it instead of fetching its own; every other runner ignores it, so
     * the argument is additive and a runner called without it behaves as before.
     */
    opts?: { snapshot?: SnapshotHandle },
  ): Promise<{
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
    /**
     * W25-03. The runner wrote its OWN succeeded scan_runs row, so `scanned: 0`
     * is a measurement ("no attack chains", "nothing changed"), not "nobody
     * looked". The processor then writes no "nothing was scanned" row of its
     * own: on the 0.2.0 install the attack chainer, the knowledge register and
     * the architecture register all wrote a good row and then had it buried
     * under a second one reading "No commits in range to sweep".
     */
    recordedRun?: boolean;
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
    'No model is configured for this workspace, so the judgement half could not run — add one in Settings → Models.',
  no_snapshot: 'The source archive could not be read, so there was no tree to scan.',
  no_clusters:
    'No cluster of dismissals large enough to draft a rule from — the pass ran and found no pattern.',
  no_candidates: 'Nothing met the bar to be considered, so there was nothing to judge.',
  // W18-24, the code-scanning pull.
  code_scanning_not_supported:
    'This forge has no code-scanning alerts RepoPulse can read yet (GitLab and Gitea are not supported), so nothing was imported.',
  no_code_scanning_permission:
    'The token or GitHub App RepoPulse uses may not read code-scanning alerts, so none were imported — grant it "Code scanning alerts: Read-only" (security_events: read), or ignore this if you do not use GitHub code scanning.',
  code_scanning_not_enabled:
    'Code scanning is not set up on this repository on GitHub, so there were no alerts to import.',
  source_cap_reached:
    'The source cap was reached before anything was scanned — the repository is larger than one pass covers.',
  // W23-01. Not a runner's answer: the processor's own, when an earlier run at
  // the same commit with the same tool and data versions already holds it.
  up_to_date:
    'Nothing changed since the last successful run at this commit with these tool versions, so nothing was re-scanned. Use "Full rescan" to force it.',
  // W25-03, the architecture register: no dependency-graph tool for the
  // repository's languages (dependency-cruiser for JS/TS, grimp for Python).
  no_supported_language:
    "No architecture tool reads this repository's languages yet, so no module graph was built and nothing was measured.",
  // W25-03, the knowledge register: its window holds no commit that touched a module.
  no_history_in_window:
    "No ingested commit in the register's window touched a module, so there was no ownership to measure — ingest more history or widen the window.",
  // W25-03: what a runner that gave NO reason gets. It used to be `no_targets`'
  // sentence about commits, which was false for every runner that is not a
  // history sweep.
  no_reason:
    'Nothing was scanned, and the scanner did not say why — which is not the same as nothing being found.',
};

function nothingScannedMessage(reason: string | undefined): string {
  if (reason === undefined) return NOTHING_SCANNED['no_reason']!;
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
  /**
   * W23-01. Per scanner key, what commit and tool versions the runner above
   * WOULD use, resolved without running it — so an unchanged scan can be
   * skipped. Same injected-map shape as the runners (the framework never
   * branches on a key); a scanner with no entry always runs. Shared with
   * POST /repos/:id/scan, which asks the same question before enqueueing.
   */
  probes?: Record<string, ScanProbe>;
  weeklySweep?: (scannerKey: string) => Promise<{ enqueued: number }>;
  /**
   * W23-02 (WP-R2). What `mode: 'batch'` needs and the processor cannot know:
   * which scanners read a source tree, the commit they will all pin to, and a
   * bracket that fetches ONE archive for them. Injected, like the runners, so
   * the framework still never branches on a scanner key. Absent, or
   * `headSha` null (no connection, nothing ingested), and a batch degrades to
   * each scanner on its own path — which records its own `no_connection` /
   * `no_head_sha` row.
   */
  batch?: {
    usesSnapshot: (scannerKey: string) => boolean;
    /**
     * W25-05. True for a scanner that reads what other scanners of the same
     * batch write (an SBOM, findings): it runs after the tree scanners instead
     * of before them. Absent = every non-tree scanner runs first, as before.
     */
    runsAfterTree?: (scannerKey: string) => boolean;
    headSha: (workspaceId: number, repoId: number) => Promise<string | null>;
    withSnapshot: <T>(
      args: { workspaceId: number; repoId: number; commitSha: string },
      fn: (snapshot: SnapshotHandle) => Promise<T>,
    ) => Promise<T>;
    /**
     * W22-01. Builds the code map (names, line spans, hashes and edges, never
     * code) from the batch's tree while it exists, after the scanners. Its
     * failure is its own: logged by the hook, never a scanner's failed row.
     */
    indexTree?: (
      args: { workspaceId: number; repoId: number; commitSha: string },
      snapshot: SnapshotHandle,
    ) => Promise<void>;
  };
  /**
   * W21-02. The pattern scanners over one pull-request head (`mode: 'pr'`,
   * `commitSha` the head, `prNumber` the PR). The runner records its own rows,
   * one per scanner, and never throws for a scanner's failure.
   */
  prRunner?: (data: ScanJobData) => Promise<unknown>;
  /**
   * After any job that scanned a repository (2026-10-27): the worker queues a
   * reprice so new findings carry a risk score today, not after the nightly
   * snapshot. Not called for the sweep fan-outs, which scan nothing themselves.
   * The hook catches and logs its own failures: a queue hiccup must not fail a
   * scan whose findings are already stored.
   */
  afterScan?: (data: ScanJobData) => Promise<void>;
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
  /** `snapshot`: the batch's tree. `upToDateChecked`: the batch already asked. */
  opts: { snapshot?: SnapshotHandle; upToDateChecked?: boolean } = {},
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

  // UP TO DATE? (W23-01). Asked before the runner, because the runner's first
  // act is a tarball fetch. `force` skips the question. A probe that throws or
  // cannot say is treated as "unknown": run the scan — a skip must be earned by
  // evidence, never by a failure to look.
  if (!data.force && !opts.upToDateChecked) {
    const skipped = await skipIfUpToDate(deps, data, row);
    if (skipped) return;
  }

  let outcome;
  try {
    outcome = await runner(
      {
        workspaceId: data.workspaceId,
        repoId: data.repoId,
        ...(data.force ? { force: true } : {}),
      },
      opts.snapshot ? { snapshot: opts.snapshot } : undefined,
    );
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
      error: safeErrorText(err),
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
  if (outcome.scanned === 0 && !outcome.recordedRun) {
    await deps.db.insert(security.scanRuns).values({
      ...row,
      status: 'succeeded',
      startedAt: new Date(),
      finishedAt: new Date(),
      error: nothingScannedMessage(outcome.skipped),
    });
  }
}

/**
 * Writes the `skipped` row and returns true when the scan is already answered.
 *
 * The row restates the earlier run's finding count and points at it
 * (`base_run_id`), so the coverage table reads "up to date as of <date>" rather
 * than "never ran". It is a real succeeded row at the REAL commit — `row`'s own
 * commitSha is the job's, which is '' for a manual run.
 */
async function skipIfUpToDate(
  deps: ScanProcessorDeps,
  data: ScanJobData,
  row: {
    workspaceId: number;
    repoId: number;
    scannerKey: string;
    scannerVersion: string;
    trigger: ScanTrigger;
  },
): Promise<boolean> {
  const probe = deps.probes?.[data.scannerKey];
  if (!probe) return false;

  let match;
  let commitSha: string;
  try {
    const probed = await probe({ workspaceId: data.workspaceId, repoId: data.repoId });
    if (!probed) return false;
    commitSha = probed.commitSha;
    // The registry declares the data stamp (metadata, not a key branch); a
    // probe that knows better may override it.
    const dataVersion =
      probed.dataVersion !== undefined
        ? probed.dataVersion
        : ((await getScanner(data.scannerKey)?.dataVersion?.()) ?? null);
    match = await isUpToDate(deps.db, {
      workspaceId: data.workspaceId,
      repoId: data.repoId,
      scannerKey: data.scannerKey,
      commitSha,
      toolVersions: probed.toolVersions ?? null,
      dataVersion,
    });
  } catch {
    return false;
  }
  if (!match) return false;

  const now = new Date();
  await deps.db.insert(security.scanRuns).values({
    ...row,
    commitSha,
    status: 'succeeded',
    scope: 'skipped',
    findingCount: match.findingCount,
    baseRunId: match.id,
    toolVersions: match.toolVersions,
    dataVersion: match.dataVersion,
    startedAt: now,
    finishedAt: now,
    error: NOTHING_SCANNED['up_to_date']!,
  });
  return true;
}

/**
 * One scanner's manual/history job (W16-28), shared by the single-scanner job
 * and by a batch's non-snapshot scanners. `opts.snapshot` is set only by a batch.
 */
async function runHistoryJob(
  deps: ScanProcessorDeps,
  data: ScanJobData,
  opts: { snapshot?: SnapshotHandle; upToDateChecked?: boolean } = {},
): Promise<void> {
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
  await runSweep(deps, data, runner, opts);
  return;
}

/**
 * W23-02 (WP-R2): one commit, one snapshot, every scanner the press asked for.
 *
 * Before this, "Run scans now" enqueued one job per scanner and each snapshot
 * scanner fetched its own tarball of the same commit — five archives, five
 * extractions, five charges on the `scan` lane for one tree. Here the head is
 * resolved once, each scanner is asked "up to date?" (W23-01) and the ones that
 * remain run SEQUENTIALLY inside one `withSnapshot` bracket, each through its
 * existing runner with the tree handed in. Scanners that do not read a tree
 * (registers, the OWASP checklists, the secrets history) keep their own path and
 * run outside the bracket, so the directory exists no longer than it must.
 *
 * C1a, as amended: source on disk for the length of one scan BATCH. The bracket
 * is the injected `withSnapshot` (snapshotForScan), so the directory is deleted
 * in its `finally` on every path, and the hourly sweeper is unchanged.
 *
 * NFR-15: a scanner that throws is recorded failed (runSweep writes the row) and
 * the batch goes on. Nothing here rethrows for one scanner's fault.
 */
async function runBatch(deps: ScanProcessorDeps, data: ScanJobData): Promise<void> {
  const keys = [...new Set(data.scannerKeys ?? [])];
  const asJob = (scannerKey: string): ScanJobData => ({
    workspaceId: data.workspaceId,
    repoId: data.repoId,
    scannerKey,
    commitSha: '',
    trigger: data.trigger,
    mode: 'history',
    ...(data.force ? { force: true } : {}),
  });
  const runnerFor = (key: string): HistoryRunner | undefined =>
    deps.historyRunners?.[key] ?? deps.weeklyRunners?.[key];
  // A scanner's own failure must not end the batch. runSweep has already
  // written the failed row before it rethrows; swallowing here is the point.
  const alone = async (key: string, opts?: Parameters<typeof runHistoryJob>[2]) => {
    try {
      await runHistoryJob(deps, asJob(key), opts);
    } catch {
      /* recorded as a failed scan_run by runSweep */
    }
  };

  const batch = deps.batch;
  const treeKeys = batch ? keys.filter((k) => runnerFor(k) && batch.usesSnapshot(k)) : [];
  // W25-05. Scanners that READ another scanner's output (the supply-chain
  // register reads the SBOM dependency_cve builds; the attack chainer reads
  // every finding) run AFTER the tree scanners. They ran first, so on the 0.2.0
  // install's first scan the supply-chain register found no SBOM ~25 s before
  // one existed and the Supply Chain tile read 100/100.
  const late = (k: string) => batch?.runsAfterTree?.(k) ?? false;
  const ownKeys = keys.filter((k) => !treeKeys.includes(k) && !late(k));
  const lateKeys = keys.filter((k) => !treeKeys.includes(k) && late(k));

  for (const key of ownKeys) await alone(key);
  try {
    await runTreeKeys(deps, data, treeKeys, alone, asJob);
  } finally {
    for (const key of lateKeys) await alone(key);
  }
}

/** The tree half of a batch: one archive, every snapshot scanner inside it (W23-02). */
async function runTreeKeys(
  deps: ScanProcessorDeps,
  data: ScanJobData,
  treeKeys: string[],
  alone: (key: string, opts?: Parameters<typeof runHistoryJob>[2]) => Promise<void>,
  asJob: (scannerKey: string) => ScanJobData,
): Promise<void> {
  const batch = deps.batch;
  if (treeKeys.length === 0 || !batch) return;

  const commitSha = await batch.headSha(data.workspaceId, data.repoId).catch(() => null);
  if (!commitSha) {
    // No connection or nothing ingested: each runner says so on its own row.
    for (const key of treeKeys) await alone(key);
    return;
  }

  // Up to date? asked per scanner BEFORE the one fetch; all answered = no fetch.
  const remaining: string[] = [];
  for (const key of treeKeys) {
    if (!data.force) {
      const skipped = await skipIfUpToDate(deps, asJob(key), {
        workspaceId: data.workspaceId,
        repoId: data.repoId,
        scannerKey: key,
        scannerVersion: getScanner(key)?.version ?? 'unregistered',
        trigger: data.trigger,
      }).catch(() => false);
      if (skipped) continue;
    }
    remaining.push(key);
  }
  if (remaining.length === 0) return;

  try {
    await batch.withSnapshot(
      { workspaceId: data.workspaceId, repoId: data.repoId, commitSha },
      async (snapshot) => {
        for (const key of remaining) {
          await alone(key, { snapshot, upToDateChecked: true });
        }
        // The map is built from the same tree, inside the same bracket, so the
        // source exists no longer than the batch (C1a). Its failure must not
        // read as the scanners' (NFR-15): swallowed, the hook logs it.
        if (batch.indexTree) {
          await batch
            .indexTree({ workspaceId: data.workspaceId, repoId: data.repoId, commitSha }, snapshot)
            .catch(() => undefined);
        }
      },
    );
  } catch (err) {
    // The archive could not be had (forge refused, no tarball support, over the
    // caps). Every scanner that needed it gets a failed row saying why — never a
    // clean-looking nothing — and the job ends without a retry storm.
    const now = new Date();
    for (const key of remaining) {
      await deps.db.insert(security.scanRuns).values({
        workspaceId: data.workspaceId,
        repoId: data.repoId,
        scannerKey: key,
        scannerVersion: getScanner(key)?.version ?? 'unregistered',
        commitSha,
        trigger: data.trigger,
        status: 'failed',
        startedAt: now,
        finishedAt: now,
        error: safeErrorText(err),
      });
    }
  }
}

export function scanProcessor(deps: ScanProcessorDeps) {
  const scan = scanJob(deps);
  return async function process(job: Job<ScanJobData>): Promise<void> {
    await scan(job);
    const mode = job.data.mode;
    if (mode === 'weekly_sweep' || mode === 'history_sweep') return;
    await deps.afterScan?.(job.data);
  };
}

function scanJob(deps: ScanProcessorDeps) {
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

    if (data.mode === 'pr') {
      await deps.prRunner?.(data);
      return;
    }

    if (data.mode === 'history_sweep') {
      await deps.historySweep?.(data.scannerKey);
      return;
    }

    if (data.mode === 'history') {
      await runHistoryJob(deps, data);
      return;
    }

    if (data.mode === 'batch') {
      await runBatch(deps, data);
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
