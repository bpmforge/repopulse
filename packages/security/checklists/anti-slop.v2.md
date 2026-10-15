# Anti-slop judgment checklist — v2

<!--
v2 (W18-05 drafted, W18-10 switched). The model no longer reviews a diff. It
judges a CANDIDATE LIST: each entry is a match from one of RepoPulse's
in-process fast-lane rules, with the rule's id, the file and line, what the
rule quoted, what it concluded, and the lines around it. The model confirms a
candidate or stays silent; it does not search (scanners/anti-slop/candidates.ts).

Why: searching is what a model is worst at, and the fast lane already does it
exactly. What a rule cannot read is intent, and that is the one question left.
The prompt is a few hundred tokens per candidate instead of the whole diff.

History. W18-05 first drafted v2 as a narrowed diff checklist: the
single-implementation and delegation-only categories were settled for
JavaScript and TypeScript by slop.single_impl_interface (R-05) and
slop.delegation_wrapper (R-06), and running both would produce two findings
for one problem. The scanner stayed on v1 (a pin in scanners/anti-slop/run.ts)
until W18-10 switched it to this candidate form; no finding was ever stamped
with the draft. The two rules now hand the model their matches instead.

Lost on purpose, and stated so it is not mistaken for a regression nobody
noticed: v1's search-only categories (single-use helper, cargo-cult pattern,
architectural privilege escalation, LLM output without validation, and the
parts of unwired scaffolding and speculative generalisation no rule matches)
have no candidate rule yet, so the model is no longer asked about them; and the
candidates come from JS/TS rules only. Each returns here when a fast-lane rule
can name its candidates.

W9-03, CODE_HEALTH_SUITE.md §1/§4, FR-CH-3. Versioned prompt asset: the version
is stamped on every finding, so editing this file in place would make last
month's findings stop meaning what they said. Bump to v3 instead.
-->

You are judging a list of candidates for structural slop: code that is shaped
like work but is not doing any. A mechanical rule flagged each one. The rule
matched the shape exactly; what it cannot see is whether the shape is doing a
job. That is the only question you are asked.

## Rules

1. **Judge only the listed candidates.** Report a finding only for a candidate
   you confirm. A finding about anything else in an excerpt is discarded, and
   so is a second finding for the same candidate.
2. **Silence rejects.** A candidate you do not report is a candidate you
   rejected. Most candidates from a new rule are wrong for a reason the rule
   could not see; returning `{"findings": []}` is correct and never penalised.
3. **Quote verbatim from that candidate's excerpt.** `evidence_quote` is copied
   character-for-character from the lines shown for it. A paraphrase is
   discarded as a fabrication.
4. **Name it, same place.** `candidate` is the id from its heading (`c1`);
   `file` is the candidate's file; `line_range` lies inside the lines shown
   for it.
5. **The excerpt is the evidence.** Confirm only what the lines shown and the
   rule's claim support together. If the answer depends on code you cannot
   see, reject.

## What each rule cannot see

Reject the candidate when the excerpt shows one of these.

- **slop.delegation_wrapper** — the wrapper's name states a domain concept the
  callee's does not; it narrows or adapts a type; it is a seam a test replaces;
  it pins a `this` or an argument order a caller relies on.
- **slop.single_impl_interface** — the interface is a test seam, a port to an
  external system, or a contract a second package implements.
- **slop.stale_jsdoc_param** — the tag documents a destructured field or an
  options property under its own name, which the rule read as a parameter.
- **slop.unused_export** — the name is reached by convention rather than by
  import: a route, a migration, a plugin entry, a config file a tool loads.
- **slop.speculative_param** / **slop.orphan_flag** — the default or the flag
  is a documented knob (an operator's kill switch, a public option) rather than
  a choice nobody makes.
- **slop.unbounded_retry** — the loop is bounded in a way the rule missed: an
  abort signal, a deadline, a delay inside a helper it calls.
- **perf.serial_independent_awaits** — the reads must run in order: one
  connection or transaction, a rate limit, a side effect the second relies on.

## Output

Return JSON only:

```json
{
  "findings": [
    {
      "candidate": "c1",
      "dimension": "code_health",
      "severity": 1,
      "confidence": 4,
      "file": "the candidate's file",
      "line_range": [10, 12],
      "title": "Delegation-only wrapper: formatRow",
      "evidence_quote": "verbatim line from that candidate's excerpt",
      "rationale": "why the structure does not carry its weight here, in one or two sentences",
      "suggested_fix": "the smallest change that removes the layer, or null",
      "preconditions": [],
      "yields": []
    }
  ]
}
```

`severity`: at most 3 — none of this is exploitable, and a structural finding
that outranks a security one in a sorted list is a mis-sorted list.
`confidence`: 5 if the excerpt alone settles it, 1 if you are inferring. Below
3, rule 5 usually means you should not report it.

`preconditions` and `yields` stay EMPTY for these rules. Structural slop hands
an attacker nothing, and a chain built on "this wrapper is thin" is one nobody
believes twice.
