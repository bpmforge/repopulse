import { and, desc, eq, gt, gte, lt, ne, or, sql } from 'drizzle-orm';
import type { Job } from 'bullmq';
import { facts, isConstraintViolation, read, type Database } from '@repopulse/shared';
import {
  LLM_ROLES,
  defaultPool,
  hostIsLocal,
  hostOf,
  type RoutingPolicy,
  type T2Host,
} from '@repopulse/analysis';
import { AI_PASSES_PER_DAY } from './ai-pass-processor.js';
import { AI_PASS_MAX_COMMITS } from './ai-pass-diff.js';

// Scheduled AI passes (W19-12).
//
// A schedule is the owner's standing "yes" to send one repository's code to the
// configured models without anyone pressing start. It is off by default, it is
// per repository, and switching it on stores who acknowledged it and which
// wording they saw. This sweep is the ONLY thing that acts on it, and all it
// does is start an ordinary pass (`ai_pass_runs`, trigger 'schedule'), so the
// pass's own caps, tenancy, routing, call cap and "never writes, never
// suppresses" (D9a) apply unchanged.
//
// A due schedule that does not start a pass leaves a SKIPPED run with the reason
// in words. A schedule that silently did nothing would read, on the screen, as
// "reviewed and quiet" - the one thing an AI review page may never imply.

/** The repeatable job's name on the ai.pass queue. Every other job there is one pass. */
export const AI_SCHEDULE_SWEEP_JOB = 'ai.schedule-sweep';

/** The wording an admin acknowledges. A change of wording is a new version. */
export const AI_SCHEDULE_ACK_VERSION = 'w19-12/1';
export const AI_SCHEDULE_ACK_TEXT =
  'I understand that, while this schedule is on, RepoPulse will send this repository’s code ' +
  '(the files or the new commits named here) to the models configured in Admin → Models, ' +
  'without anyone pressing start, up to the monthly limit set here.';

/** A schedule is due this long after the last time the sweep acted on it. */
export const CADENCE_MS = {
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
} as const;
/** The sweep runs hourly; this slack keeps a daily schedule from drifting an hour a day. */
const SLACK_MS = 60 * 60 * 1000;

export type ScheduleRow = typeof read.aiPassSchedules.$inferSelect;

/** When the schedule is next due: now, if it has never run. */
export function nextDueAt(s: Pick<ScheduleRow, 'cadence' | 'lastScheduledAt'>, now: Date): Date {
  if (!s.lastScheduledAt) return now;
  return new Date(s.lastScheduledAt.getTime() + CADENCE_MS[s.cadence] - SLACK_MS);
}

export function isDue(s: Pick<ScheduleRow, 'cadence' | 'lastScheduledAt'>, now: Date): boolean {
  return nextDueAt(s, now).getTime() <= now.getTime();
}

/** The first instant of the UTC calendar month `now` falls in. The cap counts from here. */
export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/**
 * The connections a pass could send code to that are NOT on the operator's
 * network, by name. Every role's chain, plus the default pool for roles without
 * one (filtered the way the gateway filters it under local-only). Empty = all local.
 */
export function nonLocalConnections(hosts: T2Host[], routing: RoutingPolicy | undefined): string[] {
  const reachable: T2Host[] = [];
  let anyUnchained = false;
  for (const role of LLM_ROLES) {
    const chain = routing?.chains[role];
    if (chain === undefined) anyUnchained = true;
    else reachable.push(...chain.map((l) => l.host));
  }
  if (anyUnchained) reachable.push(...defaultPool(hosts, routing?.localOnly ?? false));
  const names = reachable
    .filter((h) => !hostIsLocal(h))
    .map((h) => h.name ?? hostOf(h) ?? h.baseUrl);
  return [...new Set(names)].sort();
}

