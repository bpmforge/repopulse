import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { auditLog, read, type Database } from '@repopulse/shared';
import { requireAdmin } from '../../lib/rbac.js';
import {
  artifactPresent,
  diffReports,
  uriToPath,
  type ReportData,
  type ReportParams,
  type ReportType,
} from '@repopulse/reports';
import { sendProblem } from '../../lib/problem.js';

// Report Center API (W5-04, FR-REPORTS-1/6/7, REPORTS.md §4).
//
// Downloads stream THROUGH this API behind the session check. Artifacts live on
// a local volume and must never be served from a public static path
// (REPORTS.md §4): a report carries an organisation's delivery data, and a
// guessable URL is a leak no amount of filename entropy fixes.

export interface ReportsRoutesOptions {
  db: Database;
  /** Enqueue onto reports.generate. Injectable so tests run without Redis. */
  enqueueReport?: (data: {
    reportId: number;
    workspaceId: number;
    params: ReportParams;
  }) => Promise<void>;
  /**
   * Repeatable-job seam for scheduled generation (R-A10). BullMQ already
   * stores and lists repeatable jobs, so there is no schedules TABLE — a table
   * would be a second source of truth that can disagree with the scheduler
   * actually holding the timer. Injectable so tests run without Redis.
   */
  schedules?: {
    list: (
      workspaceId: number,
    ) => Promise<{ key: string; type: string; cadence: string; next: number | null }[]>;
    add: (workspaceId: number, type: string, cadence: string, windowDays: number) => Promise<void>;
    remove: (workspaceId: number, key: string) => Promise<void>;
  };
}

const TYPES: ReportType[] = [
  'repo_health',
  'org_exec',
  'security_posture',
  'delivery_dora',
  // W9-06 (FR-REPORTS-8).
  'code_health',
];
const WINDOWS = [7, 30, 90, 365];

/**
 * The download question, answered from the DISK (W17-26). `has_pdf` used to be
 * `pdfUri !== null`, which is the row's memory of a file that may since have
 * been removed with its volume, cleaned with a scratch dir, or truncated by a
 * worker recreated mid-write; every one of those left a PDF link that opened a
 * 410. `artifact_missing` names the fourth state — the row says ready, the
 * file is gone — so the screen can offer regeneration instead of a link.
 */
