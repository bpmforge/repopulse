import { and, eq, inArray, sql } from 'drizzle-orm';
import { read, type Database } from '@repopulse/shared';
import { dedupKey } from './dedup.js';
import { pruneClosedFindingContext } from './context.js';
import { applyPackOverrides } from './pack-overrides.js';
import {
  autoResolveOutdated,
  isSuppressed,
  reappearanceDecision,
  staysClosed,
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
  /**
   * A shadow-mode rule's finding (CODE_HEALTH_SUITE.md §8.2): stored and
   * visible, excluded from scores, banners, plans and reports. Absent = the
   * scanner has no lifecycle opinion and an existing row keeps its flag; when
   * stated, a sighting carries it over, so a promoted rule's open findings
   * start counting on its next run rather than staying in shadow for good.
   */
  experimental?: boolean;
  /**
   * W18-32: the scanned file's lines around the finding, copied at scan time
   * (security/excerpt.ts). Absent = the scanner has no excerpt to give and an
   * existing row keeps what it has; when stated, a sighting replaces it, so the
   * stored lines follow the code as it was last scanned.
   */
  context?: { startLine: number; lines: string } | null;
  /**
   * W18-24: the external tool's own stable identity for this result (SARIF
   * partialFingerprints, a code-scanning alert number). Keys the finding in
   * place of evidence + line bucket — see dedupKey. Our own scanners do not
   * set it, so their keys do not move — except slopsquat (W21-05), which was
   * born with `<ecosystem>:<package>` so a dependency keeps its row when the
   * manifest lines above it change.
   */
  fingerprint?: string | null;
  /**
   * W21-03: a second model's verdict on this finding, when one was asked for.
   * Absent = no verify step ran and an existing row keeps what it has. A
   * contradicting verdict MARKS the finding (verify_status); it never changes
   * its status, so nothing is dismissed by a model.
   */
  verify?: FindingVerify;
}

/** What a second opinion records on a finding (W21-03). */
export interface FindingVerify {
  status: 'unverified' | 'confirmed' | 'contradicted';
  model: string | null;
  providerId: number | null;
  connection: string | null;
  /** The verifier's reason, or why no second opinion could be had. */
  reason: string | null;
}

/**
 * The columns a verdict writes. An `unverified` outcome (no second opinion
 * could be had) sets only its reason, and only over a finding that has no real
 * verdict yet: a later run that could not ask must not erase an earlier answer.
 */
function verifyColumns(
  v: FindingVerify,
  now: Date,
  priorStatus: string | null,
): Partial<typeof read.findings.$inferInsert> {
  if (v.status === 'unverified') {
    return priorStatus === null || priorStatus === 'unverified'
      ? { verifyReason: v.reason?.slice(0, 1000) ?? null }
      : {};
  }
  return {
    verifyStatus: v.status,
    verifiedByModel: v.model,
    verifiedByProviderId: v.providerId,
    verifiedByConnection: v.connection,
    verifiedAt: now,
    verifyReason: v.reason?.slice(0, 1000) ?? null,
  };
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
  /**
   * W20-08 (UX_TODO FND-48, FND-58): what a FULL run may close beyond
   * `reviewedFiles`. Before this, full scans passed only the files that still
   * had findings as reviewed, so a fix that cleaned the last finding out of a
   * file left that finding open for good, and repo-level findings (licenses,
   * dependency health) had no file to be reviewed at all.
   *
   * Honoured only with a sweep scope (`sweepScannerKey` or explicit
   * `sweepDimensions`): an unscoped full sweep would close every other
   * scanner's findings on the same files.
   */
  fullSweep?: FullSweep;
}

export interface FullSweep {
  /**
   * Every file in the tree the run looked at. A finding on a file NOT in it
   * points at a file that no longer exists, which is the plainest fix there
   * is, so it is closed too.
   */
  treeFiles?: readonly string[];
  /** Close file-less (repo-level) findings this run no longer reports. */
  repoLevel?: boolean;
  /**
   * Rows this run could not have reproduced (a tool adapter that failed, a
   * judgement half with no model, a manifest it could not parse). They stay
   * as they are: not seeing something you did not look for is not a fix.
   */
  keepOpen?: (row: { ruleId: string | null; file: string | null }) => boolean;
}

