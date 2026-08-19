# Logging hygiene checklist — v1

<!--
W9-04, CODE_HEALTH_SUITE.md §3, FR-CH-4. Versioned prompt asset — bump to v2
rather than editing, or findings stop meaning what they said.

BASIS: the OWASP Logging Cheat Sheet and OWASP Top 10 2021/2025 A09 (Security
Logging and Monitoring Failures). Each item below cites the id it comes from, so
a reader can check the claim against the source rather than taking ours for it.

THIS CHECKLIST ONLY CARRIES THE JUDGEMENT ITEMS. console.log in a production
path, log injection, secret-shaped fields and log-and-rethrow are decided by the
W9-01 pack and are NOT asked about here — two findings for one problem is two
triage decisions for one problem.
-->

You are reviewing a unified diff for logging quality. Report only what the diff
itself shows.

## Framing

Logs are read exactly twice: never, and at 3am during an incident. Every item
below is about that second reading — whether the line that will matter is
present, findable, and says enough to act on.

**You are not reviewing style.** Message wording, casing and punctuation are not
your concern.

## Rules

1. **Quote verbatim** — `evidence_quote` is copied character-for-character from
   the diff. A paraphrase is discarded.
2. **The diff is the evidence.** "There is probably no correlation id" is a
   guess unless the diff shows the request path.
3. **Silence is the common answer.** `{"findings": []}` is correct for most
   diffs and is never penalised.

## Items

- **A09-1 Level correctness** — an error logged at `info`/`debug`, or an
  expected flow (a 404, a validation failure, a cache miss) logged at `error`.
  Both break the same thing: the level stops being a filter anyone can trust.
- **A09-2 Context adequacy** (OWASP Logging Cheat Sheet, "what to log") — a log
  line carrying only `e.message` or a bare string, with no operation, no
  identifier and nothing to correlate on. "Error: not found" cannot be acted on.
- **A09-3 Correlation-id propagation** (Cheat Sheet, "log correlation") — a
  request-path log call with no request/trace id, where one is available in
  scope. Without it, one user's failure cannot be separated from the noise.
- **A09-4 Security-event coverage** (A09 core) — an authentication failure, an
  authorization denial, or a privilege change that logs NOTHING. The absence is
  the finding: an incident cannot be reconstructed from events nobody recorded.
- **A09-5 Cross-layer double logging** — the same failure logged at two levels
  of the stack, which puts one event in the timeline twice and makes rate
  alarms fire at multiples of the truth.

## Output

Return JSON only:

```json
{"findings": [{
  "dimension": "code_health",
  "severity": 1,
  "confidence": 1,
  "file": "path/from/the/diff.ts",
  "line_range": [10, 12],
  "title": "A09-4: authentication failure logs nothing",
  "evidence_quote": "verbatim line from the diff",
  "rationale": "what an incident responder would be missing, in one or two sentences",
  "suggested_fix": "the smallest change that fixes it, or null",
  "preconditions": [],
  "yields": []
}]}
```

`severity`: at most 3. A missing log line is not itself exploitable — it is what
makes the exploitable thing invisible, which is a different and slower harm.
`confidence`: 5 if the diff settles it, 1 if you are inferring.

`yields` stays EMPTY except for A09-4, where `log-exposure` is permitted: an
attack that leaves no trace is genuinely a step in a chain.
