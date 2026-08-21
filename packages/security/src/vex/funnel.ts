import type { ValidationFunnel, VexJustification } from '../validation/index.js';
import type { VexApplication } from './statements.js';
import { VEX_JUSTIFICATIONS } from './types.js';

// The honesty funnel (W8-14 + W8-13, FR-SEC-15).
//
// `raw → deduped → scoped → affected / not_affected / under_investigation`,
// with per-justification counts underneath. The rule inherited from W8-13 and
// kept here: only `raw → deduped` is a NARROWING — two reports of one
// vulnerability becoming one row. `scoped` is a property of the deduped
// population, and the three triage buckets PARTITION that same population.
// Rendering all five as a descending staircase would claim the funnel threw
// away findings it never threw away, which is the same dishonesty as hiding
// them, told the other way round.
//
// THE RAW COUNT IS NEVER DROPPED. "47 raw advisories → 9 affected" is the
// credibility story in both directions: it is what makes the small number
// believable, and it is what stops the small number being the only number
// anyone sees.

export interface VexFunnel {
  /** Advisories grype reported, before V0 collapsed any alias twins. */
  raw: number;
  /** Distinct vulnerabilities after V0. */
  deduped: number;
  /**
   * Of the deduped population, those V1 placed in a resolved dependency set.
   *
   * NOT A FILTER. The remainder are still reported, still priced and still in
   * the buckets below — they are the ones whose ecosystem we have no manifest
   * reader for, and dropping them would make a Java repository look clean.
   */
  scoped: number;
  /** Deduped minus scoped, named so a reader can see the two reconcile. */
  unscoped: number;
  affected: number;
  notAffected: number;
  fixed: number;
  underInvestigation: number;
  /** Of `underInvestigation`, those a version bump pushed out of a statement. */
  reopened: number;
  /** Per-justification counts for the not_affected bucket; every key present. */
  byJustification: Record<VexJustification, number>;
  /**
   * Proposals the validation tiers made that NOBODY HAS ACTED ON.
   *
   * Kept beside the decided counts and never added to them. A proposal is the
   * machine saying "this looks dismissible"; only the confirmed column reflects
   * a person having agreed, and merging the two would let the scanner appear to
   * have dismissed its own findings.
   */
  proposedNotAffected: Record<string, number>;
}

/**
 * The SCAN-TIME funnel: what one run measured, after VEX had its say.
 *
 * NOT YET CALLED IN PRODUCTION, and worth saying so plainly. It needs a
 * `VexApplication`, which only exists where the vulnerabilities do — inside the
 * dependency runner, at the same single call site `applyVexStatements` is
 * waiting for. `run.ts` is outside W8-14's write scope, so both land together.
 *
 * The API's Security-tab payload deliberately does NOT route through here: it
 * has statements and finding rows, not vulnerabilities, so it reports STATEMENT
 * COUNTS — a different measurement of a different population, named as such
 * rather than dressed up as this.
 */
export function vexFunnel(validation: ValidationFunnel, applied: VexApplication): VexFunnel {
  const byJustification = Object.fromEntries(
    VEX_JUSTIFICATIONS.map((justification) => [justification, 0]),
  ) as Record<VexJustification, number>;

  let affected = 0;
  let notAffected = 0;
  let fixed = 0;
  let underInvestigation = 0;

  for (const entry of applied.all) {
    switch (entry.verdict.status) {
      case 'affected':
        affected += 1;
        break;
      case 'fixed':
        fixed += 1;
        break;
      case 'not_affected': {
        notAffected += 1;
        const justification = entry.verdict.statement?.justification;
        if (justification) byJustification[justification] += 1;
        break;
      }
      case 'under_investigation':
        underInvestigation += 1;
        break;
    }
  }

  // Scope is a count over the SAME population the buckets partition, taken from
  // V1's own tallies rather than recomputed here — two places deriving one
  // number is how a funnel stops reconciling.
  const unscoped = validation.scoped.notInResolvedSet + validation.scoped.unreadable;

  return {
    raw: validation.raw,
    deduped: validation.deduped,
    scoped: validation.deduped - unscoped,
    unscoped,
    affected,
    notAffected,
    fixed,
    underInvestigation,
    reopened: applied.reopened.length,
    byJustification,
    proposedNotAffected: { ...validation.proposed },
  };
}

/**
 * The funnel for a repository nothing has scanned.
 *
 * Every count zero AND the caller expected to distinguish this from a scan that
 * found nothing — same rule the scanner-state code follows, for the same
 * reason: an unqualified row of zeroes on a security screen reads as "clean".
 */
export function emptyVexFunnel(): VexFunnel {
  return {
    raw: 0,
    deduped: 0,
    scoped: 0,
    unscoped: 0,
    affected: 0,
    notAffected: 0,
    fixed: 0,
    underInvestigation: 0,
    reopened: 0,
    byJustification: Object.fromEntries(VEX_JUSTIFICATIONS.map((j) => [j, 0])) as Record<
      VexJustification,
      number
    >,
    proposedNotAffected: {},
  };
}
