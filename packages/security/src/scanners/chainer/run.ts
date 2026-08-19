import { and, eq, inArray, isNotNull, notInArray, sql } from 'drizzle-orm';
import { read, security, type Database } from '@repopulse/shared';
import { persistFindings, type IncomingFinding } from '@repopulse/insights';
import { buildChains, type Chain, type ChainableFinding } from './build.js';
import { compoundFindings, type CompoundCluster } from './compound.js';

// The chainer pass (W8-09, SECURITY_SUITE.md §3.5, FR-SEC-8 / FR-INSIGHTS-6).
//
// Runs after a scan batch and weekly. It reads ALL open findings for a repo —
// any scanner, any dimension — because a chain that only ever linked one
// scanner's output would be a report about that scanner rather than about the
// repository.

export const CHAINER_SCANNER_KEY = 'attack_chainer';

export interface ChainerDeps {
  db: Database;
  workspaceId: number;
  repoId: number;
  commitSha?: string;
  trigger?: 'schedule' | 'manual';
  maxDepth?: number;
}

export interface ChainerResult {
  status: 'succeeded' | 'failed';
  scanRunId: number | null;
  chains: number;
  compound: number;
  created: number;
  /** Chain findings closed because a member was fixed or dismissed. */
  autoResolved: number;
  error?: string;
}

function terms(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (value && typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v === true)
      .map(([k]) => k);
  }
  return [];
}

/** Open findings in a shape the pure builder can work with. */
export async function chainableFindings(
  db: Database,
  workspaceId: number,
  repoId: number,
): Promise<ChainableFinding[]> {
  const rows = await db
    .select({
      id: read.findings.id,
      dedupKey: read.findings.dedupKey,
      severity: read.findings.severity,
      title: read.findings.title,
      file: read.findings.file,
      scannerKey: read.findings.scannerKey,
      yields: read.findings.yields,
      preconditions: read.findings.preconditions,
      dimension: read.findings.dimension,
    })
    .from(read.findings)
    .where(
      and(
        eq(read.findings.workspaceId, workspaceId),
        eq(read.findings.repoId, repoId),
        inArray(read.findings.status, ['open', 'confirmed']),
        // The chainer's OWN output is excluded: chaining chains would produce
        // findings about findings, deeper every week.
        notInArray(read.findings.dimension, ['chain', 'compound']),
      ),
    );

  return rows.map((row) => ({
    id: row.id,
    dedupKey: row.dedupKey,
    severity: row.severity,
    title: row.title,
    file: row.file,
    scannerKey: row.scannerKey,
    yields: terms(row.yields),
    preconditions: terms(row.preconditions),
  }));
}

function chainToFinding(chain: Chain): IncomingFinding {
  return {
    dimension: 'chain',
    severity: chain.severity,
    // 4, not 5: the LINKS are deterministic but whether the path is truly
    // walkable depends on code neither end of it can see. High enough to act
    // on, honest about what it is.
    confidence: 4,
    // A chain has no single location — it spans findings, and picking one
    // member's file would send a reader to a step rather than to the path.
    file: null,
    lineStart: null,
    lineEnd: null,
    title: `Attack chain: ${chain.steps[0]?.title ?? 'entry'} → ${chain.steps[chain.steps.length - 1]?.title ?? 'impact'}`,
    evidenceQuote: chain.summary,
    rationale:
      `${chain.steps.length} findings link into one path. Severity is one above the worst ` +
      'step, because the combination is worse than any part of it. Breaking ANY link breaks ' +
      'the chain — the cheapest step to fix is usually not the most severe one.',
    suggestedFix: null,
    scannerKey: CHAINER_SCANNER_KEY,
    ruleId: null,
    // The graph the dashboard renders, and the member ids that make every step
    // checkable. A chain nobody can trace back to its findings is a picture.
    yields: {
      chain_id: chain.chainId,
      member_finding_ids: chain.steps.map((s) => s.id),
      links: chain.links,
      nodes: chain.steps.map((step) => ({
        finding_id: step.id,
        title: step.title,
        severity: step.severity,
        scanner_key: step.scannerKey,
      })),
    },
  };
}

function compoundToFinding(cluster: CompoundCluster): IncomingFinding {
  return {
    dimension: 'compound',
    severity: cluster.severity,
    confidence: 4,
    file: cluster.file,
    lineStart: null,
    lineEnd: null,
    title: `Compound risk: ${cluster.file} flagged by ${cluster.dimensions.length} dimensions`,
    evidenceQuote: `${cluster.file}: ${cluster.dimensions.join(', ')} (${cluster.memberIds.length} findings)`,
    rationale:
      'One file carrying problems of several different kinds is a stronger signal than any ' +
      'of them alone: it usually means the file is both important and under-maintained.',
    suggestedFix: null,
    scannerKey: CHAINER_SCANNER_KEY,
    ruleId: null,
    yields: { member_finding_ids: cluster.memberIds, dimensions: cluster.dimensions },
  };
}

/**
 * Closes chain/compound findings whose members are no longer open.
 *
 * This is the "link broken" half of the design, and it needs its own pass
 * because the ordinary stale sweep works on FILES — a chain has no file, so
 * nothing else would ever close it. Every closure writes an audit row: a
 * finding that vanishes without a recorded reason is one nobody can defend.
 */
