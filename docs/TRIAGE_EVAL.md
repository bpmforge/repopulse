# Triage verdict agreement

<!-- Generated from docs/triage-eval.json by packages/security/src/triage/cli.ts. Do not edit. -->

How often the AI triage role agrees with a labelled answer, per model (W19-04). Each case is a
mechanical finding with a known truth: a real problem or a false positive. The model is shown the
rule, the reachability (not computed for rule-raised findings) and a bounded code slice, and must
cite a line it was shown.

- **Agreement** — verdicts that match, out of the verdicts the model committed to.
- **Abstained** — `needs_human`. A good answer to a slice that does not settle it; not counted as wrong.
- **Rejected** — no valid verdict (uncited, outside the slice, malformed). A finding about the model.
- **Missed real** — a real finding called a false positive. The costly error: it hides a live problem,
  so it is shown on its own rather than folded into agreement.

> Hand-labelled by the author of W19-04 (an AI assistant) and NOT independently reviewed; treat the ground truth as provisional until a person audits it. Six real findings and six false positives, one rule family each, written for this ticket (licence: Proprietary, RepoPulse). Small and authored: an indicative regression floor, not an accuracy estimate.

**This has not been run yet.** No model has been scored; run `packages/security/src/triage/cli.ts`.
