import type { VexJustification } from '../validation/types.js';

// Evidence-fed triage of mechanical findings (W19-04, AI_LAYER.md).
//
// The V5 pattern (validation/verify) applied to findings a RULE raised rather
// than dependency CVEs: the model is handed the rule's provenance, the
// reachability tier when one exists, and a bounded slice of the file, and
// returns a verdict with a citation. Its vocabulary is deliberately V5's —
// RejectReason-style rejections, a funnel with reconcilable invariants, and a
// `dismissed` counter that is ALWAYS zero — so a reader triaging a finding does
// not have to learn two shapes.
//
// NOTHING HERE SUPPRESSES, DISMISSES, MERGES OR WRITES TO A REPOSITORY. A
// verdict, a VEX justification and a patch are all proposals for a person.

export const TRIAGE_VERDICTS = ['real', 'likely_false_positive', 'needs_human'] as const;
export type TriageVerdict = (typeof TRIAGE_VERDICTS)[number];

export const TRIAGE_CHECKLIST_VERSION = 'triage.v1';

/** The finding as the rule raised it. */
export interface TriageFinding {
  dedupKey: string;
  scannerKey: string;
  ruleId: string;
  title: string;
  dimension: string;
  file: string;
  lineStart: number;
  lineEnd: number;
  evidenceQuote: string;
  /** What the rule says it looks for, when its metadata has it. */
  ruleDescription?: string | null;
  packVersion?: string | null;
  cwe?: number | null;
}

/**
 * Reachability of the code, when something computed it. Only dependency
 * findings carry a tier today; for a rule-raised code finding `tier` is null and
 * the prompt says "not computed" rather than inventing one.
 */
export interface TriageReachability {
  tier: string | null;
  detail?: string | null;
}

export interface TriageCandidate {
  finding: TriageFinding;
  reachability: TriageReachability;
  /** The file at the scanned commit. Comes from the snapshot — never fetched live (Law 4). */
  source: string;
  /** The price the finding was given; the sort key, taken rather than recomputed. */
  effectiveRisk: number;
}

/** One cited line, as OUR record has it — never the model's text. */
export interface CitedLine {
  file: string;
  line: number;
  text: string;
}

export interface TriageVex {
  justification: VexJustification;
  statement: string;
}

export type PatchProofStatus = 'verified' | 'rejected' | 'failed' | 'not_attempted';

export interface TriagePatch {
  /** The canonical diff (re-rendered from the parsed patch), present only when verified. */
  diff: string | null;
  status: PatchProofStatus;
  /** Why it was or was not accepted, in words that can reach a screen. */
  reason: string;
}

export interface TriageProposal {
  dedupKey: string;
  verdict: TriageVerdict;
  /** 1-5, as claimed. Stored, never used as a threshold. */
  confidence: number;
  model: string;
  checklistVersion: string;
  rationale: string;
  citations: CitedLine[];
  vex: TriageVex | null;
  patch: TriagePatch | null;
  /** The routing link that served the call, so a verdict has an author. */
  route: { providerName: string; model: string; linkIndex: number } | null;
}

export type TriageRejectReason =
  /** Not JSON, or not the shape the checklist asked for. */
  | 'malformed'
  /** A verdict that cites no line. */
  | 'uncited'
  /** It cited a line outside the slice it was given, or misquoted it. */
  | 'citation_not_found'
  /** A VEX justification on a verdict that cannot support one. */
  | 'ungrounded';

export interface TriageRejection {
  dedupKey: string;
  reason: TriageRejectReason;
  detail: string;
}

export type TriageSkipReason = 'below_top_n' | 'budget_exhausted';

/**
 * Counts a reader can reconcile (the V5 invariants):
 *
 *   candidates === selected + skipped.below_top_n
 *   selected   === triaged  + skipped.budget_exhausted
 *   triaged    === accepted + rejected (sum)
 */
export interface TriageFunnel {
  candidates: number;
  selected: number;
  triaged: number;
  accepted: number;
  rejected: Record<TriageRejectReason, number>;
  skipped: Record<TriageSkipReason, number>;
  verdicts: Record<TriageVerdict, number>;
  /** ALWAYS ZERO, and asserted to be. Triage proposes; a human decides. */
  dismissed: number;
}

export function emptyTriageFunnel(): TriageFunnel {
  return {
    candidates: 0,
    selected: 0,
    triaged: 0,
    accepted: 0,
    rejected: { malformed: 0, uncited: 0, citation_not_found: 0, ungrounded: 0 },
    skipped: { below_top_n: 0, budget_exhausted: 0 },
    verdicts: { real: 0, likely_false_positive: 0, needs_human: 0 },
    dismissed: 0,
  };
}
