import { and, desc, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import {
  contextWindowForRole,
  isRoleRouted,
  LocalOnlyViolationError,
  type AnalysisGateway,
  type RoutingPolicy,
  type T2Host,
} from '@repopulse/analysis';
import { recordVerdicts, type FindingVerify } from '@repopulse/insights';
import {
  emptyTriageFunnel,
  isRerunnable,
  packTriageBatch,
  runTriageBatch,
  TRIAGE_BATCH_MAX,
  type TriageFunnel,
  type TriageProposal,
} from '@repopulse/security';
import { isConstraintViolation, read, safeErrorText, type Database } from '@repopulse/shared';
import { passEgress, PASS_ROLES, type PassEgress } from '../lib/ai-pass-egress.js';
import { isAiPaused } from '../lib/ai-pause.js';
import { monthlyCallsUsed, monthlyCap } from './ai-pass-scheduler.js';
import { triageCandidateOf } from './ai-pass-processor.js';
import { fixEligibility, pickFixTargets, type FixConfig } from './ai-fix.js';
import { TEST_PATH_PATTERN } from './code-kind.js';

// W22-03: the AI judges every rule hit after each scan (CLOSE_THE_LOOP.md,
// "The loop"; owner decisions 1 and 2, taken as recommended 2026-10-29).
//
// WHAT IT DOES. When a scan finishes, the worker queues a judge run for the
// repository: the open security (SAST), performance and slop findings a RULE
// raised, with stored code context and no AI verdict yet, ranked by effective
// risk and grouped by rule, are put to the triage checklist until the budget
// is spent: several hits of one rule per call (W22-14, AI_JUDGE_BATCH_SIZE,
// default 4; 1 = one hit per call), each answered, validated and stored on its
// own, and a hit whose part of a batched answer is missing or rejected asked
// again alone in the same run. Each answer is stored as an ai_triage_verdicts
// row (rationale and OUR copy of each cited line) and sets the finding's
// verify_status: real -> confirmed (x1.0), likely_false_positive ->
// contradicted (x0.15), needs_human -> left unverified with the reason.
//
// WHEN IT RUNS (decisions 1 and 2):
//   - ON BY DEFAULT when every model the triage role routes to is on the
//     operator's network: no code leaves it, so there is nothing to
//     acknowledge. Bounded by TIME: wall-clock minutes per workspace over a
//     rolling 24 hours (ai_pass_settings.judge_minutes_per_day, server default
//     AI_JUDGE_MINUTES_PER_DAY), and at most AI_JUDGE_SCAN_MINUTES per run.
//     These calls are not on the monthly call cap.
//   - A HOSTED link in the triage route keeps today's rules: it runs only for a
//     repository an admin opted in to scheduled AI passes, with the egress
//     acknowledgement still matching the routing (W19-12), and its calls go on
//     the monthly call cap (budget 'calls').
//   - AI off (AI-77) stops it; AI_JUDGE=off removes it from the server.
//
// QUICK FIRST LOOK (2026-10-29). When the workspace routes the optional
// `triage_fast` role (a smaller, faster model), each hit goes to it first with
// the same prompt and evidence packet. A likely false positive at or above
// AI_JUDGE_FAST_MIN_CONFIDENCE is stored as the verdict (pass 'fast'); every
// other answer, a rejected answer or a model error goes on to the `triage`
// route, whose answer is the stored one (pass 'full'). Both passes spend the
// same run's minutes and calls. With no triage_fast chain nothing changes.
//
// WHAT IT NEVER DOES. It never dismisses, resolves or suppresses a finding:
// recordVerdicts writes only the verify columns, and the verdict row is a
// suggestion a person answers (D9a). A model timeout or provider error on one
// finding is recorded on the run and the loop goes on to the next.

/** Dimensions the judge looks at: security (SAST), performance and slop rule hits. */
export const JUDGE_DIMENSIONS = ['security', 'sast', 'performance', 'slop'] as const;
/** Server defaults (decision 2: a 4-hour daily window, and a per-scan budget). */
export const JUDGE_DEFAULT_MINUTES_PER_DAY = 240;
export const JUDGE_DEFAULT_SCAN_MINUTES = 30;
/** Most hits of one rule judged in one run, so one noisy rule cannot take the whole budget. */
export const JUDGE_PER_RULE = 25;
/** Most candidates read for one run (ranked; the rest wait for the next scan). */
export const JUDGE_MAX_CANDIDATES = 2000;
/** On a hosted link: most calls one judge run may make (the same ceiling as a pass). */
export const JUDGE_MAX_CALLS_HOSTED = 30;
/**
 * W25-02: most minutes of waiting for a busy model one judge run is NOT charged
 * for. On the 0.2.0 install axum's run took 71 minutes for two calls because
 * its 30-minute clock ran while scan reviews held the one-slot local model;
 * gin's reached 35 minutes with no call made. Waiting is now added to the
 * run's deadline (bounded by this), so the budget is the model's time.
 */
export const JUDGE_MAX_QUEUE_ALLOWANCE_MINUTES = 120;
/** Consecutive model errors after which the run stops (the model is down, not one finding). */
export const JUDGE_MAX_CONSECUTIVE_ERRORS = 5;
/**
 * Quick first look (W22-03): the least confidence, as a share of the checklist's
 * 1-5 scale, at which a likely false positive from the triage_fast route is kept
 * without asking the main model. 0.8 = 4 of 5.
 */
export const JUDGE_DEFAULT_FAST_MIN_CONFIDENCE = 0.8;
/**
 * W22-14: hits of one rule per model call on this server unless
 * AI_JUDGE_BATCH_SIZE says otherwise (1 = one per call, as before batching).
 */
export const JUDGE_DEFAULT_BATCH_SIZE = 4;
/** Most entries of plan.judge.batches kept on the run row (the counts stay whole). */
const JUDGE_BATCH_LOG_MAX = 200;
/** Calls one finding may take: the answer and one corrective retry (runTriage's own rule). */
const CALLS_PER_FINDING = 2;
const DAY_MS = 24 * 60 * 60 * 1000;
const INITIATOR = 'ai-judge';

export interface JudgeConfig {
  enabled: boolean;
  /** Server default for a workspace with no judge_minutes_per_day of its own. */
  minutesPerDay: number;
  /** Most minutes one judge run may spend. */
  scanMinutes: number;
  /**
   * Quick first look: least confidence (0-1 share of the 1-5 scale) at which a
   * triage_fast "likely false positive" stands. Absent = the default, 0.8.
   */
  fastMinConfidence?: number;
  /**
   * W22-14: most hits of one rule asked in one model call (1-8). Absent or 1 =
   * one hit per call, exactly as before batching. The server reads
   * AI_JUDGE_BATCH_SIZE (default 4).
   */
  batchSize?: number;
}

function wholeMinutes(raw: string | undefined, fallback: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= max ? n : fallback;
}

export function judgeConfigFromEnv(env: Record<string, string | undefined>): JudgeConfig {
  return {
    enabled: (env.AI_JUDGE ?? 'on') !== 'off',
    minutesPerDay: wholeMinutes(env.AI_JUDGE_MINUTES_PER_DAY, JUDGE_DEFAULT_MINUTES_PER_DAY, 1440),
    scanMinutes: wholeMinutes(env.AI_JUDGE_SCAN_MINUTES, JUDGE_DEFAULT_SCAN_MINUTES, 1440),
    fastMinConfidence: shareOf(env.AI_JUDGE_FAST_MIN_CONFIDENCE, JUDGE_DEFAULT_FAST_MIN_CONFIDENCE),
    batchSize: batchSizeOf(env.AI_JUDGE_BATCH_SIZE),
  };
}

function batchSizeOf(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return JUDGE_DEFAULT_BATCH_SIZE;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= TRIAGE_BATCH_MAX ? n : JUDGE_DEFAULT_BATCH_SIZE;
}

function shareOf(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= 1 ? n : fallback;
}

/** The workspace's daily judge minutes: its own setting, or the server default. */
export async function judgeMinutesPerDay(
  db: Database,
  workspaceId: number,
  cfg: JudgeConfig,
): Promise<number> {
  const [row] = await db
    .select({ m: read.aiPassSettings.judgeMinutesPerDay })
    .from(read.aiPassSettings)
    .where(eq(read.aiPassSettings.workspaceId, workspaceId))
    .limit(1);
  return row?.m ?? cfg.minutesPerDay;
}

/**
 * Wall-clock milliseconds local judge runs of this workspace spent in the last
 * 24 hours (a running one counts up to now). Always workspace-filtered (Law 5).
 */
export async function judgeMsUsed(db: Database, workspaceId: number, now: Date): Promise<number> {
  const [row] = await db
    .select({
      // W25-02: less what a finished run spent waiting for the model.
      ms: sql<number>`coalesce(sum(greatest(0, extract(epoch from (coalesce(${read.aiPassRuns.finishedAt}, ${now.toISOString()}::timestamptz) - ${read.aiPassRuns.startedAt})) * 1000 - coalesce((${read.aiPassRuns.plan} -> 'judge' ->> 'queued_ms')::float8, 0))), 0)::float8`,
    })
    .from(read.aiPassRuns)
    .where(
      and(
        eq(read.aiPassRuns.workspaceId, workspaceId),
        eq(read.aiPassRuns.mode, 'judge'),
        eq(read.aiPassRuns.budget, 'time'),
        isNotNull(read.aiPassRuns.startedAt),
        gte(read.aiPassRuns.startedAt, new Date(now.getTime() - DAY_MS)),
      ),
    );
  return Math.max(0, Number(row?.ms ?? 0));
}

export type JudgeEligibility =
  | { ok: true; budget: 'time'; minutes: number; perDay: number; usedMs: number }
  | { ok: true; budget: 'calls'; minutes: number; maxCalls: number }
  | { ok: false; code: string; reason: string };

export type EgressOf = (
  db: Database,
  workspaceId: number,
  roles?: Parameters<typeof passEgress>[2],
) => Promise<PassEgress>;

/**
 * May this repository's rule hits be judged now, and within what budget?
 * Decided from the server's own facts (the same egress definition as the audit
 * and local-only), never from a connection's name.
 */
export async function judgeEligibility(args: {
  db: Database;
  workspaceId: number;
  repoId: number;
  config: JudgeConfig;
  now: Date;
  egress?: EgressOf;
}): Promise<JudgeEligibility> {
  const { db, workspaceId: ws, repoId, config, now } = args;
  const egressOf = args.egress ?? passEgress;
  if (!config.enabled) {
    return { ok: false, code: 'disabled', reason: 'AI judging is switched off on this server.' };
  }
  if (await isAiPaused(db, ws)) {
    return {
      ok: false,
      code: 'ai_paused',
      reason: 'AI analysis is switched off for this workspace, so no rule hit was judged.',
    };
  }
  // The quick first look's route counts too, but only when it is routed
  // (passEgress leaves an unrouted optional role out).
  const triage = await egressOf(db, ws, ['triage', 'triage_fast']);
  if (triage.destinations.length === 0) {
    return { ok: false, code: 'no_gateway', reason: triage.sentence };
  }

  if (!triage.leaves_network) {
    // Decision 1: every routed model is local, so it is on by default.
    // Decision 2: bounded by time, not by the monthly call count.
    const perDay = await judgeMinutesPerDay(db, ws, config);
    const usedMs = await judgeMsUsed(db, ws, now);
    const leftMs = perDay * 60_000 - usedMs;
    if (leftMs < 60_000) {
      return {
        ok: false,
        code: 'time_budget_spent',
        reason: `This workspace's ${perDay} minutes of local AI judging for the last 24 hours are used up, so no rule hit was judged. More time frees up as the 24-hour window moves on, or an admin can raise it in Settings → Analysis.`,
      };
    }
    return {
      ok: true,
      budget: 'time',
      minutes: Math.min(config.scanMinutes, Math.floor(leftMs / 60_000)),
      perDay,
      usedMs,
    };
  }

  // A hosted link: the W19-12 opt-in and the monthly cap, exactly as before.
  if (triage.local_only) {
    return {
      ok: false,
      code: 'local_only_forbids',
      reason:
        'Local-only is on, but the triage route includes a model off your network. Nothing was sent.',
    };
  }
  const full = await egressOf(db, ws, PASS_ROLES);
  const [schedule] = await db
    .select({ digest: read.aiPassSchedules.egressDigest })
    .from(read.aiPassSchedules)
    .where(
      and(
        eq(read.aiPassSchedules.workspaceId, ws),
        eq(read.aiPassSchedules.repoId, repoId),
        eq(read.aiPassSchedules.enabled, true),
      ),
    )
    .limit(1);
  if (!schedule) {
    return {
      ok: false,
      code: 'not_opted_in',
      reason:
        'The triage route includes a model off your network, so rule hits are judged only for a repository an admin has opted in to scheduled AI passes (acknowledging where source is sent).',
    };
  }
  if (schedule.digest !== full.digest) {
    return {
      ok: false,
      code: 'routing_changed',
      reason:
        'The models this workspace routes to have changed since the AI-pass schedule was acknowledged, so nothing was sent. Acknowledge the new destinations on the schedule to continue.',
    };
  }
  const left = (await monthlyCap(db, ws)) - (await monthlyCallsUsed(db, ws, now));
  if (left < 1) {
    return {
      ok: false,
      code: 'cap_reached',
      reason:
        "This month's AI call cap is used up, so no rule hit was judged on the hosted model. It resets on the 1st, or an admin can raise it.",
    };
  }
  return {
    ok: true,
    budget: 'calls',
    minutes: config.scanMinutes,
    maxCalls: Math.min(left, JUDGE_MAX_CALLS_HOSTED),
  };
}

type FindingRow = typeof read.findings.$inferSelect;

/**
 * Risk order, grouped by rule: the rule whose riskiest open hit ranks highest
 * goes first, its hits in risk order, at most `perRule` of them; then the next
 * rule. Ties break on ids so two runs over the same findings judge the same ones.
 */
export function orderJudgeQueue<
  T extends {
    id: number;
    scannerKey: string | null;
    ruleId: string | null;
    effectiveRisk: string | number | null;
  },
>(rows: readonly T[], perRule = JUDGE_PER_RULE): T[] {
  const risk = (r: T) => Number(r.effectiveRisk ?? 0);
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const key = `${r.scannerKey ?? ''}\u0000${r.ruleId ?? ''}`;
    const g = groups.get(key) ?? [];
    g.push(r);
    groups.set(key, g);
  }
  const ordered = [...groups.entries()].map(([key, g]) => {
    g.sort((a, b) => risk(b) - risk(a) || a.id - b.id);
    return { key, top: risk(g[0]!), firstId: g[0]!.id, hits: g.slice(0, perRule) };
  });
  ordered.sort((a, b) => b.top - a.top || a.firstId - b.firstId);
  return ordered.flatMap((g) => g.hits);
}

