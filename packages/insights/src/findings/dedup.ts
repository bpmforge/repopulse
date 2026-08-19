import { createHash } from 'node:crypto';

// Finding dedup (W6-03, ANALYSIS_TIERS.md §5, FR-ANALYSIS-6).
//
// The same review run twice must produce zero new rows. Without that, a model
// that is asked the same question on Monday and Tuesday grows the findings list
// without anything changing in the code — and a list that grows on its own is
// one people stop reading.

export interface DedupInput {
  dimension: string;
  /** Null for repo-level scanner findings (a CVE has no line). */
  file: string | null;
  evidenceQuote: string;
  lineStart: number | null;
  /** W8-02: present only for scanner findings. */
  // `| undefined` explicitly: exactOptionalPropertyTypes is on, and a caller
  // spreading a record that has the field set to undefined is the normal way
  // an analysis finding arrives here.
  scannerKey?: string | null | undefined;
  ruleId?: string | null | undefined;
}

/**
 * Normalizes evidence for keying.
 *
 * Digits are stripped because a model quoting the same line will sometimes
 * include the line number and sometimes not, and because constants shift by a
 * digit far more often than the finding changes. Whitespace collapses for the
 * same reason the validator collapses it: models reflow text.
 */
export function normalizeEvidence(quote: string): string {
  // Digits FIRST, then whitespace. The other order leaves the gap where the
  // number was ("foo( 42 )" -> "foo(  )"), so normalizing an already-normalized
  // quote would produce a different string — and a normalizer that is not
  // idempotent gives the same finding two keys.
  return quote
    .toLowerCase()
    .replace(/\b\d+\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * sha256(dimension \0 file \0 normalized) with a line-BUCKET tiebreak.
 *
 * The bucket (⌊line/10⌋) is what makes this survive ordinary editing: a finding
 * that drifts three lines because something was inserted above it is the same
 * finding, and keying on the exact line would resurrect it as new on every
 * adjacent change. Ten lines is coarse enough to absorb that drift and fine
 * enough that two genuinely different findings in one file stay distinct.
 */
export function dedupKey(input: DedupInput): string {
  const normalized = normalizeEvidence(input.evidenceQuote);
  const bucket = input.lineStart === null ? 'repo' : String(Math.floor(input.lineStart / 10));

  // BACKWARD-COMPATIBLE BY CONSTRUCTION (W8-02). An analysis finding — one with
  // no scannerKey — hashes exactly the string it always did. Appending the new
  // fields unconditionally would re-key every finding already in the store, so
  // the next run would create a duplicate of each and every occurrence count,
  // triage decision and false-positive suppression would silently detach from
  // its finding. Scanner findings get the richer key; analysis findings do not
  // move.
  const base = `${input.dimension}\0${input.file}\0${normalized}\0${bucket}`;
  const keyed = input.scannerKey
    ? `${input.scannerKey}\0${input.ruleId ?? ''}\0${base}`
    : base;

  return createHash('sha256').update(keyed).digest('hex');
}
