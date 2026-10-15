import { and, desc, eq, gte, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Queue } from 'bullmq';
import { auditLog, core, read, type Database } from '@repopulse/shared';
import { QUEUE, createQueue, createRedisConnection, type QueueName } from '@repopulse/ingest';
import { resolvePatchTarget } from '@repopulse/security';
import { sendProblem } from '../../lib/problem.js';

// Verified patches (W18-19, D16 "Verified + CI pull", API_DESIGN.md §2).
//
//   GET  /findings/:id/patch  — the verified fix for a finding, if there is one
//   POST /findings/:id/patch  — ask for one to be drafted and verified
//
// NOTHING HERE WRITES TO THE FORGE (D9a). The diff is served to the person who
// asked, who copies or downloads it and applies it with their own tools. There
// is no "open a PR" button because there is no write scope to open one with,
// and D16 reaffirmed that there will not be.
//
// WHAT A DEVELOPER SEES. A verified patch: the diff and a note that it was
// re-scanned. A rejected one: nothing — not the diff, not the reason. A patch
// that failed the re-scan is a patch the product does not stand behind, and
// showing it "for reference" would hand someone a diff that introduces a
// finding. Admins see the reason, because they are the ones who decide whether
// the model or the rules need attention.

/** Requests a workspace may make per rolling day. Each is a model call over a file of source. */
export const PATCH_DRAFTS_PER_DAY = 50;

/** Per-session request rate on POST (SC-11 style). */
export const PATCH_DRAFT_RATE_LIMIT = { max: 10, timeWindow: '1 minute' } as const;

export interface PatchRoutesOptions {
  db: Database;
  redisUrl?: string | undefined;
  /** Injectable so tests exercise the route without Redis. */
  queueFor?: (queue: QueueName) => Queue | undefined;
  /** Injectable clock for the daily cap. */
  now?: () => Date;
}

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

type PatchRow = typeof read.verifiedPatches.$inferSelect;

/** The file name a downloaded patch gets: the finding's file, made safe for a filename. */
function patchFilename(file: string, findingId: number): string {
  const base = file.split('/').pop() ?? 'fix';
  return `repopulse-finding-${findingId}-${base.replace(/[^A-Za-z0-9._-]/g, '_')}.patch`;
}

/**
 * The patch as THIS caller may see it.
 *
 * Projected rather than filtered client-side: a reason or a rejected diff that
 * reaches the browser has been disclosed, whatever the screen then does with
 * it.
 */
export function patchView(row: PatchRow, file: string, isAdmin: boolean) {
  const base = {
    id: row.id,
    status: row.status as 'pending' | 'verified' | 'rejected' | 'failed',
    commit_sha: row.commitSha,
    tier: row.tier,
    created_at: row.createdAt.toISOString(),
    finished_at: row.finishedAt?.toISOString() ?? null,
  };
  const admin = isAdmin ? { reason_code: row.reasonCode, reason: row.reason } : {};

  if (row.status === 'verified') {
    const runs = (row.verificationRuns ?? []) as { runner?: string; state?: string }[];
    return {
      ...base,
      ...admin,
      diff: row.diff,
      filename: patchFilename(file, row.findingId),
      model_id: row.modelId,
      verification: {
        // The re-scan, in summary: which rule sets ran on the original and the
        // patched file. Enough for "re-scanned with what?" without the noise.
        rule_sets: [...new Set(runs.map((r) => r.runner).filter((r): r is string => !!r))],
        runs: runs.length,
      },
    };
  }
  if (row.status === 'rejected') {
    // Admin: the reason, the code, and what the model produced. Anyone else:
    // that an attempt exists and nothing more.
    return isAdmin ? { ...base, ...admin, diff: row.diff, model_id: row.modelId } : base;
  }
  return { ...base, ...admin };
}

