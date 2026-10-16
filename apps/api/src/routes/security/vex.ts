import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { auditLog, core, read, security, type Database } from '@repopulse/shared';
import {
  CYCLONEDX_SCHEMA,
  OPENVEX_SCHEMA,
  basePurl,
  embedVex,
  isVexJustification,
  isVexStatus,
  openVexDocument,
  parseRange,
  schemaRegistry,
  validateAgainstSchema,
  type VexStatementRecord,
  type VexStatus,
  attributionReport,
  resolveScopes,
} from '@repopulse/security';
import { sendProblem } from '../../lib/problem.js';

// VEX triage and export (W8-14, SECURITY_SUITE.md §3.6, FR-SEC-14).
//
// THE GATE THIS FILE EXISTS FOR: `not_affected` without a justification is a
// 400. Not a warning, not a nullable column — a refusal. "We looked and it does
// not apply" is only worth storing if it carries a reason a reader can
// disagree with, and every unjustified dismissal that gets in is a finding
// nobody can ever re-examine on its merits.
//
// The same rule is enforced twice more, deliberately: by a CHECK constraint on
// vex_statements, so a writer that is not this route cannot bypass it, and by
// the published OpenVEX schema itself, which makes the export the third place
// an unjustified dismissal would be caught. Three gates for one rule is not
// belt and braces here — it is the difference between a policy and a habit.

