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

## Public benchmarks, by CWE (W18-40)

Two public suites are scored in the units their authors publish, next to our own corpus.
The numbers appear in the product's rule precision view with the date they were taken, and
the full tables are in [`benchmarks/report.md`](benchmarks/report.md) under *Public
benchmarks, by CWE*.

| Suite | What | Licence |
|---|---|---|
| `owasp-benchmark` | OWASP Benchmark for Java v1.2: every case of eleven categories (cmdi, crypto, hash, ldapi, pathtraver, securecookie, sqli, trustbound, weakrand, xpathi, xss), with OWASP's own verdict per case | GPL-2.0, fetched and hash-pinned, never committed |
| `juliet-java` | NIST Juliet Java v1.3: a stride sample of up to 150 files for each of fourteen weakness directories (23 and 36 path traversal, 78, 80/81/83, 89, 90, 259, 327, 328, 338 weak PRNG, 601, 643) | public domain, fetched and hash-pinned |

**First measured run (2026-10-16, opengrep 1.27.1, commit a7d15ea).** 2,740 OWASP cases and
3,095 Juliet labels. Across both suites precision was 52.6% and recall 28.9%. Where we were
bad is stated, not hidden: nothing reported CWE 22, 90, 259, 327, 328, 330, 501, 614 or 643
(TPR 0%), and the SQL-injection rules flagged almost every safe OWASP look-alike (CWE 89: TPR
97.4%, FPR 96.1%, Youden 0.013). Commands to reproduce are below.

