import { and, eq, inArray, sql } from 'drizzle-orm';
import { read, type Database } from '@repopulse/shared';
import { dedupKey } from './dedup.js';
import {
  autoResolveOutdated,
  isSuppressed,
  reappearanceDecision,
  type FindingStatus,
} from './lifecycle.js';

// Findings store (W6-03, FR-ANALYSIS-6 / FR-INSIGHTS-1).

export interface IncomingFinding {
  dimension: string;
  severity: number;
  confidence: number;
  // Nullable since W8-02: a CVE or an IaC misconfiguration is a repo-level
  // fact with no line to point at, and an invented location in a security
  // finding sends someone to the wrong place with confidence.
  file: string | null;
  lineStart: number | null;
  lineEnd: number | null;
  title: string;
  evidenceQuote: string;
  rationale: string;
  suggestedFix: string | null;
  /** W8-04 scanner fields. Absent on analysis findings, and the dedup key
   *  changes shape only when they are present (see dedup.ts). */
  scannerKey?: string | null;
  ruleId?: string | null;
  cveId?: string | null;
  /** What an attacker gains, for the chainer: { 'credential:aws': true }. */
  yields?: Record<string, unknown> | null;
}

export interface PersistParams {
  workspaceId: number;
  repoId: number;
  /** Exactly one of these two. A scanner run is not an analysis run (W8-04). */
  analysisRunId?: number | null;
  scanRunId?: number | null;
  pullRequestId: number | null;
  tier: number;
  findings: readonly IncomingFinding[];
  /** Files this run actually reviewed — used to auto-resolve stale findings. */
  reviewedFiles?: readonly string[];
  /**
   * Restricts the stale sweep to findings this run could have produced (W8-04).
   *
   * Without it, a secrets scan that reviewed src/config.ts would auto-resolve
   * the CODE_HEALTH findings on that file — a scanner silently closing another
   * pass's work. Defaults to the dimensions present in `findings`, which is
   * the narrowest correct answer when the caller says nothing.
   */
  sweepDimensions?: readonly string[];
  sweepScannerKey?: string | null;
}

export interface PersistResult {
  created: number;
  /** Sightings of a false-positive dismissal, counted but not resurfaced. */
  suppressed: number;
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
  const result: PersistResult = { created: 0, updated: 0, reopened: 0, autoResolved: 0, suppressed: 0 };
  const now = new Date();

  const keyed = params.findings.map((f) => ({
    finding: f,
    // The scanner fields are threaded through — W8-02 added them to the key
    // precisely so two scanners flagging the same line stay two findings, and
    // a store that dropped them here would have collapsed them into one row
    // while the dedup unit test went on passing.
    key: dedupKey({
      dimension: f.dimension,
      file: f.file,
      evidenceQuote: f.evidenceQuote,
      lineStart: f.lineStart,
      scannerKey: f.scannerKey ?? null,
      ruleId: f.ruleId ?? null,
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
        analysisRunId: params.analysisRunId ?? null,
        scanRunId: params.scanRunId ?? null,
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
        scannerKey: finding.scannerKey ?? null,
        ruleId: finding.ruleId ?? null,
        cveId: finding.cveId ?? null,
        yields: finding.yields ?? null,
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
    //
    // FP-suppression memory (R-B4): a finding dismissed as a false positive
    // stays dismissed while its evidence is unchanged — and the dedup key IS
    // the unchanged test. Re-surfacing it would let the next scheduled run
    // overrule a person, and a dismiss button that does not stick is one
    // nobody presses twice. The sighting still counts.
    const suppressed = isSuppressed(prior.status as FindingStatus, prior.dismissReason);
    const decision = suppressed ? null : reappearanceDecision(prior.status as FindingStatus);
    if (suppressed) result.suppressed += 1;
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
    const sweepDimensions =
      params.sweepDimensions ?? [...new Set(params.findings.map((f) => f.dimension))];
    const candidates = await db
      .select()
      .from(read.findings)
      .where(
        and(
          eq(read.findings.workspaceId, params.workspaceId),
          eq(read.findings.repoId, params.repoId),
          inArray(read.findings.file, [...params.reviewedFiles]),
          inArray(read.findings.status, ['open', 'confirmed']),
          // A run may only close what it could have found. A pass with nothing
          // to say about a dimension has not observed that its findings are
          // gone; it has simply not looked.
          ...(sweepDimensions.length > 0
            ? [inArray(read.findings.dimension, [...sweepDimensions])]
            : []),
          ...(params.sweepScannerKey !== undefined && params.sweepScannerKey !== null
            ? [eq(read.findings.scannerKey, params.sweepScannerKey)]
            : []),
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
  // file is nullable since W8-02 (repo-level findings have no path). Those are
  // excluded from per-FILE density rather than bucketed under an empty key,
  // which would invent a file named "" at the top of every hotspot list.
  return new Map(rows.filter((r) => r.file !== null).map((r) => [r.file as string, r.n]));
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
