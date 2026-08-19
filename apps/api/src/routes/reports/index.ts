import { createReadStream } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { auditLog, read, type Database } from '@repopulse/shared';
import { uriToPath, type ReportParams, type ReportType } from '@repopulse/reports';
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
}

const TYPES: ReportType[] = ['repo_health', 'org_exec', 'security_posture', 'delivery_dora'];
const WINDOWS = [7, 30, 90, 365];

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
  app.post<{ Body: { type?: unknown; repo_ids?: unknown; window_days?: unknown } }>(
    '/reports',
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      const userId = request.session.get('userId');
      if (workspaceId === undefined || userId === undefined) {
        return fail(request, reply, 401, 'No active session');
      }

      const type = request.body?.type;
      if (typeof type !== 'string' || !TYPES.includes(type as ReportType)) {
        return fail(request, reply, 400, 'Invalid report type', 'type must be one of ' + TYPES.join(', '));
      }
      const windowDays = Number(request.body?.window_days ?? 30);
      if (!WINDOWS.includes(windowDays)) {
        return fail(request, reply, 400, 'Invalid window', 'window_days must be one of ' + WINDOWS.join(', '));
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
    },
  );

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
      items: rows.map((r) => ({
        id: r.id,
        type: r.type,
        status: r.status,
        params: r.params,
        generated_at: r.generatedAt.toISOString(),
        error: r.error,
        has_pdf: r.pdfUri !== null,
      })),
    });
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
      has_pdf: row.pdfUri !== null,
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
    if (!row.pdfUri) return fail(request, reply, 409, 'Report is not ready', 'status: ' + row.status);

    const path = uriToPath(row.pdfUri);
    try {
      await stat(path);
    } catch {
      // 410, not 404: the report exists and its row says ready — what is gone
      // is the file, and saying so is what lets someone regenerate instead of
      // wondering whether they mistyped the id.
      return fail(request, reply, 410, 'Report artifact is gone', 'The PDF was removed from storage.');
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
}