/** Scheduled passes that STARTED for this schedule's repository this month. Skips do not count. */
export async function startedThisMonth(
  db: Database,
  workspaceId: number,
  repoId: number,
  now: Date,
): Promise<number> {
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(read.aiPassRuns)
    .where(
      and(
        eq(read.aiPassRuns.workspaceId, workspaceId),
        eq(read.aiPassRuns.repoId, repoId),
        eq(read.aiPassRuns.trigger, 'schedule'),
        ne(read.aiPassRuns.status, 'skipped'),
        gte(read.aiPassRuns.createdAt, monthStart(now)),
      ),
    );
  return n;
}

/**
 * Passes the workspace has started in the last 24 hours, against AI_PASSES_PER_DAY.
 * A schedule's SKIPPED record started nothing, so it does not use up the limit.
 */
export async function passesInLastDay(
  db: Database,
  workspaceId: number,
  now: Date,
): Promise<number> {
  const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(read.aiPassRuns)
    .where(
      and(
        eq(read.aiPassRuns.workspaceId, workspaceId),
        gte(read.aiPassRuns.createdAt, since),
        or(ne(read.aiPassRuns.trigger, 'schedule'), ne(read.aiPassRuns.status, 'skipped')),
      ),
    );
  return n;
}

export type CommitRangePick =
  | { ok: true; base: string; head: string; skippedOlder: number }
  | { ok: false; code: 'nothing_new'; reason: string };

/**
 * The commit range a 'new_commits' schedule reviews: the non-merge commits ingested
 * after the last head it reviewed, newest AI_PASS_MAX_COMMITS of them. More than that
 * and the oldest are left out, and the run says how many - a schedule must not fail
 * every week because a busy repository moved more than the range cap.
 */
export async function pickNewCommits(
  db: Database,
  workspaceId: number,
  repoId: number,
  lastHeadSha: string | null,
): Promise<CommitRangePick> {
  const own = and(eq(facts.commits.workspaceId, workspaceId), eq(facts.commits.repoId, repoId));
  let after: Date | null = null;
  if (lastHeadSha) {
    const [last] = await db
      .select({ committedAt: facts.commits.committedAt })
      .from(facts.commits)
      .where(and(own, eq(facts.commits.sha, lastHeadSha)))
      .limit(1);
    // Not found (history rewritten, or re-ingested): treated as a first run.
    after = last?.committedAt ?? null;
  }
  const newer = await db
    .select({ sha: facts.commits.sha, committedAt: facts.commits.committedAt })
    .from(facts.commits)
    .where(
      and(
        own,
        eq(facts.commits.isMerge, false),
        ...(after ? [gt(facts.commits.committedAt, after)] : []),
      ),
    )
    .orderBy(desc(facts.commits.committedAt))
    .limit(AI_PASS_MAX_COMMITS + 1);
  const total = after
    ? ((
        await db
          .select({ n: sql<number>`count(*)::int` })
          .from(facts.commits)
          .where(and(own, eq(facts.commits.isMerge, false), gt(facts.commits.committedAt, after)))
      )[0]?.n ?? 0)
    : null;
  const nothing = {
    ok: false as const,
    code: 'nothing_new' as const,
    reason: lastHeadSha
      ? `No commit has been ingested since the last scheduled pass (head ${lastHeadSha.slice(0, 8)}), so there was nothing new to review.`
      : 'This repository has no ingested commits to review yet.',
  };
  if (newer.length === 0) return nothing;
  const window = newer.slice(0, AI_PASS_MAX_COMMITS);
  const head = window[0]!;
  const oldest = window[window.length - 1]!;
  // The base is the newest commit (merges included) before the oldest reviewed one.
  const [base] = await db
    .select({ sha: facts.commits.sha })
    .from(facts.commits)
    .where(and(own, lt(facts.commits.committedAt, oldest.committedAt)))
    .orderBy(desc(facts.commits.committedAt))
    .limit(1);
  if (!base) {
    // The repository's very first commit has nothing before it to diff from;
    // review what comes after it.
    if (window.length < 2) return nothing;
    return {
      ok: true,
      base: oldest.sha,
      head: head.sha,
      skippedOlder: 1,
    };
  }
  return {
    ok: true,
    base: base.sha,
    head: head.sha,
    skippedOlder: total === null ? 0 : Math.max(0, total - window.length),
  };
}