async function artifactFields(row: {
  status: string;
  pdfUri: string | null;
}): Promise<{ has_pdf: boolean; artifact_missing: boolean }> {
  const present = await artifactPresent(row.pdfUri);
  return { has_pdf: present, artifact_missing: row.status === 'ready' && !present };
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

export default async function reportsRoutes(
  app: FastifyInstance,
  opts: ReportsRoutesOptions,
): Promise<void> {
  const { db } = opts;

  /** POST /reports — pin the params, then queue the generation. */
  app.post<{
    Body: { type?: unknown; repo_ids?: unknown; window_days?: unknown; annotation?: unknown };
  }>('/reports', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    const userId = request.session.get('userId');
    if (workspaceId === undefined || userId === undefined) {
      return fail(request, reply, 401, 'No active session');
    }

    const type = request.body?.type;
    if (typeof type !== 'string' || !TYPES.includes(type as ReportType)) {
      return fail(
        request,
        reply,
        400,
        'Invalid report type',
        'type must be one of ' + TYPES.join(', '),
      );
    }
    const windowDays = Number(request.body?.window_days ?? 30);
    if (!WINDOWS.includes(windowDays)) {
      return fail(
        request,
        reply,
        400,
        'Invalid window',
        'window_days must be one of ' + WINDOWS.join(', '),
      );
    }
    const repoIds = Array.isArray(request.body?.repo_ids)
      ? (request.body.repo_ids as unknown[]).map(Number).filter(Number.isInteger)
      : [];

    // "now" and the snapshot high-watermark resolve ONCE, here, and are
    // stored with the report (FR-REPORTS-7). Resolving them in the worker
    // would make two reports queued a second apart disagree, and would make
    // "regenerate with the same scope" quietly mean a different scope.
    const now = new Date();
    const params: ReportParams = {
      type: type as ReportType,
      workspaceId: String(workspaceId),
      repoIds: repoIds.map(String),
      windowDays: windowDays as ReportParams['windowDays'],
      windowEnd: now.toISOString(),
      snapshotAt: now.toISOString(),
      weightsVersion: 'v1',
      catalogVersion: 'v1',
      // Captured at generation and stored IN the params (R-A11), never as a
      // mutable column: a report is immutable, so changing the note means
      // generating a new report. That is the property that makes a report
      // quotable weeks later.
      ...(typeof request.body?.annotation === 'string' && request.body.annotation.trim() !== ''
        ? { annotation: request.body.annotation.trim().slice(0, 2000) }
        : {}),
    };

    const [row] = await db
      .insert(read.reports)
      .values({
        workspaceId,
        type: params.type,
        params: params as unknown as Record<string, unknown>,
        status: 'queued',
        generatedBy: userId,
      })
      .returning();

    await opts.enqueueReport?.({ reportId: row!.id, workspaceId, params });

    auditLog(request.log, {
      event: 'report.generated',
      actorUserId: userId,
      workspaceId,
      ip: request.ip,
      ua: request.headers['user-agent'] ?? null,
      reportId: row!.id,
      reportType: params.type,
    });

    return reply.code(201).send({ id: row!.id, status: row!.status, params });
  });

  /** GET /reports — history, newest first. */
  app.get('/reports', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
    const rows = await db
      .select()
      .from(read.reports)
      .where(eq(read.reports.workspaceId, workspaceId))
      .orderBy(desc(read.reports.generatedAt))
      .limit(100);
    return reply.send({
      items: await Promise.all(
        rows.map(async (r) => ({
          id: r.id,
          type: r.type,
          status: r.status,
          params: r.params,
          generated_at: r.generatedAt.toISOString(),
          error: r.error,
          ...(await artifactFields(r)),
        })),
      ),
    });
  });

  /**
   * POST /reports/:id/retry — queue the SAME row again (W17-26).
   *
   * A failed report had no way back but "generate another one", which loses
   * the pinned params: the retry would resolve a new `snapshotAt` and quietly
   * measure a different moment. Re-queueing the row keeps the pins, the id
   * people already shared, and the annotation. Allowed for a failed report and
   * for a ready one whose artifact is gone — never for a queued or running one,
   * where a second job would race the first over the same files.
   */
  app.post<{ Params: { id: string } }>('/reports/:id/retry', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    const userId = request.session.get('userId');
    if (workspaceId === undefined || userId === undefined) {
      return fail(request, reply, 401, 'No active session');
    }
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return fail(request, reply, 400, 'Invalid report id');

    const [row] = await db
      .select()
      .from(read.reports)
      .where(and(eq(read.reports.id, id), eq(read.reports.workspaceId, workspaceId)))
      .limit(1);
    if (!row) return fail(request, reply, 404, 'Not Found');

    const { artifact_missing } = await artifactFields(row);
    if (row.status !== 'failed' && !artifact_missing) {
      return fail(
        request,
        reply,
        409,
        'Report cannot be retried',
        row.status === 'ready'
          ? 'This report is ready and its PDF is present.'
          : 'status: ' + row.status,
      );
    }

    // Guarded on the status that was read: two people pressing Retry on the
    // same failed row queue ONE job — the second UPDATE matches nothing.
    const [requeued] = await db
      .update(read.reports)
      // generated_at moves to now: it is when this row was last queued, which
      // is what the history sorts by and what the screen's stale-job cutoff
      // measures from. The pinned window and snapshot live in params and do
      // not move — that is the point of retrying rather than regenerating.
      .set({ status: 'queued', error: null, pdfUri: null, generatedAt: new Date() })
      .where(and(eq(read.reports.id, id), eq(read.reports.status, row.status)))
      .returning({ id: read.reports.id });
    if (!requeued)
      return fail(request, reply, 409, 'Report cannot be retried', 'Its status just changed.');

    const params = row.params as unknown as ReportParams;
    await opts.enqueueReport?.({ reportId: row.id, workspaceId, params });

    auditLog(request.log, {
      event: 'report.generated',
      actorUserId: userId,
      workspaceId,
      ip: request.ip,
      ua: request.headers['user-agent'] ?? null,
      reportId: row.id,
      reportType: row.type,
      retry: true,
    });

    return reply.code(202).send({ id: row.id, status: 'queued', params });
  });

  /** GET /reports/:id — one report, with its stored ReportData when present. */
  app.get<{ Params: { id: string } }>('/reports/:id', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return fail(request, reply, 400, 'Invalid report id');

    const [row] = await db
      .select()
      .from(read.reports)
      .where(and(eq(read.reports.id, id), eq(read.reports.workspaceId, workspaceId)))
      .limit(1);
    // Tenancy (Law 5): another workspace's report is a 404, never a 403.
    if (!row) return fail(request, reply, 404, 'Not Found');

    let data: unknown = null;
    if (row.jsonUri) {
      try {
        data = JSON.parse(await readFile(uriToPath(row.jsonUri), 'utf8'));
      } catch {
        // A missing artifact must not 500 the status endpoint: the ROW is the
        // truth about whether generation succeeded, and the viewer can say the
        // artifact is gone rather than the report having failed.
        data = null;
      }
    }

    return reply.send({
      id: row.id,
      type: row.type,
      status: row.status,
      params: row.params,
      generated_at: row.generatedAt.toISOString(),
      error: row.error,
      ...(await artifactFields(row)),
      data,
    });
  });

  /** GET /reports/:id/download — streamed, session-checked, audited. */
  app.get<{ Params: { id: string } }>('/reports/:id/download', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    const userId = request.session.get('userId');
    if (workspaceId === undefined || userId === undefined) {
      return fail(request, reply, 401, 'No active session');
    }
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return fail(request, reply, 400, 'Invalid report id');

    const [row] = await db
      .select()
      .from(read.reports)
      .where(and(eq(read.reports.id, id), eq(read.reports.workspaceId, workspaceId)))
      .limit(1);
    if (!row) return fail(request, reply, 404, 'Not Found');
    if (!row.pdfUri)
      return fail(request, reply, 409, 'Report is not ready', 'status: ' + row.status);

    const path = uriToPath(row.pdfUri);
    try {
      await stat(path);
    } catch {
      // 410, not 404: the report exists and its row says ready — what is gone
      // is the file, and saying so is what lets someone regenerate instead of
      // wondering whether they mistyped the id.
      return fail(
        request,
        reply,
        410,
        'Report artifact is gone',
        'The PDF was removed from storage.',
      );
    }

    auditLog(request.log, {
      event: 'report.downloaded',
      actorUserId: userId,
      workspaceId,
      ip: request.ip,
      ua: request.headers['user-agent'] ?? null,
      reportId: row.id,
    });

    return reply
      .header('content-type', 'application/pdf')
      .header('content-disposition', 'attachment; filename="report-' + row.id + '.pdf"')
      .send(createReadStream(path));
  });

  /** GET /reports/:id/diff/:otherId — per-row deltas between two reports. */
  app.get<{ Params: { id: string; otherId: string } }>(
    '/reports/:id/diff/:otherId',
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
      const ids = [Number(request.params.id), Number(request.params.otherId)];
      if (!ids.every(Number.isInteger)) return fail(request, reply, 400, 'Invalid report id');

      const rows = await db
        .select()
        .from(read.reports)
        .where(and(eq(read.reports.workspaceId, workspaceId), inArray(read.reports.id, ids)));
      if (rows.length !== 2) return fail(request, reply, 404, 'Not Found');

      const loaded: Record<number, ReportData | null> = {};
      for (const row of rows) {
        loaded[row.id] = null;
        if (!row.jsonUri) continue;
        try {
          loaded[row.id] = JSON.parse(await readFile(uriToPath(row.jsonUri), 'utf8')) as ReportData;
        } catch {
          loaded[row.id] = null;
        }
      }
      const before = loaded[ids[0] as number];
      const after = loaded[ids[1] as number];
      if (!before || !after) {
        // 409, not 500: both reports exist, but one has no stored data to
        // compare — which is a state, not a server fault.
        return fail(
          request,
          reply,
          409,
          'Report data unavailable',
          'One of these reports has no stored ReportData.',
        );
      }

      return reply.send({ before: ids[0], after: ids[1], ...diffReports(before, after) });
    },
  );

  /** GET /reports/schedules — what is scheduled, and when it next runs. */
  app.get('/reports/schedules', { preHandler: requireAdmin }, async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
    const items = (await opts.schedules?.list(workspaceId)) ?? [];
    return reply.send({ items });
  });

  /** POST /reports/schedules — admin-only. In-app only; no delivery channel (N-4). */
  app.post<{ Body: { type?: unknown; cadence?: unknown; window_days?: unknown } }>(
    '/reports/schedules',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      const userId = request.session.get('userId');
      if (workspaceId === undefined || userId === undefined) {
        return fail(request, reply, 401, 'No active session');
      }
      const type = request.body?.type;
      const cadence = request.body?.cadence;
      if (typeof type !== 'string' || !TYPES.includes(type as ReportType)) {
        return fail(request, reply, 400, 'Invalid report type');
      }
      if (cadence !== 'monthly' && cadence !== 'quarterly') {
        return fail(request, reply, 400, 'Invalid cadence', 'cadence must be monthly or quarterly');
      }
      const windowDays = Number(request.body?.window_days ?? 30);
      if (!WINDOWS.includes(windowDays)) return fail(request, reply, 400, 'Invalid window');

      await opts.schedules?.add(workspaceId, type, cadence, windowDays);
      auditLog(request.log, {
        event: 'report.scheduled',
        actorUserId: userId,
        workspaceId,
        ip: request.ip,
        ua: request.headers['user-agent'] ?? null,
        reportType: type,
        cadence,
      });
      return reply.code(201).send({ type, cadence, window_days: windowDays });
    },
  );

  /** DELETE /reports/schedules/:key — admin-only. */
  app.delete<{ Params: { key: string } }>(
    '/reports/schedules/:key',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
      await opts.schedules?.remove(workspaceId, decodeURIComponent(request.params.key));
      return reply.send({ key: request.params.key, deleted: true });
    },
  );
}
