import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { Job } from 'bullmq';
import { core, read, safeErrorText, type Database } from '@repopulse/shared';
import {
  contentHash,
  contextWindowForRole,
  excerptAround,
  findingVerdict,
  needsCompare,
  needsVerification,
  planPathsScope,
  planReviewScope,
  quoteInText,
  quoteStillPresent,
  restrictDiff,
  reviewPromptVersion,
  runSpecialists,
  specialistById,
  type AnalysisGateway,
  type LlmRole,
  type PathsScopePlan,
  type ReviewScopePlan,
  type RoutingPolicy,
  type SpecialistId,
  type SecondModelVerify,
  type T2Host,
} from '@repopulse/analysis';
import {
  carryForwardReview,
  dedupKey,
  persistFindings,
  recordVerdicts,
  type FindingVerify,
} from '@repopulse/insights';
import {
  TRIAGE_TOP_N,
  parseContextPacket,
  runTriage,
  type TriageCandidate,
} from '@repopulse/security';
import {
  overlaps,
  rangesByFile,
  type DiffEntry,
  type DiffRequest,
  type LoadedDiff,
} from './ai-pass-diff.js';
import { isAiPaused } from '../lib/ai-pause.js';
import { withAiPass } from './ai-pass-context.js';
import { describeEndpoint, loadStoredRouting, providersFor } from '../lib/llm-routing.js';
import {
  JUDGE_DIMENSIONS,
  judgeConfigFromEnv,
  runJudge,
  type EgressOf,
  type JudgeConfig,
} from './ai-judge.js';
import { isFirstLook } from './ai-first-look.js';
import { isTestPath } from './code-kind.js';
import {
  emptyFixSummary,
  FIX_RESERVE_SHARE,
  pickFixTargets,
  runFixes,
  type FixDeps,
  type FixSummary,
} from './ai-fix.js';

// ai.pass processor (W19-09): planned specialists, then evidence-fed triage, over
// one repository, through THIS workspace's routing chain.
//
// WHAT THIS CAN AND CANNOT DO.
//   - It reads a snapshot of the repository (never writes to it, D9a) and sends
//     the files it selected to the workspace's own model. Local-only, the routing
//     chain, the egress audit and the call cap are enforced by the gateway; this
//     code adds the cap on files, bytes and calls.
//   - It writes ordinary findings (the specialists') and triage SUGGESTIONS. It
//     never changes the status of an existing finding, never dismisses, never
//     resolves: persistFindings is called WITHOUT reviewedFiles, which is the only
//     thing that makes it auto-resolve, and the suggestion table has no way to
//     touch a finding.
//   - Every failure lands on the run row, in words. Nothing is retried (one
//     attempt): a retry would repeat dozens of model calls.

/** Hard limits on what a pass reads. A repo-wide pass is bounded, never "everything". */
export const AI_PASS_MAX_FILES = 40;
export const AI_PASS_MAX_BYTES = 400_000;
export const AI_PASS_MAX_PATHS = 50;
/** Gateway calls for one pass - specialists and triage together, retries counted. */
export const AI_PASS_MAX_CALLS = 30;

export interface AiPassJobData {
  workspaceId: number;
  runId: number;
  requestId?: string;
  /** A lower call cap for this pass (a scheduled pass is limited by what is left of the month). */
  maxCalls?: number;
  /**
   * W23-07 / W25-07: review the whole pull request, or every file of a
   * repository pass, even when an incremental re-review would do.
   */
  force?: boolean;
  /** W25-16: a folder review reads test code too (off by default). */
  includeTests?: boolean;
}

export interface PassFile {
  path: string;
  content: string;
}

export type LoadedSources =
  | {
      ok: true;
      commitSha: string;
      files: PassFile[];
      /** W20-16 (AI-85): files in scope that were not read, by reason (W25-16: tests). */
      skipped?: { unsupported: number; tooLarge: number; tests?: number };
      /**
       * W25-16: files that exist in scope but were left out on purpose (test
       * code). An incremental pass must not close their findings as deleted.
       */
      leftOut?: string[];
    }
  | { ok: false; code: string; reason: string };

export interface AiPassDeps {
  db: Database;
  /** This workspace's gateway, its hosts and routing (W16-19); null when it has no model. */
  gatewayFor: (
    workspaceId: number,
  ) => Promise<{ gateway: AnalysisGateway; hosts: T2Host[]; routing?: RoutingPolicy } | null>;
  /** The repository's files at its head, restricted to `paths`. */
  loadSources: (args: {
    workspaceId: number;
    repoId: number;
    paths: string[];
    /**
     * W25-01: `paths` is a RANKED list of files (a first look): read them in
     * order up to the pass caps instead of refusing a scope over the caps.
     */
    fit?: boolean;
    /** W25-16: read test code under the named folders too (Include tests). */
    includeTests?: boolean;
  }) => Promise<LoadedSources>;
  /**
   * W25-01: the files a first-look pass reads (trigger `after_scan`, mode
   * `paths`), ranked from our own database when it starts (ai-first-look.ts).
   * Absent = a first-look row fails by name instead of reviewing nothing.
   */
  rankFirstLook?: (args: { workspaceId: number; repoId: number }) => Promise<string[]>;
  /** The changes of a pull request or a commit range (W19-11); absent = diff mode unavailable. */
  loadDiff?: (req: DiffRequest) => Promise<LoadedDiff>;
  /**
   * W23-07: the files that differ between two heads of a pull request (the
   * forge compare, budgeted, in the worker). Absent or null = unavailable, and
   * the review is a full one.
   */
  compareHeads?: (req: {
    workspaceId: number;
    repoId: number;
    base: string;
    head: string;
  }) => Promise<{
    files: { path: string; status: string; previousPath?: string }[];
    truncated: boolean;
  } | null>;
  /**
   * W20-18 (UX_TODO AI-14): a gateway on ONE connection and model, for a second
   * opinion. Absent = second opinions are unavailable on this server.
   */
  secondOpinionGatewayFor?: (
    workspaceId: number,
    pin: { providerId: number; model: string },
  ) => Promise<{ gateway: AnalysisGateway; hosts: T2Host[] } | null>;
  /**
   * W21-03: a second-model verifier for this pass's own findings, limited to
   * the calls the pass has left and counted on its row (`wrap` is the pass's
   * cancel check and call counter). Absent = no verify step on this server.
   */
  verifierFor?: (args: {
    workspaceId: number;
    repoId: number;
    hosts: T2Host[];
    maxCalls: number;
    wrap: (g: AnalysisGateway) => AnalysisGateway;
  }) => { verify: SecondModelVerify; calls(): number };
  maxCalls?: number;
  now?: () => Date;
  /**
   * W22-03: judge runs (mode 'judge', queued after a scan). `config` defaults
   * to the environment's; `afterVerdicts` queues a reprice so verify_status
   * moves the ranking today; `egress` is for tests.
   */
  judge?: {
    config?: JudgeConfig;
    afterVerdicts?: (target: {
      workspaceId: number;
      repoId: number;
      runId: number;
    }) => Promise<void>;
    egress?: EgressOf;
    /**
     * W22-09: after judging, verified fixes for the top confirmed findings,
     * in the same run and budget (ai-fix.ts). Absent = no drafting here.
     */
    fixes?: FixDeps;
    /**
     * 2026-10-29: each scanner is its own job and every one queues the judge
     * when it ends, so the run used to start after the FIRST scanner and judge
     * the previous scan's findings (seen live on outline: semgrep and anti-slop
     * were still running). True while scan jobs for the repo are still queued
     * or running; the run then waits (`requeue`) instead of starting.
     */
    scansPending?: (target: { workspaceId: number; repoId: number }) => Promise<boolean>;
    /**
     * The gateway judge runs use (2026-10-29): the workspace's background
     * gateway, whose calls wait behind scans for the model. Absent = gatewayFor.
     */
    gatewayFor?: AiPassDeps['gatewayFor'];
    /** Puts the run's job back on the queue after `delayMs`; the row stays pending. */
    requeue?: (data: AiPassJobData, delayMs: number) => Promise<void>;
  };
}

