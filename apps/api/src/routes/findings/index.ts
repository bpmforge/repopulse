import { and, desc, eq, gte, ilike, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { auditLog, core, facts, read, security, type Database } from '@repopulse/shared';
import { canTransition, falsePositiveRate, type FindingStatus } from '@repopulse/insights';
import { blobUrl, webBaseUrl, type ForgeKind } from '@repopulse/forge';
import { sendProblem } from '../../lib/problem.js';
import { actorLoginFor } from '../../lib/actor.js';
import { FINDING_DIMENSIONS } from '@repopulse/shared/dimensions';
import { externalOf, foundByOf } from '../../lib/found-by.js';
import {
  EXPORT_CAP,
  cleanTicketUrl,
  findingsCsv,
  findingsSarif,
  type ExportFormat,
} from './export.js';

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
/** The most ids one "select all matching" may hold (W20-08, FND-12). */
export const BULK_SELECT_CAP = 1000;

/**
 * `status=active`: the findings still to fix, open AND confirmed (W20-08,
 * UX_TODO FND-49). The Security tab, Sensitive changes and every "N open"
 * count already meant this; the list's `status=open` meant open alone, so a
 * finding left the default list the moment someone confirmed it — exactly when
 * it still needed fixing — and "All 12 open findings" landed on a shorter list.
 */
export const ACTIVE_STATUSES = ['open', 'confirmed'] as const;

/**
 * The statuses a `status` query names: one status, `active`, or a comma list
 * of either. Unknown values are dropped; an empty answer means "no filter",
 * the same leniency the single value always had.
 */
export function statusesFrom(raw: string | undefined): string[] {
  if (!raw) return [];
  const out = new Set<string>();
  for (const part of raw.split(',')) {
    const value = part.trim();
    if (value === 'active') ACTIVE_STATUSES.forEach((s) => out.add(s));
    else if (STATUSES.includes(value as FindingStatus)) out.add(value);
  }
  return [...out];
}

/**
 * Who may dismiss or mark won't-fix (W20-08, UX_TODO FND-66).
 *
 * SRS FR-AUTH-4 has two roles, admin and member, so "a security reviewer"
 * is the admin. Any member could dismiss a critical finding with a one-word
 * note and turn their own failing `repopulse check` green, with no second
 * person involved. Now a high or critical finding, or one raised on a pull
 * request that is still open (the author's own build), needs an admin; every
 * other finding any member may still close, with a note long enough to be
 * read later.
 */
export const DISMISS_NOTE_MIN = 10;
const CLOSING_STATUSES: readonly string[] = ['dismissed', 'wont_fix'];

export function dismissNeedsAdmin(f: { severity: number; prState: string | null }): boolean {
  return f.severity >= 4 || f.prState === 'open';
}

/** Why this role may not make this move, or null when it may. */
export function dismissRefusal(
  to: string,
  finding: { severity: number; prState: string | null },
  role: string | undefined,
): string | null {
  if (!CLOSING_STATUSES.includes(to) || role === 'admin') return null;
  if (!dismissNeedsAdmin(finding)) return null;
  return finding.severity >= 4
    ? "Only an admin may dismiss or mark won't fix a high or critical finding."
    : "Only an admin may dismiss or mark won't fix a finding raised on a pull request that is still open.";
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

/** The longest an accepted risk may go before it is looked at again (W20-21, FND-25). */
export const REVIEW_BY_MAX_DAYS = 730;

/**
 * The review date an accepted-risk dismissal must carry (W20-21, UX_TODO
 * FND-25): a calendar day after today and within two years. Returns the date
 * or the sentence that refuses it.
 */
export function reviewByFrom(
  raw: unknown,
  today: Date = new Date(),
): { date: string } | { refusal: string } {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return {
      refusal:
        'An accepted risk needs a review date (YYYY-MM-DD): the day someone looks at it again. The finding reopens on that day.',
    };
  }
  const day = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== raw) {
    return { refusal: `${raw} is not a calendar date.` };
  }
  const todayIso = today.toISOString().slice(0, 10);
  if (raw <= todayIso) return { refusal: 'The review date must be after today.' };
  const latest = new Date(today.getTime() + REVIEW_BY_MAX_DAYS * 86_400_000)
    .toISOString()
    .slice(0, 10);
  if (raw > latest) {
    return { refusal: `The review date must be within two years (by ${latest}).` };
  }
  return { date: raw };
}

/** The latest a rotation may be dated: today; and no earlier than the finding (W20-21, FND-61). */
export function rotatedOnFrom(
  raw: unknown,
  firstSeen: Date,
  today: Date = new Date(),
): { date: string } | { refusal: string } {
  if (typeof raw !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return { refusal: 'Say when the credential was rotated (YYYY-MM-DD).' };
  }
  const day = new Date(`${raw}T00:00:00Z`);
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== raw) {
    return { refusal: `${raw} is not a calendar date.` };
  }
  if (raw > today.toISOString().slice(0, 10)) {
    return { refusal: 'The rotation date cannot be in the future.' };
  }
  // A day's grace: the leak may be older than our first sighting of it, but a
  // rotation BEFORE the year it was seen is almost certainly a typo.
  if (raw < new Date(firstSeen.getTime() - 366 * 86_400_000).toISOString().slice(0, 10)) {
    return { refusal: 'That date is long before this secret was first seen; check the year.' };
  }
  return { date: raw };
}

/** Comma list of positive integers, capped; anything else is dropped. */
export function idList(raw: string | undefined, cap = BULK_SELECT_CAP): number[] {
  if (!raw) return [];
  return [
    ...new Set(
      raw
        .split(',')
        .map((p) => Number(p.trim()))
        .filter((n) => Number.isInteger(n) && n > 0),
    ),
  ].slice(0, cap);
}

// KEYSET CURSOR — one shape per sort (W17-32).
//
// A keyset cursor has to carry every column the ORDER BY uses, or the "after
// this row" predicate and the ordering disagree and pages skip and repeat rows.
// The cursor used to be `${severity}:${id}` for BOTH sorts while the default
// sort ordered by effective_risk first: walking 10,000 findings under
// sort=risk returned 610 distinct rows, 270 of them twice, and 9,390 never.
//
//   severity: `${severity}:${id}`
//   risk:     `r:${effective_risk | '-'}:${severity}:${id}`   ('-' = unpriced)
//
// effective_risk travels as the numeric's own text (never through a float), so
// the predicate compares exactly what Postgres ordered by.
export type FindingSort = 'risk' | 'severity';
export type FindingCursor =
  | { sort: 'severity'; severity: number; id: number }
  | { sort: 'risk'; risk: string | null; severity: number; id: number };

