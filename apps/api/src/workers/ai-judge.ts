import { and, desc, eq, gte, inArray, isNotNull, lt, sql } from 'drizzle-orm';
import {
  contextWindowForRole,
  LocalOnlyViolationError,
  type AnalysisGateway,
  type RoutingPolicy,
  type T2Host,
} from '@repopulse/analysis';
import { recordVerdicts, type FindingVerify } from '@repopulse/insights';
import { emptyTriageFunnel, isRerunnable, runTriage, type TriageFunnel } from '@repopulse/security';
import { isConstraintViolation, read, safeErrorText, type Database } from '@repopulse/shared';
import { passEgress, PASS_ROLES, type PassEgress } from '../lib/ai-pass-egress.js';
import { isAiPaused } from '../lib/ai-pause.js';
import { monthlyCallsUsed, monthlyCap } from './ai-pass-scheduler.js';
import { triageCandidateOf } from './ai-pass-processor.js';
import { fixEligibility, pickFixTargets, type FixConfig } from './ai-fix.js';

// W22-03: the AI judges every rule hit after each scan (CLOSE_THE_LOOP.md,
// "The loop"; owner decisions 1 and 2, taken as recommended 2026-10-29).
//
// WHAT IT DOES. When a scan finishes, the worker queues a judge run for the
// repository: the open security (SAST), performance and slop findings a RULE
// raised, with stored code context and no AI verdict yet, ranked by effective
// risk and grouped by rule, are put to the triage checklist one at a time
// until the budget is spent. Each answer is stored as an ai_triage_verdicts
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
/** Consecutive model errors after which the run stops (the model is down, not one finding). */
export const JUDGE_MAX_CONSECUTIVE_ERRORS = 5;
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
  };
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
      ms: sql<number>`coalesce(sum(extract(epoch from (coalesce(${read.aiPassRuns.finishedAt}, ${now.toISOString()}::timestamptz) - ${read.aiPassRuns.startedAt})) * 1000), 0)::float8`,
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
  const triage = await egressOf(db, ws, ['triage']);
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
 * dimensions, riskiest first. Workspace- and repository-filtered (Law 5).
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
  const staleBefore = new Date(now.getTime() - (deps.config.scanMinutes + 60) * 60_000);
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
  stopped: 'done' | 'time_budget' | 'call_cap' | 'errors' | 'local_only';
  elapsed_ms: number;
}

export function verifyOf(p: {
  verdict: string;
  rationale: string;
  model: string;
  connection: string | null;
  impact?: string | null;
  impactReason?: string | null;
}): FindingVerify {
  const base = { model: p.model, providerId: null, connection: p.connection };
  const why = p.rationale.slice(0, 900);
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
  const deadline = started.getTime() + ok.minutes * 60_000;
  const maxCalls = ok.budget === 'calls' ? ok.maxCalls : Number.POSITIVE_INFINITY;
  let calls = 0;
  const budgetLeft = () => ({
    kind: ok.budget,
    deadlineMs: deadline,
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
  const funnel = emptyTriageFunnel();
  let fixable = a.fixReserve?.pending ?? false;
  const reserveMs = a.fixReserve ? Math.floor(ok.minutes * 60_000 * a.fixReserve.share) : 0;
  const judgeDeadline = () => deadline - (fixable ? reserveMs : 0);
  let consecutiveErrors = 0;
  let verdicts = 0;
  let fatal: string | null = null;

  for (const [i, f] of queue.entries()) {
    if (a.now().getTime() >= judgeDeadline()) {
      summary.stopped = 'time_budget';
      summary.not_reached = queue.length - i;
      break;
    }
    if (calls >= maxCalls) {
      summary.stopped = 'call_cap';
      summary.not_reached = queue.length - i;
      break;
    }
    const rule = `${f.scannerKey}:${f.ruleId}`;
    let result: Awaited<ReturnType<typeof runTriage>>;
    try {
      result = await runTriage([triageCandidateOf(f)], {
        gateway: a.wg.gateway,
        contextWindow,
        limit: 1,
        maxCalls: Math.min(CALLS_PER_FINDING, maxCalls - calls),
        meta: { repoId: String(run.repoId), prNumber: 0, initiator: INITIATOR },
      });
    } catch (err) {
      // A cancelled run stops here (the processor records it).
      if (err instanceof Error && err.name === 'PassCancelledError') throw err;
      calls += 1;
      summary.errors += 1;
      summary.failed_finding_ids.push(f.id);
      if (summary.error_samples.length < 10) {
        summary.error_samples.push({
          finding_id: f.id,
          rule,
          error: safeErrorText(err).slice(0, 300),
        });
      }
      // Local-only refusing the route is not one finding's problem: every
      // later call would be refused the same way.
      if (err instanceof LocalOnlyViolationError) {
        summary.stopped = 'local_only';
        summary.not_reached = queue.length - i - 1;
        fatal = err.message;
        break;
      }
      consecutiveErrors += 1;
      if (consecutiveErrors >= JUDGE_MAX_CONSECUTIVE_ERRORS) {
        summary.stopped = 'errors';
        summary.not_reached = queue.length - i - 1;
        fatal = `The model failed ${consecutiveErrors} times in a row (last: ${safeErrorText(err).slice(0, 300)}), so judging stopped for this run.`;
        break;
      }
      continue;
    }
    consecutiveErrors = 0;
    calls += result.calls;
    addFunnel(funnel, result.funnel);
    const p = result.proposals[0];
    if (!p) {
      summary.rejected += 1;
      summary.failed_finding_ids.push(f.id);
      continue;
    }
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
      })
      .onConflictDoNothing()
      .returning({ id: read.aiTriageVerdicts.id });
    // Another pass answered this finding meanwhile: its suggestion stands.
    if (!stored) continue;
    summary.judged += 1;
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
          }),
        },
      ],
    });
    verdicts += 1;
  }

  summary.elapsed_ms = a.now().getTime() - started.getTime();
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
    patch.reason = `Stopped at this run's ${ok.minutes}-minute budget${judgeDeadline() < deadline ? ' (part of it kept for drafting fixes)' : ''}; ${summary.not_reached} rule hit(s) wait for the next scan.`;
  } else if (summary.stopped === 'call_cap') {
    patch.reasonCode = 'call_cap';
    patch.reason = `Stopped at this run's ${summary.max_calls}-call cap; ${summary.not_reached} rule hit(s) wait for the next scan.`;
  }
  return { status: 'succeeded', patch, verdicts, ...(budget ? { budget } : {}) };
}