/** How often a judge run waiting for its repo's scans looks again. */
export const JUDGE_SCAN_WAIT_POLL_MS = 60_000;
/**
 * The longest a judge run waits for scans before judging what is there. Under
 * the stale-run cutoff in queueJudgeAfterScan (per-scan minutes + queue allowance + 60), so a
 * waiting run is never closed as stalled.
 */
export const JUDGE_SCAN_WAIT_MAX_MS = 45 * 60_000;

export type AiPassResult = {
  status: 'succeeded' | 'failed' | 'skipped';
  code?: string;
  reason?: string;
};

/** A file is in scope when it equals a path or sits under a directory prefix. */
export function inScope(file: string, paths: readonly string[]): boolean {
  return paths.some((p) => {
    const norm = p.replace(/\/+$/, '');
    return file === norm || file.startsWith(`${norm}/`);
  });
}

const stripPatchPrefix = (s: string): string => s.replace(/^\+/gm, '');

/** W25-06: how often a model call in flight looks for a cancel of its pass. */
export const PASS_CANCEL_POLL_MS = 5_000;

/** Thrown inside a pass whose row an admin cancelled (W20-21, UX_TODO AI-33). */
export class PassCancelledError extends Error {
  constructor() {
    super('The pass was cancelled.');
    this.name = 'PassCancelledError';
  }
}

/**
 * The pass's view of the gateway (W20-21, UX_TODO AI-33, AI-64): before each
 * model call it checks that the row is still running (an admin may have
 * cancelled it; then it throws and nothing more is sent), and after each call
 * it writes the number of calls so far, so a long pass shows progress instead
 * of nothing until it ends.
 */
export function trackPassGateway(
  inner: AnalysisGateway,
  db: Database,
  ids: { workspaceId: number; runId: number },
  /** Calls the pass already made through another tracker (W21-03 verify step). */
  startAt = 0,
  /** W25-06: how often a call in flight checks whether its pass was cancelled. */
  cancelPollMs = PASS_CANCEL_POLL_MS,
): AnalysisGateway {
  let calls = startAt;
  const where = and(
    eq(read.aiPassRuns.id, ids.runId),
    eq(read.aiPassRuns.workspaceId, ids.workspaceId),
  );
  const stillRunning = async (): Promise<boolean> => {
    const [row] = await db
      .select({ status: read.aiPassRuns.status })
      .from(read.aiPassRuns)
      .where(where)
      .limit(1);
    return row?.status === 'running';
  };
  return {
    async complete(prompt, opts) {
      if (!(await stillRunning())) throw new PassCancelledError();
      // W25-06: a cancel DURING the call aborts it. Before, the row read
      // "cancelled" at once but the model call went on: on the 0.2.0 install
      // saleor's and outline's cancelled judges still wrote verdicts 15-23
      // minutes later and held the one LM Studio slot all that time.
      const controller = new AbortController();
      const timer = setInterval(() => {
        stillRunning()
          .then((running) => {
            if (!running) controller.abort(new PassCancelledError());
          })
          .catch(() => undefined);
      }, cancelPollMs);
      timer.unref?.();
      const signal = opts.signal
        ? AbortSignal.any([opts.signal, controller.signal])
        : controller.signal;
      try {
        return await inner.complete(prompt, { ...opts, signal });
      } catch (err) {
        if (controller.signal.aborted) throw new PassCancelledError();
        throw err;
      } finally {
        clearInterval(timer);
        calls += 1;
        await db
          .update(read.aiPassRuns)
          .set({ calls })
          .where(and(where, eq(read.aiPassRuns.status, 'running')))
          .catch(() => undefined);
      }
    },
    health: (tier) => inner.health(tier),
  };
}