const RISK_TEXT = /^-?\d+(\.\d+)?$/;

export function encodeCursor(
  sort: FindingSort,
  row: { severity: number; id: number; effectiveRisk: string | null },
): string {
  const text =
    sort === 'risk'
      ? `r:${row.effectiveRisk ?? '-'}:${row.severity}:${row.id}`
      : `${row.severity}:${row.id}`;
  return Buffer.from(text).toString('base64url');
}
export function decodeCursor(cursor: string): FindingCursor | null {
  try {
    const parts = Buffer.from(cursor, 'base64url').toString('utf8').split(':');
    const tail = (sev: string | undefined, id: string | undefined) => {
      const severity = Number(sev);
      const parsed = Number(id);
      if (!Number.isInteger(severity) || !Number.isInteger(parsed)) return null;
      return { severity, id: parsed };
    };
    if (parts[0] === 'r' && parts.length === 4) {
      const [, risk, sev, id] = parts;
      if (risk !== '-' && !RISK_TEXT.test(risk ?? '')) return null;
      const t = tail(sev, id);
      return t ? { sort: 'risk', risk: risk === '-' ? null : (risk ?? null), ...t } : null;
    }
    if (parts.length === 2) {
      const t = tail(parts[0], parts[1]);
      return t ? { sort: 'severity', ...t } : null;
    }
    return null;
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
/** The scan that last saw a finding, joined beside the one that raised it (W20-21). */
const lastSeenRun = alias(security.scanRuns, 'last_seen_run');

function findingsQuery(db: Database) {
  return (
    db
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
        contextLines: read.findings.contextLines,
        contextStartLine: read.findings.contextStartLine,
        recommendation: read.findings.recommendation,
        rationale: read.findings.rationale,
        prState: facts.pullRequests.state,
        status: read.findings.status,
        dismissReason: read.findings.dismissReason,
        occurrenceCount: read.findings.occurrenceCount,
        verifyStatus: read.findings.verifyStatus,
        // W21-03: the second model's verdict, when one was had, and its reason
        // (or why none could be had).
        secondModel: read.findings.verifiedByModel,
        secondConnection: read.findings.verifiedByConnection,
        secondAt: read.findings.verifiedAt,
        verifyReason: read.findings.verifyReason,
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
        scanToolVersions: security.scanRuns.toolVersions,
        scanScannerVersion: security.scanRuns.scannerVersion,
        // W20-15 (UX_TODO X-10): which of the customer's models raised it.
        analysisModelId: read.analysisRuns.modelId,
        // W20-18 (UX_TODO X-08): the tracker issue someone linked.
        externalTicketUrl: read.findings.externalTicketUrl,
        // W20-21 (UX_TODO FND-70): the pull request it was raised on.
        prNumber: facts.pullRequests.number,
        // W20-21 (UX_TODO FND-25): when an accepted risk is looked at again.
        reviewBy: read.findings.reviewBy,
        // W20-21 (UX_TODO FND-51): the scan that last saw it.
        lastSeenScanRunId: read.findings.lastSeenScanRunId,
        lastSeenScanCommit: lastSeenRun.commitSha,
        lastSeenScanAt: lastSeenRun.startedAt,
        // W20-25 (UX_TODO X-10): the model and connection that last judged it
        // (its newest triage answer, a second opinion aside), same workspace.
        verifiedVerdict: sql<
          string | null
        >`(select v.verdict from ${read.aiTriageVerdicts} v where v.finding_id = ${read.findings.id} and v.workspace_id = ${read.findings.workspaceId} and v.second_opinion_of is null order by v.created_at desc, v.id desc limit 1)`,
        verifiedModel: sql<
          string | null
        >`(select v.model from ${read.aiTriageVerdicts} v where v.finding_id = ${read.findings.id} and v.workspace_id = ${read.findings.workspaceId} and v.second_opinion_of is null order by v.created_at desc, v.id desc limit 1)`,
        verifiedConnection: sql<
          string | null
        >`(select coalesce(p.name, v.connection_name) from ${read.aiTriageVerdicts} v left join ${core.llmProviders} p on p.id = v.llm_provider_id and p.workspace_id = v.workspace_id where v.finding_id = ${read.findings.id} and v.workspace_id = ${read.findings.workspaceId} and v.second_opinion_of is null order by v.created_at desc, v.id desc limit 1)`,
        verifiedAt: sql<
          string | null
        >`(select v.created_at from ${read.aiTriageVerdicts} v where v.finding_id = ${read.findings.id} and v.workspace_id = ${read.findings.workspaceId} and v.second_opinion_of is null order by v.created_at desc, v.id desc limit 1)`,
      })
      .from(read.findings)
      .innerJoin(core.repos, eq(core.repos.id, read.findings.repoId))
      .innerJoin(core.forgeConnections, eq(core.forgeConnections.id, core.repos.connectionId))
      // LEFT: an analysis-run finding has no scan run, and must still be listed.
      // An inner join here would have silently dropped every Tier-2 finding from
      // the explorer — the failure mode this codebase keeps producing.
      .leftJoin(security.scanRuns, eq(security.scanRuns.id, read.findings.scanRunId))
      .leftJoin(read.analysisRuns, eq(read.analysisRuns.id, read.findings.analysisRunId))
      // W20-08 (FND-66): whether the pull request it was raised on is still
      // open decides who may dismiss it.
      .leftJoin(facts.pullRequests, eq(facts.pullRequests.id, read.findings.pullRequestId))
      .leftJoin(lastSeenRun, eq(lastSeenRun.id, read.findings.lastSeenScanRunId))
  );
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
    // W18-32: lines of the scanned file around the finding, copied at scan
    // time. null when there are none to show (secrets, repo-level findings,
    // old rows, closed past retention); the web app then shows the evidence.
    context:
      r.contextLines === null || r.contextStartLine === null
        ? null
        : { start_line: r.contextStartLine, lines: r.contextLines },
    recommendation: r.recommendation,
    // W20-08 (UX_TODO FND-57): WHY the scanner thinks this applies. It was
    // overwritten by the fix whenever one existed, so the person deciding
    // "real, or not affected?" saw the upgrade advice and never the reason.
    // Null on rows stored before the column, and wherever it would only repeat
    // the recommendation.
    rationale: r.rationale !== null && r.rationale !== r.recommendation ? r.rationale : null,
    status: r.status,
    // W20-08 (FND-66): true when dismissing or marking won't fix needs an admin.
    dismiss_requires_admin: dismissNeedsAdmin(r),
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
    dependency: dependencyEvidenceOf(r),
    // null, not 0: the nightly reprice may not have reached it, and a 0
    // would read as "judged, and judged harmless".
    effective_risk: r.effectiveRisk === null ? null : Number(r.effectiveRisk),
    risk_band: r.riskBand,
    risk_factors: r.riskFactors,
    experimental: r.experimental,
    // W18-24. Set when ANOTHER tool raised this finding (a SARIF upload or a
    // GitHub code-scanning alert), so the UI can say whose opinion it is.
    // Null for every finding RepoPulse produced itself.
    external: externalOf(r),
    // W20-15 (UX_TODO X-10): rule, model or another tool — the "mechanical
    // first, then AI" promise, said on every finding instead of "Tier N".
    found_by: foundByOf(r),
    // W20-25 (UX_TODO X-10): which of the customer's AI models judged it, on
    // which connection, and what it said. Null when no model has.
    // W21-03: or the second model's verify verdict (confirmed / contradicted),
    // whichever is newer.
    verified_by: verifiedByOf(r),
    // W21-03: the second model's reason for its verdict, or why no second
    // opinion could be had. Null when no verify step has run.
    verify_reason: r.verifyReason ?? null,
    // W20-18 (UX_TODO X-08): the tracker issue (Jira, Linear, ...) someone
    // linked, http(s) only; null when nobody has.
    external_ticket_url: r.externalTicketUrl,
    // W20-21 (UX_TODO FND-70): the pull request it was raised on, so the panel
    // can link RepoPulse's own PR page. Null when it was not raised on one.
    pull_request: r.prNumber === null ? null : { number: r.prNumber },
    // W20-21 (UX_TODO FND-25): an accepted risk's review date, YYYY-MM-DD.
    review_by: r.reviewBy,
    // W20-21 (UX_TODO FND-51): the scan that last saw it, with its commit.
    last_seen_scan:
      r.lastSeenScanRunId === null
        ? null
        : {
            id: r.lastSeenScanRunId,
            commit_sha: r.lastSeenScanCommit ?? null,
            at: r.lastSeenScanAt?.toISOString() ?? null,
          },
    // OPEN IT IN THE FORGE (W16-41). Null when there is nothing honest to link
    // to — a finding about the whole repository has no file, and a connection
    // with no recorded base URL has no instance to point at.
    forge: forgeLinkFor(r),
  };
}

