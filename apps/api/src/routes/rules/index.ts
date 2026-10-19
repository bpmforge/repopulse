import { and, desc, eq, like, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { auditLog, read, security, type Database } from '@repopulse/shared';
import {
  canTransition,
  demotionFlag,
  fpRate,
  promotionVerdict,
  validateHealthRule,
  type RuleStatus,
} from '@repopulse/security';
import { requireAdmin } from '../../lib/rbac.js';
import { sendProblem } from '../../lib/problem.js';
import { actorLoginFor } from '../../lib/actor.js';

// Rule workbench API (W9-07, CODE_HEALTH_SUITE.md §8, FR-CH-8/9, FR-AUTH-4).
//
// Admin-only, and every transition is audited. A rule going live changes what
// every future scan says about someone's code, which is exactly the kind of
// change that needs a name and a timestamp attached.

export interface RulesRoutesOptions {
  db: Database;
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

/**
 * The finding rule ids a registry row speaks for (W20-08, UX_TODO FND-59).
 *
 * A tool row (`tool.checkov`) governs every one of that tool's rules, and its
 * findings carry the longer per-rule id (`tool.checkov.CKV_AWS_24`), so an
 * exact match counted zero findings and the row could never meet the gate.
 * A tool row counts all of the tool's rules; any other row its own id only.
 */
export function ruleIdMatch(ruleId: string) {
  return /^tool\.[^.]+$/.test(ruleId)
    ? or(eq(read.findings.ruleId, ruleId), like(read.findings.ruleId, `${ruleId}.%`))!
    : eq(read.findings.ruleId, ruleId);
}

/** Findings + dispositions for one rule, the promotion gate's evidence. */
async function evidenceFor(
  db: Database,
  workspaceId: number,
  ruleId: string,
  shadowStartedAt: Date | null,
): Promise<{ findings: number; daysActive: number; fpRate: number | null }> {
  const [counts] = await db
    .select({
      findings: sql<number>`count(*)::int`,
      triaged: sql<number>`count(*) filter (where ${read.findings.status} in ('confirmed','dismissed','resolved','wont_fix'))::int`,
      fp: sql<number>`count(*) filter (where ${read.findings.status} = 'dismissed' and ${read.findings.dismissReason} = 'false_positive')::int`,
    })
    .from(read.findings)
    .where(and(eq(read.findings.workspaceId, workspaceId), ruleIdMatch(ruleId)));

  return {
    findings: counts?.findings ?? 0,
    daysActive: shadowStartedAt
      ? Math.floor((Date.now() - shadowStartedAt.getTime()) / 86_400_000)
      : 0,
    fpRate: fpRate({
      dismissedFalsePositive: counts?.fp ?? 0,
      triaged: counts?.triaged ?? 0,
    }),
  };
}

export default async function rulesRoutes(
  app: FastifyInstance,
  opts: RulesRoutesOptions,
): Promise<void> {
  const { db } = opts;

  /** GET /rules — the workbench queue, with each rule's gate evidence. */
  app.get('/rules', { preHandler: requireAdmin }, async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');

    const rows = await db
      .select()
      .from(security.ruleRegistry)
      .where(eq(security.ruleRegistry.workspaceId, workspaceId))
      .orderBy(desc(security.ruleRegistry.updatedAt));

    const items = [];
    for (const row of rows) {
      const evidence = await evidenceFor(db, workspaceId, row.ruleId, row.shadowStartedAt);
      const verdict = promotionVerdict(evidence);
      items.push({
        rule_id: row.ruleId,
        status: row.status,
        provenance: row.provenance,
        shadow_started_at: row.shadowStartedAt?.toISOString() ?? null,
        evidence,
        // The gate's reasons travel with the row: an admin looking at a
        // disabled button needs to know whether to wait a week or fix the rule.
        promotion: {
          eligible: row.status === 'candidate' && verdict.eligible,
          reasons: verdict.reasons,
        },
        demotion_candidate: row.demotionCandidate || demotionFlag(evidence),
      });
    }

    return reply.send({ items });
  });

  /** POST /rules — propose a rule. Always lands `proposed`. */
  app.post<{ Body: unknown }>('/rules', { preHandler: requireAdmin }, async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');

    // W20-08 (UX_TODO FND-65): who proposed it and when are stamped here when
    // the body leaves them out, as the web form does — the signed-in admin and
    // today, rather than whatever a form field claimed.
    const body = (request.body ?? {}) as { provenance?: Record<string, unknown> };
    const userId = request.session.get('userId');
    const provenance = {
      ...(body.provenance ?? {}),
      author:
        typeof body.provenance?.['author'] === 'string' && body.provenance['author'] !== ''
          ? body.provenance['author']
          : ((userId !== undefined ? await actorLoginFor(db, userId) : null) ?? 'unknown'),
      date:
        typeof body.provenance?.['date'] === 'string' && body.provenance['date'] !== ''
          ? body.provenance['date']
          : new Date().toISOString().slice(0, 10),
    };

    let rule;
    try {
      // enforceLicense: a proposal arriving over the API is an import as far
      // as licensing is concerned, whoever typed it.
      rule = validateHealthRule(
        { ...(request.body as object), provenance, status: 'proposed' },
        { enforceLicense: true },
      );
    } catch (err) {
      return fail(request, reply, 400, 'Invalid rule', (err as Error).message);
    }

    const [row] = await db
      .insert(security.ruleRegistry)
      .values({
        workspaceId,
        ruleId: rule.id,
        status: 'proposed',
        provenance: rule.provenance,
        updatedBy: request.session.get('userId') ?? null,
      })
      .onConflictDoNothing()
      .returning();

    if (!row) return fail(request, reply, 409, 'Rule already registered');

    // SC-22: a rule entering the registry changes what future scans say about
    // someone's code, so it gets a name and a timestamp like every other
    // admin action.
    auditLog(request.log, {
      event: 'rule.proposed',
      actorUserId: request.session.get('userId') ?? null,
      workspaceId,
      ip: request.ip,
      ua: request.headers['user-agent'] ?? null,
      ruleId: rule.id,
      provenance: rule.provenance,
    });

    return reply.code(201).send({ rule_id: rule.id, status: 'proposed' });
  });

  /** POST /rules/:ruleId/transition — the only way status changes. */
  app.post<{ Params: { ruleId: string }; Body: { to: RuleStatus; reason?: string } }>(
    '/rules/:ruleId/transition',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
      const { to, reason } = request.body ?? ({} as { to: RuleStatus; reason?: string });

      const [row] = await db
        .select()
        .from(security.ruleRegistry)
        .where(
          and(
            eq(security.ruleRegistry.workspaceId, workspaceId),
            eq(security.ruleRegistry.ruleId, request.params.ruleId),
          ),
        );
      if (!row) return fail(request, reply, 404, 'Rule not found');

      if (!canTransition(row.status as RuleStatus, to)) {
        return fail(
          request,
          reply,
          400,
          'Invalid transition',
          `${row.status} → ${to} is not a lifecycle step. proposed goes to candidate first: the promotion gate needs evidence, and evidence needs the rule to have run somewhere.`,
        );
      }

      if (to === 'active') {
        const evidence = await evidenceFor(db, workspaceId, row.ruleId, row.shadowStartedAt);
        const verdict = promotionVerdict(evidence);
        if (!verdict.eligible) {
          // Refused with the reasons, not silently allowed with a warning: the
          // gate is the whole point of shadow mode.
          return fail(request, reply, 400, 'Promotion gate not met', verdict.reasons.join('; '));
        }
      }

      await db
        .update(security.ruleRegistry)
        .set({
          status: to,
          updatedBy: request.session.get('userId') ?? null,
          updatedAt: new Date(),
          ...(to === 'candidate' ? { shadowStartedAt: new Date() } : {}),
          ...(to === 'active' ? { demotionCandidate: false } : {}),
        })
        .where(eq(security.ruleRegistry.id, row.id));

      auditLog(request.log, {
        event: `rule.${to}`,
        actorUserId: request.session.get('userId') ?? null,
        workspaceId,
        ip: request.ip,
        ua: request.headers['user-agent'] ?? null,
        ruleId: row.ruleId,
        from: row.status,
        reason: reason ?? null,
      });

      return reply.send({ rule_id: row.ruleId, status: to });
    },
  );
}