export function aiPassProcessor(deps: AiPassDeps) {
  const now = deps.now ?? (() => new Date());
  const baseMaxCalls = deps.maxCalls ?? AI_PASS_MAX_CALLS;

  // W20-21 (UX_TODO AI-29): every model call inside the pass is attributed to
  // it on the egress audit.
  return (job: Job<AiPassJobData>): Promise<AiPassResult> =>
    withAiPass(job.data.runId, () => process(job));

  async function process(job: Job<AiPassJobData>): Promise<AiPassResult> {
    const { workspaceId, runId } = job.data;
    const maxCalls = Math.max(1, Math.min(baseMaxCalls, job.data.maxCalls ?? baseMaxCalls));
    const { db } = deps;

    // Always workspace-filtered (Law 5).
    const [run] = await db
      .select()
      .from(read.aiPassRuns)
      .where(and(eq(read.aiPassRuns.id, runId), eq(read.aiPassRuns.workspaceId, workspaceId)))
      .limit(1);
    if (!run) return { status: 'skipped', code: 'not_found', reason: 'No such pass.' };
    if (run.status !== 'pending') {
      return { status: 'skipped', code: 'already_started', reason: `Already ${run.status}.` };
    }

    const finish = async (
      status: 'succeeded' | 'failed' | 'skipped',
      patch: Partial<typeof read.aiPassRuns.$inferInsert> = {},
    ): Promise<AiPassResult> => {
      // W20-21 (UX_TODO AI-33): never over a row an admin cancelled meanwhile.
      const ended = await db
        .update(read.aiPassRuns)
        .set({ status, finishedAt: now(), ...patch })
        .where(
          and(
            eq(read.aiPassRuns.id, runId),
            eq(read.aiPassRuns.workspaceId, workspaceId),
            inArray(read.aiPassRuns.status, ['pending', 'running']),
          ),
        )
        .returning({ id: read.aiPassRuns.id });
      if (ended.length === 0) {
        return { status: 'failed', code: 'cancelled', reason: 'The pass was cancelled.' };
      }
      return {
        status,
        ...(patch.reasonCode ? { code: patch.reasonCode } : {}),
        ...(patch.reason ? { reason: patch.reason } : {}),
      };
    };
    const fail = (
      code: string,
      reason: string,
      extra: Partial<typeof read.aiPassRuns.$inferInsert> = {},
    ) => finish('failed', { reasonCode: code, reason: reason.slice(0, 2000), ...extra });
    // W20-11 (UX_TODO AI-60): what a pass had already done when it failed
    // partway (LM Studio crashing during triage, say). The calls were made, so
    // they count toward the monthly cap, and the findings the specialists had
    // already written are on the repository; both were dropped from the row.
    // Calls inside a triage step that then threw are not known here, so the
    // count is the specialists' (a floor, never an overcount).
    let progress: Partial<typeof read.aiPassRuns.$inferInsert> = {};

    // W20-18 (UX_TODO AI-77): AI switched off after this was queued. Nothing
    // is sent; recorded as skipped (it never ran, so it is not a pass today).
    if (await isAiPaused(db, workspaceId)) {
      return finish('skipped', {
        reasonCode: 'ai_paused',
        reason:
          'AI analysis was switched off for this workspace before this pass started, so nothing was sent to a model.',
      });
    }

    // A judge run waits until its repo's scans are done, so it judges the
    // findings (and evidence packets) of this scan, not the last one.
    const j = deps.judge;
    // W25-01: a first look waits the same way, so it ranks files by the
    // findings of the scan that queued it.
    const firstLook = run.mode === 'paths' && run.trigger === 'after_scan';
    if (
      (run.mode === 'judge' || firstLook) &&
      j?.scansPending &&
      j.requeue &&
      now().getTime() - run.createdAt.getTime() < JUDGE_SCAN_WAIT_MAX_MS &&
      (await j.scansPending({ workspaceId, repoId: run.repoId }))
    ) {
      await j.requeue(job.data, JUDGE_SCAN_WAIT_POLL_MS);
      return {
        status: 'skipped',
        code: 'waiting_for_scans',
        reason: "Waiting for this repository's scans to finish.",
      };
    }

    // Compare-and-set on `pending` (W20-21, AI-33): a pass cancelled while it
    // waited in the queue does not start.
    const started = await db
      .update(read.aiPassRuns)
      .set({ status: 'running', startedAt: now() })
      .where(
        and(
          eq(read.aiPassRuns.id, runId),
          eq(read.aiPassRuns.workspaceId, workspaceId),
          eq(read.aiPassRuns.status, 'pending'),
        ),
      )
      .returning({ id: read.aiPassRuns.id });
    if (started.length === 0) {
      return { status: 'skipped', code: 'already_started', reason: 'No longer queued.' };
    }

    if (run.mode === 'second_opinion') {
      try {
        return await secondOpinionStep({ deps, run, workspaceId, runId, maxCalls, fail, finish });
      } catch (err) {
        return fail('error', safeErrorText(err));
      }
    }

    if (run.mode === 'judge') {
      try {
        return await judgeStep({ deps, run, workspaceId, runId, now, fail, finish });
      } catch (err) {
        return fail('error', safeErrorText(err));
      }
    }

    try {
      const built = await deps.gatewayFor(workspaceId);
      const wg = built
        ? { ...built, gateway: trackPassGateway(built.gateway, db, { workspaceId, runId }) }
        : null;
      if (!wg) {
        return fail(
          'no_gateway',
          'No model is configured for this workspace, so there was nothing to run the pass on. Add one in Settings → Models.',
        );
      }

      // What is reviewed: the repository's files at its head (paths mode), or the
      // changes of a pull request / commit range (diff modes).
      let input: Parameters<typeof runSpecialists>[0];
      let promptTitle: string;
      let filesRead: number;
      let filesSkipped: { unsupported: number; tooLarge: number; tests?: number } | null = null;
      let unreadable: string[] = [];
      let diffRanges: Map<string, [number, number][]> | null = null;
      let commitSha: string;
      let incremental: Extract<ReviewScopePlan, { scope: 'incremental' }> | null = null;
      let reviewScope: { scope: 'full' | 'incremental'; baseRunId?: number } = { scope: 'full' };
      let fullDiff: readonly DiffEntry[] = [];
      // W25-07: a repository pass over the same paths as an earlier one.
      let pathsIncremental: Extract<PathsScopePlan, { scope: 'incremental' }> | null = null;
      // W25-16: test files this pass left out on purpose (they still exist).
      let leftOut = new Set<string>();
      let fileHashes: Record<string, string> | null = null;
      let allFiles: ReadonlyMap<string, string> = new Map();
      if (run.mode === 'paths') {
        let paths = run.paths;
        if (firstLook && paths.length === 0) {
          if (!deps.rankFirstLook) {
            return fail(
              'no_ranking',
              'Choosing files for a first look is not available on this server.',
            );
          }
          paths = await deps.rankFirstLook({ workspaceId, repoId: run.repoId });
          if (paths.length === 0) {
            return finish('skipped', {
              reasonCode: 'nothing_to_rank',
              reason:
                'The first scan left no open finding and no recent commit on a file type the AI reads, so there was nothing to choose files from.',
            });
          }
        }
        const loaded = await deps.loadSources({
          workspaceId,
          repoId: run.repoId,
          paths,
          ...(firstLook ? { fit: true } : {}),
          ...(job.data.includeTests === true ? { includeTests: true } : {}),
        });
        if (!loaded.ok) return fail(loaded.code, loaded.reason);
        commitSha = loaded.commitSha;
        let sentFiles = loaded.files;
        fileHashes = Object.fromEntries(loaded.files.map((f) => [f.path, contentHash(f.content)]));
        allFiles = new Map(loaded.files.map((f) => [f.path, f.content]));
        if (!firstLook) {
          // W25-07: only the files whose content changed since the last clean
          // pass over these same paths go to the model.
          const decision = await decidePathsScope({
            deps,
            run,
            workspaceId,
            files: Object.entries(fileHashes).map(([p, hash]) => ({ path: p, hash })),
            force: job.data.force === true,
          });
          if (decision.scope === 'incremental') {
            // W25-16: a test file left out of this pass still exists; it is
            // not "gone", so its earlier findings are neither closed nor carried.
            leftOut = new Set(loaded.leftOut ?? []);
            pathsIncremental = {
              ...decision,
              removed: decision.removed.filter((p) => !leftOut.has(p)),
            };
            reviewScope = { scope: 'incremental', baseRunId: decision.baseRunId };
            const changed = new Set(decision.changed);
            sentFiles = loaded.files.filter((f) => changed.has(f.path));
          }
        }
        // W25-07: when no file changed, nothing goes to the specialists (an
        // empty input plans none of them, so no call is made); triage of the
        // rule hits in scope still runs, as new scans may have raised some.
        input = { kind: 'module', name: `repo-${run.repoId}`, files: sentFiles };
        if (firstLook) {
          // The row names exactly what was read, best-ranked first.
          paths = loaded.files.map((f) => f.path);
          await db
            .update(read.aiPassRuns)
            .set({ paths })
            .where(
              and(eq(read.aiPassRuns.id, runId), eq(read.aiPassRuns.workspaceId, workspaceId)),
            );
        }
        promptTitle = firstLook
          ? `First look after the first scan: the ${paths.length} files with the most findings and churn`
          : `Repository pass over ${paths.join(', ')}`;
        filesRead = sentFiles.length;
        filesSkipped = loaded.skipped ?? null;
      } else {
        if (!deps.loadDiff) {
          return fail('no_diff_source', 'Reviewing a diff is not available on this server.');
        }
        const loaded = await deps.loadDiff({
          workspaceId,
          repoId: run.repoId,
          mode: run.mode,
          prNumber: run.prNumber,
          base: run.baseRef,
          head: run.headRef,
        });
        if (!loaded.ok) return fail(loaded.code, loaded.reason);
        commitSha = loaded.commitSha;
        // W23-07: on a new push to a reviewed pull request, only the hunks
        // changed since the prior reviewed head go to the model.
        let sent = loaded.files;
        if (run.mode === 'pull_request' && run.prNumber !== null) {
          const decision = await decideReviewScope({
            deps,
            run,
            workspaceId,
            headSha: loaded.headRef,
            prFiles: loaded.files.map((f) => f.path),
            force: job.data.force === true,
          });
          if (decision.scope === 'incremental') {
            sent = restrictDiff(loaded.files, decision.changed);
            incremental = decision;
            reviewScope = { scope: 'incremental', baseRunId: decision.baseRunId };
          }
        }
        fullDiff = loaded.files;
        input = {
          kind: 'diff',
          files: sent.map((f) => ({ path: f.path, patch: f.patch })),
        };
        promptTitle = loaded.title;
        filesRead = sent.length;
        unreadable = loaded.unreadable;
        diffRanges = rangesByFile(loaded.files);
        await db
          .update(read.aiPassRuns)
          .set({ baseRef: loaded.baseRef, headRef: loaded.headRef })
          .where(eq(read.aiPassRuns.id, runId));
      }
      await db
        .update(read.aiPassRuns)
        .set({
          commitSha,
          ...(run.mode === 'pull_request' || run.mode === 'paths'
            ? {
                scope: reviewScope.scope,
                baseRunId: reviewScope.baseRunId ?? null,
                promptVersion: reviewPromptVersion(),
              }
            : {}),
          ...(run.mode === 'paths' ? { fileHashes } : {}),
        })
        .where(eq(read.aiPassRuns.id, runId));

      const window = (id: SpecialistId): number | null =>
        contextWindowForRole(wg.routing, specialistById(id).role as LlmRole, wg.hosts);

      // 1. The planned specialists. A third of the call cap (at most what triage can
      // use) is held back for triage, so a tight cap cannot starve it entirely; any
      // of it the specialists do not need is still the cap, not extra.
      // W27-04: a first look triages no rule hits (they are the judge's), so its
      // whole cap goes to reading code.
      const triageReserve = triageReserveFor(run, maxCalls);
      const spec = await runSpecialists(input, {
        gateway: wg.gateway,
        contextWindowFor: window,
        maxCalls: maxCalls - triageReserve,
        prTitle: promptTitle,
        meta: { repoId: String(run.repoId), prNumber: 0, initiator: 'ai-pass' },
      });
      progress = {
        calls: spec.calls,
        specialists: {
          usage: spec.usage,
          droppedForBudget: spec.droppedForBudget,
          failures: spec.failures,
          rejected: spec.rejected.length,
          filesRead,
          ...(filesSkipped ? { filesSkipped } : {}),
        },
      };

      // 2. Persist what they found, as ordinary findings, and how each was raised.
      const analysisRunIds: number[] = [];
      for (const [id, usage] of Object.entries(spec.usage) as [
        SpecialistId,
        NonNullable<(typeof spec.usage)[SpecialistId]>,
      ][]) {
        const mine = spec.findings.filter((f) => f.specialist === id);
        if (mine.length === 0) continue;
        const sp = specialistById(id);
        const [ar] = await db
          .insert(read.analysisRuns)
          .values({
            workspaceId,
            repoId: run.repoId,
            tier: 2,
            dimension: sp.dimension,
            checklistVersion: sp.checklistVersion,
            modelId: usage.models[0] ?? 'unknown',
            status: 'succeeded',
            passKind: 'find',
            chunkCount: usage.chunks,
            promptTokens: usage.tokensIn,
            outputTokens: usage.tokensOut,
            cacheReadTokens: usage.cacheReadTokens,
            startedAt: run.startedAt ?? now(),
            finishedAt: now(),
          })
          .returning({ id: read.analysisRuns.id });
        analysisRunIds.push(ar!.id);

        const incoming = mine.map((f) => ({
          dimension: f.dimension,
          severity: f.severity,
          confidence: f.confidence,
          file: f.file,
          lineStart: Math.max(1, f.line_range[0]),
          lineEnd: Math.max(1, f.line_range[1]),
          title: f.title,
          evidenceQuote: stripPatchPrefix(f.evidence_quote),
          rationale: f.rationale,
          suggestedFix: f.suggested_fix,
          // No scanner and no rule: these are a model's judgement, not a rule's.
          scannerKey: null,
          ruleId: null,
        }));
        // NO reviewedFiles: that is what would let this auto-resolve other findings.
        await persistFindings(db, {
          workspaceId,
          repoId: run.repoId,
          analysisRunId: ar!.id,
          pullRequestId: null,
          tier: 2,
          findings: incoming,
        });

        const keys = incoming.map((f) =>
          dedupKey({
            dimension: f.dimension,
            file: f.file,
            evidenceQuote: f.evidenceQuote,
            lineStart: f.lineStart,
            scannerKey: null,
            ruleId: null,
          }),
        );
        const rows = await db
          .select({ id: read.findings.id, key: read.findings.dedupKey })
          .from(read.findings)
          .where(
            and(
              eq(read.findings.workspaceId, workspaceId),
              eq(read.findings.repoId, run.repoId),
              inArray(read.findings.dedupKey, keys),
            ),
          );
        const idByKey = new Map(rows.map((r) => [r.key, r.id]));
        for (const [i, f] of mine.entries()) {
          const findingId = idByKey.get(keys[i]!);
          if (findingId === undefined) continue;
          await db
            .insert(read.aiFindingProvenance)
            .values({
              workspaceId,
              findingId,
              aiPassRunId: runId,
              specialist: id,
              checklistVersion: f.checklistVersion,
              model: f.model,
              route: (f.route ?? null) as Record<string, unknown> | null,
            })
            .onConflictDoNothing();
        }
      }

      // 2b. W23-07: an incremental review decides every OTHER finding of the base
      // pass from the new full diff: quote still there = carried, gone = closed.
      let carried: { carried: number; closed: number } | null = null;
      if (incremental) {
        const patches = new Map(fullDiff.map((f) => [f.path, f.patch]));
        carried = await carryForwardReview({
          db,
          workspaceId,
          repoId: run.repoId,
          baseAiPassRunId: incremental.baseRunId,
          newAiPassRunId: runId,
          quoteInDiff: (file, quote) => quoteStillPresent(quote, patches.get(file)),
        });
      } else if (pathsIncremental) {
        // W25-07: the base pass's other findings are decided from the files'
        // full text now: quote still there = carried, file or quote gone = closed.
        carried = await carryForwardReview({
          db,
          workspaceId,
          repoId: run.repoId,
          baseAiPassRunId: pathsIncremental.baseRunId,
          newAiPassRunId: runId,
          // A file left out on purpose (W25-16) was not looked at: its
          // findings stand as they were rather than close as "gone".
          quoteInDiff: (file, quote) => leftOut.has(file) || quoteInText(quote, allFiles.get(file)),
        });
      }

      // 3. Evidence-fed triage of RULE-raised findings in scope.
      const triage = await triageStep({
        deps,
        wg,
        run,
        workspaceId,
        runId,
        callsSoFar: spec.calls,
        maxCalls,
        now,
        diffRanges,
      });

      // 4. W21-03: a second model's verdict on what the specialists raised
      // (severity 3 and up), with the calls the pass has left. A contradiction
      // MARKS a finding; it is never dismissed by a model.
      const fileText = new Map<string, string>(
        input.kind === 'diff'
          ? input.files.map((f) => [f.path, stripPatchPrefix(f.patch ?? '')])
          : input.kind === 'module'
            ? input.files.map((f) => [f.path, f.content])
            : [],
      );
      const verify = await verifyStep({
        deps,
        wg,
        run,
        workspaceId,
        runId,
        callsSoFar: spec.calls + triage.calls,
        maxCalls,
        findings: spec.findings,
        fileText,
      });

      const planned = spec.plan.waves.flatMap((w) => w.specialists.map((s) => s.specialist.id));
      const summary = {
        waves: spec.plan.waves.map((w) => ({
          wave: w.wave,
          specialists: w.specialists.map((s) => ({ id: s.specialist.id, reason: s.reason })),
        })),
        skipped: spec.plan.skipped,
        counts: spec.plan.counts,
      };
      const nothingRelevant = planned.length === 0 && triage.skipped !== null;
      // W25-07: the reason a repository pass with no changed file asked the model nothing.
      const noChange =
        nothingRelevant && pathsIncremental && pathsIncremental.changed.length === 0
          ? (() => {
              const at = pathsIncremental.sinceSha.slice(0, 8);
              const gone = pathsIncremental.removed.length;
              const closed = carried?.closed ?? 0;
              return gone > 0
                ? `No file under these paths changed since the pass at ${at}, so the model was not asked again. ${gone} ${gone === 1 ? 'file it read is' : 'files it read are'} gone, and ${closed} ${closed === 1 ? 'finding' : 'findings'} in them closed.`
                : `None of the ${pathsIncremental.unchanged.length} files under these paths changed since the pass at ${at}, so the model was not asked again. Its findings still stand.`;
            })()
          : null;
      // W20-06 (UX_TODO AI-59): a pass where every specialist that ran gave only
      // unusable answers (malformed JSON twice, common with local models) and
      // triage reviewed nothing has reviewed NOTHING. Recorded as failed, with
      // the reason, so it can never read as "✓ finished, no findings".
      const ran = planned.filter((id) => !spec.droppedForBudget.includes(id));
      const failedIds = new Set(spec.failures.map((f) => f.specialist));
      const allSpecialistsFailed =
        ran.length > 0 &&
        ran.every((id) => failedIds.has(id) && (spec.usage[id]?.findings ?? 0) === 0);
      const triageReviewed = ((triage.funnel as { triaged?: number } | null)?.triaged ?? 0) > 0;
      const unusable = allSpecialistsFailed && !triageReviewed;
      return finish(nothingRelevant ? 'skipped' : unusable ? 'failed' : 'succeeded', {
        plan: summary,
        specialists: {
          usage: spec.usage,
          droppedForBudget: spec.droppedForBudget,
          failures: spec.failures,
          rejected: spec.rejected.length,
          filesRead,
          ...(filesSkipped ? { filesSkipped } : {}),
          ...(unreadable.length > 0 ? { unreadable } : {}),
          verify: verify.summary,
          ...(incremental && carried
            ? {
                incremental: {
                  sinceSha: incremental.sinceSha,
                  baseRunId: incremental.baseRunId,
                  filesChanged: incremental.changed.length,
                  filesInPullRequest: fullDiff.length,
                  carriedForward: carried.carried,
                  closed: carried.closed,
                },
              }
            : {}),
          ...(pathsIncremental && carried
            ? {
                incremental: {
                  sinceSha: pathsIncremental.sinceSha,
                  baseRunId: pathsIncremental.baseRunId,
                  chain: pathsIncremental.chain,
                  filesChanged: pathsIncremental.changed.length,
                  filesUnchanged: pathsIncremental.unchanged.length,
                  filesRemoved: pathsIncremental.removed.length,
                  carriedForward: carried.carried,
                  closed: carried.closed,
                },
              }
            : {}),
        },
        triageFunnel: triage.funnel as unknown as Record<string, unknown> | null,
        triageSkipped: triage.skipped,
        calls: spec.calls + triage.calls + verify.calls,
        analysisRunIds,
        ...(noChange
          ? { reasonCode: 'no_change', reason: noChange }
          : nothingRelevant
            ? {
                reasonCode: 'nothing_relevant',
                reason: 'Nothing in scope needed a specialist, and there was nothing to triage.',
              }
            : unusable
              ? {
                  reasonCode: 'specialists_unusable',
                  reason:
                    'No specialist gave a usable answer (each answer was malformed even after a retry, or the model did not finish in time), so this pass reviewed nothing. Try a model that follows JSON instructions more reliably, or a narrower scope.',
                }
              : {}),
      });
    } catch (err) {
      // A local-only refusal arrives here with its sentence (role and connection).
      return fail('error', safeErrorText(err), progress);
    }
  }
}