/** Findings a judge run in the last 24 hours could not get an answer for: not retried yet. */
async function recentlyFailedIds(
  db: Database,
  workspaceId: number,
  repoId: number,
  now: Date,
): Promise<Set<number>> {
  const runs = await db
    .select({ plan: read.aiPassRuns.plan })
    .from(read.aiPassRuns)
    .where(
      and(
        eq(read.aiPassRuns.workspaceId, workspaceId),
        eq(read.aiPassRuns.repoId, repoId),
        eq(read.aiPassRuns.mode, 'judge'),
        gte(read.aiPassRuns.createdAt, new Date(now.getTime() - DAY_MS)),
      ),
    )
    .orderBy(desc(read.aiPassRuns.createdAt))
    .limit(50);
  const ids = new Set<number>();
  for (const r of runs) {
    const failed = (r.plan as { judge?: { failed_finding_ids?: unknown } } | null)?.judge
      ?.failed_finding_ids;
    if (Array.isArray(failed)) for (const id of failed) if (typeof id === 'number') ids.add(id);
  }
  return ids;
}

/**
 * Open rule hits with stored context and no AI verdict, in the judged
 * dimensions, outside test code (W25-16), riskiest first. Workspace- and repository-filtered (Law 5).
 */
export async function judgeCandidates(
  db: Database,
  workspaceId: number,
  repoId: number,
  limit = JUDGE_MAX_CANDIDATES,
): Promise<FindingRow[]> {
  return db
    .select()
    .from(read.findings)
    .where(
      and(
        eq(read.findings.workspaceId, workspaceId),
        eq(read.findings.repoId, repoId),
        eq(read.findings.status, 'open'),
        eq(read.findings.experimental, false),
        inArray(read.findings.dimension, [...JUDGE_DIMENSIONS]),
        isNotNull(read.findings.scannerKey),
        isNotNull(read.findings.ruleId),
        isNotNull(read.findings.file),
        isNotNull(read.findings.lineStart),
        isNotNull(read.findings.contextLines),
        // W25-16: no model time on rule hits in test code. The hit stays
        // open and listed; only the judging is skipped. (Secrets are not a
        // judged dimension, so a real key in a test file is unaffected.)
        sql`${read.findings.file} !~ ${TEST_PATH_PATTERN}`,
        sql`not exists (select 1 from ai_triage_verdicts v where v.finding_id = ${read.findings.id} and v.workspace_id = ${workspaceId})`,
      ),
    )
    .orderBy(sql`${read.findings.effectiveRisk} desc nulls last`, read.findings.id)
    .limit(limit);
}

