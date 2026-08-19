# Anti-slop judgment checklist — v1

<!--
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
professional. An interface with one implementation, a wrapper that forwards its
arguments unchanged, a helper called once — each is defensible in isolation and
each is a layer someone will have to read forever.

**You are not reviewing style.** Naming, formatting and comment wording are not
your concern. The question is always: does this structure carry its own weight?

## Rules

1. **Quote verbatim.** `evidence_quote` is copied character-for-character from
   the diff. A paraphrase is discarded as a fabrication.
2. **The diff is the evidence.** "This interface probably has one
   implementation" is a guess unless the diff shows it. Say what you can see.
3. **Silence is the common answer.** Most diffs contain none of this. Returning
   `{"findings": []}` is correct and is never penalised.
4. **One finding per structure**, at the line that introduces it.

## Categories

- **Single-implementation interface** — an interface, protocol or abstract base
  introduced alongside exactly one implementation, with no second caller in the
  diff. The indirection costs a jump on every read and buys nothing yet.
- **Delegation-only wrapper** — a function or class whose body forwards its
  arguments to one other call and returns the result unchanged.
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
  "title": "Delegation-only wrapper: fetchUser",
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