/**
 * W23-07: full or incremental. Looks for the latest FINISHED review of this pull
 * request; the cheap checks (no prior, different prompt version, same head,
 * `force`) decide without a forge call. Any failure to compare is a full review.
 */
async function decideReviewScope(a: {
  deps: AiPassDeps;
  run: typeof read.aiPassRuns.$inferSelect;
  workspaceId: number;
  headSha: string;
  prFiles: string[];
  force: boolean;
}): Promise<ReviewScopePlan> {
  const { db } = a.deps;
  const [row] = await db
    .select()
    .from(read.aiPassRuns)
    .where(
      and(
        eq(read.aiPassRuns.workspaceId, a.workspaceId),
        eq(read.aiPassRuns.repoId, a.run.repoId),
        eq(read.aiPassRuns.mode, 'pull_request'),
        eq(read.aiPassRuns.prNumber, a.run.prNumber as number),
        eq(read.aiPassRuns.status, 'succeeded'),
        sql`${read.aiPassRuns.id} < ${a.run.id}`,
        isNotNull(read.aiPassRuns.commitSha),
      ),
    )
    .orderBy(desc(read.aiPassRuns.id))
    .limit(1);
  const specialists = (row?.specialists ?? {}) as {
    droppedForBudget?: unknown[];
    failures?: unknown[];
    unreadable?: unknown[];
  };
  const prior = row
    ? {
        runId: row.id,
        headSha: row.commitSha as string,
        promptVersion: row.promptVersion,
        completeAndClean:
          (specialists.droppedForBudget ?? []).length === 0 &&
          (specialists.failures ?? []).length === 0 &&
          (specialists.unreadable ?? []).length === 0,
      }
    : null;
  const promptVersion = reviewPromptVersion();
  const args = { prior, newHeadSha: a.headSha, promptVersion, force: a.force };
  const comparison =
    needsCompare(args) === 'compare' && a.deps.compareHeads && prior
      ? await a.deps.compareHeads({
          workspaceId: a.workspaceId,
          repoId: a.run.repoId,
          base: prior.headSha,
          head: a.headSha,
        })
      : null;
  return planReviewScope({ ...args, comparison, prFiles: a.prFiles });
}