export interface QueueJudgeResult {
  queued: boolean;
  code?: string;
  runId?: number;
}

/**
 * After a scan (W22-03): queue one judge run for the repository when there is
 * something to judge and a budget to judge it in. Writes no row when it does
 * not queue (a skipped row after every scan would bury the pass history); the
 * reason is returned for the worker's log.
 */
export async function queueJudgeAfterScan(
  deps: {
    db: Database;
    config: JudgeConfig;
    enqueue: (data: { workspaceId: number; runId: number }) => Promise<void>;
    now?: () => Date;
    egress?: EgressOf;
    /** W22-09: also queue when nothing is left to judge but a confirmed finding needs a fix. */
    fixes?: FixConfig;
  },
  target: { workspaceId: number; repoId: number },
): Promise<QueueJudgeResult> {
  const { db } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const { workspaceId: ws, repoId } = target;
  const ok = await judgeEligibility({
    db,
    workspaceId: ws,
    repoId,
    config: deps.config,
    now,
    ...(deps.egress ? { egress: deps.egress } : {}),
  });
  if (!ok.ok) return { queued: false, code: ok.code };
  if ((await judgeCandidates(db, ws, repoId, 1)).length === 0) {
    // W22-09: a confirmed finding the last run had no time to draft a fix for
    // is still worth a run, within the same budget.
    const fixable =
      deps.fixes !== undefined &&
      (
        await fixEligibility({
          db,
          workspaceId: ws,
          config: deps.fixes,
          runBudget: ok.budget,
          ...(deps.egress ? { egress: deps.egress } : {}),
        })
      ).ok &&
      (await pickFixTargets(db, ws, repoId, 1, now)).targets.length > 0;
    if (!fixable) return { queued: false, code: 'nothing_to_judge' };
  }

  // A judge run a crashed worker left active would block every later one.
  // W25-02: a run may also wait up to JUDGE_MAX_QUEUE_ALLOWANCE_MINUTES for the model.
  const staleBefore = new Date(
    now.getTime() - (deps.config.scanMinutes + JUDGE_MAX_QUEUE_ALLOWANCE_MINUTES + 60) * 60_000,
  );
  await db
    .update(read.aiPassRuns)
    .set({
      status: 'failed',
      reasonCode: 'stalled',
      reason: 'This judge run stopped without finishing (the worker restarted), so it was closed.',
      finishedAt: now,
    })
    .where(
      and(
        eq(read.aiPassRuns.workspaceId, ws),
        eq(read.aiPassRuns.repoId, repoId),
        eq(read.aiPassRuns.mode, 'judge'),
        inArray(read.aiPassRuns.status, ['pending', 'running']),
        lt(read.aiPassRuns.createdAt, staleBefore),
      ),
    );

  let runId: number;
  try {
    const [run] = await db
      .insert(read.aiPassRuns)
      .values({
        workspaceId: ws,
        repoId,
        paths: [],
        mode: 'judge',
        trigger: 'after_scan',
        budget: ok.budget,
        createdAt: now,
      })
      .returning({ id: read.aiPassRuns.id });
    runId = run!.id;
  } catch (err) {
    // One waiting judge run already covers what this scan found: candidates
    // are chosen when it starts, not when it is queued.
    if (isConstraintViolation(err, 'ai_pass_runs_one_active_judge_key')) {
      return { queued: false, code: 'already_queued' };
    }
    throw err;
  }
  await deps.enqueue({ workspaceId: ws, runId });
  return { queued: true, runId };
}

