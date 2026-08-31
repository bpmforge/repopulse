import { and, desc, eq, gte, inArray, isNotNull, lt, or, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { auditLog, core, facts, read, security, type Database } from '@repopulse/shared';
import { canTransition, falsePositiveRate, type FindingStatus } from '@repopulse/insights';
import { blobUrl, webBaseUrl, type ForgeKind } from '@repopulse/forge';
import { sendProblem } from '../../lib/problem.js';
import { FINDING_DIMENSIONS } from '@repopulse/shared/dimensions';

// Findings API (W6-04, API_DESIGN.md §2, FR-API-3 / FR-INSIGHTS-1).

export interface FindingsRoutesOptions {
  db: Database;
}

const STATUSES = ['open', 'confirmed', 'dismissed', 'resolved', 'wont_fix'] as const;
// W8-10: the scanner dimensions join the analysis ones. Before this, a secrets
// finding was stored, listed and counted but could not be FILTERED — the facet
// silently dropped an unknown dimension, so asking for the thing you wanted
// showed you everything instead.
// W9-17: the facet IS the schema's list. It was a hand-kept copy, and `slop`
// sat here while missing from the CHECK constraint for a whole wave — offered
// to users in this layer and unwritable in the one below.
const DIMENSIONS = FINDING_DIMENSIONS;

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


// ONE PROJECTION FOR EVERY WAY OF ASKING (W16-32).
//
// The list and the single-finding lookup have to return the same shape, or a
// finding opened from a LINK would render differently from the same finding
// opened by a CLICK. Extracted for that reason rather than for brevity: two
// copies of thirty columns is exactly the kind of duplication that drifts by
// one field and is noticed by a user rather than a test.
function findingsQuery(db: Database) {
  return db
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
      effectiveRisk: read.findings.effectiveRisk,
      riskBand: read.findings.riskBand,
      riskFactors: read.findings.riskFactors,
      experimental: read.findings.experimental,
      scannerKey: read.findings.scannerKey,
      ruleId: read.findings.ruleId,
      cveId: read.findings.cveId,
      chainId: read.findings.chainId,
      scanRunId: read.findings.scanRunId,
      yields: read.findings.yields,
      // Everything the forge link needs (W16-41). The connection carries the
      // instance and its kind; the SCAN RUN carries the commit the finding was
      // raised on, which is what makes the link point at the code as it was
      // rather than at whatever is on the branch today.
      defaultBranch: core.repos.defaultBranch,
      forgeKind: core.forgeConnections.provider,
      forgeBaseUrl: core.forgeConnections.baseUrl,
      scanCommitSha: security.scanRuns.commitSha,
    })
    .from(read.findings)
    .innerJoin(core.repos, eq(core.repos.id, read.findings.repoId))
    .innerJoin(core.forgeConnections, eq(core.forgeConnections.id, core.repos.connectionId))
    // LEFT: an analysis-run finding has no scan run, and must still be listed.
    // An inner join here would have silently dropped every Tier-2 finding from
    // the explorer — the failure mode this codebase keeps producing.
    .leftJoin(security.scanRuns, eq(security.scanRuns.id, read.findings.scanRunId));
}

type FindingRow = Awaited<ReturnType<ReturnType<typeof findingsQuery>['execute']>>[number];

/** The wire shape of one finding (FR-API-3). */
function toFinding(r: FindingRow) {
  return {
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
  // null, not '', for every one of these: a finding with no rule id has
  // no rule id, and an empty string would render as a blank chip that
  // looks like a rendering bug.
  scanner_key: r.scannerKey,
  rule_id: r.ruleId,
  cve_id: r.cveId,
  chain_id: r.chainId,
  scan_run_id: r.scanRunId,
  kev: r.yields?.['kev'] === true,
  // null, not 0: the nightly reprice may not have reached it, and a 0
  // would read as "judged, and judged harmless".
  effective_risk: r.effectiveRisk === null ? null : Number(r.effectiveRisk),
  risk_band: r.riskBand,
  risk_factors: r.riskFactors,
  experimental: r.experimental,
  // OPEN IT IN THE FORGE (W16-41). Null when there is nothing honest to link
  // to — a finding about the whole repository has no file, and a connection
  // with no recorded base URL has no instance to point at.
  forge: forgeLinkFor(r),
};
}

/**
 * The forge link for one finding, and which kind of ref it is pinned to.
 *
 * Pinned to the SCAN'S COMMIT wherever there is one, so the link shows the code
 * as it was when the finding was raised — line 15 of a file moves, and a link
 * to today's line 15 quietly points at something else. Where there is no commit
 * (a Tier-2 analysis run records none) it falls back to the default branch and
 * SAYS so, rather than implying a precision it does not have.
 */
