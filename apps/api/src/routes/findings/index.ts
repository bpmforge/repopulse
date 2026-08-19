import { and, desc, eq, gte, inArray, lt, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { auditLog, core, read, type Database } from '@repopulse/shared';
import { canTransition, falsePositiveRate, type FindingStatus } from '@repopulse/insights';
import { sendProblem } from '../../lib/problem.js';

// Findings API (W6-04, API_DESIGN.md §2, FR-API-3 / FR-INSIGHTS-1).

export interface FindingsRoutesOptions {
  db: Database;
}

const STATUSES = ['open', 'confirmed', 'dismissed', 'resolved', 'wont_fix'] as const;
const DIMENSIONS = ['code_health', 'security', 'performance', 'test_coverage'] as const;

/** Reasons a dismissal may carry. false_positive is the one the FP rate reads. */
const DISMISS_REASONS = ['false_positive', 'accepted_risk', 'not_applicable', 'duplicate'] as const;

const PAGE_SIZE = 50;

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

/** Keyset cursor `${severity}:${id}` — findings sort by severity then id. */
export function encodeCursor(severity: number, id: number): string {
  return Buffer.from(`${severity}:${id}`).toString('base64url');
}
export function decodeCursor(cursor: string): { severity: number; id: number } | null {
  try {
    const [sev, id] = Buffer.from(cursor, 'base64url').toString('utf8').split(':');
    const severity = Number(sev);
    const parsed = Number(id);
    if (!Number.isInteger(severity) || !Number.isInteger(parsed)) return null;
    return { severity, id: parsed };
  } catch {
    return null;
  }
}

export default async function findingsRoutes(
  app: FastifyInstance,
  opts: FindingsRoutesOptions,
): Promise<void> {
  const { db } = opts;

  /** GET /findings — cursor-paginated, filtered. */
  app.get<{
    Querystring: {
      dimension?: string;
      status?: string;
      severity_min?: string;
      confidence_min?: string;
      repo_id?: string;
      verify_status?: string;
      cursor?: string;
    };
  }>('/findings', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');

    const q = request.query;
    const filters = [eq(read.findings.workspaceId, workspaceId)];
    if (q.dimension && DIMENSIONS.includes(q.dimension as (typeof DIMENSIONS)[number])) {
      filters.push(eq(read.findings.dimension, q.dimension));
    }
    if (q.status && STATUSES.includes(q.status as FindingStatus)) {
      filters.push(eq(read.findings.status, q.status));
    }
    if (q.severity_min && Number.isInteger(Number(q.severity_min))) {
      filters.push(gte(read.findings.severity, Number(q.severity_min)));
    }
    if (q.confidence_min && Number.isInteger(Number(q.confidence_min))) {
      filters.push(gte(read.findings.confidence, Number(q.confidence_min)));
    }
    if (q.repo_id && Number.isInteger(Number(q.repo_id))) {
      filters.push(eq(read.findings.repoId, Number(q.repo_id)));
    }
    // W6-05 facet. 'unverified' is a real answer, not the absence of one — a
    // finding nobody re-judged must be filterable as such.
    if (q.verify_status && ['unverified', 'confirmed', 'contradicted'].includes(q.verify_status)) {
      filters.push(eq(read.findings.verifyStatus, q.verify_status));
    }

    // Keyset, not offset: the list is ordered by severity and new findings
    // arrive at the top, so an offset page would skip or repeat rows while
    // someone is reading — which presents as "findings are missing".
    if (q.cursor) {
      const decoded = decodeCursor(q.cursor);
      if (!decoded) return fail(request, reply, 400, 'Invalid cursor');
      filters.push(
        or(
          lt(read.findings.severity, decoded.severity),
          and(eq(read.findings.severity, decoded.severity), lt(read.findings.id, decoded.id)),
        )!,
      );
    }

    const rows = await db
      .select({
        id: read.findings.id,
        repoId: read.findings.repoId,
        org: core.repos.org,
        repoName: core.repos.name,
        dimension: read.findings.dimension,
        severity: read.findings.severity,
        confidence: read.findings.confidence,
        title: read.findings.title,
        file: read.findings.file,
        lineStart: read.findings.lineStart,
        lineEnd: read.findings.lineEnd,
        evidence: read.findings.evidence,
        recommendation: read.findings.recommendation,
        status: read.findings.status,
        dismissReason: read.findings.dismissReason,
        occurrenceCount: read.findings.occurrenceCount,
        verifyStatus: read.findings.verifyStatus,
        firstSeenAt: read.findings.firstSeenAt,
        lastSeenAt: read.findings.lastSeenAt,
        tier: read.findings.tier,
      })
      .from(read.findings)
      .innerJoin(core.repos, eq(core.repos.id, read.findings.repoId))
      .where(and(...filters))
      .orderBy(desc(read.findings.severity), desc(read.findings.id))
      .limit(PAGE_SIZE + 1);

    const page = rows.slice(0, PAGE_SIZE);
    const last = page[page.length - 1];
    return reply.send({
      items: page.map((r) => ({
        id: r.id,
        repo: { id: r.repoId, org: r.org, name: r.repoName },
        dimension: r.dimension,
        severity: r.severity,
        confidence: r.confidence,
        title: r.title,
        file: r.file,
        line_range: [r.lineStart, r.lineEnd],
        evidence: r.evidence,
        recommendation: r.recommendation,
        status: r.status,
        dismiss_reason: r.dismissReason,
        occurrence_count: r.occurrenceCount,
        verify_status: r.verifyStatus,
        first_seen_at: r.firstSeenAt.toISOString(),
        last_seen_at: r.lastSeenAt.toISOString(),
        tier: r.tier,
      })),
      next_cursor: rows.length > PAGE_SIZE && last ? encodeCursor(last.severity, last.id) : null,
    });
  });

  /** GET /findings/stats — counts by dimension/severity/status + FP rate. */
  app.get('/findings/stats', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');

    const byDimension = await db
      .select({
        dimension: read.findings.dimension,
        status: read.findings.status,
        n: sql<number>`count(*)::int`,
      })
      .from(read.findings)
      .where(eq(read.findings.workspaceId, workspaceId))
      .groupBy(read.findings.dimension, read.findings.status);

    const fp = await falsePositiveRate(db, workspaceId);

    return reply.send({
      by_dimension: byDimension,
      false_positive_rate: fp.rate,
      false_positive_count: fp.dismissedFalsePositive,
      total: fp.total,
      // rate === null means nothing has been reviewed yet. Sent through as null
      // rather than 0 so the UI can say "no data" instead of implying a
      // flawless model (FR-INSIGHTS-1).
    });
  });

  /** GET /findings/:id/history — the audit trail for one finding. */
  app.get<{ Params: { id: string } }>('/findings/:id/history', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return fail(request, reply, 400, 'Invalid finding id');

    const [finding] = await db
      .select({ id: read.findings.id })
      .from(read.findings)
      .where(and(eq(read.findings.id, id), eq(read.findings.workspaceId, workspaceId)))
      .limit(1);
    // Tenancy (Law 5): another workspace's finding is a 404, never a 403.
    if (!finding) return fail(request, reply, 404, 'Not Found');

    const events = await db
      .select()
      .from(read.findingEvents)
      .where(eq(read.findingEvents.findingId, id))
      .orderBy(read.findingEvents.at);

    return reply.send({
      items: events.map((e) => ({
        from_status: e.fromStatus,
        to_status: e.toStatus,
        // null actor = the analysis pass. Without the distinction an automatic
        // reopen is indistinguishable from a colleague reopening it.
        actor: e.actor,
        automatic: e.actor === null,
        reason: e.reason,
        at: e.at.toISOString(),
      })),
    });
  });

  /** PATCH /findings/:id — a human moving a finding through its lifecycle. */
  app.patch<{
    Params: { id: string };
    Body: { status?: unknown; note?: unknown; dismiss_reason?: unknown };
  }>('/findings/:id', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    const userId = request.session.get('userId');
    if (workspaceId === undefined || userId === undefined) {
      return fail(request, reply, 401, 'No active session');
    }
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return fail(request, reply, 400, 'Invalid finding id');

    const next = request.body?.status;
    if (typeof next !== 'string' || !STATUSES.includes(next as FindingStatus)) {
      return fail(
        request,
        reply,
        400,
        'Invalid status',
        `status must be one of ${STATUSES.join(', ')}`,
      );
    }
    const note = typeof request.body?.note === 'string' ? request.body.note.trim() : '';
    if (note === '') {
      // Required (FR-INSIGHTS-1). A dismissal with no reason is unreviewable
      // six months later, and "why was this closed?" is the first question
      // anyone asks about a finding that turned out to matter.
      return fail(
        request,
        reply,
        400,
        'A note is required',
        'Every status change records why it was made.',
      );
    }

    const [finding] = await db
      .select()
      .from(read.findings)
      .where(and(eq(read.findings.id, id), eq(read.findings.workspaceId, workspaceId)))
      .limit(1);
    if (!finding) return fail(request, reply, 404, 'Not Found');

    if (!canTransition(finding.status as FindingStatus, next as FindingStatus)) {
      // 409, not 400: the request is well-formed, the STATE forbids it.
      return fail(
        request,
        reply,
        409,
        'Transition not allowed',
        `${finding.status} → ${next} is not a permitted transition`,
      );
    }

    const dismissReason =
      next === 'dismissed' &&
      typeof request.body?.dismiss_reason === 'string' &&
      DISMISS_REASONS.includes(request.body.dismiss_reason as (typeof DISMISS_REASONS)[number])
        ? request.body.dismiss_reason
        : null;

    const now = new Date();
    await db
      .update(read.findings)
      .set({
        status: next,
        statusChangedBy: userId,
        statusChangedAt: now,
        ...(next === 'dismissed' ? { dismissReason } : {}),
      })
      .where(eq(read.findings.id, id));

    await db.insert(read.findingEvents).values({
      workspaceId,
      findingId: id,
      fromStatus: finding.status,
      toStatus: next,
      actor: userId,
      reason: dismissReason ? `${dismissReason}: ${note}` : note,
    });

    auditLog(request.log, {
      event: 'finding.status_changed',
      actorUserId: userId,
      workspaceId,
      ip: request.ip,
      ua: request.headers['user-agent'] ?? null,
      findingId: id,
      fromStatus: finding.status,
      toStatus: next,
      dismissReason,
    });

    return reply.send({ id, status: next, dismiss_reason: dismissReason });
  });

  /** POST /findings/bulk — the same transition across a selection. */
  app.post<{ Body: { ids?: unknown; status?: unknown; note?: unknown } }>(
    '/findings/bulk',
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      const userId = request.session.get('userId');
      if (workspaceId === undefined || userId === undefined) {
        return fail(request, reply, 401, 'No active session');
      }
      const ids = Array.isArray(request.body?.ids)
        ? (request.body.ids as unknown[]).map(Number).filter(Number.isInteger)
        : [];
      const next = request.body?.status;
      const note = typeof request.body?.note === 'string' ? request.body.note.trim() : '';
      if (ids.length === 0) return fail(request, reply, 400, 'No findings selected');
      if (typeof next !== 'string' || !STATUSES.includes(next as FindingStatus)) {
        return fail(request, reply, 400, 'Invalid status');
      }
      if (note === '') return fail(request, reply, 400, 'A note is required');

      const rows = await db
        .select()
        .from(read.findings)
        .where(and(eq(read.findings.workspaceId, workspaceId), inArray(read.findings.id, ids)));

      const now = new Date();
      const applied: number[] = [];
      const skipped: { id: number; reason: string }[] = [];

      for (const row of rows) {
        if (!canTransition(row.status as FindingStatus, next as FindingStatus)) {
          // Reported per id rather than failing the whole batch: a bulk action
          // that rejects 40 findings because one was already resolved is a
          // bulk action nobody uses.
          skipped.push({ id: row.id, reason: `${row.status} → ${next} not permitted` });
          continue;
        }
        await db
          .update(read.findings)
          .set({ status: next, statusChangedBy: userId, statusChangedAt: now })
          .where(eq(read.findings.id, row.id));
        await db.insert(read.findingEvents).values({
          workspaceId,
          findingId: row.id,
          fromStatus: row.status,
          toStatus: next,
          actor: userId,
          reason: note,
        });
        applied.push(row.id);
      }

      auditLog(request.log, {
        event: 'finding.status_changed',
        actorUserId: userId,
        workspaceId,
        ip: request.ip,
        ua: request.headers['user-agent'] ?? null,
        bulk: true,
        appliedCount: applied.length,
        skippedCount: skipped.length,
        toStatus: next,
      });

      return reply.send({ applied, skipped });
    },
  );
}
