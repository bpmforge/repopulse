# Model evaluation

<!-- Generated from packages/security/src/eval/results.generated.ts by packages/security/src/eval/cli.ts. Do not edit. -->

How well each model does each analysis role on labelled fixtures (W19-05). For every role the
specialist is run over cases with a planted defect and clean cases, and scored for:

- **Precision** — of what it reported, how much was a planted defect. A model that cries wolf scores low.
- **Recall** — of the planted defects, how many it reported. A model that misses things scores low.
- **Not scored** — cases that hit a provider error. They are listed in full and the role is shown as
  *incomplete*; a dropped connection is never published as a model that found nothing.
- **Format failures** — cases where the model never produced the required JSON after one retry; scored
  as having found nothing, and counted because it is a property of the model.

> The fixtures are small (four cases per role, eight for performance; half with a planted defect, half clean), written for this
> ticket by an AI assistant, and **their labels have not been reviewed by a person**. They are an
> indicative floor, not an accuracy estimate. The OWASP Benchmark and Juliet slices in
> `fixtures/benchmark` grade scanner detection and need a fetched corpus; they are **not** part of
> these runs. Results depend on the provider: the temperature is fixed at 0.1, and a seed is sent only
> when requested and may be ignored by the server.

### `qwen/qwen3.8-27b`

Engine: OpenAI-compatible endpoint at localhost:1234 · run 2026-10-18 · temperature 0.1 · seed 7 (requested; the provider may ignore it) · complete

| Role | Checklist | Cases | Precision | Recall | TP | FP | FN | Not scored | Format failures |
|---|---|--:|--:|--:|--:|--:|--:|--:|--:|
| Security | v1 | 4 | 100% | 100% | 2 | 0 | 0 | 0 | 0 |
| Performance | v2 | 4 | 67% | 100% | 2 | 1 | 0 | 0 | 0 |
| Code health | v2 | 4 | 100% | 100% | 2 | 0 | 0 | 0 | 0 |
| Test coverage | v1 | 4 | 67% | 100% | 2 | 1 | 0 | 0 | 0 |
| Best practices | v1 | 4 | 100% | 100% | 2 | 0 | 0 | 0 | 0 |
| AI slop | v1 | 4 | 67% | 100% | 2 | 1 | 0 | 0 | 0 |

Triage agreement: 100% (12 agree, 0 disagree, 0 abstained, 0 rejected, 0 missed real, of 12 — see TRIAGE_EVAL.md)