function forgeLinkFor(r: FindingRow): { url: string; ref_kind: 'commit' | 'branch' } | null {
  if (r.file === null) return null;
  // The stored base is the API host, not the site — api.github.com serves the
  // API and github.com serves the file. A null base is not "unknown" either:
  // for the hosted forges it means the public instance, exactly as the provider
  // clients already read it.
  const base = webBaseUrl(r.forgeKind as ForgeKind, r.forgeBaseUrl);
  if (base === null) return null;
  const refKind = r.scanCommitSha ? ('commit' as const) : ('branch' as const);
  const url = blobUrl({
    kind: r.forgeKind as ForgeKind,
    baseUrl: base,
    org: r.org,
    repo: r.repoName,
    path: r.file,
    ref: r.scanCommitSha ?? r.defaultBranch,
    refKind,
    lineStart: r.lineStart,
    lineEnd: r.lineEnd,
  });
  return url === null ? null : { url, ref_kind: refKind };
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
      /** Exact repo-relative path — the file drill-down's own findings (W16-46). */
      file?: string;
      /** PR number, WITH repo_id — the PR drill-down's automated review (W16-46). */
      pr_number?: string;
      verify_status?: string;
      scanner_key?: string;
      cve_id?: string;
      /** 'true' restricts to findings that belong to an attack chain. */
      in_chain?: string;
      /** 'true' restricts to CISA KEV-listed CVEs. */
      kev?: string;
      /** W9-11: act | schedule | track. */
      risk_band?: string;
      /** W9-11: 'risk' (default) or 'severity'. */
      sort?: string;
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
    // EXACT path, not a prefix match. The file drill-down asks about one file,
    // and a prefix would fold `src/pay.ts` in with `src/pay.test.ts` — a
    // longer list that looks like more thorough reporting and is wrong.
    if (q.file) filters.push(eq(read.findings.file, q.file));

    // A PR is identified by (repo, number) everywhere the UI can see; the
    // findings table stores the internal id. Resolved with a subquery rather
    // than by teaching the web app about internal ids, and REQUIRING repo_id —
    // a bare number is not a pull request, and matching one across every
    // repository would attach another project's review to this PR.
    if (q.pr_number && q.repo_id && Number.isInteger(Number(q.pr_number))) {
      filters.push(
        inArray(
          read.findings.pullRequestId,
          db
            .select({ id: facts.pullRequests.id })
            .from(facts.pullRequests)
            .where(
              and(
                eq(facts.pullRequests.workspaceId, workspaceId),
                eq(facts.pullRequests.repoId, Number(q.repo_id)),
                eq(facts.pullRequests.number, Number(q.pr_number)),
              ),
            ),
        ),
      );
    }
    // W6-05 facet. 'unverified' is a real answer, not the absence of one — a
    // finding nobody re-judged must be filterable as such.
    if (q.verify_status && ['unverified', 'confirmed', 'contradicted'].includes(q.verify_status)) {
      filters.push(eq(read.findings.verifyStatus, q.verify_status));
    }

    // W8-10 scanner facets (SECURITY_SUITE §5). Driven by what the finding
    // rows carry, so a scanner added later is filterable the day it writes its
    // first row — no per-scanner code here.
    if (q.scanner_key) filters.push(eq(read.findings.scannerKey, q.scanner_key));
    if (q.cve_id) filters.push(eq(read.findings.cveId, q.cve_id));
    if (q.in_chain === 'true') filters.push(isNotNull(read.findings.chainId));
    if (q.risk_band && ['act', 'schedule', 'track'].includes(q.risk_band)) {
      filters.push(eq(read.findings.riskBand, q.risk_band));
    }
    if (q.kev === 'true') {
      // KEV lives in the finding's payload rather than a column: it is a fact
      // about the CVE, set by the dependency scanner (W8-06, parked), and a
      // column would have to be backfilled for every scanner that never sets
      // it. Filtering on the payload means this facet works the day W8-06
      // lands and returns nothing — correctly — until then.
      filters.push(sql`${read.findings.yields} ->> 'kev' = 'true'`);
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

    const rows = await findingsQuery(db)
      .where(and(...filters))
      // W9-11: effective_risk by DEFAULT, severity on request. Severity alone
      // put a critical finding in a file nobody touches above a high one in the
      // hot path — the ordering the risk engine exists to replace. The severity
      // sort is retained because "show me everything critical" is a real
      // question, just not the default one.
      .orderBy(
        ...(q.sort === 'severity'
          ? [desc(read.findings.severity), desc(read.findings.id)]
          : [
              // NULLS LAST: an unpriced finding has not been judged low-risk,
              // it has not been judged at all, and sorting it to the top or
              // silently to the bottom would both be claims.
              sql`${read.findings.effectiveRisk} desc nulls last`,
              desc(read.findings.severity),
              desc(read.findings.id),
            ]),
      )
      .limit(PAGE_SIZE + 1);

    const page = rows.slice(0, PAGE_SIZE);
    const last = page[page.length - 1];
    return reply.send({
      items: page.map(toFinding),
      next_cursor: rows.length > PAGE_SIZE && last ? encodeCursor(last.severity, last.id) : null,
    });
  });

  /**
   * GET /findings/:id — one finding, whatever the caller's filters are (W16-32).
   *
   * W16-16 put the open finding in the URL, and the explorer's filters are
   * component state — so a link to a dismissed finding, opened by someone whose
   * Status is the default "open", found nothing in the list and could only say
   * so. A triage tool whose "look at this one" link depends on the recipient's
   * view is not a link.
   *
   * Registered BEFORE /findings/stats reads oddly and is not a hazard: Fastify's
   * router prefers a static segment over a parameter, so /findings/stats
   * resolves to its own handler regardless of order. Kept adjacent to the list
   * instead, beside the projection they share.
   */
  app.get<{ Params: { id: string } }>('/findings/:id', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return fail(request, reply, 400, 'Invalid finding id');

    const [row] = await findingsQuery(db)
      .where(and(eq(read.findings.workspaceId, workspaceId), eq(read.findings.id, id)))
      .limit(1);
    // Tenancy (Law 5): another workspace's finding is a 404, never a 403 — a
    // 403 would confirm the id exists, which is a link someone could probe.
    if (!row) return fail(request, reply, 404, 'No such finding');

    return reply.send(toFinding(row));
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