/**
 * What the dependency scanner worked out about one CVE (W20-08, UX_TODO
 * FND-57): reachability tier, usage and its evidence, call sites, scope,
 * EPSS and aliases. All of it was computed and stored in `yields` and none of
 * it was sent, so the panel could say only "pkg@ver is affected by CVE-X".
 * Null for every finding that is not a dependency or image CVE.
 */
export function dependencyEvidenceOf(r: {
  dimension: string;
  scannerKey: string | null;
  yields: Record<string, unknown> | null;
}) {
  if (r.dimension !== 'dependency' || r.yields === null) return null;
  const y = r.yields;
  const strings = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  const scope = y['dep_scope'] as { kind?: unknown; depth?: unknown } | undefined;
  // Both are stored as the scanner's own records ({file, line, symbol} and
  // {file, line, quote}, validation/types.ts); anything else is dropped rather
  // than rendered as "[object Object]".
  const located = (v: unknown, extra: 'symbol' | 'quote') =>
    (Array.isArray(v) ? v : []).flatMap((c: unknown) => {
      if (!c || typeof c !== 'object') return [];
      const rec = c as Record<string, unknown>;
      if (typeof rec['file'] !== 'string') return [];
      return [
        {
          file: rec['file'],
          line: typeof rec['line'] === 'number' ? rec['line'] : null,
          [extra]: typeof rec[extra] === 'string' ? rec[extra] : null,
        },
      ];
    });
  return {
    reachability: typeof y['reachability'] === 'string' ? y['reachability'] : null,
    usage: typeof y['usage'] === 'string' ? y['usage'] : null,
    usage_evidence: located(y['usage_evidence'], 'quote'),
    call_sites: located(y['call_sites'], 'symbol'),
    scope:
      scope && typeof scope.kind === 'string'
        ? { kind: scope.kind, depth: typeof scope.depth === 'number' ? scope.depth : null }
        : null,
    epss: typeof y['epss'] === 'number' ? y['epss'] : null,
    aliases: strings(y['aliases']),
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
/** `{tool, source, tool_version}` for an external finding, else null (W18-24). */
// FoundBy, foundByOf and externalOf live in lib/found-by.ts (W21-01), shared
// with the PR's "New on this PR" answer.
export type { FoundBy } from '../../lib/found-by.js';

/**
 * Which AI model judged a finding (W20-25), now including the second-model
 * verify (W21-03): the newer of the newest triage answer and the verify
 * verdict. A verify verdict reads 'confirmed' or 'contradicted'; a
 * contradiction marks the finding and never changes its status.
 */
export function verifiedByOf(r: {
  verifiedModel?: string | null;
  verifiedConnection?: string | null;
  verifiedVerdict?: string | null;
  verifiedAt?: string | Date | null;
  secondModel: string | null;
  secondConnection: string | null;
  secondAt: Date | null;
  verifyStatus: string;
}): { model: string; connection: string | null; verdict: string | null; at: string | null } | null {
  const triageAt = r.verifiedAt ? new Date(r.verifiedAt) : null;
  const triage =
    r.verifiedModel === null || r.verifiedModel === undefined
      ? null
      : {
          model: r.verifiedModel,
          connection: r.verifiedConnection ?? null,
          verdict: r.verifiedVerdict ?? null,
          at: triageAt ? triageAt.toISOString() : null,
        };
  const second =
    r.secondModel === null || r.verifyStatus === 'unverified'
      ? null
      : {
          model: r.secondModel,
          connection: r.secondConnection,
          verdict: r.verifyStatus,
          at: r.secondAt ? r.secondAt.toISOString() : null,
        };
  if (!second) return triage;
  if (!triage) return second;
  return (r.secondAt?.getTime() ?? 0) >= (triageAt?.getTime() ?? 0) ? second : triage;
}

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

/**
 * One transition, atomically: the status write and the history row that
 * explains it succeed or fail together (W17-23).
 *
 * Two things were possible before. The row could change status with no event
 * behind it (the insert failed after the update committed), which is a
 * decision nobody can later account for. And two people acting on the same
 * finding both read `open`, both passed the lifecycle check, and the second
 * write silently replaced the first — the WHERE now names the status that was
 * read, so a row that has moved is left alone and reported. Returns false in
 * that case and writes nothing.
 */
async function applyTransition(
  db: Database,
  t: {
    workspaceId: number;
    findingId: number;
    fromStatus: string;
    toStatus: string;
    userId: number;
    actorLogin: string | null;
    reason: string;
    dismissReason?: string | null;
    /** W20-21 (FND-25): set with an accepted risk, cleared by every other move. */
    reviewBy?: string | null;
  },
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const moved = await tx
      .update(read.findings)
      .set({
        status: t.toStatus,
        statusChangedBy: t.userId,
        statusChangedAt: new Date(),
        ...(t.dismissReason !== undefined ? { dismissReason: t.dismissReason } : {}),
        reviewBy: t.reviewBy ?? null,
      })
      .where(
        and(
          eq(read.findings.id, t.findingId),
          eq(read.findings.workspaceId, t.workspaceId),
          eq(read.findings.status, t.fromStatus),
        ),
      )
      .returning({ id: read.findings.id });
    if (moved.length === 0) return false;
    await tx.insert(read.findingEvents).values({
      workspaceId: t.workspaceId,
      findingId: t.findingId,
      fromStatus: t.fromStatus,
      toStatus: t.toStatus,
      actor: t.userId,
      actorLogin: t.actorLogin,
      reason: t.reason,
    });
    return true;
  });
}

