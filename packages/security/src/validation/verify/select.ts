import type { ValidatedVulnerability } from '../types.js';
import type { SkipReason, VerifyCandidate } from './types.js';

// V5 candidate selection (W8-15, SECURITY_SUITE.md §3.6 — "optional, top-N by
// effective risk").
//
// Two decisions live here and both are about spend. A model call costs a slot
// on a machine somebody else is also using, so V5 runs on the findings where a
// human is actually going to spend triage time — the top of the effective_risk
// sort, which is the default sort every dependency surface already uses — and
// it does not run on findings a deterministic tier has already settled.

/** The default top-N. Small on purpose: this is triage help, not a second scan. */
export const VERIFY_TOP_N = 10;

/**
 * The ceiling a caller cannot raise past.
 *
 * A cap that config can lift is not a cap. One repository with four hundred
 * open CVEs would otherwise turn a nightly scan into four hundred sequential
 * LM Studio calls and starve every other pass on the host.
 */
export const VERIFY_MAX_CALLS = 25;

/** Structural view of findings.ts' PricedIncomingFinding — see candidatesFrom. */
export interface PricedLike {
  pricing: { effectiveRisk: number };
  key: string;
}

/**
 * Zips validated vulnerabilities with the prices V4 gave them.
 *
 * Structurally typed rather than importing PricedIncomingFinding: the
 * dependency scanner imports this module's package, and importing back into
 * scanners/dependency would close a cycle for the sake of one field's type.
 *
 * INDEX-ALIGNED, and it says so by throwing. dependencyFindings maps one
 * finding per vulnerability in order; if that ever stops being true, a silent
 * zip would attach every price to the wrong CVE and the top-N would be
 * confidently wrong rather than obviously broken.
 */
export function candidatesFrom(
  vulnerabilities: readonly ValidatedVulnerability[],
  priced: readonly PricedLike[],
): VerifyCandidate[] {
  if (vulnerabilities.length !== priced.length) {
    throw new Error(
      `V5 cannot align ${vulnerabilities.length} vulnerabilities with ${priced.length} priced ` +
        'findings: they are index-aligned by construction, so a mismatch means the mapper ' +
        'changed shape and every price would attach to the wrong CVE.',
    );
  }
  return vulnerabilities.map((vulnerability, index) => ({
    vulnerability,
    effectiveRisk: priced[index]!.pricing.effectiveRisk,
    dedupKey: priced[index]!.key,
  }));
}

export interface Selection {
  selected: VerifyCandidate[];
  /** Everything not selected, with the reason. Reported, never dropped quietly. */
  skipped: { candidate: VerifyCandidate; reason: SkipReason }[];
}

/**
 * Top-N by effective risk, minus the findings a model has nothing to add to.
 *
 * `proven_unreachable` is the exclusion that matters: govulncheck built a call
 * graph and found no path, and V0-V3 already attached the corresponding
 * proposal. Asking a model to second-guess a call-graph proof from an evidence
 * summary can only produce a weaker claim about a stronger fact, and if it
 * disagreed we would have to ignore it — so the call is not made.
 */
export function selectForVerify(
  candidates: readonly VerifyCandidate[],
  limit: number = VERIFY_TOP_N,
): Selection {
  const cap = Math.max(0, Math.min(limit, VERIFY_MAX_CALLS));
  const skipped: Selection['skipped'] = [];
  const eligible: VerifyCandidate[] = [];

  for (const candidate of candidates) {
    if (candidate.vulnerability.reachability.tier === 'proven_unreachable') {
      skipped.push({ candidate, reason: 'already_proven_unreachable' });
      continue;
    }
    eligible.push(candidate);
  }

  // Ties break on the dedup key so two runs over the same findings send the
  // same ones. A non-deterministic top-N would make "why was this verified
  // last night and not tonight" unanswerable.
  eligible.sort(
    (a, b) => b.effectiveRisk - a.effectiveRisk || a.dedupKey.localeCompare(b.dedupKey),
  );

  const selected = eligible.slice(0, cap);
  for (const candidate of eligible.slice(cap)) skipped.push({ candidate, reason: 'below_top_n' });

  return { selected, skipped };
}