/**
 * W25-07: full or incremental for a repository pass. The base is the latest
 * SUCCEEDED pass over exactly the same paths that read a head (a skipped
 * "nothing changed" row is not a base: it reviewed nothing). Its stored file
 * hashes say which files the model already answered for.
 */
async function decidePathsScope(a: {
  deps: AiPassDeps;
  run: typeof read.aiPassRuns.$inferSelect;
  workspaceId: number;
  files: { path: string; hash: string }[];
  force: boolean;
}): Promise<PathsScopePlan> {
  const rows = await a.deps.db
    .select()
    .from(read.aiPassRuns)
    .where(
      and(
        eq(read.aiPassRuns.workspaceId, a.workspaceId),
        eq(read.aiPassRuns.repoId, a.run.repoId),
        eq(read.aiPassRuns.mode, 'paths'),
        eq(read.aiPassRuns.status, 'succeeded'),
        sql`${read.aiPassRuns.id} < ${a.run.id}`,
        isNotNull(read.aiPassRuns.commitSha),
      ),
    )
    .orderBy(desc(read.aiPassRuns.id))
    .limit(20);
  const key = (paths: readonly string[]) => JSON.stringify([...paths].sort());
  const row = rows.find(
    (r) => r.workspaceId === a.workspaceId && key(r.paths) === key(a.run.paths),
  );
  const specialists = (row?.specialists ?? {}) as {
    droppedForBudget?: unknown[];
    failures?: unknown[];
    unreadable?: unknown[];
    incremental?: { chain?: number };
  };
  const prior = row
    ? {
        runId: row.id,
        commitSha: row.commitSha as string,
        promptVersion: row.promptVersion,
        fileHashes: row.fileHashes ?? null,
        completeAndClean:
          (specialists.droppedForBudget ?? []).length === 0 &&
          (specialists.failures ?? []).length === 0 &&
          (specialists.unreadable ?? []).length === 0,
        chain: row.scope === 'incremental' ? (specialists.incremental?.chain ?? 1) : 0,
      }
    : null;
  return planPathsScope({
    prior,
    promptVersion: reviewPromptVersion(),
    files: a.files,
    force: a.force,
  });
}

