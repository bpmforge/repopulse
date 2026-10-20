import { and, asc, desc, eq, gt, gte, lte, or, sql } from 'drizzle-orm';
import { core, facts, isConstraintViolation, read, type Database } from '@repopulse/shared';
import { passEgress as defaultPassEgress, type PassEgress } from '../lib/ai-pass-egress.js';
import { AI_PASS_MAX_CALLS } from './ai-pass-processor.js';

// The AI-pass scheduler (W19-12). STRICTLY OPT-IN: it only ever looks at schedules
// an admin saved as enabled, each carrying the acknowledgement of where source
// would be sent. It runs in the worker (never the API), reads the forge only
// through the pass's own budgeted loaders, and does the same thing a person's
// click does: queue an `ai.pass` job. It cannot suppress, resolve, merge or write
// to a repository - a pass never does.
//
// EVERY REFUSAL IS RECORDED. A tick that does not start a pass writes a `skipped`
// pass row with a reason a person can read; nothing is silently dropped. Hard
// stops, in order: another pass already running, no model, local-only forbidding a
// hosted link, the routing having changed since the acknowledgement, the
// workspace's monthly call cap, the daily pass limit, and (for the pull-request
// scope) nothing new to review.

/** How often the worker looks for due schedules. */
export const SCHEDULER_TICK_MS = 15 * 60 * 1000;
/** Most schedules one tick will start, so a backlog cannot stampede the model. */
export const MAX_STARTS_PER_TICK = 5;
/** Passes per workspace per 24 h - the same limit as a manual start. */
export const SCHEDULED_PASSES_PER_DAY = 10;
/** Below this many calls left in the month, a pass is not worth starting. */
export const MIN_CALLS_TO_START = 4;
/** After a transient refusal (active pass, daily limit) look again in this long. */
const RETRY_MS = 3 * 60 * 60 * 1000;
/** After starting a pull-request pass with more waiting, look again in this long. */
const DRAIN_MS = 60 * 60 * 1000;
const FREQUENCY_MS = { daily: 24 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000 } as const;
/**
 * W20-11 (UX_TODO AI-62): a pull-request head whose scheduled review FAILED is
 * tried again on later runs, at most this many times in all. A failure used to
 * count as "reviewed", and the PR was never looked at again unless someone pushed.
 */
export const PR_REVIEW_ATTEMPTS = 3;

/**
 * The server's time zone (W20-18, UX_TODO AI-53; decision 2026-10-20): a run
 * window is in the SERVER's hours, and the screen names this zone beside it.
 */
export function serverTimeZone(): string {
  try {
    // Intl already honours TZ when it is set; nothing else is read here.
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Whether `at` falls in [start, end) of the server's hours; end before start wraps midnight. */
export function inRunWindow(at: Date, start: number | null, end: number | null): boolean {
  if (start === null || end === null) return true;
  const h = at.getHours();
  return start < end ? h >= start && h < end : h >= start || h < end;
}

/** The next time the window opens after `at` (start hour, server time). */
export function nextWindowStart(at: Date, start: number): Date {
  const next = new Date(at.getTime());
  next.setHours(start, 0, 0, 0);
  if (next.getTime() <= at.getTime()) next.setDate(next.getDate() + 1);
  return next;
}

/** A due time moved into the window: unchanged if inside, else the window's next opening. */
export function intoRunWindow(at: Date, start: number | null, end: number | null): Date {
  if (start === null || end === null || inRunWindow(at, start, end)) return at;
  return nextWindowStart(at, start);
}

export interface SchedulerAudit {
  (
    event: 'ai_pass.scheduled_started' | 'ai_pass.scheduled_skipped',
    detail: Record<string, unknown>,
    workspaceId: number,
  ): void;
}

export interface SchedulerDeps {
  db: Database;
  /** Queue the pass job. */
  enqueue: (data: { workspaceId: number; runId: number; maxCalls: number }) => Promise<void>;
  now?: () => Date;
  egress?: (db: Database, workspaceId: number) => Promise<PassEgress>;
  audit?: SchedulerAudit;
}

export interface TickResult {
  considered: number;
  started: number;
  skipped: number;
}

/** First day of the calendar month, UTC. */
export function monthStart(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
}

/** Model calls this workspace's passes (manual and scheduled) have used this month. */
export async function monthlyCallsUsed(
  db: Database,
  workspaceId: number,
  now: Date,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`coalesce(sum(${read.aiPassRuns.calls}), 0)::int` })
    .from(read.aiPassRuns)
    .where(
      and(
        eq(read.aiPassRuns.workspaceId, workspaceId),
        gte(read.aiPassRuns.createdAt, monthStart(now)),
      ),
    );
  return row?.n ?? 0;
}

