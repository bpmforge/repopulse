import { and, desc, eq, gte, ilike, inArray, lt, lte, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { read, type Database } from '@repopulse/shared';
import { requireAdmin } from '../../../lib/rbac.js';
import { sendProblem } from '../../../lib/problem.js';

// Settings → Audit log (W20-10, UX_TODO X-04).
//
// Role changes, member removal, identity merges, rule promotions, scanner
// toggles, routing changes and Tier-3 opt-ins were written only as `audit:`
// lines in the container log, so an admin could not see from the app who
// changed something, or when. auditLog now also writes `audit_events`
// (lib/audit-store.ts); this reads it back.
//
// ADMIN-ONLY: the log names people, addresses and every privileged change in
// the workspace. WORKSPACE-FILTERED on every query (Law 5).

export interface AuditRoutesOptions {
  db: Database;
}

const PAGE_DEFAULT = 50;
const PAGE_MAX = 200;
/** An export is a file, not a page; still bounded so one click cannot dump a decade. */
const EXPORT_MAX = 5000;

interface AuditQuery {
  event?: string;
  actor?: string;
  from?: string;
  to?: string;
  before?: string;
  limit?: string;
  format?: string;
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

function parseDate(raw: string | undefined): Date | null | 'invalid' {
  if (raw === undefined || raw === '') return null;
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? 'invalid' : d;
}

/** RFC 4180 quoting — and a leading = + - @ is defused so a spreadsheet does not run it. */
export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? '' : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export default async function auditRoutes(
  app: FastifyInstance,
  opts: AuditRoutesOptions,
): Promise<void> {
  const { db } = opts;

  app.get<{ Querystring: AuditQuery }>(
    '/admin/audit',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
      const q = request.query;

      const from = parseDate(q.from);
      const to = parseDate(q.to);
      if (from === 'invalid' || to === 'invalid') {
        return fail(request, reply, 400, 'from and to must be dates (YYYY-MM-DD or ISO 8601)');
      }
      const exporting = q.format === 'csv';
      const limitRaw = q.limit === undefined ? PAGE_DEFAULT : Number(q.limit);
      if (!Number.isInteger(limitRaw) || limitRaw < 1) {
        return fail(request, reply, 400, 'limit must be a positive whole number');
      }
      const limit = Math.min(limitRaw, exporting ? EXPORT_MAX : PAGE_MAX);
      const before = q.before === undefined ? null : Number(q.before);
      if (before !== null && !Number.isInteger(before)) {
        return fail(request, reply, 400, 'before must be an audit entry id');
      }

      const t = read.auditEvents;
      const where: SQL[] = [eq(t.workspaceId, workspaceId)];
      const events = (q.event ?? '')
        .split(',')
        .map((e) => e.trim())
        .filter(Boolean);
      if (events.length > 0) where.push(inArray(t.event, events));
      const actor = q.actor?.trim();
      if (actor) {
        // A number is an account id; anything else is part of a login.
        where.push(
          /^\d+$/.test(actor)
            ? eq(t.actorUserId, Number(actor))
            : ilike(t.actorLogin, `%${actor.replace(/[\\%_]/g, (c) => `\\${c}`)}%`),
        );
      }
      if (from) where.push(gte(t.occurredAt, from));
      // A bare date for `to` means "through the end of that day", which is what
      // someone filtering 1 March to 7 March expects to include.
      if (to) {
        const inclusive = /^\d{4}-\d{2}-\d{2}$/.test(q.to ?? '')
          ? new Date(to.getTime() + 24 * 60 * 60 * 1000 - 1)
          : to;
        where.push(lte(t.occurredAt, inclusive));
      }
      if (before !== null) where.push(lt(t.id, before));

      const rows = await db
        .select({
          id: t.id,
          event: t.event,
          actorUserId: t.actorUserId,
          actorLogin: t.actorLogin,
          ip: t.ip,
          detail: t.detail,
          occurredAt: t.occurredAt,
        })
        .from(t)
        .where(and(...where))
        .orderBy(desc(t.id))
        .limit(limit + 1);
      const page = rows.slice(0, limit);

      if (exporting) {
        const header = ['occurred_at', 'event', 'actor_user_id', 'actor_login', 'ip', 'detail'];
        const lines = page.map((r) =>
          [
            r.occurredAt.toISOString(),
            r.event,
            r.actorUserId,
            r.actorLogin,
            r.ip,
            JSON.stringify(r.detail),
          ]
            .map(csvCell)
            .join(','),
        );
        return reply
          .header('content-type', 'text/csv; charset=utf-8')
          .header(
            'content-disposition',
            `attachment; filename="repopulse-audit-${new Date().toISOString().slice(0, 10)}.csv"`,
          )
          .send([header.join(','), ...lines].join('\n') + '\n');
      }

      // The event names this workspace has actually recorded, for the filter —
      // offering every member of the union would list events that never happen.
      const known = await db
        .selectDistinct({ event: t.event })
        .from(t)
        .where(eq(t.workspaceId, workspaceId))
        .orderBy(sql`1`);

      return reply.send({
        items: page.map((r) => ({
          id: r.id,
          event: r.event,
          actor_user_id: r.actorUserId,
          actor_login: r.actorLogin,
          ip: r.ip,
          detail: r.detail,
          occurred_at: r.occurredAt.toISOString(),
        })),
        next_before: rows.length > limit ? (page[page.length - 1]?.id ?? null) : null,
        events: known.map((k) => k.event),
      });
    },
  );
}