type SpecialistFinding = Awaited<ReturnType<typeof runSpecialists>>['findings'][number];

/** What the verify step did, on the pass row (specialists.verify). */
export interface PassVerifySummary {
  asked: number;
  confirmed: number;
  contradicted: number;
  /** Findings at or above the floor that got no second opinion, and the first reason why. */
  unverified: number;
  reason: string | null;
}

async function verifyStep(a: {
  deps: AiPassDeps;
  wg: { gateway: AnalysisGateway; hosts: T2Host[] };
  run: typeof read.aiPassRuns.$inferSelect;
  workspaceId: number;
  runId: number;
  callsSoFar: number;
  maxCalls: number;
  findings: readonly SpecialistFinding[];
  fileText: ReadonlyMap<string, string>;
}): Promise<{ summary: PassVerifySummary | null; calls: number }> {
  const due = a.findings.filter((f) => needsVerification(f.severity));
  if (!a.deps.verifierFor || due.length === 0) return { summary: null, calls: 0 };
  const summary: PassVerifySummary = {
    asked: 0,
    confirmed: 0,
    contradicted: 0,
    unverified: 0,
    reason: null,
  };
  const remaining = Math.max(0, a.maxCalls - a.callsSoFar);
  const verifier = a.deps.verifierFor({
    workspaceId: a.workspaceId,
    repoId: a.run.repoId,
    hosts: a.wg.hosts,
    maxCalls: remaining,
    wrap: (g) =>
      trackPassGateway(g, a.deps.db, { workspaceId: a.workspaceId, runId: a.runId }, a.callsSoFar),
  });
  const verdicts: { dedupKey: string; verify: FindingVerify }[] = [];
  for (const f of due) {
    const evidenceQuote = stripPatchPrefix(f.evidence_quote);
    const lineStart = Math.max(1, f.line_range[0]);
    const before = verifier.calls();
    const v = findingVerdict(
      await verifier.verify({
        title: f.title,
        evidenceQuote,
        file: f.file,
        severity: f.severity,
        dimension: f.dimension,
        rationale: f.rationale,
        excerpt: excerptAround(a.fileText.get(f.file) ?? evidenceQuote, {
          quote: evidenceQuote,
          line: lineStart,
        }),
        finder: { providerId: f.route?.providerId ?? null, model: f.model ?? null },
      }),
    );
    if (verifier.calls() > before) summary.asked += 1;
    if (v.status === 'confirmed') summary.confirmed += 1;
    else if (v.status === 'contradicted') summary.contradicted += 1;
    else {
      summary.unverified += 1;
      summary.reason ??= v.reason;
    }
    verdicts.push({
      dedupKey: dedupKey({
        dimension: f.dimension,
        file: f.file,
        evidenceQuote,
        lineStart,
        scannerKey: null,
        ruleId: null,
      }),
      verify: v,
    });
  }
  await recordVerdicts(a.deps.db, {
    workspaceId: a.workspaceId,
    repoId: a.run.repoId,
    verdicts,
  });
  return { summary, calls: verifier.calls() };
}

/** Why a first look's triage step did not run (W27-04). */
export const FIRST_LOOK_TRIAGE_SKIPPED =
  'A first look reviews code only; rule hits from the scan are left to the AI judge.';

/**
 * Calls held back from the specialists for triage: none on a first look
 * (W27-04, it triages nothing), otherwise a third of the cap, at most what
 * triage can use.
 */
export function triageReserveFor(run: { mode: string; trigger: string }, maxCalls: number): number {
  if (isFirstLook(run)) return 0;
  return Math.min(TRIAGE_TOP_N * 2, Math.floor(maxCalls / 3));
}

/** True when a judge run for the repository is waiting or running. Workspace-filtered (Law 5). */
async function activeJudgeRun(db: Database, workspaceId: number, repoId: number): Promise<boolean> {
  const [row] = await db
    .select({ id: read.aiPassRuns.id })
    .from(read.aiPassRuns)
    .where(
      and(
        eq(read.aiPassRuns.workspaceId, workspaceId),
        eq(read.aiPassRuns.repoId, repoId),
        eq(read.aiPassRuns.mode, 'judge'),
        inArray(read.aiPassRuns.status, ['pending', 'running']),
      ),
    )
    .limit(1);
  return row !== undefined;
}

