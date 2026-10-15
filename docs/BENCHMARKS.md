# Benchmarks — accuracy of the deterministic layers

W18-17 (E13.5). This page says how accurate Repo Pulse's deterministic checks are on a
pinned, labelled corpus, how the numbers were produced, and what they do not show. The
full generated report, with every miss and false positive listed, is in
[`docs/benchmarks/report.md`](benchmarks/report.md), and the machine-readable copy is
[`docs/benchmarks/report.json`](benchmarks/report.json). Both are committed, so the
change between two releases is a `git diff` of those files.

## Scope

**Measured:** the deterministic layers only.

- **Fast lane (in-process):** the anti_slop arithmetic and graph checks
  (`slop.low_logic_density`, `slop.docstring_inflation`, `slop.unused_export`,
  `slop.phantom_symbol`, `slop.phantom_module`) and the secrets rulepack (15 rules).
  They are called the way the scanners call them. Shadow status is ignored on purpose,
  because these numbers are part of the evidence for promoting a rule from `candidate`.
- **YAML rulepacks:** every rule file in `rulepacks/semgrep/`,
  `rulepacks/code-health/` and `rulepacks/code-health/perf/` (26 rules at the time of
  writing). They run under whichever of opengrep or semgrep is installed.

**Not measured:**

- **The LLM tiers (T2 checklists, T3), the verify gate and the chainer.** This first
  version is deterministic by design: a benchmark that calls a model is neither
  reproducible nor free to run, and it would need its own method (sampling, several runs,
  judge disagreement). That is follow-up work.
- **The dependency scanner, code_health_tools (lizard, jscpd, ruff, Biome) and the
  architecture checks.** They need an SBOM and registry data, installed tools, or a whole
  repository graph. Labels in those dimensions are listed as *skipped*, not as misses.

## Method

1. **Corpus.** Each suite is a directory under `packages/security/fixtures/benchmark/`
   with a `suite.json`. That file gives the suite's source (repository, pinned commit,
   licence), its trees (the directories scanned, each as if it were a repository root)
   and its labels.
