import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { auditLog, core, read, type Database } from '@repopulse/shared';
import { requireAdmin } from '../../lib/rbac.js';
import { sendProblem } from '../../lib/problem.js';
import { passEgress, PASS_SENDS } from '../../lib/ai-pass-egress.js';
import {
  monthlyCallsUsed,
  monthlyCap,
  SCHEDULED_PASSES_PER_DAY,
  SCHEDULER_TICK_MS,
} from '../../workers/ai-pass-scheduler.js';
import { cleanPaths } from './index.js';

// Scheduled AI passes (W19-12), the API side. STRICTLY OPT-IN: a schedule is off
// until an admin saves it as enabled, and enabling needs the digest of where
// source would be sent (from GET .../schedule), which proves the admin was shown
// the current destinations. Reading is open to members, so they can see what is
// scheduled and what was skipped; every write is admin-only, workspace-scoped and
// audited. Nothing here starts a pass: the worker's scheduler does, within the caps.

const FREQUENCY_MS = { daily: 86_400_000, weekly: 7 * 86_400_000 } as const;

function fail(
  req: FastifyRequest,
  reply: FastifyReply,
  status: number,
  title: string,
  detail?: string,
): FastifyReply {
  sendProblem(req, reply, status, title, detail === undefined ? {} : { detail });
  return reply;
}

export interface ScheduleRoutesOptions {
  db: Database;
  now?: () => Date;
}

