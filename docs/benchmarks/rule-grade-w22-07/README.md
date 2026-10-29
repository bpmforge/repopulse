# Imported rules on the walkthrough repos (W22-07)

Every rule Repo Pulse imports through `rulepacks/third-party/LEDGER.json` was run on the six
walkthrough repositories, and every hit outside a test path was counted per rule. A sample of
those hits was read and given a proposed label. This is the evidence W22-07 asks for before any
imported rule can leave shadow.

**Proposed labels are Claude's reading, not the verdict.** The `brad` column in
[sheet.csv](sheet.csv) is empty. Only that column can promote a rule.

## Headline

- **Engine check.** All 629 rules pass `opengrep scan --validate` on opengrep 1.25.0 with 0
  configuration errors: 0xdea 49, elttam 78, GitLab 270, bpm-rulepacks 232.
- **Hits.** 975 hits outside test paths: 674 from bpm-rulepacks, 301 from the 397 third-party
  rules. Another 248 hits were in test paths (207 bpm, 41 third-party) and are not graded.
- **Proposed precision.** 3.9%: 30 true out of 775 sampled hits. bpm-rulepacks had 29 true, the
  third-party rules had 1.
- **Rules that never fired.** 376 of the 397 third-party rules and 185 of the 232 bpm rules had
  no hit at all. On this corpus they are **ungradeable, not clean**: no repo is C/C++ (all 49
  0xdea rules), and none is Java, C# or Scala (most of GitLab's rules).

## What was run

| Repo | Commit |
|---|---|
| tokio-rs/axum | ff653461168d8fd292bce78d9488d1e30cf9cfa0 |
| gin-gonic/gin | 0f09c3a9b4626d9fe9979cf4d0521d6ae32ab646 |
| mastodon/mastodon-ios | d43ae0d6406865a4672e2ced1846ffda8a65d732 |
| android/nowinandroid | 2982e63cb691ad49cd009aab43dc206fee6699c2 |
| outline/outline | 7b3c8fe9f43c3e0cea20754e85a6bfe28661a993 |
| saleor/saleor | c982006cc04c77a97def93218dedac8d715eb041 |

The repos are the walkthrough copies from the local test forge, cloned at depth 1, scanned, and
deleted afterwards.

- **Third-party rules.** The ledger at `ledger:60ad24b9c75e` (main 5bd23e50). The `0xdea`,
  `elttam` and `gitlab` directories were scanned with `opengrep scan --sarif --timeout 30`.
- **bpm-rulepacks.** Scanned from the source repo at bf61d24 with its own `scan.mjs
  --include-tests`. Its rule patterns are identical to the imported f32aebf: the only
  difference is a licence metadata line in each file.

## How hits were chosen and labelled

- **Test paths.** A hit is in a test path when its file matches `scan.mjs`'s TEST_PATH_RE,
  plus `_test.go`, `test_*.py` and Swift/Kotlin/Java `*Tests`. Those hits are counted but
  not sampled.
- **Ids.** Live hits are sorted by source, repo, file, line and rule, and numbered from 1. These
  are the ids in both CSVs.
- **Sample.** This is owner choice B from the perf hand-check: every hit for a rule with 30 or
  fewer hits; for a larger rule, a Fisher-Yates shuffle of its ids (ascending), drawn with
  mulberry32(seed ^ javaHash(rule)), taking the first 30. **The seed is 20261028**, not the perf
  sheet's 20261026.
- **Labels.** Only `true` and `wrong`. These are security and slop rules, so the perf sheet's
  `small` does not apply. Each label was given after reading the code around the hit: the
  whole catch body, the source of the href, where the path came from, and so on.

[hits-all.csv](hits-all.csv) lists every live hit with a `sampled` flag.

## Not covered by this sheet

- **Test-path hits.** 248 hits, listed above.
- **Saleor's `.semgrep/` rule fixtures.** These are saleor's tests of its own Semgrep rules,
  and TEST_PATH_RE missed them. All 23 `python_requests_rule-request-without-timeout` hits
  are there, labelled wrong in the sheet. The scanner needs to exclude that path (see
  dispositions).