export async function resolveBrokenChains(
  db: Database,
  workspaceId: number,
  repoId: number,
): Promise<number> {
  const rows = await db
    .select({
      id: read.findings.id,
      status: read.findings.status,
      yields: read.findings.yields,
      dimension: read.findings.dimension,
    })
    .from(read.findings)
    .where(
      and(
        eq(read.findings.workspaceId, workspaceId),
        eq(read.findings.repoId, repoId),
        inArray(read.findings.dimension, ['chain', 'compound']),
        inArray(read.findings.status, ['open', 'confirmed']),
        isNotNull(read.findings.yields),
      ),
    );
  if (rows.length === 0) return 0;

  const memberIdsOf = (yields: unknown): number[] => {
    const raw = (yields as { member_finding_ids?: unknown } | null)?.member_finding_ids;
    return Array.isArray(raw) ? raw.filter((id): id is number => typeof id === 'number') : [];
  };

  const memberIds = new Set<number>();
  for (const row of rows) for (const id of memberIdsOf(row.yields)) memberIds.add(id);
  if (memberIds.size === 0) return 0;

  const openMembers = await db
    .select({ id: read.findings.id })
    .from(read.findings)
    .where(
      and(
        inArray(read.findings.id, [...memberIds]),
        inArray(read.findings.status, ['open', 'confirmed']),
      ),
    );
  const stillOpen = new Set(openMembers.map((m) => m.id));

  const now = new Date();
  let resolved = 0;
  for (const row of rows) {
    const ids = memberIdsOf(row.yields);
    if (ids.length === 0) continue;
    // ANY member closing breaks a chain — that is the whole point of a path.
    // A compound cluster needs the same treatment for a different reason: with
    // one dimension gone it is no longer a concentration of three.
    if (ids.every((id) => stillOpen.has(id))) continue;

    await db
      .update(read.findings)
      .set({ status: 'resolved', statusChangedAt: now })
      .where(eq(read.findings.id, row.id));
    await db.insert(read.findingEvents).values({
      workspaceId,
      findingId: row.id,
      fromStatus: row.status,
      toStatus: 'resolved',
      actor: null,
      reason:
        row.dimension === 'chain'
          ? 'a member finding was resolved — the path no longer holds'
          : 'a member finding was resolved — fewer than three dimensions remain',
    });
    resolved += 1;
  }
  return resolved;
}

/** The post-scan pass: chains, compound risk, and broken-link cleanup. */
export async function runChainer(deps: ChainerDeps): Promise<ChainerResult> {
  const [run] = await deps.db
    .insert(security.scanRuns)
    .values({
      workspaceId: deps.workspaceId,
      repoId: deps.repoId,
      scannerKey: CHAINER_SCANNER_KEY,
      scannerVersion: 'chainer.v1',
      commitSha: deps.commitSha ?? '',
      trigger: deps.trigger ?? 'schedule',
      status: 'running',
    })
    .returning();
  const runId = run!.id;

  try {
    // Cleanup FIRST: a chain whose member was fixed yesterday must not be
    // rebuilt from today's findings and counted as new.
    const autoResolved = await resolveBrokenChains(deps.db, deps.workspaceId, deps.repoId);

    const findings = await chainableFindings(deps.db, deps.workspaceId, deps.repoId);
    const chains = buildChains(findings, {
      ...(deps.maxDepth !== undefined ? { maxDepth: deps.maxDepth } : {}),
    });
    const clusters = await compoundFindings(deps.db, deps.workspaceId, deps.repoId);

    const incoming = [...chains.map(chainToFinding), ...clusters.map(compoundToFinding)];
    const persisted = await persistFindings(deps.db, {
      workspaceId: deps.workspaceId,
      repoId: deps.repoId,
      scanRunId: runId,
      pullRequestId: null,
      tier: 1,
      findings: incoming,
      sweepScannerKey: CHAINER_SCANNER_KEY,
    });

    await deps.db
      .update(security.scanRuns)
      .set({ status: 'succeeded', findingCount: incoming.length, finishedAt: new Date() })
      .where(eq(security.scanRuns.id, runId));

    return {
      status: 'succeeded',
      scanRunId: runId,
      chains: chains.length,
      compound: clusters.length,
      created: persisted.created,
      autoResolved,
    };
  } catch (err) {
    await deps.db
      .update(security.scanRuns)
      .set({
        status: 'failed',
        error: (err as Error).message.slice(0, 500),
        finishedAt: new Date(),
      })
      .where(eq(security.scanRuns.id, runId));
    return {
      status: 'failed',
      scanRunId: runId,
      chains: 0,
      compound: 0,
      created: 0,
      autoResolved: 0,
      error: (err as Error).message,
    };
  }
}

/** Repos with open findings — the weekly recompute's work list. */
export async function reposWithFindings(db: Database, workspaceId: number): Promise<number[]> {
  const rows = await db
    .selectDistinct({ repoId: read.findings.repoId })
    .from(read.findings)
    .where(
      and(
        eq(read.findings.workspaceId, workspaceId),
        inArray(read.findings.status, ['open', 'confirmed']),
        sql`${read.findings.dimension} not in ('chain', 'compound')`,
      ),
    );
  return rows.map((r) => r.repoId);
}