async function triageStep(a: {
  deps: AiPassDeps;
  wg: { gateway: AnalysisGateway; hosts: T2Host[]; routing?: RoutingPolicy };
  run: typeof read.aiPassRuns.$inferSelect;
  workspaceId: number;
  runId: number;
  callsSoFar: number;
  maxCalls: number;
  now: () => Date;
  /** Diff modes: the lines the change adds, per file; triage is limited to findings on them. */
  diffRanges: Map<string, [number, number][]> | null;
}): Promise<{ funnel: object | null; skipped: string | null; calls: number }> {
  const { db } = a.deps;
  // W27-04: rule hits after a scan belong to the AI judge. A first look asking
  // the same hit at the same time would only race it and throw one answer away.
  if (isFirstLook(a.run)) {
    return { funnel: null, skipped: FIRST_LOOK_TRIAGE_SKIPPED, calls: 0 };
  }
  const remaining = a.maxCalls - a.callsSoFar;
  if (remaining < 1) {
    return {
      funnel: null,
      skipped: 'The call cap was used up by the specialists, so triage did not run.',
      calls: 0,
    };
  }

  // Rule-raised, open, with the stored code context (no forge call), in scope,
  // and not already carrying a suggestion - one suggestion per finding, and a
  // person's decision is never re-asked.
  const rows = await db
    .select()
    .from(read.findings)
    .where(
      and(
        eq(read.findings.workspaceId, a.workspaceId),
        eq(read.findings.repoId, a.run.repoId),
        eq(read.findings.status, 'open'),
        eq(read.findings.experimental, false),
        isNotNull(read.findings.scannerKey),
        isNotNull(read.findings.ruleId),
        isNotNull(read.findings.file),
        isNotNull(read.findings.lineStart),
        isNotNull(read.findings.contextLines),
        sql`not exists (select 1 from ai_triage_verdicts v where v.finding_id = ${read.findings.id} and v.workspace_id = ${a.workspaceId})`,
      ),
    )
    .orderBy(desc(read.findings.effectiveRisk))
    .limit(200);
  // W27-04: a judge run waiting or running for this repository takes every open
  // judged-dimension hit without a verdict when it starts, so those are left to it.
  const judgeActive = await activeJudgeRun(db, a.workspaceId, a.run.repoId);
  const judged = new Set<string>(JUDGE_DIMENSIONS);
  const ranges = a.diffRanges;
  const scoped = rows.filter((r) => {
    if (r.file === null) return false;
    // W25-16 / W27-04: no model time on rule hits in test code.
    if (isTestPath(r.file)) return false;
    if (judgeActive && judged.has(r.dimension)) return false;
    // Diff modes: only a finding on lines the change adds or alters.
    if (ranges) {
      const mine = ranges.get(r.file);
      return mine !== undefined && overlaps(mine, r.lineStart!, r.lineEnd ?? r.lineStart!);
    }
    return inScope(r.file, a.run.paths);
  });
  if (scoped.length === 0) {
    return {
      funnel: null,
      skipped: ranges
        ? 'No open rule-raised finding sits on lines this change adds or alters (with stored code context and no earlier suggestion), so there was nothing to triage.'
        : 'No open rule-raised finding in scope has stored code context and no earlier suggestion, so there was nothing to triage.',
      calls: 0,
    };
  }

  const byKey = new Map(scoped.map((r) => [r.dedupKey, r]));
  const candidates: TriageCandidate[] = scoped.map(triageCandidateOf);

  const result = await runTriage(candidates, {
    gateway: a.wg.gateway,
    contextWindow: contextWindowForRole(a.wg.routing, 'triage', a.wg.hosts),
    limit: TRIAGE_TOP_N,
    maxCalls: remaining,
    meta: { repoId: String(a.run.repoId), prNumber: 0, initiator: 'ai-pass' },
  });

  for (const p of result.proposals) {
    const row = byKey.get(p.dedupKey);
    if (!row) continue;
    await db
      .insert(read.aiTriageVerdicts)
      .values({
        workspaceId: a.workspaceId,
        findingId: row.id,
        aiPassRunId: a.runId,
        verdict: p.verdict,
        confidence: p.confidence,
        model: p.model,
        checklistVersion: p.checklistVersion,
        rationale: p.rationale,
        citations: p.citations,
        vexJustification: p.vex?.justification ?? null,
        vexStatement: p.vex?.statement ?? null,
        impact: p.impact ?? null,
        impactReason: p.impactReason ?? null,
        // Only a patch that a re-scan proved is ever stored.
        patchDiff: p.patch?.status === 'verified' ? p.patch.diff : null,
        patchStatus: p.patch?.status ?? 'not_attempted',
        patchReason: p.patch?.reason ?? null,
        route: p.route as Record<string, unknown> | null,
        // W20-25 (UX_TODO X-10): which connection answered, as columns.
        ...verifierColumns(p.route),
      })
      .onConflictDoNothing();
  }
  return { funnel: result.funnel, skipped: null, calls: result.calls };
}

/**
 * W22-03: a judge run - the open rule hits after a scan, judged one at a time
 * within the workspace's budget (ai-judge.ts). Same gateway, cancel check and
 * call counter as a pass; never changes a finding's status.
 */
async function judgeStep(a: {
  deps: AiPassDeps;
  run: typeof read.aiPassRuns.$inferSelect;
  workspaceId: number;
  runId: number;
  now: () => Date;
  fail: (code: string, reason: string) => Promise<AiPassResult>;
  finish: (
    status: 'succeeded' | 'failed' | 'skipped',
    patch?: Partial<typeof read.aiPassRuns.$inferInsert>,
  ) => Promise<AiPassResult>;
}): Promise<AiPassResult> {
  const { deps, run, workspaceId, runId } = a;
  const built = await (deps.judge?.gatewayFor ?? deps.gatewayFor)(workspaceId);
  if (!built) {
    return a.fail(
      'no_gateway',
      'No model is configured for this workspace, so no rule hit was judged. Add one in Settings → Models.',
    );
  }
  const wg = {
    ...built,
    gateway: trackPassGateway(built.gateway, deps.db, { workspaceId, runId }),
  };
  const fixes = deps.judge?.fixes;
  const fixesOn = fixes !== undefined && fixes.config.enabled && fixes.config.top > 0;
  const judged = await runJudge({
    db: deps.db,
    run,
    workspaceId,
    runId,
    wg,
    config: deps.judge?.config ?? judgeConfigFromEnv(process.env),
    now: a.now,
    ...(deps.judge?.egress ? { egress: deps.judge.egress } : {}),
    ...(fixesOn
      ? {
          fixReserve: {
            share: FIX_RESERVE_SHARE,
            pending:
              (await pickFixTargets(deps.db, workspaceId, run.repoId, 1, a.now())).targets.length >
              0,
          },
        }
      : {}),
  });

  // W22-09: then verified fixes for the top confirmed findings, with what the
  // run has left (its deadline and calls), through the same tracked gateway.
  let status = judged.status;
  let patch = judged.patch;
  if (fixes !== undefined && judged.budget) {
    const drafted = await runFixes({
      db: deps.db,
      workspaceId,
      repoId: run.repoId,
      runBudget: judged.budget.kind,
      gateway: wg.gateway,
      deps: fixes,
      deadlineMs: judged.budget.deadlineMs,
      callsLeft: judged.budget.callsLeft,
      now: a.now,
    });
    patch = withFixes(patch, drafted.summary, drafted.calls);
    // Nothing to judge, but fixes were drafted: the run did something.
    if (status === 'skipped' && drafted.summary.attempts.length > 0) {
      status = 'succeeded';
      patch = { ...patch, reasonCode: null, reason: null };
    }
  } else if (fixes !== undefined) {
    patch = withFixes(
      patch,
      emptyFixSummary(fixes.config.top, judged.patch.reasonCode ?? 'judge_stopped'),
      0,
    );
  }
  const result = await a.finish(status, patch);
  if (judged.verdicts > 0) {
    await deps.judge
      ?.afterVerdicts?.({ workspaceId, repoId: run.repoId, runId })
      .catch(() => undefined);
  }
  return result;
}

/** The run's row with the drafting step's summary (plan.fixes) and calls added. */
function withFixes(
  patch: Partial<typeof read.aiPassRuns.$inferInsert>,
  summary: FixSummary,
  calls: number,
): Partial<typeof read.aiPassRuns.$inferInsert> {
  const plan = (patch.plan ?? {}) as Record<string, unknown>;
  return {
    ...patch,
    plan: { ...plan, fixes: summary },
    calls: (patch.calls ?? 0) + calls,
  };
}

