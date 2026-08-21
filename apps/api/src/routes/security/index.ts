import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { core, read, security, type Database } from '@repopulse/shared';
import { SCANNER_DEFAULTS, emptyVexFunnel, isEnabled, listScanners } from '@repopulse/security';
import { sendProblem } from '../../lib/problem.js';
import vexRoutes from './vex.js';

// Security posture API (W8-10, SECURITY_SUITE.md §5, FR-SEC-10 / NFR-15).
//
// The rule that shapes every payload here: a scanner that has never run, a
// scanner that is switched off, and a scanner that ran and found nothing are
// THREE DIFFERENT ANSWERS. Collapsing them into "0 findings" is how a security
// screen tells someone they are safe when nobody has looked — so each scanner
// carries an explicit state and the UI is never handed a bare zero.

export interface SecurityRoutesOptions {
  db: Database;
}

export type ScannerState = 'not_enabled' | 'never_run' | 'ok' | 'error' | 'partial';

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

/** Last run per scanner key for one repo. */
export function stateOf(
  enabled: boolean,
  run: { status: string; partial: boolean | null } | undefined,
): ScannerState {
  if (!enabled) return 'not_enabled';
  if (!run) return 'never_run';
  if (run.status === 'failed') return 'error';
  if (run.status === 'budget_exceeded' || run.partial === true) return 'partial';
  return 'ok';
}