/** The state of each pull request a finding was raised on, by internal id. */
async function prStates(
  db: Database,
  workspaceId: number,
  ids: readonly (number | null)[],
): Promise<Map<number, string>> {
  const wanted = [...new Set(ids.filter((id): id is number => id !== null))];
  if (wanted.length === 0) return new Map();
  const rows = await db
    .select({ id: facts.pullRequests.id, state: facts.pullRequests.state })
    .from(facts.pullRequests)
    .where(
      and(eq(facts.pullRequests.workspaceId, workspaceId), inArray(facts.pullRequests.id, wanted)),
    );
  return new Map(rows.map((r) => [r.id, r.state]));
}

/** The note rule for closing moves (W20-08, FND-66), or null when the note will do. */
function noteRefusal(to: string, note: string): string | null {
  if (!CLOSING_STATUSES.includes(to) || note.length >= DISMISS_NOTE_MIN) return null;
  return `A dismissal or won't-fix note must say why in at least ${DISMISS_NOTE_MIN} characters: it is the only record of the decision.`;
}

/** The list's query parameters, as GET /findings and GET /findings/ids read them. */
interface ListQuery {
  dimension?: string;
  status?: string;
  severity_min?: string;
  confidence_min?: string;
  repo_id?: string;
  file?: string;
  pr_number?: string;
  verify_status?: string;
  scanner_key?: string;
  cve_id?: string;
  in_chain?: string;
  kev?: string;
  risk_band?: string;
  rule_id?: string;
  experimental?: string;
  /** W20-13 (FND-20): free text over title, file, CVE id, rule id. */
  q?: string;
  /** W20-13 (FND-46): the findings of one attack chain. */
  chain_id?: string;
  /** W20-21 (FND-22): these findings only, a comma list of ids ("Show these"). */
  ids?: string;
  /** W20-21 (FND-68): findings first raised by these scan runs (comma list). */
  scan_run_id?: string;
  /** W20-21 (FND-68): findings these scan runs closed (comma list). */
  closed_by_scan_run?: string;
  /** W20-21 (AI-32): findings raised by one AI pass. */
  ai_pass_run_id?: string;
  /** W20-21 (AI-32): `model` = raised by a model (an AI pass or a model review). */
  found_by?: string;
  /** W20-21 (FND-55): `security` = every security-shaped dimension at once. */
  dimension_group?: string;
  /** W20-21 (FND-55): exactly this severity (the tile's per-severity counts). */
  severity?: string;
}

/** The dimensions the Overview security tile counts (`dimension_group=security`). */
export const SECURITY_GROUP_DIMENSIONS = [
  'secrets',
  'dependency',
  'sast',
  'iac',
  'chain',
  'security',
];

