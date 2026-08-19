import { and, eq, inArray, sql } from 'drizzle-orm';
import { read, type Database } from '@repopulse/shared';
import { dedupKey } from './dedup.js';
import { autoResolveOutdated, reappearanceDecision, type FindingStatus } from './lifecycle.js';

// Findings store (W6-03, FR-ANALYSIS-6 / FR-INSIGHTS-1).

export interface IncomingFinding {
  dimension: string;
  severity: number;
  confidence: number;
  file: string;
  lineStart: number;
  lineEnd: number;
  title: string;
  evidenceQuote: string;
  rationale: string;
  suggestedFix: string | null;
}

export interface PersistParams {
  workspaceId: number;
  repoId: number;
  analysisRunId: number;
  pullRequestId: number | null;
  tier: number;
  findings: readonly IncomingFinding[];
  /** Files this run actually reviewed — used to auto-resolve stale findings. */
  reviewedFiles?: readonly string[];
}

export interface PersistResult {
  created: number;
  /** Existing rows whose last_seen and occurrence_count were bumped. */
  updated: number;
  reopened: number;
  autoResolved: number;
}

/**
 * Persists a run's findings, deduped.
 *
 * The contract that matters: re-running an unchanged PR creates ZERO rows. A
 * findings list that grows every time the same question is asked is a list
 * people stop reading — and the count is what feeds the health score, so it
 * would also quietly move a number nobody changed the code to move.
 */
export async function persistFindings(db: Database, params: PersistParams): Promise<PersistResult> {
  const result: PersistResult = { created: 0, updated: 0, reopened: 0, autoResolved: 0 };
  const now = new Date();

  const keyed = params.findings.map((f) => ({
    finding: f,
    key: dedupKey({
      dimension: f.dimension,
      file: f.file,
      evidenceQuote: f.evidenceQuote,
      lineStart: f.lineStart,
    }),
  }));

  const existing =
    keyed.length === 0
      ? []
      : await db
          .select()
          .from(read.findings)
          .where(
            and(
              eq(read.findings.workspaceId, params.workspaceId),
              eq(read.findings.repoId, params.repoId),
              inArray(
                read.findings.dedupKey,
                keyed.map((k) => k.key),
              ),
            ),
          );
  const byKey = new Map(existing.map((row) => [row.dedupKey, row]));

  for (const { finding, key } of keyed) {
    const prior = byKey.get(key);

    if (!prior) {
      await db.insert(read.findings).values({
        workspaceId: params.workspaceId,
        repoId: params.repoId,
        analysisRunId: params.analysisRunId,
        pullRequestId: params.pullRequestId,
        dimension: finding.dimension,
        severity: finding.severity,
        confidence: finding.confidence,
        title: finding.title,
        file: finding.file,
        lineStart: finding.lineStart,
        lineEnd: finding.lineEnd,
        evidence: finding.evidenceQuote,
        recommendation: finding.suggestedFix ?? finding.rationale,
        tier: params.tier,
        dedupKey: key,
        status: 'open',
        firstSeenAt: now,
        lastSeenAt: now,
        occurrenceCount: 1,
      });
      result.created += 1;
      continue;
    }

    // Seen before: bump the sighting, never duplicate the row.
    const decision = reappearanceDecision(prior.status as FindingStatus);
    await db
      .update(read.findings)
      .set({
        lastSeenAt: now,
        occurrenceCount: prior.occurrenceCount + 1,
        ...(decision ? { status: decision.next, statusChangedAt: now } : {}),
      })
      .where(eq(read.findings.id, prior.id));
    result.updated += 1;

    if (decision) {
      // actor null = the analysis pass, not a person. "Why did this come back?"
      // has to be answerable, and the evidence is the answer.
      await db.insert(read.findingEvents).values({
        workspaceId: params.workspaceId,
        findingId: prior.id,
        fromStatus: prior.status,
        toStatus: decision.next,
        actor: null,
        reason: decision.reason,
      });
      result.reopened += 1;
    }
  }

  // Findings on files this run reviewed but no longer reports are stale.
  if (params.reviewedFiles && params.reviewedFiles.length > 0) {
    const seenKeys = new Set(keyed.map((k) => k.key));
    const candidates = await db
      .select()
      .from(read.findings)
      .where(
        and(
          eq(read.findings.workspaceId, params.workspaceId),
          eq(read.findings.repoId, params.repoId),
          inArray(read.findings.file, [...params.reviewedFiles]),
          inArray(read.findings.status, ['open', 'confirmed']),
        ),
      );

    for (const row of candidates) {
      if (seenKeys.has(row.dedupKey)) continue;
      const decision = autoResolveOutdated(row.status as FindingStatus);
      if (!decision) continue;
      await db
        .update(read.findings)
        .set({ status: decision.next, statusChangedAt: now })
        .where(eq(read.findings.id, row.id));
      await db.insert(read.findingEvents).values({
        workspaceId: params.workspaceId,
        findingId: row.id,
        fromStatus: row.status,
        toStatus: decision.next,
        actor: null,
        // 'outdated_diff', not 'fixed': we observed that we stopped seeing it,
        // not that anyone fixed it. Crediting a fix we did not witness would
        // make the resolution rate a number nobody should trust.
        reason: decision.reason,
      });
      result.autoResolved += 1;
    }
  }

  return result;
}

/** Open-finding counts per file, for hotspot ranking (FR-INSIGHTS-5). */
export async function openFindingDensity(
  db: Database,
  workspaceId: number,
  repoId: number,
): Promise<Map<string, number>> {
  const rows = await db
    .select({ file: read.findings.file, n: sql<number>`count(*)::int` })
    .from(read.findings)
    .where(
      and(
        eq(read.findings.workspaceId, workspaceId),
        eq(read.findings.repoId, repoId),
        inArray(read.findings.status, ['open', 'confirmed']),
      ),
    )
    .groupBy(read.findings.file);
  return new Map(rows.map((r) => [r.file, r.n]));
}

/** analysis_false_positive_rate inputs (FR-INSIGHTS-1). */
export async function falsePositiveRate(
  db: Database,
  workspaceId: number,
  dimension?: string,
): Promise<{ dismissedFalsePositive: number; total: number; rate: number | null }> {
  const where = dimension
    ? and(eq(read.findings.workspaceId, workspaceId), eq(read.findings.dimension, dimension))
    : eq(read.findings.workspaceId, workspaceId);

  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      fp: sql<number>`count(*) filter (where ${read.findings.status} = 'dismissed' and ${read.findings.dismissReason} = 'false_positive')::int`,
    })
    .from(read.findings)
    .where(where);

  const total = row?.total ?? 0;
  const fp = row?.fp ?? 0;
  // null, not 0, when nothing has been reviewed: a 0% false-positive rate over
  // zero findings reads as "the model is perfect" rather than "we have no data".
  return { dismissedFalsePositive: fp, total, rate: total === 0 ? null : fp / total };
}