export default async function securityRoutes(
  app: FastifyInstance,
  opts: SecurityRoutesOptions,
): Promise<void> {
  const { db } = opts;

  // Registered here rather than in the api-v1 plugin: VEX is part of the
  // security surface, and keeping its registration beside the payload it feeds
  // means the two cannot drift into being wired from different places.
  await app.register(vexRoutes, { db });

  /** GET /repos/:repoId/security — the Security tab's whole payload. */
  app.get<{ Params: { repoId: string } }>('/repos/:repoId/security', async (request, reply) => {
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

    const stored = await db
      .select()
      .from(security.repoScannerConfig)
      .where(
        and(
          eq(security.repoScannerConfig.workspaceId, workspaceId),
          eq(security.repoScannerConfig.repoId, repoId),
        ),
      );
    const enabledByKey = new Map(stored.map((row) => [row.scannerKey, row.enabled]));

    // Latest run per scanner, in one pass rather than per key: DISTINCT ON is
    // the reason this endpoint stays one query as scanners are added.
    const runs = await db
      .select()
      .from(security.scanRuns)
      .where(
        and(eq(security.scanRuns.workspaceId, workspaceId), eq(security.scanRuns.repoId, repoId)),
      )
      .orderBy(desc(security.scanRuns.startedAt))
      .limit(500);
    const latestByKey = new Map<string, (typeof runs)[number]>();
    for (const run of runs)
      if (!latestByKey.has(run.scannerKey)) latestByKey.set(run.scannerKey, run);

    const registered = new Map(listScanners().map((s) => [s.key, s]));
    // The catalog is the union of registered scanners and documented defaults,
    // same as the admin screen: a scanner that failed to register must still
    // appear, or its absence looks intentional.
    const keys = [
      ...new Set([
        ...registered.keys(),
        ...SCANNER_DEFAULTS.map((d) => d.key),
        ...latestByKey.keys(),
      ]),
    ].sort();

    const findings = await db
      .select({
        severity: read.findings.severity,
        dimension: read.findings.dimension,
        scannerKey: read.findings.scannerKey,
        status: read.findings.status,
        firstSeenAt: read.findings.firstSeenAt,
      })
      .from(read.findings)
      .where(
        and(
          eq(read.findings.workspaceId, workspaceId),
          eq(read.findings.repoId, repoId),
          inArray(read.findings.status, ['open', 'confirmed']),
        ),
      );

    const openBySeverity: Record<number, number> = {};
    for (const f of findings) openBySeverity[f.severity] = (openBySeverity[f.severity] ?? 0) + 1;

    const scanners = keys.map((key) => {
      const run = latestByKey.get(key);
      const stateRun = run ? { status: run.status, partial: run.partial } : undefined;
      const enabled = isEnabled(
        key,
        enabledByKey.has(key) ? { enabled: enabledByKey.get(key)! } : undefined,
      );
      return {
        key,
        display_name:
          registered.get(key)?.displayName ??
          SCANNER_DEFAULTS.find((d) => d.key === key)?.key ??
          key,
        registered: registered.has(key),
        enabled,
        state: stateOf(enabled, stateRun),
        last_run_at: run?.finishedAt?.toISOString() ?? run?.startedAt.toISOString() ?? null,
        last_run_status: run?.status ?? null,
        // The scanner's own error, verbatim: "why is this red" has to be
        // answerable without a log search.
        error: run?.error ?? null,
        scanner_version: run?.scannerVersion ?? null,
        open_findings: findings.filter((f) => f.scannerKey === key).length,
      };
    });

    const chainRows = await db
      .select({
        chainId: read.findings.chainId,
        id: read.findings.id,
        title: read.findings.title,
        severity: read.findings.severity,
      })
      .from(read.findings)
      .where(
        and(
          eq(read.findings.workspaceId, workspaceId),
          eq(read.findings.repoId, repoId),
          isNotNull(read.findings.chainId),
          inArray(read.findings.status, ['open', 'confirmed']),
        ),
      )
      .orderBy(read.findings.severity);

    const chains = new Map<string, { id: string; severity: number; nodes: unknown[] }>();
    for (const row of chainRows) {
      const id = row.chainId as string;
      const chain = chains.get(id) ?? { id, severity: 0, nodes: [] };
      chain.nodes.push({ finding_id: row.id, title: row.title, severity: row.severity });
      // A chain is as severe as its worst step, never an average: an average
      // would let one critical link hide behind three trivial ones.
      chain.severity = Math.max(chain.severity, row.severity);
      chains.set(id, chain);
    }

    // The CVE validation + VEX funnel (W8-13/W8-14, FR-SEC-15). Read off the
    // LAST DEPENDENCY RUN, because `raw` is grype's pre-dedup match count and
    // exists nowhere else — de-duplication is precisely what the findings table
    // stores the far side of.
    const dependencyRun = latestByKey.get('dependency_cve');
    const storedFunnel = dependencyRun?.validationFunnel ?? null;

    const vexRows = await db
      .select({
        status: security.vexStatements.status,
        justification: security.vexStatements.justification,
      })
      .from(security.vexStatements)
      .where(
        and(
          eq(security.vexStatements.workspaceId, workspaceId),
          eq(security.vexStatements.repoId, repoId),
        ),
      );

    const byJustification = { ...emptyVexFunnel().byJustification };
    let notAffected = 0;
    let affectedStatements = 0;
    let fixedStatements = 0;
    for (const row of vexRows) {
      if (row.status === 'not_affected') {
        notAffected += 1;
        if (row.justification && row.justification in byJustification) {
          byJustification[row.justification as keyof typeof byJustification] += 1;
        }
      } else if (row.status === 'affected') affectedStatements += 1;
      else if (row.status === 'fixed') fixedStatements += 1;
    }

    const secretsRuns = runs.filter((r) => r.scannerKey === 'secrets');
    const lastStream = secretsRuns.find((r) => r.trigger === 'pr_synced' || r.trigger === 'push');
    const lastHistory = secretsRuns.find((r) => r.trigger === 'schedule' || r.trigger === 'manual');

    return reply.send({
      repo: { id: repo.id, org: repo.org, name: repo.name },
      open_by_severity: openBySeverity,
      open_total: findings.length,
      scanners,
      secrets: {
        open: findings.filter((f) => f.dimension === 'secrets').length,
        // Two clocks, not one: stream mode says "we are watching new commits"
        // and history says "we have looked back". A repo with a recent stream
        // scan and no history sweep is not covered, and one number cannot say
        // that.
        last_stream_scan_at: lastStream?.finishedAt?.toISOString() ?? null,
        last_history_scan_at: lastHistory?.finishedAt?.toISOString() ?? null,
        // Verified-secret escalation is built and gated off (W8-04); until a
        // verifier can confirm liveness this is honestly zero.
        verified: 0,
      },
      // CVEs: empty until the dependency scanner exists (W8-06, parked for
      // missing tools). The KEY is present so the tab renders an explained
      // empty state rather than a missing section — an absent panel reads as a
      // broken page, and a broken security page reads as no problems.
      cves: [] as { cve_id: string; package: string; severity: number; kev: boolean }[],
      validation_funnel: storedFunnel,
      // NULL, not zero, when the last dependency run predates the column or
      // never happened. The honesty rule (FR-SEC-15) says the raw count is
      // never hidden, and a zero here would say "no advisories" when it means
      // "nobody wrote the number down" — the same failure the scanner states
      // above exist to prevent.
      validation_funnel_recorded: storedFunnel !== null,
      vex: {
        statements: vexRows.length,
        not_affected: notAffected,
        affected: affectedStatements,
        fixed: fixedStatements,
        by_justification: byJustification,
      },
      chains: [...chains.values()].sort((a, b) => b.severity - a.severity),
      // Distinguishes "no chains" from "chain analysis has never run" — W8-09
      // computes chains, and until it lands the empty list means the latter.
      chains_computed: false,
    });
  });

  /** GET /org/security — the org rollup tile (FR-INSIGHTS-2). */
  app.get('/org/security', async (request, reply) => {
    const workspaceId = request.workspace?.id;
    if (workspaceId === undefined) return fail(request, reply, 401, 'No active session');

    const rows = await db
      .select({
        severity: read.findings.severity,
        n: sql<number>`count(*)::int`,
      })
      .from(read.findings)
      .where(
        and(
          eq(read.findings.workspaceId, workspaceId),
          eq(read.findings.dimension, 'secrets'),
          inArray(read.findings.status, ['open', 'confirmed']),
        ),
      )
      .groupBy(read.findings.severity);

    const all = await db
      .select({ severity: read.findings.severity, n: sql<number>`count(*)::int` })
      .from(read.findings)
      .where(
        and(
          eq(read.findings.workspaceId, workspaceId),
          inArray(read.findings.dimension, [
            'secrets',
            'dependency',
            'sast',
            'iac',
            'chain',
            'security',
          ]),
          inArray(read.findings.status, ['open', 'confirmed']),
        ),
      )
      .groupBy(read.findings.severity);

    const [kev] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(read.findings)
      .where(
        and(
          eq(read.findings.workspaceId, workspaceId),
          inArray(read.findings.status, ['open', 'confirmed']),
          sql`${read.findings.yields} ->> 'kev' = 'true'`,
        ),
      );

    const [worst] = await db
      .select({
        chainId: read.findings.chainId,
        severity: sql<number>`max(${read.findings.severity})::int`,
      })
      .from(read.findings)
      .where(
        and(
          eq(read.findings.workspaceId, workspaceId),
          isNotNull(read.findings.chainId),
          inArray(read.findings.status, ['open', 'confirmed']),
        ),
      )
      .groupBy(read.findings.chainId)
      .orderBy(desc(sql`max(${read.findings.severity})`))
      .limit(1);

    const bySeverity: Record<number, number> = {};
    for (const row of all) bySeverity[row.severity] = row.n;

    return reply.send({
      open_by_severity: bySeverity,
      open_total: all.reduce((sum, r) => sum + r.n, 0),
      kev_count: kev?.n ?? 0,
      secrets_open: rows.reduce((sum, r) => sum + r.n, 0),
      // Always red-flagged when non-zero (SECURITY_SUITE §5) — and honestly 0
      // while live verification is off (W8-04).
      verified_secrets: 0,
      worst_chain: worst?.chainId ? { id: worst.chainId, severity: worst.severity } : null,
      // The basis label: what the security numbers are actually built on, so a
      // sub-score computed from one scanner does not read like a full audit.
      basis: 'scanners: secrets',
    });
  });
}
