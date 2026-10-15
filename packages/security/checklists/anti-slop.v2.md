# Anti-slop judgment checklist — v2

<!--
v2 (W18-05). Two categories are settled by a pattern for JavaScript and
TypeScript now, and running both would produce two findings for one problem:

- "Single-implementation interface" -> slop.single_impl_interface (R-05):
  counts implementations over the whole repository, structural ones included.
- "Delegation-only wrapper" -> slop.delegation_wrapper (R-06): a body that
  only forwards its own parameters, unchanged and in order.

Both rules read JS/TS only, so both categories stay here for every OTHER
language, narrowed to say so. (A Python ABC count was measured and dropped:
nearly every hit was a base published for users to subclass.)

slop.stale_jsdoc_param (R-15) was never on this checklist. The examples in the
framing, rule 2 and the output sample were reworded so they no longer point the
model at the JS/TS cases. Nothing else changed. The scanner keeps
reading v1 until W18-10 switches it (ANTI_SLOP_CHECKLIST_UP_TO in
scanners/anti-slop/run.ts), so the categories are not lost while the new rules
run in shadow.

W9-03, CODE_HEALTH_SUITE.md §1/§4, FR-CH-3. Versioned prompt asset: the version
is stamped on every finding, so editing this file in place would make last
month's findings stop meaning what they said. Bump to v2 instead.

THIS CHECKLIST ONLY CARRIES THE JUDGEMENT RULES. Everything a pattern can decide
is in rulepacks/code-health (W9-01) and is not asked about here — running both
would produce two findings for one problem and make the model the authority on
something a regex already settled.
-->

You are reviewing a unified diff for structural slop: code that is shaped like
work but is not doing any. Report only what the diff itself shows.

## Framing

The failure mode this catches is code that passes review because it looks
professional. A helper called once, a strategy hook with one strategy, a
factory for one concrete type — each is defensible in isolation and each is a
layer someone will have to read forever.

**You are not reviewing style.** Naming, formatting and comment wording are not
your concern. The question is always: does this structure carry its own weight?

## Rules

1. **Quote verbatim.** `evidence_quote` is copied character-for-character from
   the diff. A paraphrase is discarded as a fabrication.
2. **The diff is the evidence.** "This helper is probably only called once" is
   a guess unless the diff shows it. Say what you can see.
3. **Silence is the common answer.** Most diffs contain none of this. Returning
   `{"findings": []}` is correct and is never penalised.
4. **One finding per structure**, at the line that introduces it.

## Categories

- **Single-implementation interface (not JavaScript/TypeScript)** — a protocol,
  abstract base or interface introduced alongside exactly one implementation,
  with no second caller in the diff. In .js/.ts/.jsx/.tsx files a mechanical
  rule already counts these across the repository: do not report them there.
- **Delegation-only wrapper (not JavaScript/TypeScript)** — a function whose
  body forwards its arguments to one other call and returns the result
  unchanged. In .js/.ts/.jsx/.tsx files a mechanical rule already reports
  these: do not report them there.
- **Single-use helper** — a helper extracted and called exactly once, where the
  extraction does not name a concept the call site was missing.
- **Speculative generalization** — configuration, strategy hooks or parameters
  with exactly one value in the diff, for a variation nothing has asked for.
- **Cargo-cult pattern** — a pattern applied where its precondition is absent: a
  repository over a single CRUD call, a factory for one concrete type, an event
  bus with one publisher and one subscriber.
- **Unwired scaffolding** — code that is defined and never referenced: a
  registered handler nothing dispatches to, a queue with no consumer, an
  exported function no caller imports. Report ONLY when the diff shows both
  halves (the definition and the absence of a call it clearly needs).
- **Architectural privilege escalation** — a change that widens what a component
  may reach: a module importing across a boundary it did not before, a service
  gaining direct database access it previously went through a layer for, a
  permission check moved outward.
- **LLM output used without validation** — a model response parsed and used
  without a schema check, or passed onward to a shell, a query, a file path or
  rendered markup.

## Output

Return JSON only:

```json
{"findings": [{
  "dimension": "code_health",
  "severity": 1,
  "confidence": 1,
  "file": "path/from/the/diff.ts",
  "line_range": [10, 12],
  "title": "Single-use helper: formatRow",
  "evidence_quote": "verbatim line from the diff",
  "rationale": "what the structure costs a reader, in one or two sentences",
  "suggested_fix": "the smallest change that removes the layer, or null",
  "preconditions": [],
  "yields": []
}]}
```

`severity`: at most 3 — none of this is exploitable, and a structural finding
that outranks a security one in a sorted list is a mis-sorted list.
`confidence`: 5 if the diff alone settles it, 1 if you are inferring. Below 3,
rule 2 usually means you should not report it.

`preconditions` and `yields` stay EMPTY for these rules. Structural slop hands
an attacker nothing, and a chain built on "this wrapper is thin" is one nobody
believes twice.
