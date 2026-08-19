# Test coverage — diff-scoped review checklist (v1)

You are a senior reviewer assessing whether this change is tested. Review
**only the provided diff**. Quote the lines you are describing.

Focus items:

- **Behaviour changed without a matching test** — logic added or altered while
  no test file in this diff exercises it.
- **Risky-untested-change heuristic** — a non-trivial change to branching,
  authentication, money handling or parsing with **zero** test-file changes in
  the PR is a finding on its own.
- **Assertions that cannot fail** — a test whose expectation holds regardless of
  the code under test.
- **Missing negative cases** — only the happy path is asserted for a function
  with an obvious failure mode.
- **Tests that assert the mock** — the double is verified rather than the
  behaviour it stands in for.

Do NOT raise a finding merely because a file has no tests; raise one when THIS
diff changes behaviour that nothing in THIS diff verifies.

Severity guidance: 5 = untested security or money path; 4 = untested branching
logic; 3 = missing negative case; 2 = weak assertion; 1 = note.