export interface VexRoutesOptions {
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
 * The purl a finding is about.
 *
 * Parsed out of the evidence quote, which the dependency scanner writes as
 * `<purl> is affected by <id>` — a documented coupling to
 * scanners/dependency/findings.ts and the only structured purl a finding row
 * carries. `yields` holds the funnel's evidence and the pricing inputs but not
 * the package identity, and `title` holds a human sentence. Returning null
 * rather than guessing keeps a malformed row a 400 instead of a statement
 * attached to the wrong package.
 */
export function purlOfFinding(evidence: string): string | null {
  const [candidate] = evidence.split(' is affected by ');
  if (!candidate || !candidate.startsWith('pkg:')) return null;
  return basePurl(candidate.trim());
}

/** DB rows → the shape the pure vex module reads. */
function toRecords(
  rows: (typeof security.vexStatements.$inferSelect & { authorEmail?: string | null })[],
): VexStatementRecord[] {
  return rows.map((row) => ({
    id: row.id,
    packagePurl: row.packagePurl,
    vulnId: row.vulnId,
    versionRange: row.versionRange,
    status: row.status as VexStatus,
    justification: (row.justification ?? null) as VexStatementRecord['justification'],
    statusNotes: row.statusNotes,
    evidence: row.evidence,
    // Attributed to a person. 'unknown author' is honest about a row whose user
    // has since been deleted; 'system' would be a claim nobody made.
    author: row.authorEmail ?? `user:${row.authorUserId ?? 'unknown'}`,
    createdAt: row.createdAt,
  }));
}

async function statementsForRepo(db: Database, workspaceId: number, repoId: number) {
  return db
    .select({
      id: security.vexStatements.id,
      workspaceId: security.vexStatements.workspaceId,
      repoId: security.vexStatements.repoId,
      packagePurl: security.vexStatements.packagePurl,
      vulnId: security.vexStatements.vulnId,
      versionRange: security.vexStatements.versionRange,
      status: security.vexStatements.status,
      justification: security.vexStatements.justification,
      statusNotes: security.vexStatements.statusNotes,
      evidence: security.vexStatements.evidence,
      authorUserId: security.vexStatements.authorUserId,
      createdAt: security.vexStatements.createdAt,
      authorEmail: core.users.email,
    })
    .from(security.vexStatements)
    .leftJoin(core.users, eq(core.users.id, security.vexStatements.authorUserId))
    .where(
      and(
        eq(security.vexStatements.workspaceId, workspaceId),
        eq(security.vexStatements.repoId, repoId),
      ),
    )
    .orderBy(desc(security.vexStatements.createdAt));
}

export default async function vexRoutes(
  app: FastifyInstance,
  opts: VexRoutesOptions,
): Promise<void> {
  const { db } = opts;

  /** POST /findings/:id/vex — triage a dependency finding into a VEX statement. */
  app.post<{
    Params: { id: string };
    Body: {
      status?: unknown;
      justification?: unknown;
      version_range?: unknown;
      notes?: unknown;
    };
  }>('/findings/:id/vex', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    const userId = request.session.get('userId');
    if (workspaceId === undefined || userId === undefined) {
      return fail(request, reply, 401, 'No active session');
    }
    const id = Number(request.params.id);
    if (!Number.isInteger(id)) return fail(request, reply, 400, 'Invalid finding id');

    const status = request.body?.status;
    if (!isVexStatus(status)) {
      return fail(
        request,
        reply,
        400,
        'Invalid VEX status',
        'status must be one of not_affected, affected, fixed, under_investigation',
      );
    }
    if (status === 'under_investigation') {
      // NOT STORED, and refusing is kinder than accepting and doing nothing.
      // Untriaged is the absence of a statement, so "set it to
      // under_investigation" is a request to WITHDRAW one — a DELETE, which is
      // a different call with a different audit story.
      return fail(
        request,
        reply,
        400,
        'under_investigation is not a statement',
        'It is the computed state of a finding no statement covers. Delete the statement instead.',
      );
    }

    // THE GATE. See the header.
    const justification = request.body?.justification;
    if (status === 'not_affected' && !isVexJustification(justification)) {
      return fail(
        request,
        reply,
        400,
        'not_affected requires a justification',
        'One of component_not_present, vulnerable_code_not_present, ' +
          'vulnerable_code_not_in_execute_path, ' +
          'vulnerable_code_cannot_be_controlled_by_adversary, ' +
          'inline_mitigations_already_exist — so a reader can disagree with the reason.',
      );
    }
    if (
      status !== 'not_affected' &&
      justification !== undefined &&
      !isVexJustification(justification)
    ) {
      return fail(request, reply, 400, 'Invalid justification');
    }

    const rawRange = request.body?.version_range;
    const [finding] = await db
      .select()
      .from(read.findings)
      .where(and(eq(read.findings.id, id), eq(read.findings.workspaceId, workspaceId)))
      .limit(1);
    if (!finding) return fail(request, reply, 404, 'Finding not found');
    if (finding.dimension !== 'dependency') {
      // VEX is a statement about a vulnerability in a component. A secret or a
      // SAST finding has no purl and no version range, and forcing one into
      // this shape would produce an export that lies about what it describes.
      return fail(
        request,
        reply,
        400,
        'Not a dependency finding',
        'VEX statements describe a vulnerability in a component; this finding is ' +
          `dimension '${finding.dimension}'.`,
      );
    }

    const purl = purlOfFinding(finding.evidence);
    if (!purl || !finding.ruleId) {
      return fail(
        request,
        reply,
        400,
        'Finding carries no package identity',
        'This finding has no purl in its evidence or no vulnerability id, so a ' +
          'statement about it could not be matched back to a future scan.',
      );
    }

    // Defaults to the version the finding was observed at, which is the honest
    // default: the triager looked at THIS version, and claiming more than that
    // on their behalf is how a suppression outlives its evidence.
    const versionRange =
      typeof rawRange === 'string' && rawRange.trim() !== ''
        ? rawRange.trim()
        : versionFromEvidence(finding.evidence);
    if (versionRange === null) {
      return fail(
        request,
        reply,
        400,
        'A version range is required',
        'The finding does not record a version, so the range it applies to must be stated.',
      );
    }
    const parsed = parseRange(versionRange);
    if (!parsed.ok) {
      return fail(request, reply, 400, 'Invalid version range', parsed.error);
    }

    const notes = typeof request.body?.notes === 'string' ? request.body.notes.trim() : '';

    const [row] = await db
      .insert(security.vexStatements)
      .values({
        workspaceId,
        repoId: finding.repoId,
        packagePurl: purl,
        vulnId: finding.ruleId,
        versionRange,
        status,
        justification: isVexJustification(justification) ? justification : null,
        statusNotes: notes === '' ? null : notes,
        // What the triager was actually shown, captured so the statement can be
        // re-examined later against the same evidence rather than against
        // whatever the tiers say next month.
        evidence: {
          finding_id: id,
          reachability: finding.yields?.['reachability'] ?? null,
          usage: finding.yields?.['usage'] ?? null,
          aliases: finding.yields?.['aliases'] ?? [],
          effective_risk: finding.effectiveRisk,
        },
        authorUserId: userId,
      })
      // A re-triage of the same (package, vuln, range) is an amendment, not a
      // second opinion — the unique key says so, and the newest statement is
      // what the scanner reads.
      .onConflictDoUpdate({
        target: [
          security.vexStatements.workspaceId,
          security.vexStatements.repoId,
          security.vexStatements.packagePurl,
          security.vexStatements.vulnId,
          security.vexStatements.versionRange,
        ],
        set: {
          status,
          justification: isVexJustification(justification) ? justification : null,
          statusNotes: notes === '' ? null : notes,
          authorUserId: userId,
          createdAt: new Date(),
        },
      })
      .returning();

    auditLog(request.log, {
      event: 'vex.statement_recorded',
      actorUserId: userId,
      workspaceId,
      ip: request.ip,
      ua: request.headers['user-agent'] ?? null,
      findingId: id,
      packagePurl: purl,
      vulnId: finding.ruleId,
      versionRange,
      vexStatus: status,
      justification: isVexJustification(justification) ? justification : null,
    });

    return reply.code(201).send({
      id: row!.id,
      finding_id: id,
      package_purl: purl,
      vuln_id: finding.ruleId,
      version_range: versionRange,
      status,
      justification: row!.justification,
    });
  });

