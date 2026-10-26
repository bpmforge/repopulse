# Hand-check run: W21-20 performance rules

Follows [docs/work/HAND_CHECK_W21-20.md](../../work/HAND_CHECK_W21-20.md) (main 059b080). Run 2026-10-26 on Brad's Mac. The source was downloaded for measurement only and deleted afterwards; nothing from it is committed except the short excerpts the brief asks for in [SHEET.md](SHEET.md).

## Status

**Marking set chosen by Brad (option B, 2026-10-26):** every hit for a rule with 30 hits or fewer; a seeded random sample of 30 for a larger rule ([sample.json](sample.json): seed 20261026, the method is recorded there). 542 rows across 31 rules, all with a proposed label, in [SHEET.md](SHEET.md) / [sheet.csv](sheet.csv). The bar is judged on those rows from Brad's column only. [proposals-all.csv](proposals-all.csv) keeps Claude's label for every W21-20 hit, sampled or not.

**Marked by Brad, 2026-10-26 14:16 UTC: "accept the proposals"** (no exceptions), recorded as the `brad` column of every row. Recounted from his column: **6 rules clear the bar**: `copy-on-append`, `find-by-key-in-loop` (JS/TS), `includes-in-loop`, `go-nested-range-join`, `java-contains-in-loop`, `membership-in-list-in-loop-py`. **5 go live**: `includes-in-loop` is held in shadow (below). None of the original 27 rules does: `await-in-loop` 50%, `orm-call-in-loop` 29%, `java-db-call-in-loop` 35%, `unbounded-promise-all` 56%, and the rest have fewer than 5 true hits in their rows.

**Sample versus full count, `includes-in-loop`.** Its sample of 30 has 5 true and 0 wrong (100%, passes). Across all 200 of its hits the proposed labels are 48 true and 14 wrong (77%, would not pass): the sample happened to miss every misfire. Under option B the sample alone would have decided; on the full count it is held in shadow until it stops firing on strings and is re-checked (owner-accepted recommendation, 2026-10-26). `find-by-key-in-loop`'s sample (5 true, 0 wrong) agrees with its full count (8 true, 0 wrong).

## Repositories (default branch at run time)

| Repository | Commit | Files scanned | Hits | Excluded as test/vendored/generated | Kept | Parse errors |
|---|---|--:|--:|--:|--:|--:|
| excalidraw/excalidraw (master) | `b7de45e88111` | 587 | 59 | 9 | 50 | 3 |
| outline/outline (main) | `670410b2365a` | 2402 | 504 | 146 | 358 | 1 |
| immich-app/immich (main) | `f7b8ae5da370` | 1103 | 417 | 147 | 270 | 4 |
| saleor/saleor (main) | `1771e1cf6c61` | 2637 | 431 | 253 | 178 | 0 |
| zulip/zulip (main) | `36d23126800f` | 2440 | 639 | 332 | 307 | 0 |
| paperless-ngx/paperless-ngx (dev) | `5f17b1a310aa` | 658 | 97 | 15 | 82 | 1 |
| thingsboard/thingsboard (master) | `7a53801216e1` | 7822 | 301 | 0 | 301 | 0 |
| apache/commons-collections (master) | `892bdc8fa734` | 367 | 0 | 0 | 0 | 0 |
| mihonapp/mihon (main) | `007ec9a868bf` | 931 | 7 | 0 | 7 | 11 |
| prometheus/prometheus (main) | `a83f7158e7f0` | 717 | 28 | 1 | 27 | 5 |
| go-gitea/gitea (main) | `85211296ddcf` | 2322 | 125 | 2 | 123 | 20 |
| traefik/traefik (master) | `f1f227eda7d6` | 694 | 22 | 2 | 20 | 33 |

## Method

- Engine: semgrep 1.176.0 on the host, `--timeout 30 --max-target-bytes 1000000`, every pack in `packages/security/rulepacks/code-health/perf/` at main 059b080. Rules only apply to the languages they declare, so each repo got the rules for its languages.
- Exclusions: the perf scanner's own `DEFAULT_EXCLUDED_GLOBS` (via its `isExcluded`), plus vendored/generated code (`vendor/`, `third_party/`, `node_modules/`, `dist/`, `build/`, `generated/`, Django `migrations/`, `*.min.*`, `*.pb.go`, `*_gen.go`, `*.d.ts`) and test files by NAME the product glob misses (`*_test.go`, `test_*.py`, `*_test.py`, `*Test.java`, `src/test/`, `__tests__/`, `testdata/`, examples, docs, stories).
- One row per (rule, file, line). Labels proposed by reading each hit in context (three labelling passes, then 15 random rows re-read by hand: all 15 matched the code).

## Notes for the marking

- `includes-in-loop`: 10 of its 14 proposed "wrong" are a STRING receiver (`hostname.indexOf(k)`, `html.includes(ns)`), which a pattern cannot tell from an array. 3 are the de-duplication idiom `arr.filter((v, i, a) => a.indexOf(v) === i)`, labelled wrong because there is no second collection, though it IS an O(n²) dedupe; Brad may prefer to count those true (#1467, #1502, #1536).
- Several "small" rows are judgement calls on lists with no enforced bound (widget data keys, saved views, custom fields). The labelling passes flagged them; they are listed in the PR description.

## Product gap found while running

The perf scanner excludes `**/*.test.*` but not Go's `*_test.go` or Python's `test_*.py` / `*_test.py`, so in a real install those test files get performance findings. Not fixed here (out of this brief's scope); worth a ticket.

## What the original rules get wrong (from the labelling passes)

- `orm-call-in-loop` (JS): most misfires are `.update()` / `.get()` that are not database calls (Reflect, lodash, hashers, UI widgets, caches). Matching a method NAME is not enough on real code.
- `await-in-loop`, `java-db-call-in-loop`: deliberate sequential work, mostly cursor/keyset pagination and batched deletes with pauses.
- `regex-compile-in-loop` (JS/Go): the pattern is built from the loop variable, so there is nothing to hoist.
- `go-defer-in-loop`: the defer runs once because the iteration returns or breaks.
- `sync-io-in-async`: startup, init, build and dev-tool code, never a request path.
- String concatenation (JS/Py/Java/Go): a string created fresh each iteration with two or three appends, or a number `+=`.

## Wired

The 6 rules are live on new installs via `packages/security/src/rules/hand-checked.data.ts`, generated from this sheet's `brad` column; `hand-checked.test.ts` fails if the two disagree. Decision and results: `docs/BENCHMARKS.md`, "Hand-checked performance rules live by default (W21-20)".
