import type { ValidatedVulnerability, VexJustification, VexProposal } from '../types.js';

// V5 — the adversarial verify pass (W8-15, SECURITY_SUITE.md §3.6, FR-SEC-13,
// FR-ANALYSIS-9).
//
// V0-V3 are deterministic and cheap; V5 is a model and is neither, so it runs
// on the top-N findings by effective_risk and nowhere else. What it produces is
// a PROPOSAL — the same VexProposal shape V0-V3 already emit — and the reason
// the vocabulary is shared is that a reader triaging a finding should not have
// to learn which tier proposed what. Where they differ is provenance: a V5
// proposal names the model that made it and the confidence it claimed, because
// a judgement carries a different weight from a lockfile lookup and hiding that
// behind one word would be the dishonest kind of tidy.
//
// NOTHING HERE DISMISSES ANYTHING, and no downstream code may read it as if it
// did. That is not caution about model quality; it is the design. A tool that
// can close a CVE unattended is one bad answer away from hiding a live
// vulnerability behind a sentence nobody read.

/** What V5 needs to know about a finding to decide whether it is worth a call. */
export interface VerifyCandidate {
  vulnerability: ValidatedVulnerability;
  /**
   * effective_risk as V4 priced it — the sort key, taken rather than recomputed.
   *
   * findings.ts prices each finding once through the shared priceFinding and
   * stores that number. Scoring again here would be a second scoring path for
   * one column, which is how the popover stops matching the score it explains.
   */
  effectiveRisk: number;
  /** persistFindings' dedup key, so a proposal can be attached to its stored row. */
  dedupKey: string;
}

/** Why a top-N candidate was NOT sent to a model. Counted, never silent. */
export type SkipReason = 'already_proven_unreachable' | 'below_top_n' | 'budget_exhausted';

/** One evidence line the model cited, after it was matched against V2/V3 output. */
export interface CitedEvidence {
  kind: 'import' | 'call_site';
  file: string;
  line: number;
  /** The import statement or symbol from OUR record, never from the model's text. */
  detail: string;
}

/** Why an answer was thrown away. Each one is counted on the funnel. */
export type RejectReason =
  /** The response was not JSON, or not the shape the checklist asked for. */
  | 'malformed'
  /** It cited a file:line that appears in no V2 or V3 record for this finding. */
  | 'evidence_not_found'
  /** The justification's ground does not hold on the deterministic verdicts. */
  | 'ungrounded';

/** A V5 answer that survived validation. */
export interface VerifyProposal {
  dedupKey: string;
  primaryId: string;
  packageName: string;
  /** The model's verdict. `true` — the ordinary answer — yields no proposal. */
  applies: boolean;
  /** 1-5, as the model claimed it. Stored, never used as a threshold here. */
  confidence: number;
  /** Which model answered, so a proposal nobody agrees with has an author. */
  model: string;
  /**
   * The proposal for a human to confirm, or null when the model left the
   * finding alone. Shaped exactly like V0-V3's so the triage UI has one thing
   * to render.
   */
  proposal: VexProposal | null;
  /** The V2/V3 lines the model relied on, matched back to our own records. */
  citedEvidence: CitedEvidence[];
}

/** An answer that did not survive, kept so a reader can see WHAT did not. */
export interface VerifyRejection {
  dedupKey: string;
  primaryId: string;
  reason: RejectReason;
  /** The specific failure, in a sentence: which citation, which ground. */
  detail: string;
}

/**
 * The V5 funnel, as counts a reader can reconcile against the proposals.
 *
 * `verified` is calls made, not findings improved: most answers are
 * `applies: true` and produce nothing, and a funnel that only counted
 * proposals would make an expensive pass look like a productive one.
 *
 * TWO INVARIANTS A READER CAN CHECK, and tests do:
 *
 *   candidates === selected + skipped.already_proven_unreachable + skipped.below_top_n
 *   selected   === verified + skipped.budget_exhausted
 *
 * `selected` is therefore the PRE-BUDGET cut — what this pass intended to ask
 * about — and the budget's bite shows up as a skip rather than by quietly
 * shrinking the intention. A funnel whose numbers do not add up makes a reader
 * guess which one lied, which is the failure the V0-V3 funnel is built to
 * avoid, pointed at a different tier.
 */
export interface VerifyFunnel {
  /** Findings offered to V5 — the whole priced population. */
  candidates: number;
  /** Selected for a call after the top-N cut and the eligibility rules. */
  selected: number;
  /** Gateway calls actually made. Below `selected` only when a budget bit. */
  verified: number;
  /** Answers that validated. */
  accepted: number;
  /** Answers thrown away, by reason. */
  rejected: Record<RejectReason, number>;
  /** Candidates not sent, by reason. */
  skipped: Record<SkipReason, number>;
  /** Accepted answers that proposed a justification, by justification. */
  proposed: Record<string, number>;
  /** Accepted answers that left the finding alone — the expected majority. */
  affirmed: number;
  /** ALWAYS ZERO, and asserted to be. V5 proposes; W8-14 and a human dismiss. */
  dismissed: number;
}

export function emptyVerifyFunnel(): VerifyFunnel {
  return {
    candidates: 0,
    selected: 0,
    verified: 0,
    accepted: 0,
    rejected: { malformed: 0, evidence_not_found: 0, ungrounded: 0 },
    skipped: { already_proven_unreachable: 0, below_top_n: 0, budget_exhausted: 0 },
    proposed: {},
    affirmed: 0,
    dismissed: 0,
  };
}

export type { VexJustification, VexProposal };