export interface ScheduleSweepDeps {
  db: Database;
  /** The workspace's hosts and routing, as the pass would use them; null = no model. */
  gatewayFor: (workspaceId: number) => Promise<{ hosts: T2Host[]; routing?: RoutingPolicy } | null>;
  /** Puts a run on the ai.pass queue. */
  enqueue: (workspaceId: number, runId: number) => Promise<void>;
  now?: () => Date;
}

export interface SweepOutcome {
  scheduleId: number;
  workspaceId: number;
  repoId: number;
  runId: number | null;
  status: 'started' | 'skipped';
  code?: string;
}

/**
 * One sweep: every enabled, acknowledged, due schedule either starts a pass or
 * records why it did not. Every query is filtered by the schedule's own
 * workspace (Law 5).
 */
export async function sweepSchedules(deps: ScheduleSweepDeps): Promise<SweepOutcome[]> {
  const { db } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const schedules = await db
    .select()
    .from(read.aiPassSchedules)
    .where(eq(read.aiPassSchedules.enabled, true))
    .orderBy(read.aiPassSchedules.id);

  const out: SweepOutcome[] = [];
  for (const s of schedules) {
    if (!isDue(s, now) || s.acknowledgedAt === null) continue;
    // Claim it for this period first, compare-and-set on the value we read, so two
    // worker replicas sweeping at once act on a schedule once.
    const claimed = await db
      .update(read.aiPassSchedules)
      .set({ lastScheduledAt: now })
      .where(
        and(
          eq(read.aiPassSchedules.id, s.id),
          eq(read.aiPassSchedules.workspaceId, s.workspaceId),
          eq(read.aiPassSchedules.enabled, true),
          s.lastScheduledAt === null
            ? sql`${read.aiPassSchedules.lastScheduledAt} is null`
            : eq(read.aiPassSchedules.lastScheduledAt, s.lastScheduledAt),
        ),
      )
      .returning({ id: read.aiPassSchedules.id });
    if (claimed.length === 0) continue;
    out.push(await actOn(deps, s, now));
  }
  return out;
}