/** What a judge run did, stored on its row (plan.judge) for the screen and the next run. */
export interface JudgeSummary {
  budget: 'time' | 'calls';
  minutes_allowed: number;
  max_calls: number | null;
  candidates: number;
  rules: number;
  judged: number;
  /** Judged real (verify_status confirmed), less the negligible ones below. */
  confirmed: number;
  /**
   * W22-03 (2026-10-29): judged real, but on a small or bounded input (a
   * performance hit's impact 'negligible'). Also verify_status confirmed;
   * counted apart so a run's "confirmed" is what is worth fixing.
   */
  real_but_negligible: number;
  contradicted: number;
  needs_human: number;
  /** Answers that failed the checklist (malformed, uncited, ...): no verdict stored. */
  rejected: number;
  /** Model calls that threw (timeout, provider error): recorded, and the loop went on. */
  errors: number;
  error_samples: { finding_id: number; rule: string; error: string }[];
  /** Not retried for 24 hours, so one finding a model cannot answer does not eat every run. */
  failed_finding_ids: number[];
  /** Left for a later run: the budget ran out first. */
  not_reached: number;
  /** Quick first look (triage_fast) routed for this run. */
  fast_pass: boolean;
  /** Stored from the quick first look: a confident likely false positive (pass 'fast'). */
  fast_cleared: number;
  /** Sent on to the main triage route after the quick first look (any other answer or an error). */
  escalated: number;
  /** Quick-first-look calls that threw; each of those hits was escalated. */
  fast_errors: number;
  /** Wall-clock milliseconds spent in each pass (the per-verdict cost of each model). */
  fast_ms: number;
  full_ms: number;
  /**
   * W22-14: on escalated hits where both passes answered and the main verdict
   * was stored, how the quick first look's verdict compares with the main one,
   * keyed "<fast verdict>-><full verdict>" (e.g. "needs_human->real").
   */
  fast_vs_full: Record<string, number>;
  /** W22-14: most hits of one rule per call this run was allowed (1 = one per call). */
  batch_size: number;
  /**
   * W22-14: every model call (or single-hit call with its retry) in order:
   * which pass, how many hits it asked, how many came back without an
   * accepted answer, and its wall clock. At most JUDGE_BATCH_LOG_MAX kept.
   */
  batches: { pass: 'fast' | 'full'; hits: number; rejected: number; ms: number }[];
  /** W22-14: hits a batched main-model call did not answer acceptably, asked again alone. */
  batch_retried: number;
  stopped: 'done' | 'time_budget' | 'call_cap' | 'errors' | 'local_only';
  elapsed_ms: number;
  /**
   * W25-02: milliseconds the run's calls spent waiting for a busy model
   * (scans and other analysis go first). Not charged to the run's minutes, up
   * to JUDGE_MAX_QUEUE_ALLOWANCE_MINUTES, nor to the workspace's daily ones.
   */
  queued_ms?: number;
}

