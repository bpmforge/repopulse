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
  /**
   * W18-24: a stable identity the TOOL computed — SARIF partialFingerprints,
   * a GitHub code-scanning alert number. Honoured only beside a scannerKey.
   */
  fingerprint?: string | null | undefined;
}

/**
 * Normalizes evidence for keying.
 *
 * Standalone numbers are stripped because a model quoting the same line will
 * sometimes include the line number and sometimes not, and because a constant
 * shifts by a digit far more often than the finding changes. Whitespace
 * collapses for the same reason the validator collapses it: models reflow text.
 *
 * DIGITS INSIDE AN IDENTIFIER SURVIVE (W8-16). The original rule was
 * `\b\d+\b`, and a hyphen is a word boundary — so `CVE-2020-11023` and
 * `CVE-2020-11022` both normalized to `cve--` and collapsed into ONE finding.
 * Two different vulnerabilities on one package became one row, and the second
 * was silently counted as another sighting of the first. Found while building
 * the dependency scanner (W8-06), which worked around the symptom by carrying
 * the id in `ruleId`; this is the cause.
 *
 * The rule now: a token containing a LETTER is an identifier and keeps its
 * digits; a token that is only digits and punctuation is a number and loses
 * them. `:` and brackets separate tokens, while `-`, `_` and `.` join them —
 * which is how these strings are actually written, so `app.ts:42` still loses
 * its line number while `cve-2020-11023` and `log4j-core` keep their identity.
 */
export function normalizeEvidence(quote: string): string {
  // Tokens are runs of identifier characters; everything else is a separator
  // and is preserved verbatim so the shape of the quote still distinguishes
  // two different lines.
  const normalized = quote.toLowerCase().replace(/[a-z0-9._-]+/g, (token) =>
    // A letter anywhere makes it a name, not a measurement.
    /[a-z]/.test(token) ? token : token.replace(/\d+/g, ''),
  );

  // Whitespace last. Doing it first would leave the gap where a number was
  // ("foo( 42 )" -> "foo(  )"), so normalizing an already-normalized quote
  // would produce a different string — and a normalizer that is not idempotent
  // gives the same finding two keys.
  return normalized.replace(/\s+/g, ' ').trim();
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
  // A TOOL-SUPPLIED FINGERPRINT REPLACES the evidence-and-bucket half (W18-24).
  // External tools (SARIF uploads, code-scanning alerts) already solved line
  // drift their own way — CodeQL's primaryLocationLineHash survives an
  // insertion fifty lines up, where the ten-line bucket would mint a new
  // finding and orphan its triage. The file stays in the key because those
  // hashes are of line CONTENT, not path: the same flagged line in two files
  // hashes alike and would otherwise fold into one row. Absent everywhere
  // else, so no existing key moves.
  if (input.fingerprint && input.scannerKey) {
    const fp = `${input.scannerKey}\0${input.ruleId ?? ''}\0fp\0${input.dimension}\0${input.file}\0${input.fingerprint}`;
    return createHash('sha256').update(fp).digest('hex');
  }
  const base = `${input.dimension}\0${input.file}\0${normalized}\0${bucket}`;
  const keyed = input.scannerKey
    ? `${input.scannerKey}\0${input.ruleId ?? ''}\0${base}`
    : base;

  return createHash('sha256').update(keyed).digest('hex');
}
