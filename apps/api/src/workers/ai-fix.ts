import { and, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { AnalysisGateway } from '@repopulse/analysis';
import type { ForgeProvider } from '@repopulse/forge';
import {
  isRerunnable,
  resolvePatchTarget,
  runPatchDraft,
  type PatchDraftDeps,
  type PatchDraftResult,
} from '@repopulse/security';
import { read, safeErrorText, type Database } from '@repopulse/shared';
import { passEgress, PASS_ROLES } from '../lib/ai-pass-egress.js';
import { isAiPaused } from '../lib/ai-pause.js';
import type { EgressOf } from './ai-judge.js';

// W22-09: verified fixes ready by default for the top confirmed findings
// (CLOSE_THE_LOOP.md, "The loop": confirmed -> verified fix drafted -> rescan
// proves it).
//
// WHEN. In the same ai_pass_runs row as the judge (mode 'judge'), right after
// judging: the run's wall clock is what the judge's daily minutes measure, so
// drafting spends from the SAME budget with no second ledger. While a fix could
// be drafted, the judge leaves FIX_RESERVE_SHARE of the run's minutes for it.
//
// WHAT. The riskiest open findings whose verify_status is `confirmed` and whose
// rule can be re-run on a patched file (target.ts isRerunnable), with no answer
// yet at the snapshot a patch would apply to: at most `top` drafts a run. Each
// is the existing W18-19 job (run.ts): the model drafts a diff, it is applied
// to the file at the scanned commit, the rules re-run, and the row is
// `verified` only when the finding clears and nothing new fires. A `rejected`
// row keeps its reason for an admin and is never shown as a fix; only verified
// rows are listed as ready to apply (GET /patches/ready).
//
// WHO MAY DRAFT (the judge's rules, applied to the `patch` role):
//   - every model the patch role routes to is local: on by default;
//   - a hosted link: only inside a judge run that is itself on the hosted
//     opt-in (budget 'calls': the repository's AI-pass schedule acknowledged
//     the current routing), when every patch destination is one that
//     acknowledgement named, and within the run's calls;
//   - AI off stops it (checked again before each draft); AI_JUDGE=off, which
//     stops the judge runs, stops it too.
//
// NEVER. Nothing is written to the forge: no branch, commit, pull request or
// comment (D9a, run.ts). A timeout or provider error on one draft is recorded
// on its row and on the run, and the loop goes on.

/** Server defaults: drafts per run, and the share of a run kept for drafting. */
export const FIX_DEFAULT_TOP = 5;
export const FIX_RESERVE_SHARE = 1 / 3;
/** Confirmed findings read per run (risk order) to find `top` that need a draft. */
export const FIX_MAX_CANDIDATES = 50;
/** Consecutive drafts that could not be made after which drafting stops for the run. */
export const FIX_MAX_CONSECUTIVE_FAILURES = 3;
/** A draft that could not be made (model down, forge down) is retried after this. */
const RETRY_FAILED_AFTER_MS = 24 * 60 * 60 * 1000;
const INITIATOR = 'ai-fix';

export interface FixConfig {
  enabled: boolean;
  /** Most drafts one run makes. */
  top: number;
}

/**
 * The server's drafting config: on with the judge (AI_JUDGE=off removes both),
 * FIX_DEFAULT_TOP drafts a run. No knob of its own: the judge's minutes bound it.
 */
export function fixConfigFor(judge: { enabled: boolean }): FixConfig {
  return { enabled: judge.enabled, top: FIX_DEFAULT_TOP };
}

export type FixEligibility =
  { ok: true; hosted: boolean } | { ok: false; code: string; reason: string };

/**
 * May fixes be drafted in this run? Decided from the server's own egress facts
 * for the `patch` role, and the budget kind the judge run already holds.
 */
export async function fixEligibility(a: {
  db: Database;
  workspaceId: number;
  config: FixConfig;
  runBudget: 'time' | 'calls';
  egress?: EgressOf;
}): Promise<FixEligibility> {
  const { db, workspaceId: ws } = a;
  const egressOf = a.egress ?? passEgress;
  if (!a.config.enabled || a.config.top < 1) {
    return { ok: false, code: 'disabled', reason: 'Fix drafting is switched off on this server.' };
  }
  if (await isAiPaused(db, ws)) {
    return {
      ok: false,
      code: 'ai_paused',
      reason: 'AI analysis is switched off for this workspace, so no fix was drafted.',
    };
  }
  const patch = await egressOf(db, ws, ['patch']);
  if (patch.destinations.length === 0) {
    return { ok: false, code: 'no_gateway', reason: patch.sentence };
  }
  if (!patch.leaves_network) return { ok: true, hosted: false };

  if (patch.local_only) {
    return {
      ok: false,
      code: 'local_only_forbids',
      reason:
        'Local-only is on, but the fix route includes a model off your network. Nothing was sent.',
    };
  }
  if (a.runBudget !== 'calls') {
    return {
      ok: false,
      code: 'patch_route_hosted',
      reason:
        'Fixes are drafted by a model off your network, so they are drafted automatically only for a repository an admin opted in to scheduled AI passes. A person can still ask for a fix on the finding.',
    };
  }
  // The run's opt-in acknowledged where the PASS roles send source; the patch
  // role sends a file too, so each of its destinations must be one of those.
  const acknowledged = new Set(
    (await egressOf(db, ws, PASS_ROLES)).destinations.map((d) => d.provider_id),
  );
  const unacknowledged = patch.destinations.filter((d) => !acknowledged.has(d.provider_id));
  if (unacknowledged.length > 0) {
    return {
      ok: false,
      code: 'patch_route_unacknowledged',
      reason: `The fix route sends source to ${unacknowledged.map((d) => d.provider_name).join(', ')}, which the AI-pass acknowledgement does not name, so no fix was drafted automatically.`,
    };
  }
  return { ok: true, hosted: true };
}

export interface FixTarget {
  findingId: number;
  commitSha: string;
  dedupKey: string;
  repoId: number;
  /** An earlier attempt that could not be made, retried now. */
  retryPatchId: number | null;
}

/**
 * The confirmed findings that need a draft, riskiest first, at most `top`.
 * A finding with any answer at its snapshot (pending, verified, rejected, or
 * failed within a day) is passed over: a rejected draft is a verdict, and only
 * a person's Try again asks the model again. Workspace- and repository-
 * filtered (Law 5).
 */
export async function pickFixTargets(
  db: Database,
  workspaceId: number,
  repoId: number,
  top: number,
  now: Date,
): Promise<{ targets: FixTarget[]; confirmed: number }> {
  if (top < 1) return { targets: [], confirmed: 0 };
  const rows = await db
    .select({
      id: read.findings.id,
      scannerKey: read.findings.scannerKey,
      ruleId: read.findings.ruleId,
    })
    .from(read.findings)
    .where(
      and(
        eq(read.findings.workspaceId, workspaceId),
        eq(read.findings.repoId, repoId),
        inArray(read.findings.status, ['open', 'confirmed']),
        eq(read.findings.experimental, false),
        eq(read.findings.verifyStatus, 'confirmed'),
        isNotNull(read.findings.file),
        isNotNull(read.findings.scannerKey),
        isNotNull(read.findings.ruleId),
      ),
    )
    .orderBy(sql`${read.findings.effectiveRisk} desc nulls last`, read.findings.id)
    .limit(FIX_MAX_CANDIDATES);
  const rerunnable = rows.filter((r) => isRerunnable(r.scannerKey, r.ruleId));

  const targets: FixTarget[] = [];
  for (const r of rerunnable) {
    if (targets.length >= top) break;
    const t = await resolvePatchTarget(db, workspaceId, r.id);
    if (!t.ok) continue;
    const [existing] = await db
      .select({
        id: read.verifiedPatches.id,
        status: read.verifiedPatches.status,
        finishedAt: read.verifiedPatches.finishedAt,
      })
      .from(read.verifiedPatches)
      .where(
        and(
          eq(read.verifiedPatches.workspaceId, workspaceId),
          eq(read.verifiedPatches.findingId, r.id),
          eq(read.verifiedPatches.commitSha, t.commitSha),
        ),
      )
      .limit(1);
    if (existing) {
      const stale =
        existing.status === 'failed' &&
        (existing.finishedAt === null ||
          now.getTime() - existing.finishedAt.getTime() >= RETRY_FAILED_AFTER_MS);
      if (!stale) continue;
    }
    targets.push({
      findingId: r.id,
      commitSha: t.commitSha,
      dedupKey: t.dedupKey,
      repoId: t.repoId,
      retryPatchId: existing?.id ?? null,
    });
  }
  return { targets, confirmed: rerunnable.length };
}

/** What the drafting step did, stored on the judge run's row (plan.fixes). */
export interface FixSummary {
  /** Why nothing was drafted, when it was not allowed (the eligibility code). */
  skipped: string | null;
  top: number;
  /** Confirmed findings with a re-runnable rule that were looked at. */
  confirmed: number;
  /** Picked for a draft this run. */
  targets: number;
  drafted: number;
  verified: number;
  /** Drafted, and the rescan said no: recorded with its reason, never shown as a fix. */
  rejected: number;
  /** The attempt could not be made (timeout, provider error, forge down). */
  failed: number;
  attempts: { finding_id: number; patch_id: number; status: string; code: string }[];
  not_reached: number;
  stopped: 'done' | 'time_budget' | 'call_cap' | 'errors' | 'ai_paused' | 'skipped';
  elapsed_ms: number;
}

export function emptyFixSummary(top: number, skipped: string | null = null): FixSummary {
  return {
    skipped,
    top,
    confirmed: 0,
    targets: 0,
    drafted: 0,
    verified: 0,
    rejected: 0,
    failed: 0,
    attempts: [],
    not_reached: 0,
    stopped: skipped ? 'skipped' : 'done',
    elapsed_ms: 0,
  };
}

export interface FixDeps {
  config: FixConfig;
  /** The repository's forge (read only, scan lane); null when it has no active connection. */
  forgeFor: (
    workspaceId: number,
    repoId: number,
  ) => Promise<{ provider: ForgeProvider; repoFullName: string } | null>;
  /** Injectable for tests: the W18-19 draft-and-verify job. */
  draft?: (deps: PatchDraftDeps) => Promise<PatchDraftResult>;
  egress?: EgressOf;
}

/**
 * Draft verified fixes for the top confirmed findings, inside a judge run.
 * `gateway` is the run's tracked gateway (cancel check, call counter);
 * `deadlineMs` and `callsLeft` are what the run has left.
 */
export async function runFixes(a: {
  db: Database;
  workspaceId: number;
  repoId: number;
  runBudget: 'time' | 'calls';
  gateway: AnalysisGateway;
  deps: FixDeps;
  deadlineMs: number;
  callsLeft: number;
  now: () => Date;
}): Promise<{ summary: FixSummary; calls: number }> {
  const { db, workspaceId: ws, repoId, deps } = a;
  const started = a.now();
  const ok = await fixEligibility({
    db,
    workspaceId: ws,
    config: deps.config,
    runBudget: a.runBudget,
    ...(deps.egress ? { egress: deps.egress } : {}),
  });
  if (!ok.ok) return { summary: emptyFixSummary(deps.config.top, ok.code), calls: 0 };

  const { targets, confirmed } = await pickFixTargets(db, ws, repoId, deps.config.top, started);
  const summary = emptyFixSummary(deps.config.top);
  summary.confirmed = confirmed;
  summary.targets = targets.length;
  if (targets.length === 0) return { summary, calls: 0 };

  // Count the drafting calls, and notice a cancelled run: run.ts records any
  // thrown error on the patch row, so the cancel has to be seen out here.
  let calls = 0;
  let cancelled: unknown = null;
  const counted: AnalysisGateway = {
    async complete(prompt, opts) {
      calls += 1;
      try {
        return await a.gateway.complete(prompt, opts);
      } catch (err) {
        if (err instanceof Error && err.name === 'PassCancelledError') cancelled = err;
        throw err;
      }
    },
    health: (tier) => a.gateway.health(tier),
  };

  const draft = deps.draft ?? runPatchDraft;
  let consecutiveFailures = 0;
  for (const [i, t] of targets.entries()) {
    if (a.now().getTime() >= a.deadlineMs) {
      summary.stopped = 'time_budget';
      summary.not_reached = targets.length - i;
      break;
    }
    if (calls >= a.callsLeft) {
      summary.stopped = 'call_cap';
      summary.not_reached = targets.length - i;
      break;
    }
    // "AI off stops fix drafts", also when it is switched off mid-run.
    if (await isAiPaused(db, ws)) {
      summary.stopped = 'ai_paused';
      summary.not_reached = targets.length - i;
      break;
    }

    const patchId = await claimPatchRow(db, ws, t, started);
    if (patchId === null) continue; // a person asked for it meanwhile: theirs stands

    let result: PatchDraftResult;
    try {
      const forge = await deps.forgeFor(ws, t.repoId);
      result = await draft({
        db,
        workspaceId: ws,
        patchId,
        gateway: counted,
        forge,
        initiator: INITIATOR,
      });
    } catch (err) {
      if (cancelled) throw cancelled;
      // Anything run.ts did not record itself (a forge connection that will
      // not decrypt, say): recorded on the row, in its own words.
      const reason = safeErrorText(err).slice(0, 2000);
      await db
        .update(read.verifiedPatches)
        .set({ status: 'failed', reasonCode: 'error', reason, finishedAt: a.now() })
        .where(
          and(
            eq(read.verifiedPatches.id, patchId),
            eq(read.verifiedPatches.workspaceId, ws),
            eq(read.verifiedPatches.status, 'pending'),
          ),
        );
      result = { status: 'failed', code: 'error', reason };
    }
    if (cancelled) throw cancelled;

    summary.attempts.push({
      finding_id: t.findingId,
      patch_id: patchId,
      status: result.status,
      code: result.code,
    });
    if (result.status === 'verified' || result.status === 'rejected') {
      summary.drafted += 1;
      summary[result.status] += 1;
      consecutiveFailures = 0;
      continue;
    }
    summary.failed += 1;
    consecutiveFailures += 1;
    if (consecutiveFailures >= FIX_MAX_CONSECUTIVE_FAILURES) {
      summary.stopped = 'errors';
      summary.not_reached = targets.length - i - 1;
      break;
    }
  }
  summary.elapsed_ms = a.now().getTime() - started.getTime();
  return { summary, calls };
}

/**
 * The verified_patches row this draft writes its answer on: a new `pending`
 * row (requested_by null: the after-judge drafting asked), or an earlier
 * attempt that could not be made, reset to `pending`. Null when another
 * request holds the row now.
 */
async function claimPatchRow(
  db: Database,
  workspaceId: number,
  t: FixTarget,
  now: Date,
): Promise<number | null> {
  if (t.retryPatchId !== null) {
    const [reset] = await db
      .update(read.verifiedPatches)
      .set({
        status: 'pending',
        tier: 2,
        reason: null,
        reasonCode: null,
        requestedBy: null,
        createdAt: now,
        finishedAt: null,
      })
      .where(
        and(
          eq(read.verifiedPatches.id, t.retryPatchId),
          eq(read.verifiedPatches.workspaceId, workspaceId),
          eq(read.verifiedPatches.status, 'failed'),
        ),
      )
      .returning({ id: read.verifiedPatches.id });
    return reset?.id ?? null;
  }
  const [row] = await db
    .insert(read.verifiedPatches)
    .values({
      workspaceId,
      repoId: t.repoId,
      findingId: t.findingId,
      commitSha: t.commitSha,
      targetDedupKey: t.dedupKey,
      tier: 2,
      requestedBy: null,
      createdAt: now,
    })
    .onConflictDoNothing()
    .returning({ id: read.verifiedPatches.id });
  return row?.id ?? null;
}