/** `%` and `_` in a search are literal text, not LIKE wildcards. */
export function likeContains(text: string): string {
  return `%${text.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/**
 * Every filter the list applies, built once (W20-08). GET /findings/ids must
 * select exactly the rows the list counts in `total`, or "select all 240
 * matching" would act on a different 240.
 */
export function listFilters(db: Database, workspaceId: number, q: ListQuery) {
  const filters = [eq(read.findings.workspaceId, workspaceId)];
  if (q.dimension && DIMENSIONS.includes(q.dimension as (typeof DIMENSIONS)[number])) {
    filters.push(eq(read.findings.dimension, q.dimension));
  }
  // One status, `active` (open + confirmed) or a comma list (W20-08, FND-49).
  const statuses = statusesFrom(q.status);
  if (statuses.length === 1) filters.push(eq(read.findings.status, statuses[0]!));
  else if (statuses.length > 1) filters.push(inArray(read.findings.status, statuses));
  if (q.dimension_group === 'security') {
    filters.push(inArray(read.findings.dimension, SECURITY_GROUP_DIMENSIONS));
  }
  if (q.severity && Number.isInteger(Number(q.severity))) {
    filters.push(eq(read.findings.severity, Number(q.severity)));
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
  if (q.chain_id) filters.push(eq(read.findings.chainId, q.chain_id));
  if (q.risk_band && ['act', 'schedule', 'track'].includes(q.risk_band)) {
    filters.push(eq(read.findings.riskBand, q.risk_band));
  }
  if (q.rule_id) filters.push(eq(read.findings.ruleId, q.rule_id));
  if (q.kev === 'true') {
    // KEV lives in the finding's payload rather than a column: it is a fact
    // about the CVE, set by the dependency scanner (W8-06, parked), and a
    // column would have to be backfilled for every scanner that never sets
    // it. Filtering on the payload means this facet works the day W8-06
    // lands and returns nothing — correctly — until then.
    filters.push(sql`${read.findings.yields} ->> 'kev' = 'true'`);
  }

  // W20-13 (UX_TODO FND-20): "find the lodash one" without paging. Case-blind
  // substring match on the fields a person remembers a finding by; capped so
  // a pasted wall of text is not a query plan.
  const text = typeof q.q === 'string' ? q.q.trim().slice(0, 200) : '';
  if (text) {
    const pattern = likeContains(text);
    filters.push(
      or(
        ilike(read.findings.title, pattern),
        ilike(read.findings.file, pattern),
        ilike(read.findings.cveId, pattern),
        ilike(read.findings.ruleId, pattern),
      )!,
    );
  }

  // W20-21 (UX_TODO FND-22): "Show these" after a bulk action names its ids.
  const ids = idList(q.ids);
  if (ids.length > 0) filters.push(inArray(read.findings.id, ids));
  // W20-21 (UX_TODO FND-68): what one manual scan raised, and what it closed.
  const raisedBy = idList(q.scan_run_id, 50);
  if (raisedBy.length > 0) filters.push(inArray(read.findings.scanRunId, raisedBy));
  const closedBy = idList(q.closed_by_scan_run, 50);
  if (closedBy.length > 0) {
    filters.push(
      inArray(
        read.findings.id,
        db
          .select({ id: read.findingEvents.findingId })
          .from(read.findingEvents)
          .where(
            and(
              eq(read.findingEvents.workspaceId, workspaceId),
              inArray(read.findingEvents.scanRunId, closedBy),
              eq(read.findingEvents.toStatus, 'resolved'),
            ),
          ),
      ),
    );
  }
  // W20-21 (UX_TODO AI-32): what one AI pass raised, through its provenance.
  const passId = Number(q.ai_pass_run_id);
  if (q.ai_pass_run_id && Number.isInteger(passId) && passId > 0) {
    filters.push(
      inArray(
        read.findings.id,
        db
          .select({ id: read.aiFindingProvenance.findingId })
          .from(read.aiFindingProvenance)
          .where(
            and(
              eq(read.aiFindingProvenance.workspaceId, workspaceId),
              eq(read.aiFindingProvenance.aiPassRunId, passId),
            ),
          ),
      ),
    );
  }
  // A model raised it: the finding hangs off an analysis run, not a scan.
  if (q.found_by === 'model') filters.push(isNotNull(read.findings.analysisRunId));

  // SHADOW FINDINGS ARE NEVER MIXED IN SILENTLY (W18-29). A candidate rule's
  // finding is stamped experimental so its precision can be measured before
  // anyone is asked to act on it (CODE_HEALTH_SUITE §8.2). Listing them
  // beside active findings by default — which this route did until now,
  // while the risk view and top actions already left them out — presented an
  // unproven rule's guess with the same weight as a proven one. Excluded by
  // default; the explorer's facet asks for them by name, and the response
  // counts what was held back so the screen can say so instead of hiding it.
  const experimentalMode =
    q.experimental === 'include' || q.experimental === 'only' ? q.experimental : 'exclude';
  const withoutShadowFacet = [...filters];
  if (experimentalMode === 'exclude') filters.push(eq(read.findings.experimental, false));
  if (experimentalMode === 'only') filters.push(eq(read.findings.experimental, true));
  return { filters, withoutShadowFacet, experimentalMode };
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
      /** W18-29: one rule, across the scanners that carry rule ids. */
      rule_id?: string;
      /** W18-29: 'exclude' (default) | 'include' | 'only' — shadow-mode findings. */
      experimental?: string;
      /** W20-13: free-text search (title, file, CVE id, rule id). */
      q?: string;
      /** W20-13: one attack chain's findings. */
      chain_id?: string;
    } & ListQuery;
  }>('/findings', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');

    const {
      filters: built,
      withoutShadowFacet,
      experimentalMode,
    } = listFilters(db, workspaceId, request.query);
    const q = request.query;
    const filters = [...built];

    // Every filter, no cursor: what `total` counts (W20-03).
    const countFilters = [...filters];

    // Keyset, not offset: the list is ordered by severity and new findings
    // arrive at the top, so an offset page would skip or repeat rows while
    // someone is reading — which presents as "findings are missing".
    const sort: FindingSort = q.sort === 'severity' ? 'severity' : 'risk';
    if (q.cursor) {
      const decoded = decodeCursor(q.cursor);
      // A cursor minted under the other sort orders by different columns; it
      // is not "after" anything in this list.
      if (!decoded || decoded.sort !== sort) return fail(request, reply, 400, 'Invalid cursor');
      const afterSeverityId = or(
        lt(read.findings.severity, decoded.severity),
        and(eq(read.findings.severity, decoded.severity), lt(read.findings.id, decoded.id)),
      )!;
      if (decoded.sort === 'severity') {
        filters.push(afterSeverityId);
      } else if (decoded.risk === null) {
        // Inside the trailing NULLS LAST block: only unpriced rows remain.
        filters.push(and(isNull(read.findings.effectiveRisk), afterSeverityId)!);
      } else {
        filters.push(
          or(
            lt(read.findings.effectiveRisk, decoded.risk),
            and(eq(read.findings.effectiveRisk, decoded.risk), afterSeverityId),
            isNull(read.findings.effectiveRisk),
          )!,
        );
      }
    }

    const rows = await findingsQuery(db)
      .where(and(...filters))
      // W9-11: effective_risk by DEFAULT, severity on request. Severity alone
      // put a critical finding in a file nobody touches above a high one in the
      // hot path — the ordering the risk engine exists to replace. The severity
      // sort is retained because "show me everything critical" is a real
      // question, just not the default one.
      .orderBy(
        ...(sort === 'severity'
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

    // What the default held back, under the same filters (cursor excluded: the
    // count is about the list, not the page). Null when nothing was held back
    // by construction, so the UI never has to tell "zero hidden" from "not
    // asked".
    let shadowHidden: number | null = null;
    if (experimentalMode === 'exclude') {
      const [hidden] = await db
        .select({ n: sql<number>`count(*)::int` })
        .from(read.findings)
        .where(and(...withoutShadowFacet, eq(read.findings.experimental, true)));
      shadowHidden = hidden?.n ?? 0;
    }

    // How many findings match, across every page (W20-03, UX_TODO FND-10).
    // The triage queue holds one page and called it the whole queue; "50 of
    // 1,240" needs the second number, and only the database has it.
    const [matching] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(read.findings)
      .where(and(...countFilters));

    return reply.send({
      items: page.map(toFinding),
      next_cursor: rows.length > PAGE_SIZE && last ? encodeCursor(sort, last) : null,
      total: matching?.n ?? 0,
      experimental: experimentalMode,
      shadow_hidden: shadowHidden,
    });
  });

  /**
   * GET /findings/ids — every id the list's filters match, across pages
   * (W20-08, UX_TODO FND-12): "select all 240 matching" for the bulk bar.
   * The same filters as the list (listFilters), capped, and the cap is said
   * rather than silently applied, so a selection never claims rows it lacks.
   */
  app.get<{ Querystring: ListQuery }>('/findings/ids', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
    const { filters } = listFilters(db, workspaceId, request.query);
    const rows = await db
      .select({ id: read.findings.id })
      .from(read.findings)
      .where(and(...filters))
      .orderBy(desc(read.findings.id))
      .limit(BULK_SELECT_CAP + 1);
    return reply.send({
      ids: rows.slice(0, BULK_SELECT_CAP).map((r) => r.id),
      truncated: rows.length > BULK_SELECT_CAP,
      cap: BULK_SELECT_CAP,
    });
  });

  /**
   * GET /findings/export?format=csv|sarif — the list under its current filters,
   * as a file (W20-18, UX_TODO X-08). The same filters as the list
   * (listFilters, workspace-filtered) and the same order, up to EXPORT_CAP rows;
   * a cut export says so in the file and in X-RepoPulse-Truncated. Audited:
   * findings leaving the product is the SC-22 `finding.bulk_export` record.
   */
  app.get<{ Querystring: ListQuery & { format?: string; sort?: string } }>(
    '/findings/export',
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
      const format = request.query.format;
      if (format !== 'csv' && format !== 'sarif') {
        return fail(request, reply, 400, 'Choose a format', 'format must be "csv" or "sarif".');
      }
      const { filters } = listFilters(db, workspaceId, request.query);
      const sort: FindingSort = request.query.sort === 'severity' ? 'severity' : 'risk';
      const rows = await findingsQuery(db)
        .where(and(...filters))
        .orderBy(
          ...(sort === 'severity'
            ? [desc(read.findings.severity), desc(read.findings.id)]
            : [
                sql`${read.findings.effectiveRisk} desc nulls last`,
                desc(read.findings.severity),
                desc(read.findings.id),
              ]),
        )
        .limit(EXPORT_CAP + 1);
      const truncated = rows.length > EXPORT_CAP;
      const page = rows.slice(0, EXPORT_CAP);
      const base = (process.env.PUBLIC_BASE_URL ?? '').trim() || null;
      const exportRows = page.map((r) => ({
        ...r,
        recommendation: r.recommendation ?? '',
      }));

      const userId = request.session?.get('userId');
      auditLog(request.log, {
        event: 'finding.bulk_export',
        actorUserId: userId ?? null,
        workspaceId,
        ip: request.ip,
        ua: request.headers['user-agent'] ?? null,
        detail: {
          format,
          count: page.length,
          truncated,
          // The filters, not the rows: what was asked for is the record.
          filters: Object.fromEntries(
            Object.entries(request.query).filter(([k, v]) => k !== 'format' && v !== ''),
          ),
        },
      });

      const day = new Date().toISOString().slice(0, 10);
      const ext: Record<ExportFormat, string> = { csv: 'csv', sarif: 'sarif' };
      reply
        .header(
          'Content-Disposition',
          `attachment; filename="repopulse-findings-${day}.${ext[format]}"`,
        )
        .header('X-RepoPulse-Count', String(page.length))
        .header('X-RepoPulse-Truncated', truncated ? 'true' : 'false')
        .header('Cache-Control', 'no-store');
      if (format === 'csv') {
        return reply
          .type('text/csv; charset=utf-8')
          .send(findingsCsv(exportRows, { base, truncated }));
      }
      return reply
        .type('application/sarif+json; charset=utf-8')
        .send(JSON.stringify(findingsSarif(exportRows, { base, truncated }), null, 2));
    },
  );

  /**
   * PUT /findings/:id/external-ticket — link the issue that tracks this
   * finding in another tool (W20-18, UX_TODO X-08). Optional, http(s) only,
   * validated here and by a CHECK; `url: null` removes it. Any member may set
   * it (it records where the work is tracked, it decides nothing). Audited.
   */
  app.put<{ Params: { id: string }; Body: { url?: unknown } | undefined }>(
    '/findings/:id/external-ticket',
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      const userId = request.session?.get('userId');
      if (workspaceId === undefined || userId === undefined) {
        return fail(request, reply, 401, 'No active session');
      }
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) return fail(request, reply, 400, 'Invalid finding id');
      const cleaned = cleanTicketUrl(request.body?.url);
      if (typeof cleaned === 'string') return fail(request, reply, 400, 'Invalid link', cleaned);

      const [before] = await db
        .select({ url: read.findings.externalTicketUrl })
        .from(read.findings)
        .where(and(eq(read.findings.id, id), eq(read.findings.workspaceId, workspaceId)))
        .limit(1);
      // Tenancy (Law 5): another workspace's finding is a 404, never a 403.
      if (!before) return fail(request, reply, 404, 'No such finding');

      await db
        .update(read.findings)
        .set({ externalTicketUrl: cleaned.url })
        .where(and(eq(read.findings.id, id), eq(read.findings.workspaceId, workspaceId)));
      if (before.url !== cleaned.url) {
        auditLog(request.log, {
          event: 'finding.external_ticket_set',
          actorUserId: userId,
          workspaceId,
          ip: request.ip,
          ua: request.headers['user-agent'] ?? null,
          findingId: id,
          detail: { from: before.url, to: cleaned.url },
        });
      }
      return reply.send({ id, external_ticket_url: cleaned.url });
    },
  );

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
      // W20-13 (FND-71): the rate's denominator, findings a person has judged.
      triaged: fp.triaged,
      // rate === null means nothing has been reviewed yet. Sent through as null
      // rather than 0 so the UI can say "no data" instead of implying a
      // flawless model (FR-INSIGHTS-1).
    });
  });

  /**
   * GET /findings/facets — the rule facet, from what findings actually carry
   * (W18-29).
   *
   * Built from the rows, not from a catalogue: the in-process fast lane and the
   * YAML packs ship rules with no registry row until an admin acts on one, so a
   * facet fed by rule_registry would offer nothing for exactly the rules people
   * most need to look at. Active and shadow counts travel separately because
   * one rule can have both — findings raised before and after a promotion — and
   * the facet must not blur them into one number.
   */
  app.get('/findings/facets', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');

    const rows = await db
      .select({
        scannerKey: read.findings.scannerKey,
        ruleId: read.findings.ruleId,
        active: sql<number>`count(*) filter (where not ${read.findings.experimental})::int`,
        shadow: sql<number>`count(*) filter (where ${read.findings.experimental})::int`,
      })
      .from(read.findings)
      .where(and(eq(read.findings.workspaceId, workspaceId), isNotNull(read.findings.ruleId)))
      .groupBy(read.findings.scannerKey, read.findings.ruleId)
      .orderBy(read.findings.ruleId);

    const registry = await db
      .select({ ruleId: security.ruleRegistry.ruleId, status: security.ruleRegistry.status })
      .from(security.ruleRegistry)
      .where(eq(security.ruleRegistry.workspaceId, workspaceId));
    const lifecycle = new Map(registry.map((r) => [r.ruleId, r.status]));

    const [shadowTotal] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(read.findings)
      .where(and(eq(read.findings.workspaceId, workspaceId), eq(read.findings.experimental, true)));

    return reply.send({
      rules: rows.map((r) => ({
        rule_id: r.ruleId,
        scanner_key: r.scannerKey,
        active: r.active,
        shadow: r.shadow,
        // null = no registry row: the rule runs as shipped (in shadow, for the
        // fast lane), and nobody has promoted or retired it here.
        lifecycle: lifecycle.get(r.ruleId ?? '') ?? null,
      })),
      shadow_total: shadowTotal?.n ?? 0,
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

    // Workspace-filtered as well as by finding (Law 5). The scan behind an
    // automatic change is joined for its commit and date (W20-21, FND-51).
    const rows = await db
      .select({
        e: read.findingEvents,
        scanCommit: security.scanRuns.commitSha,
        scanAt: security.scanRuns.startedAt,
      })
      .from(read.findingEvents)
      .leftJoin(
        security.scanRuns,
        and(
          eq(security.scanRuns.id, read.findingEvents.scanRunId),
          eq(security.scanRuns.workspaceId, workspaceId),
        ),
      )
      .where(
        and(eq(read.findingEvents.findingId, id), eq(read.findingEvents.workspaceId, workspaceId)),
      )
      .orderBy(read.findingEvents.at);

    return reply.send({
      items: rows.map(({ e, scanCommit, scanAt }) => ({
        from_status: e.fromStatus,
        to_status: e.toStatus,
        // W20-21 (UX_TODO FND-51): the scan that made an automatic change -
        // "not seen by the scan of def456 on <date>". Null for a person's.
        scan:
          e.scanRunId === null
            ? null
            : {
                id: e.scanRunId,
                commit_sha: scanCommit ?? null,
                at: scanAt?.toISOString() ?? null,
              },
        // THREE STATES, not two (W16-59). A null actor used to mean exactly one
        // thing — the analysis pass acting by itself — and now that the FK is
        // ON DELETE SET NULL it could also mean a person whose account has been
        // removed. The denormalised login is what tells them apart, so
        // `automatic` requires BOTH to be absent; a row with a login and no id
        // is a person, and the screen says so.
        actor: e.actor,
        actor_login: e.actorLogin,
        automatic: e.actor === null && e.actorLogin === null,
        reason: e.reason,
        at: e.at.toISOString(),
      })),
    });
  });

  /** PATCH /findings/:id — a human moving a finding through its lifecycle. */
  app.patch<{
    Params: { id: string };
    Body: { status?: unknown; note?: unknown; dismiss_reason?: unknown; review_by?: unknown };
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

    const shortNote = noteRefusal(next, note);
    if (shortNote) return fail(request, reply, 400, 'The note is too short', shortNote);

    const [finding] = await db
      .select()
      .from(read.findings)
      .where(and(eq(read.findings.id, id), eq(read.findings.workspaceId, workspaceId)))
      .limit(1);
    if (!finding) return fail(request, reply, 404, 'Not Found');

    const states = await prStates(db, workspaceId, [finding.pullRequestId]);
    const refusal = dismissRefusal(
      next,
      {
        severity: finding.severity,
        prState:
          finding.pullRequestId === null ? null : (states.get(finding.pullRequestId) ?? null),
      },
      request.role,
    );
    // 403 after the 404: the finding is this workspace's, so saying it exists
    // leaks nothing, and the reason tells the member whom to ask.
    if (refusal) return fail(request, reply, 403, 'Admin role required', refusal);

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

    // W20-21 (UX_TODO FND-25): an accepted risk carries the day it is looked
    // at again, or it never comes back for review.
    let reviewBy: string | null = null;
    if (dismissReason === 'accepted_risk') {
      const parsed = reviewByFrom(request.body?.review_by);
      if ('refusal' in parsed) {
        return fail(request, reply, 400, 'A review date is required', parsed.refusal);
      }
      reviewBy = parsed.date;
    }

    // The login travels WITH the id (W16-59), so removing the account leaves
    // "a person whose account is gone" rather than "the analysis pass did it".
    const actorLogin = await actorLoginFor(db, userId);
    const applied = await applyTransition(db, {
      workspaceId,
      findingId: id,
      fromStatus: finding.status,
      toStatus: next,
      userId,
      actorLogin,
      reason: dismissReason
        ? `${dismissReason}${reviewBy ? ` (review by ${reviewBy})` : ''}: ${note}`
        : note,
      ...(next === 'dismissed' ? { dismissReason } : {}),
      reviewBy,
    });
    if (!applied) {
      // The row moved between the read above and the write: someone else's
      // decision landed first. Reported as the same conflict an invalid
      // transition is, rather than overwriting their judgement (W17-23).
      return fail(
        request,
        reply,
        409,
        'Transition not allowed',
        'The finding changed status while this request was in flight. Reload and try again.',
      );
    }

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
      ...(reviewBy ? { reviewBy } : {}),
    });

    return reply.send({ id, status: next, dismiss_reason: dismissReason, review_by: reviewBy });
  });

  /**
   * POST /findings/bulk — the same transition across a selection.
   *
   * W20-03 (UX_TODO FND-11): a bulk dismissal now carries `dismiss_reason`,
   * validated and recorded exactly as PATCH /findings/:id records it. Before
   * this every bulk dismissal landed with no reason category, so it was
   * invisible to the false-positive rate and to the rule precision it feeds.
   * Every status the lifecycle has is accepted; canTransition decides per row.
   */
  app.post<{
    Body: {
      ids?: unknown;
      status?: unknown;
      note?: unknown;
      dismiss_reason?: unknown;
      review_by?: unknown;
    };
  }>('/findings/bulk', async (request, reply) => {
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
    const shortNote = noteRefusal(next, note);
    if (shortNote) return fail(request, reply, 400, 'The note is too short', shortNote);
    const rawReason = request.body?.dismiss_reason;
    if (
      rawReason !== undefined &&
      rawReason !== null &&
      !DISMISS_REASONS.includes(rawReason as (typeof DISMISS_REASONS)[number])
    ) {
      // Refused rather than dropped: forty findings dismissed under a reason
      // nobody can see afterwards is the defect this field exists to end.
      return fail(
        request,
        reply,
        400,
        'Invalid dismiss reason',
        `dismiss_reason must be one of ${DISMISS_REASONS.join(', ')}`,
      );
    }
    const dismissReason = next === 'dismissed' && typeof rawReason === 'string' ? rawReason : null;
    // W20-21 (UX_TODO FND-25): the same review date for every accepted risk in
    // the batch, required as it is for one.
    let reviewBy: string | null = null;
    if (dismissReason === 'accepted_risk') {
      const parsed = reviewByFrom(request.body?.review_by);
      if ('refusal' in parsed) {
        return fail(request, reply, 400, 'A review date is required', parsed.refusal);
      }
      reviewBy = parsed.date;
    }
    // Resolved ONCE for the whole batch — it is the same person for every row
    // and a lookup per finding would be a query per finding. After the
    // guards, so a malformed request costs no query at all.
    const bulkActorLogin = await actorLoginFor(db, userId);

    const rows = await db
      .select()
      .from(read.findings)
      .where(and(eq(read.findings.workspaceId, workspaceId), inArray(read.findings.id, ids)));

    const applied: number[] = [];
    const skipped: { id: number; reason: string }[] = [];

    // An id this workspace does not hold is reported, not silently dropped —
    // as "not found" whether it never existed or is another workspace's, so
    // the answer cannot be used to probe for ids (Law 5, as PATCH's 404).
    const found = new Set(rows.map((r) => r.id));
    for (const id of new Set(ids)) {
      if (!found.has(id)) skipped.push({ id, reason: 'not found' });
    }

    const states = await prStates(
      db,
      workspaceId,
      rows.map((r) => r.pullRequestId),
    );
    for (const row of rows) {
      // Per row, like the lifecycle check (W20-08, FND-66): a member's bulk
      // dismissal still closes the low-severity rows and reports the rest.
      const refusal = dismissRefusal(
        next,
        {
          severity: row.severity,
          prState: row.pullRequestId === null ? null : (states.get(row.pullRequestId) ?? null),
        },
        request.role,
      );
      if (refusal) {
        skipped.push({ id: row.id, reason: 'needs an admin' });
        continue;
      }
      if (!canTransition(row.status as FindingStatus, next as FindingStatus)) {
        // Reported per id rather than failing the whole batch: a bulk action
        // that rejects 40 findings because one was already resolved is a
        // bulk action nobody uses.
        skipped.push({ id: row.id, reason: `${row.status} → ${next} not permitted` });
        continue;
      }
      const ok = await applyTransition(db, {
        workspaceId,
        findingId: row.id,
        fromStatus: row.status,
        toStatus: next,
        userId,
        actorLogin: bulkActorLogin,
        reason: dismissReason
          ? `${dismissReason}${reviewBy ? ` (review by ${reviewBy})` : ''}: ${note}`
          : note,
        ...(next === 'dismissed' ? { dismissReason } : {}),
        reviewBy,
      });
      if (ok) applied.push(row.id);
      else skipped.push({ id: row.id, reason: 'changed status while this request was in flight' });
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
      dismissReason,
    });

    return reply.send({ applied, skipped });
  });

  /**
   * POST /findings/:id/rotated — record that a leaked secret was rotated
   * (W20-21, UX_TODO FND-61).
   *
   * Deleting the line never closed a secret finding (the secret stays in the
   * commit that added it, and the secrets scan does no sweep), and none of the
   * dismiss reasons fitted. This resolves the finding with reason `rotated`,
   * a required rotation date and note, and the person who recorded it; a later
   * history sweep that sees the same secret again leaves it closed. Any member
   * may record it, as any member may mark a finding fixed. Audited.
   */
  app.post<{ Params: { id: string }; Body: { rotated_on?: unknown; note?: unknown } | undefined }>(
    '/findings/:id/rotated',
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      const userId = request.session.get('userId');
      if (workspaceId === undefined || userId === undefined) {
        return fail(request, reply, 401, 'No active session');
      }
      const id = Number(request.params.id);
      if (!Number.isInteger(id)) return fail(request, reply, 400, 'Invalid finding id');
      const note = typeof request.body?.note === 'string' ? request.body.note.trim() : '';
      if (note.length < DISMISS_NOTE_MIN) {
        return fail(
          request,
          reply,
          400,
          'A note is required',
          `Say how it was rotated (where, by whom) in at least ${DISMISS_NOTE_MIN} characters.`,
        );
      }

      const [finding] = await db
        .select()
        .from(read.findings)
        .where(and(eq(read.findings.id, id), eq(read.findings.workspaceId, workspaceId)))
        .limit(1);
      if (!finding) return fail(request, reply, 404, 'Not Found');
      if (finding.dimension !== 'secrets') {
        return fail(
          request,
          reply,
          409,
          'Not a secret',
          'Only a leaked secret can be recorded as rotated.',
        );
      }
      if (!canTransition(finding.status as FindingStatus, 'resolved')) {
        return fail(
          request,
          reply,
          409,
          'Transition not allowed',
          `A ${finding.status} finding cannot be recorded as rotated; reopen it first.`,
        );
      }
      const when = rotatedOnFrom(request.body?.rotated_on, finding.firstSeenAt);
      if ('refusal' in when) return fail(request, reply, 400, 'Invalid date', when.refusal);

      const actorLogin = await actorLoginFor(db, userId);
      const applied = await applyTransition(db, {
        workspaceId,
        findingId: id,
        fromStatus: finding.status,
        toStatus: 'resolved',
        userId,
        actorLogin,
        reason: `rotated on ${when.date}: ${note}`,
        // The closing reason, on a resolved row: what keeps a later sighting
        // of the same secret from reopening it (staysClosed).
        dismissReason: 'rotated',
      });
      if (!applied) {
        return fail(
          request,
          reply,
          409,
          'Transition not allowed',
          'The finding changed status while this request was in flight. Reload and try again.',
        );
      }
      auditLog(request.log, {
        event: 'finding.secret_rotated',
        actorUserId: userId,
        workspaceId,
        ip: request.ip,
        ua: request.headers['user-agent'] ?? null,
        findingId: id,
        detail: { rotated_on: when.date, from: finding.status },
      });
      return reply.send({ id, status: 'resolved', rotated_on: when.date });
    },
  );
}