  /** DELETE /repos/:repoId/vex/:statementId — withdraw a statement. */
  app.delete<{ Params: { repoId: string; statementId: string } }>(
    '/repos/:repoId/vex/:statementId',
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      const userId = request.session.get('userId');
      if (workspaceId === undefined || userId === undefined) {
        return fail(request, reply, 401, 'No active session');
      }
      const repoId = Number(request.params.repoId);
      const statementId = Number(request.params.statementId);
      if (!Number.isInteger(repoId) || !Number.isInteger(statementId)) {
        return fail(request, reply, 400, 'Invalid id');
      }

      const deleted = await db
        .delete(security.vexStatements)
        .where(
          and(
            eq(security.vexStatements.id, statementId),
            eq(security.vexStatements.workspaceId, workspaceId),
            eq(security.vexStatements.repoId, repoId),
          ),
        )
        .returning({ id: security.vexStatements.id });
      if (deleted.length === 0) return fail(request, reply, 404, 'Statement not found');

      auditLog(request.log, {
        event: 'vex.statement_withdrawn',
        actorUserId: userId,
        workspaceId,
        ip: request.ip,
        ua: request.headers['user-agent'] ?? null,
        statementId,
      });

      // The finding comes back on the next scan, because nothing covers it any
      // more. That is the whole mechanism — there is no un-suppress to run.
      return reply.send({ id: statementId, deleted: true });
    },
  );

  /** GET /repos/:repoId/vex — the statements themselves, for the triage UI. */
  app.get<{ Params: { repoId: string } }>('/repos/:repoId/vex', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
    const repoId = Number(request.params.repoId);
    if (!Number.isInteger(repoId)) return fail(request, reply, 400, 'Invalid repo id');

    const rows = await statementsForRepo(db, workspaceId, repoId);
    return reply.send({
      statements: rows.map((row) => ({
        id: row.id,
        package_purl: row.packagePurl,
        vuln_id: row.vulnId,
        version_range: row.versionRange,
        status: row.status,
        justification: row.justification,
        status_notes: row.statusNotes,
        author: row.authorEmail ?? null,
        created_at: row.createdAt.toISOString(),
      })),
    });
  });

  /** GET /repos/:repoId/vex.json — OpenVEX export. */
  app.get<{ Params: { repoId: string } }>('/repos/:repoId/vex.json', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
    const repoId = Number(request.params.repoId);
    if (!Number.isInteger(repoId)) return fail(request, reply, 400, 'Invalid repo id');

    const [repo] = await db
      .select({ id: core.repos.id, org: core.repos.org, name: core.repos.name })
      .from(core.repos)
      .where(and(eq(core.repos.id, repoId), eq(core.repos.workspaceId, workspaceId)))
      .limit(1);
    if (!repo) return fail(request, reply, 404, 'Repo not found');

    const document = openVexDocument(toRecords(await statementsForRepo(db, workspaceId, repoId)), {
      author: `RepoPulse workspace ${workspaceId}`,
      documentId: `https://repopulse.invalid/vex/${workspaceId}/${repo.org}/${repo.name}`,
      timestamp: new Date(),
    });

    const violations = validateAgainstSchema(schemaRegistry(), OPENVEX_SCHEMA, document);
    if (violations.length > 0) {
      // SERVED ONLY IF IT VALIDATES. An export is a document someone else's
      // tooling will consume as fact; shipping one that fails its own published
      // schema would put our name on a claim we cannot stand behind.
      return fail(
        request,
        reply,
        500,
        'Export failed validation',
        `The generated OpenVEX document does not satisfy the published schema: ` +
          violations
            .slice(0, 3)
            .map((v) => `${v.path || '/'} ${v.keyword}: ${v.message}`)
            .join('; '),
      );
    }

    return reply
      .header('content-type', 'application/json')
      .header('content-disposition', `attachment; filename="${repo.name}-openvex.json"`)
      .send(document);
  });

  /**
   * GET /repos/:repoId/attribution — a NOTICE-style inventory of what ships
   * (W18-39), grouped by license, built from the stored SBOM. Posture only.
   */
  app.get<{ Params: { repoId: string }; Querystring: { dev?: string } }>(
    '/repos/:repoId/attribution',
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
      const repoId = Number(request.params.repoId);
      if (!Number.isInteger(repoId)) return fail(request, reply, 400, 'Invalid repo id');

      const [repo] = await db
        .select({ id: core.repos.id, org: core.repos.org, name: core.repos.name })
        .from(core.repos)
        .where(and(eq(core.repos.id, repoId), eq(core.repos.workspaceId, workspaceId)))
        .limit(1);
      if (!repo) return fail(request, reply, 404, 'Repo not found');

      const [sbom] = await db
        .select({ document: security.sboms.document })
        .from(security.sboms)
        .where(and(eq(security.sboms.workspaceId, workspaceId), eq(security.sboms.repoId, repoId)))
        .orderBy(desc(security.sboms.createdAt))
        .limit(1);
      if (!sbom) {
        return fail(
          request,
          reply,
          404,
          'No SBOM stored for this repo',
          'The dependency scanner has not produced one yet.',
        );
      }
      const text = attributionReport(resolveScopes(sbom.document as Record<string, unknown>), {
        title: `${repo.org}/${repo.name}`,
        includeDev: request.query.dev === '1',
      });
      return reply
        .header('content-type', 'text/markdown; charset=utf-8')
        .header('content-disposition', `attachment; filename="${repo.name}-NOTICE.md"`)
        .send(text);
    },
  );

  /** GET /repos/:repoId/sbom — the stored CycloneDX SBOM, optionally with VEX. */
  app.get<{ Params: { repoId: string }; Querystring: { vex?: string; sha?: string } }>(
    '/repos/:repoId/sbom',
    async (request, reply) => {
      const workspaceId = request.workspace?.id;
      if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');
      const repoId = Number(request.params.repoId);
      if (!Number.isInteger(repoId)) return fail(request, reply, 400, 'Invalid repo id');

      const [repo] = await db
        .select({ id: core.repos.id, name: core.repos.name })
        .from(core.repos)
        .where(and(eq(core.repos.id, repoId), eq(core.repos.workspaceId, workspaceId)))
        .limit(1);
      if (!repo) return fail(request, reply, 404, 'Repo not found');

      const [sbom] = await db
        .select()
        .from(security.sboms)
        .where(
          and(
            eq(security.sboms.workspaceId, workspaceId),
            eq(security.sboms.repoId, repoId),
            ...(request.query.sha ? [eq(security.sboms.commitSha, request.query.sha)] : []),
          ),
        )
        .orderBy(desc(security.sboms.createdAt))
        .limit(1);
      if (!sbom) {
        // "No SBOM" and "an SBOM with no components" are different answers, and
        // a 404 is the only one that says nobody has scanned this repository.
        return fail(
          request,
          reply,
          404,
          'No SBOM stored for this repo',
          'The dependency scanner has not produced one yet.',
        );
      }

      if (request.query.vex !== '1') {
        return reply
          .header('content-disposition', `attachment; filename="${repo.name}-sbom.json"`)
          .send(sbom.document);
      }

      const { document, unmatched } = embedVex(
        sbom.document,
        toRecords(await statementsForRepo(db, workspaceId, repoId)),
      );
      const violations = validateAgainstSchema(schemaRegistry(), CYCLONEDX_SCHEMA, document);
      if (violations.length > 0) {
        return fail(
          request,
          reply,
          500,
          'Export failed validation',
          `The generated CycloneDX document does not satisfy the published schema: ` +
            violations
              .slice(0, 3)
              .map((v) => `${v.path || '/'} ${v.keyword}: ${v.message}`)
              .join('; '),
        );
      }

      return (
        reply
          .header('content-disposition', `attachment; filename="${repo.name}-sbom-vex.json"`)
          // Statements whose package is not in THIS SBOM are dropped from the
          // document (a dangling affects[].ref would fail the schema) and counted
          // in a header, so a caller comparing statement counts is not left to
          // wonder where the difference went.
          .header('x-repopulse-vex-unmatched', String(unmatched.length))
          .send(document)
      );
    },
  );
}

/**
 * The version a dependency finding was observed at.
 *
 * Read off the same evidence quote as the purl. Returns null rather than
 * defaulting to '*': a range nobody chose is the widest possible claim, and
 * making it by accident is precisely the suppression-outlives-its-evidence
 * failure this whole subsystem is built against.
 */
export function versionFromEvidence(evidence: string): string | null {
  const purl = evidence.split(' is affected by ')[0]?.trim();
  if (!purl) return null;
  const withoutQualifiers = purl.split('?')[0]!;
  const at = withoutQualifiers.lastIndexOf('@');
  const slash = withoutQualifiers.lastIndexOf('/');
  if (at <= slash) return null;
  const version = withoutQualifiers.slice(at + 1);
  return version === '' ? null : version;
}