/**
 * The connection behind a triage answer (W20-25, UX_TODO X-10), from the route
 * the gateway recorded: its id while it exists, and its name kept beside it.
 */
export function verifierColumns(route: unknown): {
  llmProviderId: number | null;
  connectionName: string | null;
} {
  const r = (route ?? {}) as { providerId?: unknown; providerName?: unknown };
  return {
    llmProviderId:
      typeof r.providerId === 'number' && Number.isInteger(r.providerId) ? r.providerId : null,
    connectionName:
      typeof r.providerName === 'string' && r.providerName !== ''
        ? r.providerName.slice(0, 200)
        : null,
  };
}

/** A rule-raised finding with stored context, as triage reads it. */
export function triageCandidateOf(r: typeof read.findings.$inferSelect): TriageCandidate {
  return {
    finding: {
      dedupKey: r.dedupKey,
      scannerKey: r.scannerKey!,
      ruleId: r.ruleId!,
      title: r.title,
      dimension: r.dimension,
      file: r.file!,
      lineStart: r.lineStart!,
      lineEnd: r.lineEnd ?? r.lineStart!,
      evidenceQuote: r.evidence,
    },
    // Only dependency findings carry a reachability tier; for a rule-raised code
    // finding it is "not computed" and the prompt says so.
    reachability: { tier: null },
    source: r.contextLines!,
    sourceStartLine: r.contextStartLine ?? 1,
    // W22-02: the evidence captured at scan time; null (old rows, unknown
    // shape) leaves the judge with the stored lines alone, as before.
    packet: parseContextPacket(r.contextPacket),
    effectiveRisk: Number(r.effectiveRisk ?? 0),
  };
}

/** What POST .../second-opinion stored on the run's plan. */
interface SecondOpinionPlan {
  verdict_id: number;
  finding_id: number;
  provider_id: number;
  model: string;
}

/** Model calls one second opinion may make: one answer and one corrective retry. */
const SECOND_OPINION_CALLS = 2;

/**
 * A SECOND OPINION (W20-18, UX_TODO AI-14): the same evidence-fed triage of one
 * finding, asked of the connection and model the person chose, stored beside
 * the suggestion it checks. Where it may go is checked AGAIN here, at the moment
 * code would be sent: a connection off the network needs the repository's
 * Tier-3 opt-in and local-only off (decision 2026-10-20). The gateway writes the
 * egress audit row for any call that leaves the network.
 */
async function secondOpinionStep(a: {
  deps: AiPassDeps;
  run: typeof read.aiPassRuns.$inferSelect;
  workspaceId: number;
  runId: number;
  maxCalls: number;
  fail: (
    code: string,
    reason: string,
    extra?: Partial<typeof read.aiPassRuns.$inferInsert>,
  ) => Promise<AiPassResult>;
  finish: (
    status: 'succeeded' | 'failed' | 'skipped',
    patch?: Partial<typeof read.aiPassRuns.$inferInsert>,
  ) => Promise<AiPassResult>;
}): Promise<AiPassResult> {
  const { db } = a.deps;
  const plan = (a.run.plan as { second_opinion?: SecondOpinionPlan } | null)?.second_opinion;
  if (!plan || !a.deps.secondOpinionGatewayFor) {
    return a.fail('no_second_opinion', 'Second opinions are not available on this server.');
  }

  const [row] = await db
    .select({ v: read.aiTriageVerdicts, f: read.findings })
    .from(read.aiTriageVerdicts)
    .innerJoin(read.findings, eq(read.findings.id, read.aiTriageVerdicts.findingId))
    .where(
      and(
        eq(read.aiTriageVerdicts.id, plan.verdict_id),
        eq(read.aiTriageVerdicts.findingId, plan.finding_id),
        eq(read.aiTriageVerdicts.workspaceId, a.workspaceId),
        eq(read.findings.workspaceId, a.workspaceId),
        eq(read.findings.repoId, a.run.repoId),
      ),
    )
    .limit(1);
  if (!row) return a.fail('not_found', 'The suggestion or its finding no longer exists.');
  const f = row.f;
  if (!f.scannerKey || !f.ruleId || !f.file || f.lineStart === null || !f.contextLines) {
    return a.fail(
      'no_context',
      'The finding no longer has the stored lines of code a second opinion reads.',
    );
  }

  // Where the code would go, decided from the server's own facts, now.
  const provider = (await providersFor(db, a.workspaceId)).find(
    (p) => p.id === plan.provider_id && p.enabled,
  );
  if (!provider) {
    return a.fail(
      'no_connection',
      'The chosen model connection was removed or switched off before the second opinion ran.',
    );
  }
  if (describeEndpoint(provider.kind, provider.baseUrl).leavesNetwork) {
    const { localOnly } = await loadStoredRouting(db, a.workspaceId);
    if (localOnly) {
      return a.fail(
        'local_only_forbids',
        'Local-only is on, and the chosen model is off your network. Nothing was sent.',
      );
    }
    const [repo] = await db
      .select({ optIn: core.repos.tier3OptIn })
      .from(core.repos)
      .where(and(eq(core.repos.id, a.run.repoId), eq(core.repos.workspaceId, a.workspaceId)))
      .limit(1);
    if (!repo?.optIn) {
      return a.fail(
        'tier3_not_opted_in',
        'The chosen model is off your network, and this repository is not opted in to Tier 3. Nothing was sent.',
      );
    }
  }

  const wg = await a.deps.secondOpinionGatewayFor(a.workspaceId, {
    providerId: plan.provider_id,
    model: plan.model,
  });
  if (!wg) {
    return a.fail(
      'no_connection',
      'The chosen model connection could not be used (it did not resolve). See Settings → Models.',
    );
  }

  const result = await runTriage([triageCandidateOf(f)], {
    gateway: wg.gateway,
    contextWindow: wg.hosts[0]?.contextWindow ?? null,
    limit: 1,
    maxCalls: Math.min(a.maxCalls, SECOND_OPINION_CALLS),
    meta: { repoId: String(a.run.repoId), prNumber: 0, initiator: 'ai-second-opinion' },
  });
  const funnel = result.funnel as unknown as Record<string, unknown>;
  const p = result.proposals[0];
  if (!p) {
    const why = result.rejections[0];
    return a.fail(
      'no_answer',
      `${plan.model} gave no usable answer${why ? ` (${why.reason}: ${why.detail})` : ''}.`,
      { calls: result.calls, triageFunnel: funnel },
    );
  }
  await db
    .insert(read.aiTriageVerdicts)
    .values({
      workspaceId: a.workspaceId,
      findingId: f.id,
      aiPassRunId: a.runId,
      secondOpinionOf: row.v.id,
      verdict: p.verdict,
      confidence: p.confidence,
      model: p.model,
      checklistVersion: p.checklistVersion,
      rationale: p.rationale,
      citations: p.citations,
      vexJustification: p.vex?.justification ?? null,
      vexStatement: p.vex?.statement ?? null,
      // No patch proof runs for a second opinion: it is a verdict, not a fix.
      patchStatus: 'not_attempted',
      route: p.route as Record<string, unknown> | null,
      ...verifierColumns(p.route),
    })
    .onConflictDoNothing();
  return a.finish('succeeded', { calls: result.calls, triageFunnel: funnel });
}