export function verifyOf(p: {
  verdict: string;
  rationale: string;
  model: string;
  connection: string | null;
  impact?: string | null;
  impactReason?: string | null;
  /** W22-03: 'fast' when the quick first look produced the verdict. */
  pass?: 'fast' | 'full' | null;
}): FindingVerify {
  const base = { model: p.model, providerId: null, connection: p.connection };
  const why = p.rationale.slice(0, 900);
  if (p.verdict === 'likely_false_positive' && p.pass === 'fast') {
    return {
      ...base,
      status: 'contradicted',
      reason: `On a quick first look (a smaller, faster model), the AI judged this rule hit a likely false positive: ${why}`,
    };
  }
  // Still confirmed (the hit is real); the reason says it is small, and why.
  if (p.verdict === 'real' && p.impact === 'negligible') {
    const small = p.impactReason ? ` ${p.impactReason.slice(0, 300)}` : '';
    return {
      ...base,
      status: 'confirmed',
      reason:
        `The AI judged this rule hit real, but on a small or bounded input, so it is unlikely to matter.${small} ${why}`.slice(
          0,
          1200,
        ),
    };
  }
  if (p.verdict === 'real') {
    return { ...base, status: 'confirmed', reason: `The AI judged this rule hit real: ${why}` };
  }
  if (p.verdict === 'likely_false_positive') {
    return {
      ...base,
      status: 'contradicted',
      reason: `The AI judged this rule hit a likely false positive: ${why}`,
    };
  }
  return {
    ...base,
    status: 'unverified',
    reason: `The AI could not decide from the code it was shown: ${why}`,
  };
}

/** Sums one runTriage funnel into the run's. */
function addFunnel(into: TriageFunnel, f: TriageFunnel): void {
  into.candidates += f.candidates;
  into.selected += f.selected;
  into.triaged += f.triaged;
  into.accepted += f.accepted;
  for (const k of Object.keys(into.rejected) as (keyof TriageFunnel['rejected'])[]) {
    into.rejected[k] += f.rejected[k];
  }
  for (const k of Object.keys(into.skipped) as (keyof TriageFunnel['skipped'])[]) {
    into.skipped[k] += f.skipped[k];
  }
  for (const k of Object.keys(into.verdicts) as (keyof TriageFunnel['verdicts'])[]) {
    into.verdicts[k] += f.verdicts[k];
  }
}

export interface JudgeRunResult {
  status: 'succeeded' | 'failed' | 'skipped';
  patch: Partial<typeof read.aiPassRuns.$inferInsert>;
  /** Verdicts written: the caller reprices the repository when > 0. */
  verdicts: number;
  /**
   * W22-09: what the run has left for drafting fixes, when it was allowed to
   * run at all: the same deadline and calls as the judge's.
   */
  budget?: { kind: 'time' | 'calls'; deadlineMs: number; callsLeft: number };
}

/**
 * The judge loop, inside an ai_pass_runs row the processor has set running.
 * `wg.gateway` is the pass's tracked gateway (cancel check, call counter).
 */