export interface PersistResult {
  created: number;
  /** Sightings of a false-positive dismissal, counted but not resurfaced. */
  suppressed: number;
  /** Existing rows whose last_seen and occurrence_count were bumped. */
  updated: number;
  reopened: number;
  autoResolved: number;
  /**
   * Findings in THIS batch that shared a dedup key with an earlier one and were
   * folded into it. Reported rather than silent: a scanner that produced twelve
   * matches and stored three should be able to say so.
   */
  foldedDuplicates: number;
}

/**
 * Persists a run's findings, deduped.
 *
 * The contract that matters: re-running an unchanged PR creates ZERO rows. A
 * findings list that grows every time the same question is asked is a list
 * people stop reading — and the count is what feeds the health score, so it
 * would also quietly move a number nobody changed the code to move.
 */
/** Narrower of two optional line bounds; null only when neither is set. */
function minDefined(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return Math.min(a, b);
}

/** Wider of two optional line bounds; null only when neither is set. */
function maxDefined(a: number | null | undefined, b: number | null | undefined): number | null {
  if (a === null || a === undefined) return b ?? null;
  if (b === null || b === undefined) return a;
  return Math.max(a, b);
}

export async function persistFindings(db: Database, params: PersistParams): Promise<PersistResult> {
  const result: PersistResult = {
    created: 0,
    updated: 0,
    reopened: 0,
    autoResolved: 0,
    suppressed: 0,
    foldedDuplicates: 0,
  };
  const now = new Date();

  // W20-21 (UX_TODO FND-53): a shipped rule this workspace moved to shadow is
  // stamped experimental; one it retired raises nothing.
  const incoming = await applyPackOverrides(db, params.workspaceId, params.findings);
  const keyed = incoming.map((f) => ({
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
      fingerprint: f.fingerprint ?? null,
    }),
  }));

  // Fold duplicates WITHIN this batch before touching the database.
  //
  // Two findings that key identically are the same finding — that is what the
  // key means. Without this fold the loop below inserted the first and let the
  // second hit findings_workspace_repo_dedup_key, the catch marked the scan run
  // failed, and NOTHING was stored: one duplicate pair lost the entire scan.
  //
  // Not a hypothetical, and not new with the scanner that found it (W9-13):
  // every deterministic scanner builds its evidence quote as
  // `<file>:<line> — <ruleId>`, and the W8-16 normaliser strips the line number
  // from a numeric token on purpose, so ANY two hits of one rule in one file
  // collide. Two console.log calls in one file took the shipped logging_hygiene
  // scanner down. It survived this long because fixtures trigger each rule once
  // and real repositories do not.
  //
  // occurrenceCount deliberately does NOT move here: it counts RUNS in which a
  // finding was seen, so a file with twenty matching lines is one finding seen
  // once, not twenty sightings.
  const folded = new Map<string, (typeof keyed)[number]>();
  for (const entry of keyed) {
    const prior = folded.get(entry.key);
    if (!prior) {
      folded.set(entry.key, entry);
      continue;
    }
    result.foldedDuplicates += 1;
    // Worst case wins on severity and confidence: a fold must never quietly
    // downgrade a finding because a milder sibling happened to be second.
    // The earliest line is kept, so the stored row points at the first
    // occurrence in the file rather than whichever the engine emitted last.
    prior.finding = {
      ...prior.finding,
      severity: Math.max(prior.finding.severity, entry.finding.severity),
      confidence: Math.max(prior.finding.confidence, entry.finding.confidence),
      // Both are nullable — a repo-scoped finding has no line at all — so the
      // bounds widen only across the values that exist rather than treating a
      // missing line as zero.
      lineStart: minDefined(prior.finding.lineStart, entry.finding.lineStart),
      lineEnd: maxDefined(prior.finding.lineEnd, entry.finding.lineEnd),
      suggestedFix: prior.finding.suggestedFix ?? entry.finding.suggestedFix,
      ...(prior.finding.verify || entry.finding.verify
        ? { verify: prior.finding.verify ?? entry.finding.verify! }
        : {}),
    };
  }
  const deduped = [...folded.values()];

  const existing =
    deduped.length === 0
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
                deduped.map((k) => k.key),
              ),
            ),
          );
  const byKey = new Map(existing.map((row) => [row.dedupKey, row]));

  for (const { finding, key } of deduped) {
    const prior = byKey.get(key);

    if (!prior) {
      await db.insert(read.findings).values({
        workspaceId: params.workspaceId,
        repoId: params.repoId,
        analysisRunId: params.analysisRunId ?? null,
        scanRunId: params.scanRunId ?? null,
        // W20-21 (FND-51): the scan that last saw it; the raising scan, at first.
        lastSeenScanRunId: params.scanRunId ?? null,
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
        rationale: finding.rationale,
        tier: params.tier,
        scannerKey: finding.scannerKey ?? null,
        ruleId: finding.ruleId ?? null,
        cveId: finding.cveId ?? null,
        yields: finding.yields ?? null,
        experimental: finding.experimental ?? false,
        contextLines: finding.context?.lines ?? null,
        contextStartLine: finding.context?.startLine ?? null,
        ...(finding.verify ? verifyColumns(finding.verify, now, null) : {}),
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
    // W20-21 (FND-61): a secret recorded as rotated stays closed when a later
    // history sweep sees it again: the old commit still holds it, as expected.
    const suppressed =
      isSuppressed(prior.status as FindingStatus, prior.dismissReason) ||
      staysClosed(prior.status as FindingStatus, prior.dismissReason);
    const decision = suppressed ? null : reappearanceDecision(prior.status as FindingStatus);
    if (suppressed) result.suppressed += 1;
    await db
      .update(read.findings)
      .set({
        lastSeenAt: now,
        ...(params.scanRunId ? { lastSeenScanRunId: params.scanRunId } : {}),
        occurrenceCount: prior.occurrenceCount + 1,
        ...(decision ? { status: decision.next, statusChangedAt: now } : {}),
        ...(finding.experimental !== undefined ? { experimental: finding.experimental } : {}),
        // W20-08 (FND-57): the reason follows the latest scan, as the context
        // does — a reachability tier that moved should say so.
        rationale: finding.rationale,
        // So does the title (2026-10-27): rows stored under a rule id as the
        // title read as a sentence after the next scan, not only new ones.
        title: finding.title,
        // W20-21 (FND-28): the fixed versions follow the latest scan too, so an
        // advisory that gains a fix says so without a new row. Merged into the
        // payload rather than replacing it: the chainer's terms live there.
        ...(Array.isArray(finding.yields?.['fixed_in'])
          ? {
              yields: sql`coalesce(${read.findings.yields}, '{}'::jsonb) || ${JSON.stringify({
                fixed_in: finding.yields['fixed_in'],
              })}::jsonb`,
            }
          : {}),
        ...(finding.context !== undefined
          ? {
              contextLines: finding.context?.lines ?? null,
              contextStartLine: finding.context?.startLine ?? null,
            }
          : {}),
        // W21-05: a fingerprinted finding is keyed independently of its line,
        // so the same row is seen after the code above it moved. Its location
        // and quote follow the latest sighting; otherwise the row would point
        // at whatever now sits on the line it was first seen at.
        ...(finding.fingerprint
          ? {
              lineStart: finding.lineStart,
              lineEnd: finding.lineEnd,
              evidence: finding.evidenceQuote,
            }
          : {}),
        ...(finding.verify ? verifyColumns(finding.verify, now, prior.verifyStatus) : {}),
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
        scanRunId: params.scanRunId ?? null,
      });
      result.reopened += 1;
    }
  }

  // Findings on files this run reviewed but no longer reports are stale.
  const reviewed = new Set(params.reviewedFiles ?? []);
  const full = params.fullSweep;
  // An empty list is "no list", never "every file is gone".
  const tree = full?.treeFiles && full.treeFiles.length > 0 ? new Set(full.treeFiles) : null;
  const scoped =
    (params.sweepScannerKey !== undefined && params.sweepScannerKey !== null) ||
    (params.sweepDimensions !== undefined && params.sweepDimensions.length > 0);
  // W20-08: a full sweep must name what it owns (see PersistParams.fullSweep).
  const sweepFull = full !== undefined && scoped;
  const sweepDimensions = params.sweepDimensions ?? [
    ...new Set(params.findings.map((f) => f.dimension)),
  ];
  // W20-13: a pass that reported nothing and named no scanner or dimension has
  // no scope at all. Without this guard the query below dropped its dimension
  // filter and closed every other pass's findings on the files it reviewed.
  const hasScope = scoped || sweepDimensions.length > 0;
  if (hasScope && (reviewed.size > 0 || sweepFull)) {
    const seenKeys = new Set(deduped.map((k) => k.key));
    // Filtered here rather than with `file IN (...)`: a full run's file list is
    // the whole tree, and a monorepo's runs past Postgres's bind-parameter
    // limit. The candidates are this repo's open findings in the sweep scope,
    // which is the smaller set.
    const candidates = await db
      .select()
      .from(read.findings)
      .where(
        and(
          eq(read.findings.workspaceId, params.workspaceId),
          eq(read.findings.repoId, params.repoId),
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

    const inScope = (row: { file: string | null; ruleId: string | null }): boolean => {
      if (full?.keepOpen?.({ ruleId: row.ruleId, file: row.file })) return false;
      if (row.file !== null && reviewed.has(row.file)) return true;
      if (!sweepFull || full === undefined) return false;
      if (row.file === null) return full.repoLevel === true;
      return tree !== null && !tree.has(row.file);
    };

    for (const row of candidates) {
      if (seenKeys.has(row.dedupKey)) continue;
      if (!inScope(row)) continue;
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
        // W20-21 (FND-51): WHICH scan stopped seeing it, so the history can
        // name its commit and date.
        scanRunId: params.scanRunId ?? null,
      });
      result.autoResolved += 1;
    }
  }

  // Retention: lines of code are not kept for findings that closed long ago.
  await pruneClosedFindingContext(db, {
    workspaceId: params.workspaceId,
    repoId: params.repoId,
    nowMs: now.getTime(),
  });

  return result;
}

/**
 * Records second-model verdicts on findings already stored (W21-03), by dedup
 * key. Workspace- and repo-filtered (Law 5). Never touches status: a
 * contradicted finding stays open for a person to decide.
 */
export async function recordVerdicts(
  db: Database,
  params: {
    workspaceId: number;
    repoId: number;
    verdicts: readonly { dedupKey: string; verify: FindingVerify }[];
  },
): Promise<{ recorded: number }> {
  const now = new Date();
  let recorded = 0;
  for (const { dedupKey: key, verify } of params.verdicts) {
    const where = and(
      eq(read.findings.workspaceId, params.workspaceId),
      eq(read.findings.repoId, params.repoId),
      eq(read.findings.dedupKey, key),
      ...(verify.status === 'unverified' ? [eq(read.findings.verifyStatus, 'unverified')] : []),
    );
    const cols = verifyColumns(verify, now, null);
    const rows = await db
      .update(read.findings)
      .set(cols)
      .where(where)
      .returning({ id: read.findings.id });
    recorded += rows.length;
  }
  return { recorded };
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
): Promise<{
  dismissedFalsePositive: number;
  total: number;
  triaged: number;
  rate: number | null;
}> {
  const where = dimension
    ? and(eq(read.findings.workspaceId, workspaceId), eq(read.findings.dimension, dimension))
    : eq(read.findings.workspaceId, workspaceId);

  const [row] = await db
    .select({
      total: sql<number>`count(*)::int`,
      fp: sql<number>`count(*) filter (where ${read.findings.status} = 'dismissed' and ${read.findings.dismissReason} = 'false_positive')::int`,
      // W20-13 (UX_TODO FND-71): the denominator is what a PERSON has judged.
      // Dividing by every finding made 500 untriaged findings read as "0%
      // dismissed as false positive", a flawless analysis nobody had checked.
      // A closed status a person sets, or any status change by a person (a
      // removed account keeps its login, W16-59).
      triaged: sql<number>`count(*) filter (where ${read.findings.status} in ('confirmed', 'dismissed', 'wont_fix') or exists (select 1 from ${read.findingEvents} fe where fe.finding_id = ${read.findings.id} and fe.workspace_id = ${read.findings.workspaceId} and (fe.actor is not null or fe.actor_login is not null)))::int`,
    })
    .from(read.findings)
    .where(where);

  const total = row?.total ?? 0;
  const fp = row?.fp ?? 0;
  const triaged = row?.triaged ?? 0;
  // null, not 0, when nothing has been reviewed: a 0% false-positive rate over
  // zero triaged findings reads as "the model is perfect" rather than "we have
  // no data".
  return {
    dismissedFalsePositive: fp,
    total,
    triaged,
    rate: triaged === 0 ? null : fp / triaged,
  };
}
