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

| Model | Cases | Agreement | Agree | Disagree | Abstained | Rejected | Missed real | Checklist | Run |
|---|--:|--:|--:|--:|--:|--:|--:|---|---|
| `qwen/qwen3.8-27b` | 12 | 100% | 12 | 0 | 0 | 0 | 0 | triage.v1 | 2026-11-02 |

## Per case

| Case | Truth | `qwen/qwen3.8-27b` |
|---|---|---|
| sql-concat-param | real | real (agree) |
| exec-user-input | real | real (agree) |
| eval-request-body | real | real (agree) |
| weak-reset-token | real | real (agree) |
| jwt-decode-auth | real | real (agree) |
| log-password | real | real (agree) |
| sql-allowlisted-column | false_positive | likely_false_positive (agree) |
| exec-constant | false_positive | likely_false_positive (agree) |
| eval-in-test | false_positive | likely_false_positive (agree) |
| random-jitter | false_positive | likely_false_positive (agree) |
| jwt-decode-after-verify | false_positive | likely_false_positive (agree) |
| console-in-cli | false_positive | likely_false_positive (agree) |