export default async function patchRoutes(
  app: FastifyInstance,
  opts: PatchRoutesOptions,
): Promise<void> {
  const { db } = opts;
  const now = opts.now ?? (() => new Date());
  const queues = new Map<string, Queue>();
  let connection: ReturnType<typeof createRedisConnection> | undefined;

  function queueFor(name: QueueName): Queue | undefined {
    if (opts.queueFor) return opts.queueFor(name);
    if (!opts.redisUrl) return undefined;
    let q = queues.get(name);
    if (!q) {
      connection ??= createRedisConnection(opts.redisUrl);
      q = createQueue(name, connection);
      queues.set(name, q);
    }
    return q;
  }

  app.addHook('onClose', async () => {
    for (const q of queues.values()) await q.close();
    await connection?.quit();
  });

  async function rowFor(workspaceId: number, findingId: number, commitSha: string) {
    const [row] = await db
      .select()
      .from(read.verifiedPatches)
      .where(
        and(
          eq(read.verifiedPatches.workspaceId, workspaceId),
          eq(read.verifiedPatches.findingId, findingId),
          eq(read.verifiedPatches.commitSha, commitSha),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** GET /findings/:id/patch */
  app.get<{ Params: { id: string } }>('/findings/:id/patch', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return fail(request, reply, 400, 'Invalid finding id');
    const isAdmin = request.role === 'admin';

    const target = await resolvePatchTarget(db, workspaceId, id);
    // Tenancy (Law 5): another workspace's finding is a 404, never a 403.
    if (!target.ok && target.status === 404) return fail(request, reply, 404, 'No such finding');
    if (!target.ok) {
      return reply.send({ eligible: false, reason: target.reason, patch: null });
    }

    const row = await rowFor(workspaceId, id, target.commitSha);
    return reply.send({
      eligible: true,
      commit_sha: target.commitSha,
      patch: row ? patchView(row, target.file, isAdmin) : null,
    });
  });

  /** POST /findings/:id/patch — draft and verify a fix. Nothing is written to the forge. */
  app.post<{ Params: { id: string }; Body: { tier?: unknown } | undefined }>(
    '/findings/:id/patch',
    { config: { rateLimit: PATCH_DRAFT_RATE_LIMIT } },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      const userId = request.session?.get('userId');
      if (workspaceId === undefined || userId === undefined) {
        return fail(request, reply, 401, 'No active session');
      }
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) return fail(request, reply, 400, 'Invalid finding id');
      const isAdmin = request.role === 'admin';

      // LOCAL BY DEFAULT. Tier-2 is the workspace's own model; Tier-3 sends a
      // file of source to a third party and needs BOTH an admin asking and the
      // repository's opt-in. The gateway enforces the opt-in again — this is
      // the early, explainable refusal, not the only one.
      const rawTier = request.body?.tier ?? 't2';
      if (rawTier !== 't2' && rawTier !== 't3') {
        return fail(request, reply, 400, 'Invalid tier', 'tier must be "t2" (default) or "t3".');
      }
      const tier = rawTier === 't3' ? 3 : 2;

      const target = await resolvePatchTarget(db, workspaceId, id);
      if (!target.ok && target.status === 404) return fail(request, reply, 404, 'No such finding');
      if (!target.ok)
        return fail(request, reply, 409, 'No verified fix can be drafted', target.reason);

      if (tier === 3) {
        if (!isAdmin) {
          return fail(request, reply, 403, 'Forbidden — admin role required for Tier-3');
        }
        const [repo] = await db
          .select({ optIn: core.repos.tier3OptIn })
          .from(core.repos)
          .where(and(eq(core.repos.id, target.repoId), eq(core.repos.workspaceId, workspaceId)))
          .limit(1);
        if (!repo?.optIn) {
          return fail(
            request,
            reply,
            409,
            'Tier-3 is not enabled for this repository',
            'Sending source to a cloud model needs the repository opt-in (Admin → Analysis). Draft with the local model instead.',
          );
        }
      }

      // IDEMPOTENT per finding and snapshot. A decided answer is returned, not
      // re-asked; an attempt that could not be made (`failed`) may be retried.
      const existing = await rowFor(workspaceId, id, target.commitSha);
      if (existing && existing.status !== 'failed') {
        return reply
          .code(existing.status === 'pending' ? 202 : 200)
          .send({ patch: patchView(existing, target.file, isAdmin) });
      }

      const since = new Date(now().getTime() - 24 * 60 * 60 * 1000);
      const [{ n } = { n: 0 }] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(read.verifiedPatches)
        .where(
          and(
            eq(read.verifiedPatches.workspaceId, workspaceId),
            gte(read.verifiedPatches.createdAt, since),
          ),
        );
      if (n >= PATCH_DRAFTS_PER_DAY) {
        return fail(
          request,
          reply,
          429,
          'Daily verified-fix limit reached',
          `This workspace has asked for ${n} fixes in the last 24 hours (limit ${PATCH_DRAFTS_PER_DAY}). Each one is a model call over a file of source.`,
        );
      }

      const queue = queueFor(QUEUE.patchDraft);
      if (!queue) {
        return fail(
          request,
          reply,
          503,
          'The job queue is unavailable',
          'Redis is not reachable from the API, so nothing can be started right now.',
        );
      }

      let row: PatchRow;
      if (existing) {
        const [reset] = await db
          .update(read.verifiedPatches)
          .set({
            status: 'pending',
            tier,
            reason: null,
            reasonCode: null,
            requestedBy: userId,
            createdAt: now(),
            finishedAt: null,
          })
          .where(eq(read.verifiedPatches.id, existing.id))
          .returning();
        row = reset!;
      } else {
        const [inserted] = await db
          .insert(read.verifiedPatches)
          .values({
            workspaceId,
            repoId: target.repoId,
            findingId: id,
            commitSha: target.commitSha,
            targetDedupKey: target.dedupKey,
            tier,
            requestedBy: userId,
            createdAt: now(),
          })
          .onConflictDoNothing()
          .returning();
        if (!inserted) {
          // Lost a race with a second click: the other request's row stands.
          const raced = await rowFor(workspaceId, id, target.commitSha);
          return reply
            .code(202)
            .send({ patch: raced ? patchView(raced, target.file, isAdmin) : null });
        }
        row = inserted;
      }

      try {
        await queue.add(
          'draft',
          { workspaceId, patchId: row.id, requestId: request.id },
          // Unique per attempt: a retried `failed` row must not collide with the
          // completed job its first attempt left behind.
          { jobId: `patch-${row.id}-${row.createdAt.getTime()}` },
        );
      } catch (err) {
        await db
          .update(read.verifiedPatches)
          .set({
            status: 'failed',
            reasonCode: 'queue_unavailable',
            reason: err instanceof Error ? err.message : String(err),
            finishedAt: now(),
          })
          .where(eq(read.verifiedPatches.id, row.id));
        return fail(request, reply, 503, 'The job queue is unavailable');
      }

      auditLog(request.log, {
        event: 'patch.draft_requested',
        actorUserId: userId,
        workspaceId,
        ip: request.ip,
        ua: request.headers['user-agent'] ?? null,
        detail: { finding_id: id, patch_id: row.id, tier, commit_sha: target.commitSha },
      });

      return reply.code(202).send({ patch: patchView(row, target.file, isAdmin) });
    },
  );

  /**
   * GET /admin/patches — recent attempts with their reasons (admin).
   *
   * Where an admin reads why fixes are being rejected: a model that keeps
   * producing diffs that do not apply, or a rule that every fix trips.
   */
  app.get('/admin/patches', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
    if (request.role !== 'admin')
      return fail(request, reply, 403, 'Forbidden — admin role required');
    const rows = await db
      .select({
        id: read.verifiedPatches.id,
        findingId: read.verifiedPatches.findingId,
        status: read.verifiedPatches.status,
        reasonCode: read.verifiedPatches.reasonCode,
        reason: read.verifiedPatches.reason,
        modelId: read.verifiedPatches.modelId,
        tier: read.verifiedPatches.tier,
        createdAt: read.verifiedPatches.createdAt,
      })
      .from(read.verifiedPatches)
      .where(eq(read.verifiedPatches.workspaceId, workspaceId))
      .orderBy(desc(read.verifiedPatches.createdAt))
      .limit(100);
    return reply.send({
      items: rows.map((r) => ({
        id: r.id,
        finding_id: r.findingId,
        status: r.status,
        reason_code: r.reasonCode,
        reason: r.reason,
        model_id: r.modelId,
        tier: r.tier,
        created_at: r.createdAt.toISOString(),
      })),
    });
  });
}