2. **Labels.** A label names a tree, a file, and optionally an inclusive line range.
   It can be satisfied in one of three ways:
   - by a specific rule, with `accept` listing language variants;
   - by any rule reporting a given CWE (OWASP Benchmark's own unit);
   - by any finding in a dimension. This kind records a defect that no deterministic rule
     claims, so it shows up as a gap instead of disappearing.

   `expect: "finding"` marks a defect. `expect: "none"` marks a near-miss that has to stay
   quiet.
3. **Run.** The runner copies every tree into a scratch directory, the way a scan
   snapshot is a repository root. It runs the fast lane once per tree and the YAML packs
   in one engine invocation, then turns everything into findings of the form
   `(suite, tree, file, lines, rule, dimension, CWE)`.
4. **Matching (`src/benchmark/match.ts`).** Findings are processed in a fixed order.
   - **TP:** a finding satisfies a label that is still unmatched. Each label can take one
     finding and each finding one label.
   - **Duplicate:** a second finding on an already-satisfied label. It counts as neither
     a TP nor an FP.
   - **FP:** a finding on an `expect: "none"` label, or a finding no label speaks to.
     The OWASP suite is the exception: there a finding no label speaks to is *ignored*,
     following OWASP Benchmark's own scoring.
   - **FN:** a defect label nothing satisfied.
   - **Skipped:** a label whose rule did not run (for example, no YAML engine on the
     machine), whose dimension no measured engine reports, or which only a YAML rule
     could satisfy on a file the engine could not parse.
5. **Scores.** Precision is TP/(TP+FP) and recall is TP/(TP+FN). Both are reported per
   rule, per dimension, per suite and in total. A score with a zero denominator is
   reported as "—", never as 100%. An FN is charged to a rule only when the label names
   that rule. Defects no rule claims count against their dimension.
6. **Determinism.** Neither report contains a timestamp, a duration or an absolute path,
   and every list is sorted. Two runs over the same corpus with the same engine are
   byte-identical; a unit test checks this.

**Adjudication.** Every finding on vendored or authored code was read by hand after the
first run. Labels that were added at that point say so in their `note`:

- `routes-login-credentials`: a real credential the secrets rule found in Juice Shop.
- `perf-await-in-loop-before-fanout`: makes the changes suite agree with the rule fixture
  of the same shape.
- `slop-docstring-inflation-ldr`: a second rule that is correct about the same file.

Findings judged wrong stayed as false positives. For example, both the retry loop's
`await` and its `try/catch` are needed, so in the first run those findings were FPs
(the rule-gap follow-up below removed them by changing the rules, not the labels).

## Corpus

| Suite | What | Source and pin | Licence | Labels |
|---|---|---|---|--:|
| `sampleco` | AI-slop corpus: a deliberately vibe-coded Express API with 12 planted defects | [bpmforge/slop-scorecard](https://github.com/bpmforge/slop-scorecard) `f3ed52573aebe6c873d580551e5986aa743c7ca1`, `sample/sampleco` (src + package.json, verbatim) | MIT, owned by bpmforge; LICENSE vendored | 15 |
| `juice-shop` | 21 code-fix snippets (SQLi, NoSQLi, open redirect) with upstream right/wrong-fix verdicts, plus the full `routes/login.ts` and `routes/search.ts` | [juice-shop/juice-shop](https://github.com/juice-shop/juice-shop) `e39a3bdb8c61295c31fa4e0a03485e68a8ca12a4` | MIT; LICENSE vendored | 24 |
| `owasp-benchmark` | 60 Java test cases: the first 5 real and 5 false-positive cases of sqli, cmdi, pathtraver, hash, crypto and weakrand | [OWASP-Benchmark/BenchmarkJava](https://github.com/OWASP-Benchmark/BenchmarkJava) `0a3113b7054a56a072e694ab65a2f8cd7405aeb7`, `expectedresults-1.2.csv` | GPL-2.0, **not vendored** (below) | 60 |
| `changes` | 19 hand-written bug-introducing changes (before/after pairs) | authored for this benchmark | proprietary (ours) | 23 |
| `rule-fixtures` | the existing trigger/clean fixtures for the YAML packs, read in place | `packages/security/fixtures/{code-health,perf,semgrep}` | proprietary (ours) | 29 |

**Licences.** This repository is proprietary (UNLICENSED). MIT code can be vendored as
long as the notice comes with it, so SampleCo and the Juice Shop files are copied verbatim
with their LICENSE files beside them. OWASP Benchmark is GPL-2.0, and copying its test
cases in would put GPL code in this tree. Its `suite.json` therefore commits only the
upstream commit, the selection rule, the selected test ids, and the SHA-256 of each file
and of the answer key. No GPL source or text derived from it is committed. A prep step
fetches exactly those bytes into the gitignored `.cache/` and refuses any file whose hash
differs:

```sh
pnpm --filter @repopulse/security bench:prepare-owasp         # fetch + verify (prep time, needs network)
pnpm --filter @repopulse/security bench:prepare-owasp --pin   # re-select and re-pin (when moving the commit)
```

Its labels come from the upstream `expectedresults-1.2.csv` at prep time, so they are
OWASP's verdicts and not ours. If the prep step has not been run, the suite is reported
as `not-prepared` and contributes no labels.

**Bug-introducing changes.** These follow Signal65's method of replaying the commits
that introduced bugs. Each case is one plausible edit: `before/` is correct code and
`after/` is the same file once the edit has introduced one defect. The scanner should
flag `after/` at the labelled lines and stay quiet on `before/`, so any finding on a
before tree is an FP. The edits were written to look like ordinary refactors:
`exec` destructured from `child_process`, SQL built in a variable,
`Math.random().toString(36).slice(2)`. They were not shaped to match the rules, so
several were misses in the first run. The rule-gap follow-up fixed those rules
afterwards, with its own trigger and clean fixtures; the cases themselves were left
as they were. The cases cover:

- **sast:** 7 cases (SQL ×2, exec, eval, JWT, weak hash, random token)
- **logging:** 3 cases
- **performance:** 2 cases
- **slop:** 6 cases (empty catch, phantom symbol, phantom module, unused export,
  docstring inflation, LDR)
- **secrets:** 1 case

## How to run

```sh
pnpm --filter @repopulse/security bench:prepare-owasp    # once per clone; optional
pnpm --filter @repopulse/security bench                  # writes docs/benchmarks/report.{json,md}
pnpm --filter @repopulse/security bench --check          # exit 1 if the committed report is stale
pnpm --filter @repopulse/security bench --no-yaml        # fast lane only
pnpm --filter @repopulse/security bench --yaml-bin /path/to/opengrep
```

There is no network access at run time. The corpus is on disk, and the engine runs with
`--metrics=off --disable-version-check` (semgrep), with `SEMGREP_ENABLE_VERSION_CHECK=0`
set. Opengrep is used first if it is on `PATH`, because production runs it. The report
records which engine and version produced it. A different engine version is a legitimate
reason for the report to differ, so `--check` is a local guard and not a CI gate.

**Releases.** Re-run `bench` on the release commit and commit the regenerated report with
it. The diff of `docs/benchmarks/report.json` then shows, per outcome, what the release
changed. When a language pack lands (for example W18's Java pack), its rules join the
run automatically, because the runner reads every pack file in the mounted directories.
The OWASP suite starts scoring as soon as a rule reports one of its CWEs.

## Results (2026-10-15, after the rule-gap follow-up)

Engine: semgrep 1.181.0 (local), 26 YAML rules and 20 fast-lane rules. All five suites
were scored. The first-run numbers are kept below for comparison; the corpus and its
labels are the same in both runs, so every difference comes from rule changes.

| Scope | TP | FP | FN | Precision | Recall | First run (P / R) |
|---|--:|--:|--:|--:|--:|--:|
| **All suites** | 61 | 2 | 44 | 96.8% | 58.1% | 87.1% / 51.4% |
| All but OWASP (no Java rules on this branch) | 61 | 2 | 14 | 96.8% | 81.3% | 87.1% / 72.0% |
| Unseen code only (sampleco + juice-shop + changes) | 32 | 2 | 14 | 94.1% | 69.6% | 75.8% / 54.3% |
| `rule-fixtures` (regression floor) | 29 | 0 | 0 | 100% | 100% | 100% / 100% |

| Dimension | TP | FP | FN | Precision | Recall | First run (P / R) |
|---|--:|--:|--:|--:|--:|--:|
| logging | 9 | 2 | 0 | 81.8% | 100% | 81.8% / 100% |
| performance | 13 | 0 | 1 | 100% | 92.9% | 76.5% / 92.9% |
| sast | 21 | 0 | 35 | 100% | 37.5% (21/26 = 80.8% without OWASP) | 100% / 26.8% (57.7%) |
| secrets | 3 | 0 | 0 | 100% | 100% | 100% / 66.7% |
| slop | 15 | 0 | 8 | 100% | 65.2% | 88.2% / 65.2% |

| Suite | TP | FP | FN | Precision | Recall | First run (P / R) |
|---|--:|--:|--:|--:|--:|--:|
| changes | 21 | 1 | 2 | 95.5% | 91.3% | 72.0% / 78.3% |
| juice-shop | 7 | 0 | 4 | 100% | 63.6% | 100% / 54.5% |
| owasp-benchmark | 0 | 0 | 30 | — | 0% | — / 0% |
| rule-fixtures | 29 | 0 | 0 | 100% | 100% | 100% / 100% |
| sampleco | 4 | 1 | 8 | 80.0% | 33.3% | 50.0% / 8.3% |

### Rule-gap follow-up

The first run's "what the numbers say" (below) named five gaps. Each was fixed in the
rule, with a trigger fixture and a near-miss clean fixture under
`packages/security/fixtures/rule-gaps/` (checked by `src/benchmark/rule-gaps.test.ts`
through the same engine wrapper the benchmark uses) or, for secrets, cases in
`secrets.test.ts`. No benchmark label was added, removed or moved.

| Rule | First run TP / FP / FN | Now TP / FP / FN | Precision | Recall | What changed |
|---|---|---|---|---|---|
| `bpm-js-sql-string-concat` | 7 / 0 / 4 | 11 / 0 / 0 | 100% → 100% | 63.6% → 100% | Follows SQL built in a variable before the call, matches chains whose outermost operand is a variable, and adds the sqlite3 verbs (`all`, `run`, `get`, `each`, `prepare`, `execute`). Those new shapes fire only when the string reads as a SQL statement. |
| `bpm-js-child-process-concat` | 1 / 0 / 1 | 2 / 0 / 0 | 100% → 100% | 50% → 100% | Follows `exec` through a `promisify` alias, whether it was destructured, imported or reached through the module object. A bare destructured `exec` was already resolved; the miss was the alias. |
| `bpm-js-math-random-token` | 1 / 0 / 1 | 2 / 0 / 0 | 100% → 100% | 50% → 100% | Matches `Math.random().toString(n).slice(…)` and the same with a timestamp or prefix concatenated. The secret-name gate is unchanged. |
| `stripe-secret-key` (secrets dimension) | 0 / 0 / — (D1 missed) | 1 / 0 / — | — → 100% | secrets 66.7% → 100% | Allows `_` in the key body. An allowlist turns away identifiers that start with the prefix (snake_case, SCREAMING_CASE, camelCase words joined by `_`), and an underscore key stays `unverified` because it is not an issued format. |
| `bpm-perf-await-in-loop` | 3 / 4 / 0 | 3 / 0 / 0 | 42.9% → 100% | 100% → 100% | Retry and backoff exemption, described below. |
| `bpm-ch-try-catch-in-loop` | 1 / 2 / 0 | 1 / 0 / 0 | 33.3% → 100% | 100% → 100% | Same exemption. |

**The retry exemption.** A loop is exempt when it hands the result back on success
(`return` or `break`) *and* one of these holds: it counts attempts against a bound
(`for (…; i < n; …)` or `while (i < n)`) with the work inside a `try`, or it sleeps or
backs off between attempts (`await sleep/delay/backoff…(…)`, or
`await new Promise((r) => setTimeout(…))`). Neither half alone is enough. A counted
loop that returns the first match is a search that could run in parallel, and a loop
that sleeps but never stops early is pacing a batch. The trigger fixture keeps both
rules firing on those two shapes.

The remaining FPs are the two logging findings below, which this follow-up did not
touch. The remaining non-OWASP FNs have no deterministic rule (NoSQL injection, open
redirect, missing authorisation, the SampleCo judgement defects), or are
`bpm-perf-orm-call-in-loop` on `team.js` and `slop.low_logic_density` at 0.31.

### What the numbers said after the first run

The first run's tables are in the git history of this file and of
`docs/benchmarks/report.json`. It scored TP 54 / FP 8 / FN 51 (87.1% / 51.4%). Its
findings, kept as written because they are why the follow-up exists:

- **SAST precision is perfect and its recall is shape-bound.**
  `bpm-js-sql-string-concat` is 7 TP / 4 FN with no FP. It misses SQL built in a
  variable and then passed to the query call (SampleCo D2/D2b, `knex.raw(sql)`), and
  `"..." + x + "..."` chains whose outermost operand is a literal (Juice Shop
  `dbSchemaChallenge_1`). Both need taint mode rather than a call-argument pattern.
  `bpm-js-child-process-concat` misses `exec` that has been destructured from
  `child_process`. `bpm-js-math-random-token` misses `.slice(2)` after `toString(36)`.
  NoSQL injection, open redirect and missing authorisation have no deterministic rule.
- **OWASP Benchmark scores 0 of 30** because this branch has no Java rules. That is a
  coverage fact, not a precision problem, and it is why the table also gives the total
  without OWASP.
- **Performance and slop false positives come from one place: a retry loop.**
  `bpm-perf-await-in-loop` (3 TP / 4 FP) and `bpm-ch-try-catch-in-loop` (1 TP / 2 FP)
  both fire on `for … { try { return await fn() } catch { await sleep } }`, where the
  sequential await and the per-attempt catch are the point. A retry-loop exemption is the
  obvious refinement.
- **`bpm-log-injection` fired on a masked value** (`auth.mask(email)`): it cannot know a
  project's own sanitiser. **`bpm-log-console-in-prod` fired on SampleCo's startup
  banner.**
- **The fast-lane graph checks scored 1/1 each** on the change cases built for them.
  That is too few cases to estimate anything beyond "works on the canonical shape". On
  SampleCo they scored nothing, because SampleCo is CommonJS, which
  `slop.unused_export` and `slop.phantom_*` deliberately do not read (D4, D8).
  **`slop.low_logic_density` missed a padded file at LDR 0.31 against a 0.30 floor.**
- **Secrets:** the generic assignment rule found the planted literal and a real password
  in Juice Shop's login route. It missed SampleCo's fake `sk_live_…` key: the value
  contains underscores, so the Stripe rule's `[A-Za-z0-9]{24,}` does not match. It also
  missed the low-entropy `jwtSecret`.
- **SampleCo is mostly judgement work.** 6 of its 12 planted defects are of kinds no
  deterministic rule claims: duplication, a dead primary path, a stale comment, missing
  authz, and the CommonJS phantom/dead export. Another 3 (two dependency, one type
  safety) belong to scanners outside this benchmark and are skipped. Of the remaining 3,
  the empty catch (D6) is caught, and the secret (D1) and the SQL injection (D2) are
  missed for the reasons given above. Its 8.3% recall is a measure of how much of AI slop
  needs the T2 layer, which is out of scope here.

## Caveats

- **The corpus is small.** It has 151 labels, and most rules have one to three labelled
  cases, so a single label moves a rule's recall by 30–50 points. These numbers are a
  baseline to diff against, not an accuracy claim to quote.
- **Deterministic layers only.** Nothing here says how the T2/T3 layers perform, and the
  combined product will have a different, probably higher, recall on SampleCo-style slop.
- **We wrote most of the labels.** The OWASP verdicts and the Juice Shop right/wrong-fix
  verdicts are upstream's. SampleCo's ledger is upstream's (our own organisation), and the
  additions to it are marked. Everything in `changes` and `rule-fixtures` is ours, and so
  is the adjudication of every finding. `changes` was written by the same people who wrote
  the rules, so it is less independent than it looks. `rule-fixtures` was written
  alongside the rules, so its 100% only shows the rules still match their own fixtures.
- **Snippets are not repositories.** Eight Juice Shop login snippets are truncated
  fragments that no parser accepts, so their YAML-rule labels are skipped. The full
  `routes/login.ts` and `routes/search.ts` are included so that the rule is still
  measured on that code.
- **The follow-up was tuned on this corpus.** The six rules in the rule-gap table were
  changed after their misses and FPs here were read, so their 100% on this corpus is a
  fit, not an estimate. Their trigger and clean fixtures state the general shape, not
  the corpus lines, but the next unseen code is the real test of them.
- **Single-file shapes.** No case requires cross-file data flow, and the fast lane's
  whole-tree checks get only tiny trees. Precision on a real repository will be lower,
  for the reasons the shadow-mode lifecycle exists.
- **Engine differences.** Production runs opengrep inside the scan image, but this run
  used a local semgrep. The packs are written to be compatible with both, and a
  divergence would show up as a report diff when re-run under opengrep. The rule-gap
  follow-up uses a nested `pattern-not-inside` formula and `metavariable-pattern` on a
  loop body; both are in the shared rule schema, but they have only been run under
  semgrep so far.