**After W18-49 (2026-10-16, opengrep 1.27.1, commit bf83839).** Across both suites precision is
76.5% and recall 62.3% (1,584 TP, 487 FP, 960 FN; the Juliet sample is 3,141 labels after the
`antbuild/` scaffolding was excluded, so the counts are not directly comparable to the first
run's). What changed, in order of effect:

1. **Opengrep now runs with `--taint-intrafile`** (scanner and benchmark runner alike), so a value
   passed through a helper method defined in the same file is followed instead of assumed
   tainted. This is the largest false-positive reduction: with the rules otherwise unchanged,
   path traversal's FPR on OWASP went 65% to 33%.
2. **New Java rules** for weak hash (CWE-328), weak cipher (CWE-327), weak random inside a
   request handler (CWE-330), cookie without Secure (CWE-614), LDAP (CWE-90), XPath (CWE-643)
   and session trust boundary (CWE-501), plus broader servlet sources and fully qualified file
   sinks on the existing injection rules. All are shadow candidates written for ordinary Java.
3. **`bpm-java-sql-string-concat` no longer runs inside a servlet request handler**, where
   `bpm-inj-sql-java` reports the site once with data flow. **Cost, stated plainly:** a handler
   that builds SQL from a value that did not come from the request in that method (a value
   read back from the database, the second-order case) is no longer reported by this rule. The
   rule's own metadata records it.

Rows that moved (TP/FN/FP/TN; TPR / FPR / Youden), before = first run's tables, after = this run:

| Suite | CWE | Before | TPR / FPR / Youden | After | TPR / FPR / Youden |
|---|--:|---|---|---|---|
| juliet-java | 79 | 29/260/0/549 | 10.0% / 0.0% / 0.100 | 34/255/0/549 | 11.8% / 0.0% / 0.118 |
| juliet-java | 89 | 74/30/164/228 | 71.2% / 41.8% / 0.294 | 69/35/121/271 | 66.3% / 30.9% / 0.354 |
| juliet-java | 90 | 0/93/0/182 | 0.0% / 0.0% / 0.000 | 13/80/0/182 | 14.0% / 0.0% / 0.140 |
| juliet-java | 327 | 0/34/0/60 | 0.0% / 0.0% / 0.000 | 34/0/0/60 | 100.0% / 0.0% / 1.000 |
| juliet-java | 328 | 0/51/0/90 | 0.0% / 0.0% / 0.000 | 51/0/0/90 | 100.0% / 0.0% / 1.000 |
| juliet-java | 601 | 14/83/0/184 | 14.4% / 0.0% / 0.144 | 16/81/0/184 | 16.5% / 0.0% / 0.165 |
| juliet-java | 643 | 0/92/0/368 | 0.0% / 0.0% / 0.000 | 12/80/0/368 | 13.0% / 0.0% / 0.130 |
| owasp-benchmark | 22 | 0/133/0/135 | 0.0% / 0.0% / 0.000 | 118/15/44/91 | 88.7% / 32.6% / 0.561 |
| owasp-benchmark | 78 | 46/80/52/83 | 36.5% / 38.5% / -0.020 | 64/62/50/83 | 50.8% / 37.6% / 0.132 |
| owasp-benchmark | 79 | 106/140/62/147 | 43.1% / 29.7% / 0.134 | 149/97/60/149 | 60.6% / 28.7% / 0.319 |
| owasp-benchmark | 89 | 265/7/295/12 | 97.4% / 96.1% / 0.013 | 215/57/54/178 | 79.0% / 23.3% / 0.557 |
| owasp-benchmark | 90 | 0/27/0/32 | 0.0% / 0.0% / 0.000 | 24/3/7/25 | 88.9% / 21.9% / 0.670 |
| owasp-benchmark | 327 | 0/130/0/116 | 0.0% / 0.0% / 0.000 | 130/0/0/116 | 100.0% / 0.0% / 1.000 |
| owasp-benchmark | 328 | 0/129/0/107 | 0.0% / 0.0% / 0.000 | 89/40/0/107 | 69.0% / 0.0% / 0.690 |
| owasp-benchmark | 330 | 0/218/0/275 | 0.0% / 0.0% / 0.000 | 218/0/0/275 | 100.0% / 0.0% / 1.000 |
| owasp-benchmark | 501 | 0/83/0/43 | 0.0% / 0.0% / 0.000 | 72/11/20/23 | 86.7% / 46.5% / 0.402 |
| owasp-benchmark | 614 | 0/36/0/31 | 0.0% / 0.0% / 0.000 | 36/0/0/31 | 100.0% / 0.0% / 1.000 |
| owasp-benchmark | 643 | 0/15/0/20 | 0.0% / 0.0% / 0.000 | 14/1/3/17 | 93.3% / 15.0% / 0.783 |

How to read the strong rows honestly:

- **327, 330 and 614 at 100% / 0%** reflect how narrow those benchmark categories are (DES against
  AES, `Random` against `SecureRandom`, `setSecure(false)` against `true`), not a general
  guarantee. The weak-random rule only fires inside a servlet request handler, because a random
  value in a handler is more likely to be a token than jitter is; elsewhere it is silent.
- **328 at 69% on OWASP** is the ceiling for a literal-only rule: the remaining 40 cases take the
  algorithm name from a configuration property with a safe default, so flagging them would be
  guessing. Juliet's 328 and 327 are 100% / 0%.
- **CWE 501 (trust boundary) has a 46.5% FPR** on OWASP: the rule reports the store, and cannot
  see the validation OWASP's safe variants hide behind helper calls it cannot resolve. Weak
  evidence of value; it stays a candidate.
- **A bare `Cipher.getInstance("AES")`** (ECB by default in the JCA) is not reported. Juliet
  counts it as safe, so a rule for it would take Juliet 327's FPR from 0% to 100% while being
  right about real code; it is left as a separate candidate to measure.
- **At the time of W18-49 Juliet had no CWE 22 or 330 rows**: the configured directories did not
  exist in the Java archive (Juliet names path traversal CWE23/CWE36 and weak random CWE338). W18-50
  added them; see the next section. Juliet's CWE 90 and 643 TPR is low
  (14% and 13%) because most of their cases start from `Environment`, `PropertiesFile`, `database`,
  `listen_tcp` or `File` sources, not a servlet request, which these rules do not read.
- **What still scores badly:** CWE 89 on Juliet (TPR 66%, FPR 31%) and CWE 78 (Youden 0.13 on
  OWASP, negative on Juliet). The remaining OWASP false positives are values made constant by
  `switch` on a literal or a constant ternary condition, which needs path-sensitive evaluation
  the OSS engine does not do.
- **The run is load-sensitive.** Opengrep gives up on a file after a per-rule timeout, and on a
  saturated machine that silently drops findings (observed: two runs on identical input gave
  different reports). The numbers above are from a quiet machine, with two consecutive runs
  byte-identical and no engine error beyond the eight juice-shop snippets the parser rejects.
  Re-measure the same way.

**Juliet path traversal and weak PRNG (W18-50, 2026-10-17, opengrep 1.27.1, commit e49421c).** The
sample now includes Juliet's `CWE23_Relative_Path_Traversal` and `CWE36_Absolute_Path_Traversal`
(reported by our rules as CWE 22) and `CWE338_Weak_PRNG` (CWE 330): 3,785 Juliet labels, the existing
ones unchanged (the addition is purely additive, so no other row can move, and none did). The old
configuration named `CWE22_` and `CWE330_` directories that the Java archive does not have.

| Suite | CWE | TP | FN | FP | TN | TPR | FPR | Youden |
|---|--:|--:|--:|--:|--:|--:|--:|--:|
| juliet-java | 22 | 26 | 160 | 0 | 364 | 14.0% | 0.0% | 0.140 |
| juliet-java | 330 | 0 | 34 | 0 | 60 | 0.0% | 0.0% | 0.000 |

Both are low, for reasons that are visible in the data and are not the benchmark's fault:

- **CWE 22 (14%).** All 26 true positives start from a servlet request (`getQueryString_Servlet` 10 of 18,
  `getCookies_Servlet` 10 of 16, `getParameter_Servlet` 6 of 16: 26 of 50 of those cases). None of the 136 cases that start
  from `Environment`, `PropertiesFile`, `Property`, `database`, `listen_tcp`, `connect_tcp`,
  `URLConnection`, `File` or `console_readLine` is found, because the path rule reads servlet request
  data only. The OWASP Benchmark, where every case is a servlet, scores the same rule at 88.7%.
- **CWE 330 (0%).** Juliet's weak-PRNG cases are bare `Math.random()` and `java.util.Random` calls written to
  output, with no servlet and no secret anywhere near them. `bpm-java-weak-random` fires only inside a
  request handler and `bpm-java-insecure-random-token` only in a secret-shaped context, both on purpose
  (a random number in a library method is usually jitter or sampling), so neither fires. Reporting every
  weak-PRNG call would match the benchmark and bury the one that makes a token; that trade was made in W18-49 and
  this row is its measured price on the one suite that counts every use. No rule was changed to improve it.

`bpm-java-insecure-random-token` itself was also fixed in W18-50: its method-name filter sat above the
`Math.random()` alternative, which binds no method name, so that form could never match. It now does, with
fixtures and a golden test for `Math.random()`, `java.lang.Math.random()`, `ThreadLocalRandom` and
`RandomStringUtils` in secret-shaped contexts and jitter/shard near-misses. It moves no benchmark
number: it reports CWE-338, and the public suites' CWE 330 rows count only findings that carry CWE 330.

**Method.** A case is one label with a CWE. A real vulnerability that a rule with that CWE
reports is a true positive; one nothing reports is a false negative. A safe look-alike
that a rule with that CWE reports is a false positive; one that stays quiet is a true
negative. Findings carrying another CWE are ignored, not counted against us, following
OWASP Benchmark's own scoring. Per CWE:

- **TPR** = TP / (TP + FN): the share of real vulnerabilities found.
- **FPR** = FP / (FP + TN): the share of safe look-alikes flagged.
- **Youden** = TPR − FPR: 0 is a coin flip, 1 is perfect, negative is worse than guessing.
  This is the single number the OWASP Benchmark publishes.

Juliet labels are read from the code. In a single-file case a `bad()` method is a defect
and each `good*()` method is a near-miss, at the method's own lines. In the multi-file flow
variants a `_NN_bad.java` class is a whole-file defect, a `_NN_good*.java` class a whole-file
near-miss, and the `_NN_base.java` class has no label. Juliet splits cross-site scripting
over CWE 80, 81 and 83; the labels report them as 79, which is what our rules say.

**Where we score badly is published too.** A weakness class we have no rule for stays in the
table at 0% detected. Our taint rules follow a value through one function (SECURITY_SUITE.md
§3.3), and both suites route data through other files, classes and helper methods, so the
cross-file flow variants are missed by construction. That is a limit of the engine, not a
fault of the corpus, and the table shows its size.

```sh
pnpm --filter @repopulse/security bench:prepare-owasp --pin     # once, or to move the pin (needs network)
pnpm --filter @repopulse/security bench:prepare-juliet --pin
pnpm --filter @repopulse/security bench --date 2026-10-16 --commit <sha>
```

Without the prepare step a suite reports `not-prepared` and contributes nothing; the view
then says that no public benchmark has been run. `--date` and `--commit` are recorded in
the report so a published number says when it was taken; omitting them keeps a rerun
byte-identical.

## Tool adapters: checkov, actionlint, hadolint, shellcheck (W18-48)

These four run only inside the scan image, as `code_health_tools` adapters, so the benchmark reaches
them the way the product does: through `runCodeHealthTools` over a tree, in the sandbox, reading the
adapter findings. The `iac-adapters` suite is our own and is read by this lane alone (the YAML packs and
the fast lane never see it). Without a scan image the lane does not run and its labels are reported
**skipped**, not missed: `pnpm --filter @repopulse/security bench` finds `localhost/repopulse/scan:*`
in podman, or takes `--adapters-image <ref>` or `SCAN_IMAGE`; `--no-adapters` turns it off. It fails
loudly rather than publish a run in which a tool crashed or timed out.

**How the answer key was made.** Each fixture defect is written from the rule's documented definition
and marked `# expect: <rule>` on the line above (or trailing on it); `suite.json` is generated from
those markers and a test keeps them in step. A tool finding with no label is scored a false positive,
but only after being read: where the code really did have the defect (an "all ports" security group
also opens 22 and 3389; `public-read-write` includes read) the finding was added as a label, marked as
such. A `clean` tree of near-misses (port 443 open to the world, `EXPOSE 2200`, `privileged: false`,
quoted and `||`-guarded shell, expressions routed through `env`) must stay silent. A `real` tree holds
this repository's own Dockerfile, `Containerfile.scan` and shell scripts as they were on the day, with
every adapter finding read and judged: a true instance is a finding label, a false positive a `none`
label. Checks whose output the adapters drop on purpose (shellcheck info/style, SC2154; hadolint
info; the checkov checks not on the allowlist) are not labelled, because a miss there is the design.

**Results (2026-10-17, scan image, checkov 3.3.29, actionlint 1.7.12, hadolint 2.15.1, shellcheck 0.11.0).**
117 labelled defects (96 written fixtures, 21 on this repository's files) and 6 judged false positives,
over 87 distinct tool rules: 115 true positives, 7 false positives (6 judged on real files, 1 on the
fixtures), 2 misses (precision 94.3%, recall 98.3%).

| Tool | Tree | Rules | TP | FP | FN | Precision | Recall |
|---|---|--:|--:|--:|--:|--:|--:|
| checkov | fixtures | 38 | 48 | 0 | 1 | 100% | 98.0% |
| actionlint | fixtures | 15 | 14 | 0 | 1 | 100% | 93.3% |
| hadolint | fixtures | 20 | 20 | 0 | 0 | 100% | 100% |
| shellcheck | fixtures | 13 | 12 | 1 | 0 | 92.3% | 100% |
| hadolint | this repository's files | 5 | 17 | 6 | 0 | 73.9% | 100% |
| shellcheck | this repository's files | 4 | 4 | 0 | 0 | 100% | 100% |

(checkov and actionlint found nothing in this repository's real files; its workflows and manifests are
clean.) Per-rule rows, with sample sizes, are in [`benchmarks/report.md`](benchmarks/report.md) under
*Tool adapters*.

**What went wrong, and why it matters.**

- **hadolint `DL3013` (pin pip versions): 2 false positives on real code.** `pip install --no-deps "$wheel"`
  of a sha256-verified wheel is pinned; hadolint cannot see that through the variable. The fixtures had
  an unpinned install and scored it 100%, so the real files found what the synthetic ones could not.
- **hadolint `DL3025` (use JSON form for CMD): 4 false positives on real code.** It fires on
  `HEALTHCHECK ... CMD <shell form>`, which needs the shell for `|| exit 1`; the rule is about the
  container's CMD and ENTRYPOINT. Judged a false positive by the rule's own description.
- **shellcheck `SC1010`: 1 false positive.** `echo done` is flagged because `done` looks like a keyword;
  the line is correct.
- **actionlint `workflow-call`: missed.** A call to a local reusable workflow without its required input
  is reported by actionlint only when it finds a `.git` directory to anchor `./.github/workflows/...`
  against, which a tarball snapshot never has (measured both ways). In the product this check is silent.
- **checkov `CKV_DOCKER_11` (duplicate stage alias): missed.** checkov passes a Dockerfile that repeats
  `AS build`; hadolint's `DL3024` catches it, which is consistent with the dedupe map keeping hadolint's.
  The other three dedupe pairs measure equal (both sides found the defect), so no map entry drops the
  better rule.
- **actionlint's `action` (input check) only runs for actions it has metadata for**, keyed by major tag:
  a workflow pinned `actions/checkout@v4.1.7` (the form hardening guides recommend) got no input check
  while `@v4` did. Not scored, because the fixtures use `@v4` for that case; recorded here because it is a
  gap in what the adapter can see.
- **Cost on very large trees.** checkov reads the whole snapshot. On an infrastructure-only copy of a
  large repository (about 9,000 YAML and shell files) the scan did not finish inside a 15-minute budget.
  The benchmark trees are small; this is not measured further.

**No rule is promoted, and why.** Promotion out of shadow is an admin action in the rule registry on at
least 20 findings, 30 days and under 20% false positives from the workspace's own triage
(`rules/lifecycle.ts`, `PROMOTION_GATE`; the API refuses it otherwise). A labelled corpus can supply the
sample and a precision, never the 30 days or a workspace's dispositions, and here no rule reaches 20 labelled
findings (the most is `DL3018` with 10 and `DL4006` with 8, both from this repository's own files; 69
rules have exactly one; the report shows the shortfall per rule). So all 87 measured rules
stay `candidate`, their numbers shown next to the gate. Writing `active` rows into a registry, or
shipping them as defaults, to put a number to work would bypass the gate; that is a decision, not a side
effect of a benchmark. What the shadow runs on real workspaces will produce is the missing half.

**Not yet run.** checkov's allowlist has 60 checks and 38 have a labelled case; the other 22 are listed in
the report as *not yet run*, which is not the same as zero. hadolint, shellcheck and actionlint have no
fixed list (every code the tool can raise at error or warning level), so everything outside the table is
not yet run.

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

## In the product (W18-22)

The rules screen (`/admin/rules`, "Rule precision") and the finding drawer show
each rule's benchmark precision beside its triage precision. Two separate
numbers, each with its sample size and source, never averaged together.

- **Source.** The API reads a copy bundled at build time,
  `apps/api/src/lib/benchmark-precision.data.ts`, derived from
  `docs/benchmarks/report.json`. The benchmark is never run at request time.
  A drift test (`apps/api/src/lib/benchmark-precision.test.ts`) fails when the
  copy and the committed report disagree. After a new benchmark run, refresh
  the copy with
  `UPDATE_BENCHMARK_BUNDLE=1 npx vitest run apps/api/src/lib/benchmark-precision.test.ts`.
- **Per-rule precision leaves out the `rule-fixtures` suite.** Each rule was
  written against its own fixtures, so it scores 100% there by construction.
  Counting that suite would give the best numbers to the rules with the least
  outside evidence. So the per-rule figures in the product are lower than the
  `byRule` table in the report, and their samples are small (1 to 6 findings
  per rule today). The UI marks any sample under 10 as a small sample.
- **No number where nothing was measured.** A rule outside the corpus, or one
  that raised nothing on it (only misses), reads "not measured yet". It never
  reads 0% or 100%.
- **Engine.** YAML rules carry the report's semgrep version. Fast-lane rules
  are labelled in-process.

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
