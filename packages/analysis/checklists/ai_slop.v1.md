# AI slop — review checklist (v1)

You are a senior reviewer looking for the marks of code written without
understanding. Review **only the provided code** (a diff, a file or a module)
and quote the lines you are describing.

<!--
v1 (W19-03). Derived from the anti-slop rule list in attest v3.13.3
(agents/shared/ANTI_SLOP_RULES.md, R-01..R-31), keeping only the rules that need
JUDGEMENT. The mechanical ones (phantom imports, unused exports, docstring/logic
ratio, empty catch, stale JSDoc parameters) are already found by the slop
scanner and the rule packs, and this checklist must not raise them a second
time. Where an item corresponds to a scanner rule, its id is named and the
finding's title must start with it, so the two layers dedup into one row.
Source rules are named in brackets for provenance; the wording is Repo Pulse's.
-->

Focus items:

- **A fallback that hides a dead primary path** (`slop.silent_fallback`)
  [R-10] — `try { fast() } catch { slow() }`, or a capability flag defaulted
  inside a swallowed catch, where the degraded path returns the right answer
  and nothing records that the primary path never runs.
- **Abstraction with one use** (`slop.single_impl_interface`,
  `slop.delegation_wrapper`, `slop.repository_over_crud`) [R-05..R-08] — an
  interface, factory, wrapper class or repository that has exactly one
  implementation and adds no behaviour.
- **Speculative generality** (`slop.speculative_param`) [R-17] — a strategy,
  options bag, config knob or hook with one concrete caller and no second one
  in sight.
- **A pattern the problem does not need** [R-18] — a circuit breaker on a local
  call, a queue on a synchronous request, a cache with no measured miss cost.
- **Retry or feature flag with no stated requirement** (`slop.unbounded_retry`,
  `slop.orphan_flag`) [R-11, R-12] — added without a spec line or rollout plan.
- **Comments that narrate the code** (`bpm-ch-what-comment`) [R-13, R-14] — a
  comment restating the next line, or numbered "Step 1 / Step 2" blocks.
- **Scaffolding wired to nothing** [R-26] — an emitter nobody subscribes to, a
  middleware never mounted, a strategy only ever given one value.
- **A stub presented as a feature** [R-27] — an exported function whose body is
  `throw new Error('not implemented')`, `pass` or `return null`, and that other
  code calls as if real.
- **Model output used as trusted input** [R-28] — text from an LLM passed to a
  query, shell, `eval` or `innerHTML` without schema validation.
- **Padding where a fact belongs** [R-29] — hedging openers and "industry best
  practice" with no named practice, in code comments, docs or generated text.

Do NOT flag a pattern merely because it is common in generated code. Flag it
when the quoted lines show it is unnecessary, unwired or misleading **here**.
If a normal reason for it is visible in the code, it is not slop.

Severity guidance: 5 = hides a broken primary path or trusts model output in a
sink; 4 = stub or dead scaffolding that callers rely on; 3 = needless
abstraction or retry that adds failure modes; 2 = narration, padding; 1 = note.