- **Rules with no hits.** 561 rules, listed above.

## Per rule (proposed)

| Rule | Source | Live hits | Sampled | true | wrong | Precision |
|---|---|--:|--:|--:|--:|--:|
| `bpm-slop-try-catch-in-loop-python` | bpm | 97 | 30 | 0 | 30 | 0% |
| `bpm-house-catch-discards-error` | bpm | 59 | 30 | 0 | 30 | 0% |
| `bpm-slop-delegation-only-wrapper-rust` | bpm | 51 | 30 | 0 | 30 | 0% |
| `prisma-ormleak-taint-where` | imported | 49 | 30 | 0 | 30 | 0% |
| `bpm-owasp-a07-hardcoded-secret-python` | bpm | 48 | 30 | 0 | 30 | 0% |
| `javascript_pathtraversal_rule-non-literal-fs-filename` | imported | 46 | 30 | 0 | 30 | 0% |
| `bpm-slop-empty-catch` | bpm | 42 | 30 | 0 | 30 | 0% |
| `javascript_dos_rule-non-literal-regexp` | imported | 36 | 30 | 0 | 30 | 0% |
| `bpm-house-async-effect-no-cleanup` | bpm | 35 | 30 | 2 | 28 | 7% |
| `bpm-slop-try-catch-in-loop` | bpm | 34 | 30 | 0 | 30 | 0% |
| `prisma-orm-operator-injection` | imported | 33 | 30 | 0 | 30 | 0% |
| `bpm-slop-fallback-hides-failure-python` | bpm | 23 | 23 | 0 | 23 | 0% |
| `python_requests_rule-request-without-timeout` | imported | 23 | 23 | 0 | 23 | 0% |
| `bpm-framework-react-unsafe-href` | bpm | 22 | 22 | 4 | 18 | 18% |
| `bpm-slop-empty-catch-swift` | bpm | 19 | 19 | 10 | 9 | 53% |
| `bpm-secret-generic-assignment` | bpm | 18 | 18 | 0 | 18 | 0% |
| `python_assert_rule-assert-used` | imported | 18 | 18 | 1 | 17 | 6% |
| `bpm-slop-emoji-in-comments-rust` | bpm | 16 | 16 | 0 | 16 | 0% |
| `bpm-slop-unimplemented-stub-throw-python` | bpm | 16 | 16 | 1 | 15 | 6% |
| `python_random_rule-random` | imported | 16 | 16 | 0 | 16 | 0% |
| `django-orm-dynamic-orderby-or-values` | imported | 16 | 16 | 0 | 16 | 0% |
| `bpm-slop-fallback-hides-failure-swift` | bpm | 15 | 15 | 0 | 15 | 0% |
| `prisma-ormleak-taint-projection` | imported | 15 | 15 | 0 | 15 | 0% |
| `bpm-house-unbounded-response-read` | bpm | 14 | 14 | 1 | 13 | 7% |
| `bpm-slop-redundant-null-undefined-check` | bpm | 13 | 13 | 0 | 13 | 0% |
| `bpm-slop-unimplemented-stub-throw-rust` | bpm | 12 | 12 | 0 | 12 | 0% |
| `bpm-owasp-a03-sql-string-concat` | bpm | 12 | 12 | 0 | 12 | 0% |
| `bpm-house-regexp-constructed-in-loop` | bpm | 12 | 12 | 2 | 10 | 17% |
| `bpm-owasp-a03-xss-dangerously-set-innerhtml` | bpm | 11 | 11 | 0 | 11 | 0% |
| `bpm-framework-react-target-blank-noopener` | bpm | 11 | 11 | 0 | 11 | 0% |
| `bpm-slop-try-parse-fallback` | bpm | 11 | 11 | 0 | 11 | 0% |
| `javascript_react_rule-dangerouslysetinnerhtml` | imported | 11 | 11 | 0 | 11 | 0% |
| `django-orm-dynamic-lookup-kwargs` | imported | 11 | 11 | 0 | 11 | 0% |
| `bpm-framework-react-dangerous-html` | bpm | 10 | 10 | 0 | 10 | 0% |
| `bpm-house-timing-unsafe-secret-comparison` | bpm | 10 | 10 | 0 | 10 | 0% |
| `django-orm-dynamic-lookup-variable-key` | imported | 10 | 10 | 0 | 10 | 0% |
| `bpm-slop-fallback-hides-failure` | bpm | 9 | 9 | 0 | 9 | 0% |
| `bpm-slop-delegation-only-wrapper-python` | bpm | 9 | 9 | 0 | 9 | 0% |
| `bpm-slop-step-by-step-narration` | bpm | 8 | 8 | 5 | 3 | 63% |
| `bpm-slop-try-catch-in-loop-swift` | bpm | 6 | 6 | 0 | 6 | 0% |
| `bpm-house-regexp-from-unescaped-interpolation` | bpm | 5 | 5 | 0 | 5 | 0% |
| `javascript_require_rule-non-literal-require` | imported | 5 | 5 | 0 | 5 | 0% |
| `bpm-slop-fallback-hides-failure-go` | bpm | 4 | 4 | 0 | 4 | 0% |
| `bpm-owasp-a02-tls-verify-disabled-ts` | bpm | 4 | 4 | 4 | 0 | 100% |
| `struts-xml-action-name` | imported | 4 | 4 | 0 | 4 | 0% |
| `bpm-owasp-a02-weak-hash` | bpm | 3 | 3 | 0 | 3 | 0% |
| `bpm-owasp-a01-cors-wildcard` | bpm | 3 | 3 | 0 | 3 | 0% |
| `bpm-owasp-a03-command-injection-exec` | bpm | 2 | 2 | 0 | 2 | 0% |
| `bpm-slop-unimplemented-stub-throw` | bpm | 2 | 2 | 0 | 2 | 0% |
| `bpm-owasp-a06-known-vulnerable-package` | bpm | 2 | 2 | 0 | 2 | 0% |
| `bpm-slop-hardcoded-env-fallback-python` | bpm | 2 | 2 | 0 | 2 | 0% |
| `python_crypto_rule-hash-md5` | imported | 2 | 2 | 0 | 2 | 0% |
| `bpm-slop-delegation-only-wrapper-go` | bpm | 1 | 1 | 0 | 1 | 0% |
| `bpm-slop-prose-padding-fake-specificity` | bpm | 1 | 1 | 0 | 1 | 0% |
| `bpm-secret-pem-private-key` | bpm | 1 | 1 | 0 | 1 | 0% |
| `bpm-owasp-a07-cookie-insecure-flag` | bpm | 1 | 1 | 0 | 1 | 0% |
| `json-marshaler-pointer-receiver` | imported | 1 | 1 | 0 | 1 | 0% |
| `go_http_rule-http-serve` | imported | 1 | 1 | 0 | 1 | 0% |
| `beego-ormleak-dynamic-expr-review` | imported | 1 | 1 | 0 | 1 | 0% |
| `javascript_timing_rule-possible-timing-attacks` | imported | 1 | 1 | 0 | 1 | 0% |
| `python_tmpdir_rule-hardcodedtmp` | imported | 1 | 1 | 0 | 1 | 0% |
| `python_urlopen_rule-urllib-urlopen` | imported | 1 | 1 | 0 | 1 | 0% |

## Observations about the scanned code (not filed anywhere)

These are the "true" rows, recorded for the sheet only. Nothing was reported upstream.

- **outline.** TLS certificate checks are off for production Postgres, every `rediss://`
  connection, and SMTP when SMTP_SECURE is off (4 hits).
- **outline.** The editor's mention views render `attrs.href` without the `sanitizeUrl` that
  `Mention.ts` applies to the same attribute in `toDOM` (4 hits). Whether this is
  exploitable was not checked.
- **outline.** Webhook delivery reads a customer endpoint's whole response before slicing it.
- **mastodon-ios.** User actions (follow, mute, block, settings) fail silently behind
  `// TODO: handle error` catches (10 hits).
- **saleor.** User-supplied IDs are validated with `assert`, which `python -O` strips.