export async function monthlyCap(db: Database, workspaceId: number): Promise<number> {
  const [row] = await db
    .select({ cap: read.aiPassSettings.monthlyCallCap })
    .from(read.aiPassSettings)
    .where(eq(read.aiPassSettings.workspaceId, workspaceId))
    .limit(1);
  return row?.cap ?? read.AI_PASS_DEFAULT_MONTHLY_CAP;
}

export async function runScheduleTick(deps: SchedulerDeps): Promise<TickResult> {
  const { db } = deps;
  const now = (deps.now ?? (() => new Date()))();
  const egressOf = deps.egress ?? defaultPassEgress;
  const result: TickResult = { considered: 0, started: 0, skipped: 0 };

  // W20-18 (UX_TODO AI-77): a workspace with AI switched off is not looked at:
  // no pass starts and no skip row is written for every tick while it is off.
  // The schedules keep their settings and resume when AI is switched back on.
  const due = await db
    .select()
    .from(read.aiPassSchedules)
    .where(
      and(
        eq(read.aiPassSchedules.enabled, true),
        lte(read.aiPassSchedules.nextRunAt, now),
        sql`not exists (select 1 from ai_pass_settings st where st.workspace_id = ${read.aiPassSchedules.workspaceId} and st.ai_paused)`,
      ),
    )
    .orderBy(asc(read.aiPassSchedules.nextRunAt))
    .limit(50);

  for (const sch of due) {
    if (result.started >= MAX_STARTS_PER_TICK) break;
    result.considered += 1;
    const ws = sch.workspaceId;
    const interval = FREQUENCY_MS[sch.frequency];

    // W20-18 (UX_TODO AI-53): outside the run window nothing is due yet. The
    // run moves to the window's next opening (server time); not a skip, so no
    // row is written. Compare-and-set like the claim below.
    if (!inRunWindow(now, sch.windowStartHour, sch.windowEndHour)) {
      await db
        .update(read.aiPassSchedules)
        .set({ nextRunAt: nextWindowStart(now, sch.windowStartHour!), updatedAt: now })
        .where(
          and(
            eq(read.aiPassSchedules.id, sch.id),
            eq(read.aiPassSchedules.workspaceId, ws),
            eq(read.aiPassSchedules.nextRunAt, sch.nextRunAt!),
          ),
        );
      continue;
    }

    // Claim the slot first (compare-and-set on next_run_at), so a second worker or
    // an overlapping tick cannot start the same schedule twice.
    const claimed = await db
      .update(read.aiPassSchedules)
      .set({ nextRunAt: new Date(now.getTime() + interval), updatedAt: now })
      .where(
        and(
          eq(read.aiPassSchedules.id, sch.id),
          eq(read.aiPassSchedules.workspaceId, ws),
          eq(read.aiPassSchedules.enabled, true),
          eq(read.aiPassSchedules.nextRunAt, sch.nextRunAt!),
        ),
      )
      .returning({ id: read.aiPassSchedules.id });
    if (claimed.length === 0) continue;

    const retryAt = (ms: number) =>
      db
        .update(read.aiPassSchedules)
        .set({ nextRunAt: new Date(now.getTime() + ms) })
        .where(and(eq(read.aiPassSchedules.id, sch.id), eq(read.aiPassSchedules.workspaceId, ws)));

    const skip = async (code: string, reason: string, transient: boolean) => {
      await db.insert(read.aiPassRuns).values({
        workspaceId: ws,
        repoId: sch.repoId,
        requestedBy: sch.enabledBy,
        paths: sch.scopeKind === 'paths' ? sch.paths : [],
        mode: sch.scopeKind === 'paths' ? 'paths' : 'pull_request',
        trigger: 'scheduled',
        scheduleId: sch.id,
        status: 'skipped',
        reasonCode: code,
        reason,
        createdAt: now,
        finishedAt: now,
      });
      if (transient) await retryAt(RETRY_MS);
      deps.audit?.(
        'ai_pass.scheduled_skipped',
        { schedule_id: sch.id, repo_id: sch.repoId, code },
        ws,
      );
      result.skipped += 1;
    };

    // The repository must still belong to the workspace (Law 5).
    const [repo] = await db
      .select({ id: core.repos.id })
      .from(core.repos)
      .where(and(eq(core.repos.id, sch.repoId), eq(core.repos.workspaceId, ws)))
      .limit(1);
    if (!repo) {
      await skip('not_found', 'The repository no longer exists in this workspace.', false);
      continue;
    }

    // 1. One active pass per repository.
    const [active] = await db
      .select({ id: read.aiPassRuns.id })
      .from(read.aiPassRuns)
      .where(
        and(
          eq(read.aiPassRuns.workspaceId, ws),
          eq(read.aiPassRuns.repoId, sch.repoId),
          sql`status in ('pending', 'running')`,
        ),
      )
      .limit(1);
    if (active) {
      await skip(
        'active_pass',
        'Another pass was already running for this repository, so the scheduled pass did not start. It will look again later.',
        true,
      );
      continue;
    }

    // 2. A model, local-only, and the acknowledged destinations.
    const egress = await egressOf(db, ws);
    if (egress.destinations.length === 0) {
      await skip('no_gateway', egress.sentence, false);
      continue;
    }
    if (egress.local_only && egress.leaves_network) {
      await skip(
        'local_only_forbids',
        'Local-only is on, but a model this pass would use is off your network. Nothing was sent. Fix the routing or turn local-only off, then re-enable the schedule.',
        false,
      );
      continue;
    }
    if (egress.digest !== sch.egressDigest) {
      await skip(
        'routing_changed',
        'The models this workspace routes to have changed since this schedule was enabled, so it did not run. Open the schedule and acknowledge where source is sent now to continue.',
        false,
      );
      continue;
    }

    // 3. The workspace's monthly call cap (hard) and the daily pass limit.
    const cap = await monthlyCap(db, ws);
    const used = await monthlyCallsUsed(db, ws, now);
    const remaining = cap - used;
    if (remaining < MIN_CALLS_TO_START) {
      await skip(
        'cap_reached',
        `This workspace's monthly cap of ${cap} model calls is used up (${used} so far this month), so the scheduled pass did not run. It resumes next month, or when an admin raises the cap.`,
        false,
      );
      continue;
    }
    const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const [{ n: today } = { n: 0 }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(read.aiPassRuns)
      .where(
        and(
          eq(read.aiPassRuns.workspaceId, ws),
          gte(read.aiPassRuns.createdAt, since),
          sql`status <> 'skipped'`,
        ),
      );
    if (today >= SCHEDULED_PASSES_PER_DAY) {
      await skip(
        'daily_limit',
        `This workspace has already started ${today} passes in the last 24 hours (limit ${SCHEDULED_PASSES_PER_DAY}). It will look again later.`,
        true,
      );
      continue;
    }

    // 4. The scope: the configured paths, or the oldest pull request not yet reviewed.
    let scope:
      | { mode: 'paths'; paths: string[] }
      | { mode: 'pull_request'; prNumber: number; headSha: string; more: boolean };
    if (sch.scopeKind === 'paths') {
      if (sch.paths.length === 0) {
        await skip('no_scope', 'No paths are configured for this schedule.', false);
        continue;
      }
      // W20-11 (UX_TODO AI-84): the paths scope re-read the same code at every
      // interval, spending up to 30 calls a day of the cap (and, on a hosted
      // model, sending the same source out again). When the repository's head
      // has not moved since this schedule's last finished pass over the same
      // paths, nothing there can have changed, so it does not run.
      const [head] = await db
        .select({ sha: facts.commits.sha })
        .from(facts.commits)
        .where(and(eq(facts.commits.workspaceId, ws), eq(facts.commits.repoId, sch.repoId)))
        .orderBy(desc(facts.commits.committedAt))
        .limit(1);
      const [last] = await db
        .select({ commitSha: read.aiPassRuns.commitSha, paths: read.aiPassRuns.paths })
        .from(read.aiPassRuns)
        .where(
          and(
            eq(read.aiPassRuns.workspaceId, ws),
            eq(read.aiPassRuns.scheduleId, sch.id),
            eq(read.aiPassRuns.mode, 'paths'),
            eq(read.aiPassRuns.status, 'succeeded'),
          ),
        )
        .orderBy(desc(read.aiPassRuns.createdAt))
        .limit(1);
      const samePaths =
        last !== undefined &&
        [...last.paths].sort().join('\n') === [...sch.paths].sort().join('\n');
      if (head?.sha && samePaths && last?.commitSha === head.sha) {
        await skip(
          'unchanged',
          `No new commit has been ingested since the last scheduled pass reviewed these paths (at ${head.sha.slice(0, 8)}), so it did not run again.`,
          false,
        );
        continue;
      }
      scope = { mode: 'paths', paths: sch.paths };
    } else {
      const sinceDate = sch.lastRunAt ?? sch.enabledAt ?? now;
      const candidates = await db
        .select({
          number: facts.pullRequests.number,
          headSha: facts.pullRequests.headSha,
        })
        .from(facts.pullRequests)
        .where(
          and(
            eq(facts.pullRequests.workspaceId, ws),
            eq(facts.pullRequests.repoId, sch.repoId),
            eq(facts.pullRequests.state, 'open'),
            eq(facts.pullRequests.isDraft, false),
            // W20-11 (UX_TODO AI-62): a head whose review failed is due again
            // even though the PR has not changed since, and a failure is not
            // "already reviewed" - up to PR_REVIEW_ATTEMPTS failures per head.
            or(
              gt(facts.pullRequests.updatedAt, sinceDate),
              sql`exists (select 1 from ai_pass_runs r where r.workspace_id = ${ws} and r.repo_id = ${sch.repoId} and r.mode = 'pull_request' and r.pr_number = ${facts.pullRequests.number} and r.head_ref = ${facts.pullRequests.headSha} and r.status = 'failed')`,
            ),
            sql`not exists (select 1 from ai_pass_runs r where r.workspace_id = ${ws} and r.repo_id = ${sch.repoId} and r.mode = 'pull_request' and r.pr_number = ${facts.pullRequests.number} and r.head_ref = ${facts.pullRequests.headSha} and r.status not in ('skipped', 'failed'))`,
            sql`(select count(*) from ai_pass_runs r where r.workspace_id = ${ws} and r.repo_id = ${sch.repoId} and r.mode = 'pull_request' and r.pr_number = ${facts.pullRequests.number} and r.head_ref = ${facts.pullRequests.headSha} and r.status = 'failed') < ${PR_REVIEW_ATTEMPTS}`,
          ),
        )
        .orderBy(asc(facts.pullRequests.updatedAt))
        .limit(2);
      const first = candidates[0];
      if (!first) {
        await skip(
          'no_new_pull_requests',
          'No open, non-draft pull request has changed since the last scheduled run, so there was nothing new to review.',
          false,
        );
        continue;
      }
      scope = {
        mode: 'pull_request',
        prNumber: first.number,
        headSha: first.headSha,
        more: candidates.length > 1,
      };
    }

    // 5. Start it - exactly what a person's click does, marked as scheduled.
    let runId: number;
    try {
      const [run] = await db
        .insert(read.aiPassRuns)
        .values({
          workspaceId: ws,
          repoId: sch.repoId,
          requestedBy: sch.enabledBy,
          paths: scope.mode === 'paths' ? scope.paths : [],
          mode: scope.mode,
          ...(scope.mode === 'pull_request'
            ? { prNumber: scope.prNumber, headRef: scope.headSha }
            : {}),
          trigger: 'scheduled',
          scheduleId: sch.id,
          createdAt: now,
        })
        .returning({ id: read.aiPassRuns.id });
      runId = run!.id;
    } catch (err) {
      if (isConstraintViolation(err, 'ai_pass_runs_one_active_key')) {
        await skip('active_pass', 'Another pass started first, so this one did not.', true);
        continue;
      }
      throw err;
    }
    await deps.enqueue({
      workspaceId: ws,
      runId,
      maxCalls: Math.min(AI_PASS_MAX_CALLS, remaining),
    });
    await db
      .update(read.aiPassSchedules)
      .set({
        lastRunAt: now,
        ...(scope.mode === 'pull_request' && scope.more
          ? { nextRunAt: new Date(now.getTime() + DRAIN_MS) }
          : {}),
        updatedAt: now,
      })
      .where(and(eq(read.aiPassSchedules.id, sch.id), eq(read.aiPassSchedules.workspaceId, ws)));
    deps.audit?.(
      'ai_pass.scheduled_started',
      { schedule_id: sch.id, repo_id: sch.repoId, run_id: runId, mode: scope.mode },
      ws,
    );
    result.started += 1;
  }
  return result;
}