export async function runJudge(a: {
  db: Database;
  run: typeof read.aiPassRuns.$inferSelect;
  workspaceId: number;
  runId: number;
  wg: { gateway: AnalysisGateway; hosts: T2Host[]; routing?: RoutingPolicy };
  config: JudgeConfig;
  now: () => Date;
  egress?: EgressOf;
  /**
   * W22-09: the share of the run kept for drafting fixes after judging. It is
   * held back once a fix could be drafted: `pending` (a confirmed finding was
   * already waiting for one) or a hit this run confirms that has a re-runnable
   * rule. Otherwise judging may use the whole run.
   */
  fixReserve?: { share: number; pending: boolean };
}): Promise<JudgeRunResult> {
  const { db, run, workspaceId: ws, runId } = a;
  const started = a.now();
  const ok = await judgeEligibility({
    db,
    workspaceId: ws,
    repoId: run.repoId,
    config: a.config,
    now: started,
    ...(a.egress ? { egress: a.egress } : {}),
  });
  if (!ok.ok) {
    return { status: 'skipped', patch: { reasonCode: ok.code, reason: ok.reason }, verdicts: 0 };
  }

  const failedBefore = await recentlyFailedIds(db, ws, run.repoId, started);
  const rows = (await judgeCandidates(db, ws, run.repoId)).filter((r) => !failedBefore.has(r.id));
  const queue = orderJudgeQueue(rows);
  const baseDeadline = started.getTime() + ok.minutes * 60_000;
  // W25-02: time waiting for the model's slot moves the deadline, bounded.
  let queuedMs = 0;
  const deadlineNow = () =>
    baseDeadline + Math.min(queuedMs, JUDGE_MAX_QUEUE_ALLOWANCE_MINUTES * 60_000);
  const gateway: AnalysisGateway = {
    async complete(prompt, opts) {
      try {
        const r = await a.wg.gateway.complete(prompt, opts);
        queuedMs += r.queuedMs ?? 0;
        return r;
      } catch (err) {
        // A call that waited its whole queue timeout (HostBusyError) waited too.
        const waited = (err as { waitedMs?: unknown } | null)?.waitedMs;
        if (typeof waited === 'number' && Number.isFinite(waited)) queuedMs += waited;
        throw err;
      }
    },
    health: (tier) => a.wg.gateway.health(tier),
  };
  const maxCalls = ok.budget === 'calls' ? ok.maxCalls : Number.POSITIVE_INFINITY;
  let calls = 0;
  const budgetLeft = () => ({
    kind: ok.budget,
    deadlineMs: deadlineNow(),
    callsLeft: Math.max(0, maxCalls - calls),
  });
  const summary: JudgeSummary = {
    budget: ok.budget,
    minutes_allowed: ok.minutes,
    max_calls: ok.budget === 'calls' ? ok.maxCalls : null,
    candidates: rows.length,
    rules: new Set(queue.map((r) => `${r.scannerKey}:${r.ruleId}`)).size,
    judged: 0,
    confirmed: 0,
    real_but_negligible: 0,
    contradicted: 0,
    needs_human: 0,
    rejected: 0,
    errors: 0,
    error_samples: [],
    failed_finding_ids: [],
    not_reached: 0,
    fast_pass: isRoleRouted(a.wg.routing, 'triage_fast'),
    fast_cleared: 0,
    escalated: 0,
    fast_errors: 0,
    fast_ms: 0,
    full_ms: 0,
    fast_vs_full: {},
    batch_size: Math.max(1, Math.min(Math.floor(a.config.batchSize ?? 1), TRIAGE_BATCH_MAX)),
    batches: [],
    batch_retried: 0,
    stopped: 'done',
    elapsed_ms: 0,
  };
  if (queue.length === 0) {
    return {
      status: 'skipped',
      patch: {
        reasonCode: 'nothing_to_judge',
        reason:
          'No open rule hit without an AI verdict had stored code context, so nothing was judged.',
        plan: { judge: summary },
      },
      verdicts: 0,
      budget: budgetLeft(),
    };
  }

  const contextWindow = contextWindowForRole(a.wg.routing, 'triage', a.wg.hosts);
  const fastWindow = summary.fast_pass
    ? contextWindowForRole(a.wg.routing, 'triage_fast', a.wg.hosts)
    : null;
  const fastMin = a.config.fastMinConfidence ?? JUDGE_DEFAULT_FAST_MIN_CONFIDENCE;
  // Local-only refusing the fast route refuses every later call the same way.
  let fastOff = false;
  const meta = { repoId: String(run.repoId), prNumber: 0, initiator: INITIATOR };
  const funnel = emptyTriageFunnel();
  let fixable = a.fixReserve?.pending ?? false;
  const reserveMs = a.fixReserve ? Math.floor(ok.minutes * 60_000 * a.fixReserve.share) : 0;
  const judgeDeadline = () => deadlineNow() - (fixable ? reserveMs : 0);
  let consecutiveErrors = 0;
  let verdicts = 0;
  let fatal: string | null = null;

  // W22-14: hits of one rule go to the model together, up to batch_size a
  // call and as many as fit the window whole (packTriageBatch). Two queues:
  // `pending` holds hits no pass has seen yet, in queue order; `fullQueue`
  // holds hits waiting for the main model (escalated by the quick first look,
  // left over when a batch did not fit, or asked again ALONE after a batched
  // answer failed the checklist for them). The main model's queue goes first,
  // so an escalation is answered before the next rule's hits start.
  type FullItem = { row: FindingRow; fastPass: read.AiJudgeFastPass | null; alone: boolean };
  const pending: FindingRow[] = [...queue];
  const fullQueue: FullItem[] = [];
  const ruleKey = (r: FindingRow) => `${r.scannerKey}\u0000${r.ruleId}\u0000${r.dimension}`;
  const remaining = () => pending.length + fullQueue.length;
  const logBatch = (pass: 'fast' | 'full', hits: number, rejected: number, ms: number) => {
    if (summary.batches.length < JUDGE_BATCH_LOG_MAX) {
      summary.batches.push({ pass, hits, rejected, ms });
    }
  };
  /** Adds one hit's final outcome to the run's funnel (a batched call's hits, one by one). */
  const countOne = (verdict: TriageProposal['verdict']) => {
    funnel.candidates += 1;
    funnel.selected += 1;
    funnel.triaged += 1;
    funnel.accepted += 1;
    funnel.verdicts[verdict] += 1;
  };

  /** Stores one verdict and marks its finding (verify columns only, never its status). */
  async function store(
    f: FindingRow,
    p: TriageProposal,
    pass: 'fast' | 'full',
    fastPass: read.AiJudgeFastPass | null,
  ): Promise<void> {
    const route = (p.route ?? null) as { providerName?: string } | null;
    const connection = route?.providerName ? route.providerName.slice(0, 200) : null;
    const [stored] = await db
      .insert(read.aiTriageVerdicts)
      .values({
        workspaceId: ws,
        findingId: f.id,
        aiPassRunId: runId,
        verdict: p.verdict,
        confidence: p.confidence,
        model: p.model,
        // triage.v1, or triage.v1+batch when a batched call asked (W22-14).
        checklistVersion: p.checklistVersion,
        rationale: p.rationale,
        citations: p.citations,
        vexJustification: p.vex?.justification ?? null,
        vexStatement: p.vex?.statement ?? null,
        impact: p.impact ?? null,
        impactReason: p.impactReason ?? null,
        // No patch proof runs here: judging is a verdict, not a fix (W22-09).
        patchStatus: 'not_attempted',
        route: p.route as Record<string, unknown> | null,
        llmProviderId: null,
        connectionName: connection,
        // W22-03: which pass produced it, so the quick first look is measurable.
        pass,
        // W22-14: what the quick first look said before it escalated (null otherwise).
        fastPass: pass === 'full' ? fastPass : null,
      })
      .onConflictDoNothing()
      .returning({ id: read.aiTriageVerdicts.id });
    // Another pass answered this finding meanwhile: its suggestion stands.
    if (!stored) return;
    summary.judged += 1;
    if (pass === 'fast') summary.fast_cleared += 1;
    else if (fastPass?.verdict) {
      const key = `${fastPass.verdict}->${p.verdict}`;
      summary.fast_vs_full[key] = (summary.fast_vs_full[key] ?? 0) + 1;
    }
    if (p.verdict === 'real' && p.impact === 'negligible') {
      // Real, but too small to matter: no fix is drafted for it (ai-fix.ts),
      // so it does not hold back time for one either.
      summary.real_but_negligible += 1;
    } else if (p.verdict === 'real') {
      summary.confirmed += 1;
      if (isRerunnable(f.scannerKey, f.ruleId) && f.file !== null) fixable = true;
    } else if (p.verdict === 'likely_false_positive') summary.contradicted += 1;
    else summary.needs_human += 1;
    // MARKS the finding (verify columns only): never its status (D9a).
    await recordVerdicts(db, {
      workspaceId: ws,
      repoId: run.repoId,
      verdicts: [
        {
          dedupKey: f.dedupKey,
          verify: verifyOf({
            verdict: p.verdict,
            rationale: p.rationale,
            model: p.model,
            connection,
            impact: p.impact ?? null,
            impactReason: p.impactReason ?? null,
            pass,
          }),
        },
      ],
    });
    verdicts += 1;
  }

  while (remaining() > 0) {
    // Budget and time are checked between calls: a call that would start
    // after the deadline does not start.
    if (a.now().getTime() >= judgeDeadline()) {
      summary.stopped = 'time_budget';
      summary.not_reached = remaining();
      break;
    }
    if (calls >= maxCalls) {
      summary.stopped = 'call_cap';
      summary.not_reached = remaining();
      break;
    }

    // The next unit: the main model's queue first, else the next hits of one rule.
    let stage: 'fast' | 'full';
    let unit: FindingRow[];
    const fastOf = new Map<number, read.AiJudgeFastPass | null>();
    let alone = false;
    if (fullQueue.length > 0) {
      stage = 'full';
      const head = fullQueue[0]!;
      alone = head.alone;
      let n = 1;
      while (
        !alone &&
        n < summary.batch_size &&
        n < fullQueue.length &&
        !fullQueue[n]!.alone &&
        ruleKey(fullQueue[n]!.row) === ruleKey(head.row)
      ) {
        n += 1;
      }
      const items = fullQueue.splice(0, n);
      unit = items.map((it) => it.row);
      for (const it of items) fastOf.set(it.row.id, it.fastPass);
    } else {
      stage = summary.fast_pass && !fastOff ? 'fast' : 'full';
      let n = 1;
      while (
        n < summary.batch_size &&
        n < pending.length &&
        ruleKey(pending[n]!) === ruleKey(pending[0]!)
      ) {
        n += 1;
      }
      unit = pending.splice(0, n);
    }

    const plan = packTriageBatch(unit.map(triageCandidateOf), {
      contextWindow: stage === 'fast' ? fastWindow : contextWindow,
      maxHits: alone ? 1 : summary.batch_size,
    });
    const asked = unit.slice(0, plan.hits.length);
    // What did not fit the window goes back to the front, in order.
    const left = unit.slice(plan.hits.length);
    if (stage === 'full') {
      fullQueue.unshift(
        ...left.map((row) => ({ row, fastPass: fastOf.get(row.id) ?? null, alone: false })),
      );
    } else {
      pending.unshift(...left);
    }
    const rule = `${asked[0]!.scannerKey}:${asked[0]!.ruleId}`;
    const batchCalls = Math.min(CALLS_PER_FINDING, maxCalls - calls);

    if (stage === 'fast') {
      // Quick first look: only a confident likely false positive stops here.
      const t0 = a.now().getTime();
      const escalate: FullItem[] = [];
      try {
        const fast = await runTriageBatch(plan, {
          gateway,
          maxCalls: batchCalls,
          meta,
          role: 'triage_fast',
        });
        calls += fast.calls;
        const ms = a.now().getTime() - t0;
        // A batched call's time is shared by its hits.
        const perHit = Math.round(ms / asked.length);
        const byKey = new Map(fast.proposals.map((p) => [p.dedupKey, p]));
        const cleared: [FindingRow, TriageProposal][] = [];
        for (const f of asked) {
          const fp = byKey.get(f.dedupKey);
          if (fp && fp.verdict === 'likely_false_positive' && fp.confidence / 5 >= fastMin) {
            cleared.push([f, fp]);
          } else {
            escalate.push({
              row: f,
              alone: false,
              fastPass: {
                verdict: (fp?.verdict ?? null) as read.AiJudgeFastPass['verdict'],
                confidence: fp?.confidence ?? null,
                reason: !fp
                  ? 'rejected'
                  : fp.verdict === 'likely_false_positive'
                    ? 'low_confidence'
                    : 'not_false_positive',
                model: fp?.model ?? null,
                ms: perHit,
              },
            });
          }
        }
        summary.fast_ms += ms;
        logBatch('fast', asked.length, fast.rejections.length, ms);
        if (!fast.batched && cleared.length > 0) addFunnel(funnel, fast.funnel);
        for (const [f, fp] of cleared) {
          if (fast.batched) countOne(fp.verdict);
          await store(f, fp, 'fast', null);
        }
      } catch (err) {
        if (err instanceof Error && err.name === 'PassCancelledError') throw err;
        calls += 1;
        summary.fast_errors += 1;
        if (summary.error_samples.length < 10) {
          summary.error_samples.push({
            finding_id: asked[0]!.id,
            rule,
            error: `quick first look: ${safeErrorText(err)}`.slice(0, 300),
          });
        }
        if (err instanceof LocalOnlyViolationError) fastOff = true;
        const ms = a.now().getTime() - t0;
        summary.fast_ms += ms;
        logBatch('fast', asked.length, asked.length, ms);
        const perHit = Math.round(ms / asked.length);
        for (const f of asked) {
          escalate.push({
            row: f,
            alone: false,
            fastPass: {
              verdict: null,
              confidence: null,
              reason: 'provider_error',
              model: null,
              ms: perHit,
            },
          });
        }
      }
      // Escalations go on to the main model, together (one rule), next: the
      // same run's minutes and calls, checked before that call starts.
      summary.escalated += escalate.length;
      fullQueue.unshift(...escalate);
      continue;
    }

    const t1 = a.now().getTime();
    let result: Awaited<ReturnType<typeof runTriageBatch>>;
    try {
      result = await runTriageBatch(plan, {
        gateway,
        maxCalls: batchCalls,
        meta,
      });
      calls += result.calls;
    } catch (err) {
      const ms = a.now().getTime() - t1;
      summary.full_ms += ms;
      // A cancelled run stops here (the processor records it).
      if (err instanceof Error && err.name === 'PassCancelledError') throw err;
      logBatch('full', asked.length, asked.length, ms);
      calls += 1;
      summary.errors += 1;
      if (summary.error_samples.length < 10) {
        summary.error_samples.push({
          finding_id: asked[0]!.id,
          rule,
          error: safeErrorText(err).slice(0, 300),
        });
      }
      // Local-only refusing the route is not one finding's problem: every
      // later call would be refused the same way.
      if (err instanceof LocalOnlyViolationError) {
        summary.failed_finding_ids.push(...asked.map((f) => f.id));
        summary.stopped = 'local_only';
        summary.not_reached = remaining();
        fatal = err.message;
        break;
      }
      if (plan.prompt !== null) {
        // A batched call that failed (a timeout on a long answer, say): each
        // of its hits is asked again alone before it is given up on.
        summary.batch_retried += asked.length;
        fullQueue.unshift(
          ...asked.map((row) => ({ row, fastPass: fastOf.get(row.id) ?? null, alone: true })),
        );
      } else {
        summary.failed_finding_ids.push(asked[0]!.id);
      }
      consecutiveErrors += 1;
      if (consecutiveErrors >= JUDGE_MAX_CONSECUTIVE_ERRORS) {
        summary.stopped = 'errors';
        summary.not_reached = remaining();
        fatal = `The model failed ${consecutiveErrors} times in a row (last: ${safeErrorText(err).slice(0, 300)}), so judging stopped for this run.`;
        break;
      }
      continue;
    }
    const ms = a.now().getTime() - t1;
    summary.full_ms += ms;
    logBatch('full', asked.length, result.rejections.length, ms);
    consecutiveErrors = 0;
    if (!result.batched) addFunnel(funnel, result.funnel);

    const byKey = new Map(result.proposals.map((p) => [p.dedupKey, p]));
    const again: FullItem[] = [];
    for (const f of asked) {
      const p = byKey.get(f.dedupKey);
      if (p) {
        if (result.batched) countOne(p.verdict);
        await store(f, p, 'full', fastOf.get(f.id) ?? null);
      } else if (result.batched) {
        // Rejected in a batched answer (missing, answered twice, or failing
        // the checklist): asked again alone, as a single-hit call, in this
        // run when its minutes and calls allow; only that answer is final.
        again.push({ row: f, fastPass: fastOf.get(f.id) ?? null, alone: true });
      } else {
        summary.rejected += 1;
        summary.failed_finding_ids.push(f.id);
      }
    }
    summary.batch_retried += again.length;
    fullQueue.unshift(...again);
  }

  summary.elapsed_ms = a.now().getTime() - started.getTime();
  summary.queued_ms = queuedMs;
  const patch: Partial<typeof read.aiPassRuns.$inferInsert> = {
    plan: { judge: summary },
    triageFunnel: funnel as unknown as Record<string, unknown>,
    calls,
  };
  if (fatal !== null && summary.judged === 0) {
    return {
      status: 'failed',
      patch: { ...patch, reasonCode: summary.stopped, reason: fatal.slice(0, 2000) },
      verdicts,
    };
  }
  // W22-09: a model that failed five times in a row, or a route local-only
  // refuses, is not asked to draft fixes either.
  const budget = fatal === null ? budgetLeft() : undefined;
  if (fatal !== null) {
    patch.reasonCode = summary.stopped;
    patch.reason = fatal.slice(0, 2000);
  } else if (summary.stopped === 'time_budget') {
    patch.reasonCode = 'time_budget';
    patch.reason = `Stopped at this run's ${ok.minutes}-minute budget${judgeDeadline() < deadlineNow() ? ' (part of it kept for drafting fixes)' : ''}${queuedMs > 0 ? ` (not counting ${Math.round(queuedMs / 60_000)} min waiting for the model)` : ''}; ${summary.not_reached} rule hit(s) wait for the next scan.`;
  } else if (summary.stopped === 'call_cap') {
    patch.reasonCode = 'call_cap';
    patch.reason = `Stopped at this run's ${summary.max_calls}-call cap; ${summary.not_reached} rule hit(s) wait for the next scan.`;
  }
  return { status: 'succeeded', patch, verdicts, ...(budget ? { budget } : {}) };
}