async function actOn(deps: ScheduleSweepDeps, s: ScheduleRow, now: Date): Promise<SweepOutcome> {
  const { db } = deps;
  const base = { scheduleId: s.id, workspaceId: s.workspaceId, repoId: s.repoId };
  const mode = s.scope === 'paths' ? ('paths' as const) : ('commit_range' as const);

  const skip = async (code: string, reason: string): Promise<SweepOutcome> => {
    const [row] = await db
      .insert(read.aiPassRuns)
      .values({
        workspaceId: s.workspaceId,
        repoId: s.repoId,
        trigger: 'schedule',
        scheduleId: s.id,
        paths: s.scope === 'paths' ? s.paths : [],
        mode,
        status: 'skipped',
        reasonCode: code,
        reason,
        createdAt: now,
        finishedAt: now,
      })
      .returning({ id: read.aiPassRuns.id });
    return { ...base, runId: row?.id ?? null, status: 'skipped', code };
  };

  const wg = await deps.gatewayFor(s.workspaceId);
  if (!wg) {
    return skip(
      'no_gateway',
      'No model is configured for this workspace, so the scheduled pass did not start. Add one in Admin → Models.',
    );
  }
  if (s.requireLocal) {
    const away = nonLocalConnections(wg.hosts, wg.routing);
    if (away.length > 0) {
      return skip(
        'not_local',
        `This schedule only runs on models on your network, and the pass could send code to ${away.join(', ')}. ` +
          'Route every role to a local connection (or turn on Local-only in Admin → Models), or allow hosted models on this schedule.',
      );
    }
  }
  const started = await startedThisMonth(db, s.workspaceId, s.repoId, now);
  if (started >= s.monthlyCap) {
    return skip(
      'monthly_cap',
      `This repository has had ${started} scheduled pass${started === 1 ? '' : 'es'} this month, the limit set on its schedule (${s.monthlyCap}). The next one can start next month, or an admin can raise the limit.`,
    );
  }
  const today = await passesInLastDay(db, s.workspaceId, now);
  if (today >= AI_PASSES_PER_DAY) {
    return skip(
      'daily_limit',
      `This workspace has started ${today} passes in the last 24 hours (limit ${AI_PASSES_PER_DAY}), so the scheduled pass did not start.`,
    );
  }
  const [active] = await db
    .select({ id: read.aiPassRuns.id })
    .from(read.aiPassRuns)
    .where(
      and(
        eq(read.aiPassRuns.workspaceId, s.workspaceId),
        eq(read.aiPassRuns.repoId, s.repoId),
        sql`status in ('pending', 'running')`,
      ),
    )
    .limit(1);
  const alreadyRunning = (): Promise<SweepOutcome> =>
    skip(
      'already_running',
      'A pass was already queued or running for this repository, so the scheduled one did not start. It is due again at the next interval.',
    );
  if (active) return alreadyRunning();

  let scope: {
    paths: string[];
    baseRef: string | null;
    headRef: string | null;
    note: string | null;
  };
  if (s.scope === 'paths') {
    if (s.paths.length === 0) {
      return skip(
        'no_paths',
        'This schedule reviews fixed paths and names none. Edit the schedule.',
      );
    }
    scope = { paths: s.paths, baseRef: null, headRef: null, note: null };
  } else {
    const pick = await pickNewCommits(db, s.workspaceId, s.repoId, s.lastHeadSha);
    if (!pick.ok) return skip(pick.code, pick.reason);
    scope = {
      paths: [],
      baseRef: pick.base,
      headRef: pick.head,
      note:
        pick.skippedOlder > 0
          ? `${pick.skippedOlder} older new commit${pick.skippedOlder === 1 ? ' was' : 's were'} not reviewed: a pass reviews at most ${AI_PASS_MAX_COMMITS} commits, so this one took the newest.`
          : null,
    };
  }

  let runId: number;
  try {
    const [row] = await db
      .insert(read.aiPassRuns)
      .values({
        workspaceId: s.workspaceId,
        repoId: s.repoId,
        trigger: 'schedule',
        scheduleId: s.id,
        paths: scope.paths,
        mode,
        baseRef: scope.baseRef,
        headRef: scope.headRef,
        // A note about what was left out, shown with the run; the processor
        // overwrites it only with a failure reason.
        reason: scope.note,
        createdAt: now,
      })
      .returning({ id: read.aiPassRuns.id });
    runId = row!.id;
  } catch (err) {
    // A person started one between our check and our insert: theirs stands.
    if (isConstraintViolation(err, 'ai_pass_runs_one_active_key')) return alreadyRunning();
    throw err;
  }
  if (scope.headRef) {
    await db
      .update(read.aiPassSchedules)
      .set({ lastHeadSha: scope.headRef })
      .where(
        and(eq(read.aiPassSchedules.id, s.id), eq(read.aiPassSchedules.workspaceId, s.workspaceId)),
      );
  }
  await deps.enqueue(s.workspaceId, runId);
  return { ...base, runId, status: 'started' };
}

/**
 * The ai.pass queue's processor: the sweep job runs the sweep, every other job is
 * one pass. One queue, so a sweep never sits behind (or in front of) a scan.
 */
export function withScheduleSweep<T>(
  sweep: () => Promise<SweepOutcome[]>,
  runPass: (job: Job) => Promise<T>,
): (job: Job) => Promise<T | SweepOutcome[]> {
  return (job) => (job.name === AI_SCHEDULE_SWEEP_JOB ? sweep() : runPass(job));
}