export default async function scheduleRoutes(
  app: FastifyInstance,
  opts: ScheduleRoutesOptions,
): Promise<void> {
  const { db } = opts;
  const now = opts.now ?? (() => new Date());

  async function ownRepo(workspaceId: number, repoId: number): Promise<boolean> {
    const [repo] = await db
      .select({ id: core.repos.id })
      .from(core.repos)
      .where(and(eq(core.repos.id, repoId), eq(core.repos.workspaceId, workspaceId)))
      .limit(1);
    return repo !== undefined;
  }

  const view = (r: typeof read.aiPassSchedules.$inferSelect, login: string | null) => ({
    enabled: r.enabled,
    frequency: r.frequency,
    scope: { kind: r.scopeKind, paths: r.paths },
    enabled_by: login,
    enabled_at: r.enabledAt,
    last_run_at: r.lastRunAt,
    next_run_at: r.nextRunAt,
    acknowledged: r.egressAck,
  });

  app.get<{ Params: { id: string } }>('/repos/:id/ai-pass/schedule', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
    const repoId = Number(request.params.id);
    if (!Number.isInteger(repoId)) return fail(request, reply, 400, 'Invalid repository id');
    if (!(await ownRepo(workspaceId, repoId)))
      return fail(request, reply, 404, 'No such repository');

    const [row] = await db
      .select({ s: read.aiPassSchedules, login: core.users.login })
      .from(read.aiPassSchedules)
      .leftJoin(core.users, eq(core.users.id, read.aiPassSchedules.enabledBy))
      .where(
        and(
          eq(read.aiPassSchedules.workspaceId, workspaceId),
          eq(read.aiPassSchedules.repoId, repoId),
        ),
      )
      .limit(1);
    const egress = await passEgress(db, workspaceId);
    const cap = await monthlyCap(db, workspaceId);
    const used = await monthlyCallsUsed(db, workspaceId, now());
    const runs = await db
      .select()
      .from(read.aiPassRuns)
      .where(
        and(
          eq(read.aiPassRuns.workspaceId, workspaceId),
          eq(read.aiPassRuns.repoId, repoId),
          eq(read.aiPassRuns.trigger, 'scheduled'),
        ),
      )
      .orderBy(desc(read.aiPassRuns.createdAt))
      .limit(10);
    return reply.send({
      // null = never configured: scheduling is off, said as such on the screen.
      schedule: row ? view(row.s, row.login ?? null) : null,
      // What would be acknowledged right now, and the digest to send back with it.
      egress: { ...egress, sends: PASS_SENDS },
      // The acknowledgement no longer matches the routing: the schedule will skip.
      acknowledgement_stale: row?.s.enabled === true && row.s.egressDigest !== egress.digest,
      monthly: { cap, used, remaining: Math.max(0, cap - used) },
      limits: { passes_per_day: SCHEDULED_PASSES_PER_DAY, tick_minutes: SCHEDULER_TICK_MS / 60000 },
      runs: runs.map((r) => ({
        id: r.id,
        status: r.status,
        mode: r.mode,
        pr_number: r.prNumber,
        paths: r.paths,
        reason_code: r.reasonCode,
        reason: r.reason,
        calls: r.calls,
        created_at: r.createdAt,
        finished_at: r.finishedAt,
      })),
    });
  });

  interface PutBody {
    enabled?: unknown;
    frequency?: unknown;
    scope?: { kind?: unknown; paths?: unknown };
    acknowledged_egress?: unknown;
  }

  app.put<{ Params: { id: string }; Body: PutBody }>(
    '/repos/:id/ai-pass/schedule',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      const userId = request.session?.get('userId');
      if (workspaceId === undefined || userId === undefined)
        return fail(request, reply, 401, 'No active session');
      const repoId = Number(request.params.id);
      if (!Number.isInteger(repoId)) return fail(request, reply, 400, 'Invalid repository id');
      if (!(await ownRepo(workspaceId, repoId)))
        return fail(request, reply, 404, 'No such repository');
      const body = request.body ?? {};
      if (typeof body.enabled !== 'boolean')
        return fail(
          request,
          reply,
          400,
          'Say whether to enable or disable',
          'enabled must be true or false.',
        );

      const [existing] = await db
        .select()
        .from(read.aiPassSchedules)
        .where(
          and(
            eq(read.aiPassSchedules.workspaceId, workspaceId),
            eq(read.aiPassSchedules.repoId, repoId),
          ),
        )
        .limit(1);
      const meta = {
        actorUserId: userId,
        workspaceId,
        ip: request.ip,
        ua: request.headers['user-agent'] ?? null,
      };

      // Disabling needs nothing but the admin. The configuration is kept.
      if (!body.enabled) {
        if (!existing || !existing.enabled) {
          return reply.send({ schedule: existing ? view(existing, null) : null });
        }
        const [updated] = await db
          .update(read.aiPassSchedules)
          .set({ enabled: false, nextRunAt: null, updatedAt: now() })
          .where(
            and(
              eq(read.aiPassSchedules.id, existing.id),
              eq(read.aiPassSchedules.workspaceId, workspaceId),
            ),
          )
          .returning();
        auditLog(request.log, {
          ...meta,
          event: 'ai_pass_schedule.disabled',
          detail: { repo_id: repoId, schedule_id: existing.id },
        });
        return reply.send({ schedule: view(updated!, null) });
      }

      // Enabling.
      const frequency = body.frequency;
      if (frequency !== 'daily' && frequency !== 'weekly')
        return fail(
          request,
          reply,
          400,
          'Choose a schedule',
          'frequency must be "daily" or "weekly".',
        );
      const kind = body.scope?.kind;
      if (kind !== 'paths' && kind !== 'new_pull_requests')
        return fail(
          request,
          reply,
          400,
          'Choose what to review',
          'scope.kind must be "paths" or "new_pull_requests".',
        );
      let paths: string[] = [];
      if (kind === 'paths') {
        const cleaned = cleanPaths(body.scope?.paths);
        if (typeof cleaned === 'string')
          return fail(request, reply, 400, 'Name what to review', cleaned);
        paths = cleaned;
      }

      // The acknowledgement: what leaves the network, as the server sees it NOW.
      const egress = await passEgress(db, workspaceId);
      if (egress.destinations.length === 0) {
        return fail(request, reply, 409, 'No model to run a schedule on', egress.sentence);
      }
      if (egress.local_only && egress.leaves_network) {
        return fail(
          request,
          reply,
          409,
          'Local-only forbids this',
          'Local-only is on, but a model a pass would use is off your network. A schedule will not run through a hosted link. Fix the routing first.',
        );
      }
      if (body.acknowledged_egress !== egress.digest) {
        return fail(
          request,
          reply,
          409,
          'Acknowledge where source is sent',
          'The destinations were not acknowledged, or they changed since you were shown them. Reload the schedule, read where source would be sent, and confirm.',
        );
      }

      const at = now();
      const values = {
        enabled: true,
        frequency: frequency as 'daily' | 'weekly',
        scopeKind: kind as 'paths' | 'new_pull_requests',
        paths,
        egressDigest: egress.digest,
        egressAck: {
          local_only: egress.local_only,
          leaves_network: egress.leaves_network,
          destinations: egress.destinations,
          acknowledged_at: at.toISOString(),
        } as Record<string, unknown>,
        enabledBy: userId,
        enabledAt: at,
        // Never at once: the first run is one interval away. A person who wants a
        // pass now starts one by hand.
        nextRunAt: new Date(at.getTime() + FREQUENCY_MS[frequency as 'daily' | 'weekly']),
        updatedAt: at,
      };
      const [saved] = existing
        ? await db
            .update(read.aiPassSchedules)
            .set(values)
            .where(
              and(
                eq(read.aiPassSchedules.id, existing.id),
                eq(read.aiPassSchedules.workspaceId, workspaceId),
              ),
            )
            .returning()
        : await db
            .insert(read.aiPassSchedules)
            .values({ ...values, workspaceId, repoId })
            .returning();
      auditLog(request.log, {
        ...meta,
        event: existing?.enabled ? 'ai_pass_schedule.updated' : 'ai_pass_schedule.enabled',
        detail: {
          repo_id: repoId,
          schedule_id: saved!.id,
          frequency,
          scope: kind,
          paths,
          egress_digest: egress.digest,
          leaves_network: egress.leaves_network,
          destinations: egress.destinations.map((d) => ({
            provider_id: d.provider_id,
            host: d.host,
            leaves_network: d.leaves_network,
          })),
        },
      });
      return reply.send({ schedule: view(saved!, null) });
    },
  );

  // ---- the workspace's monthly cap ----------------------------------------------

  app.get('/ai-pass/settings', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
    const cap = await monthlyCap(db, workspaceId);
    const used = await monthlyCallsUsed(db, workspaceId, now());
    return reply.send({
      monthly_call_cap: cap,
      used,
      remaining: Math.max(0, cap - used),
      default_cap: read.AI_PASS_DEFAULT_MONTHLY_CAP,
    });
  });

  app.put<{ Body: { monthly_call_cap?: unknown } }>(
    '/ai-pass/settings',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      const userId = request.session?.get('userId');
      if (workspaceId === undefined || userId === undefined)
        return fail(request, reply, 401, 'No active session');
      const cap = request.body?.monthly_call_cap;
      if (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 0 || cap > 100_000) {
        return fail(
          request,
          reply,
          400,
          'Invalid monthly cap',
          'monthly_call_cap must be a whole number from 0 to 100000. 0 stops every scheduled pass.',
        );
      }
      const at = now();
      await db
        .insert(read.aiPassSettings)
        .values({ workspaceId, monthlyCallCap: cap, updatedBy: userId, updatedAt: at })
        .onConflictDoUpdate({
          target: read.aiPassSettings.workspaceId,
          set: { monthlyCallCap: cap, updatedBy: userId, updatedAt: at },
        });
      auditLog(request.log, {
        event: 'ai_pass_settings.updated',
        actorUserId: userId,
        workspaceId,
        ip: request.ip,
        ua: request.headers['user-agent'] ?? null,
        detail: { monthly_call_cap: cap },
      });
      const used = await monthlyCallsUsed(db, workspaceId, at);
      return reply.send({
        monthly_call_cap: cap,
        used,
        remaining: Math.max(0, cap - used),
        default_cap: read.AI_PASS_DEFAULT_MONTHLY_CAP,
      });
    },
  );
}
