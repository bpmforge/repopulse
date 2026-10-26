# Hand-check run for the W21-20 performance rules

Owner decision, 2026-10-26 ("Hand-checked bar"): performance rules have no
independent public benchmark, so the W21-04 starter set can never qualify them.
Instead a performance rule starts **live on new installs** when it passes the
bar below on real open-source code. Every other rule stays shadow and promotes
under the unchanged rule (20 findings, 30 days, <20% FP).

Brad approved the repo list on 2026-10-26 and said "start the hand-check on the
12 repos". He had already approved downloading public open-source code to his
Mac, for measurement only, deleted afterwards. Nothing from these repos is
committed.

## Scope

Rules: every `bpm-perf-*` rule in `packages/security/rulepacks/code-health/perf/`,
meaning the 27 original perf rules and the W21-20 complexity rules (JS/TS,
Python, Java, Kotlin, Go). Only rules for the languages a repo contains apply to
it. Other shadow rules (anti-slop, logging, security) are out of scope here.

## The 12 repos

Use each repository's default branch at the time of the run, and record the
commit SHA.

| Language | Repository |
|---|---|
| JS/TS | excalidraw/excalidraw |
| JS/TS | outline/outline |
| JS/TS | immich-app/immich |
| Python | saleor/saleor |
| Python | zulip/zulip |
| Python | paperless-ngx/paperless-ngx |
| Java | thingsboard/thingsboard |
| Java | apache/commons-collections |
| Kotlin | mihonapp/mihon |
| Go | prometheus/prometheus |
| Go | go-gitea/gitea |
| Go | traefik/traefik |

Exclude tests, fixtures, vendored and generated code, as the pack already does.

## The bar (per rule)

A rule goes live by default only if **all** of these hold:

1. At least **5 true hits** across the 12 repos.
2. Precision of **at least 80%**, where precision = true / (true + wrong).
   "Small list" hits (correct shape, input bounded and small) count as neither
   true nor wrong, and are reported separately.
3. **A person** (Brad) has marked every hit. Claude's reading is a proposed
   label, not the verdict.

A rule with fewer than 5 true hits stays shadow. That means "not enough
evidence", not "failed".

## Output

1. **A marking sheet for Brad.** Write it to
   `docs/benchmarks/perf-hand-check/SHEET.md`, plus a CSV next to it. Give one
   row per hit with these columns: rule, repo@sha, file:line, a 3-6 line
   excerpt, the proposed label (true / small list / wrong), a one-line reason,
   and an empty "Brad" column. Group the rows by rule. Put a summary of the
   proposed counts per rule at the top.
2. **A PR with the sheet and the per-rule table.** Do not merge it until Brad
   has marked the sheet. After he marks it, recount from his labels only.
3. **Wire the rules that pass**, in the same way W21-04 wired the starter set:
   - Add them to a checked-in manifest with their evidence. Either extend
     `starter-set.data.ts` with a new evidence source `hand-checked`, or add a
     sibling manifest. Choose whichever fits the code better.
   - Make sure Settings, Rules and the finding panel show the reason "live via
     hand-checked evidence".
   - Add a test that fails if the manifest and the marked sheet disagree.
   - Record the decision and the results in `docs/BENCHMARKS.md`.
