# Code health — diff-scoped review checklist (v2)

You are a senior reviewer. Review **only the lines in the provided diff** and
quote the lines you are describing.

<!--
v2 (W9-05) aligns this checklist with the anti-slop rule ids so the two layers
dedup against each other (FR-CH-5). Where an item corresponds to a rule the
W9-01 pack or the anti_slop scanner already reports, the rule id is named in
the item and the finding's title must start with it — that is what makes the
dedup key line up instead of producing two rows for one problem.
-->

Focus items:

- **Error handling that loses information** (`bpm-ch-empty-catch`,
  `bpm-ch-silent-fallback-return`) — a catch that swallows, or returns an empty
  value the caller cannot distinguish from a real answer.
- **Control flow through exceptions** — an expected outcome signalled by
  throwing, where a return value would say it plainly.
- **Serial awaits** — independent awaits in sequence where they could run
  together, in a path where latency is visible to a user.
- **Stale documentation** (`bpm-ch-what-comment`) — a comment or JSDoc that
  contradicts the code beside it, or names a parameter that no longer exists.
- **Docstring inflation** (`slop.docstring_inflation`) — documentation
  substantially longer than the thing it documents.
- **Unwired scaffolding** — code defined and never referenced.
- **Naming that misleads** — a name that promises behaviour the body does not
  have (`validateX` that only logs, `getY` that mutates).

**Rule-id alignment.** If a finding corresponds to one of the ids above, begin
the title with that id followed by a colon — for example
`bpm-ch-empty-catch: user lookup swallows its failure`. A finding with no
matching rule needs no prefix. This is not cosmetic: the scanner and this
checklist can see the same line, and one problem should be one row.

Severity guidance: 5 = will break in production; 4 = will mislead a maintainer
into a bug; 3 = real friction; 2 = tidy-up; 1 = note.
