# Hand-check run: W21-20 performance rules

Follows [docs/work/HAND_CHECK_W21-20.md](../../work/HAND_CHECK_W21-20.md) (main 059b080). Run 2026-10-26 on Brad's Mac. The source was downloaded for measurement only and deleted afterwards; nothing from it is committed except the short excerpts the brief asks for in [SHEET.md](SHEET.md).

## Status

- **W21-20 complexity rules: 396 hits, all with a proposed label.** Waiting for Brad's marks in SHEET.md / sheet.csv. Proposed result: 5 of 13 rules clear the bar (≥5 true, ≥80% precision); `includes-in-loop` misses at 77%, 8 rules have fewer than 5 true hits. These are proposals; the recount uses Brad's column only.
- **The original 27 perf rules: 1327 hits, not yet on the sheet.** The brief scopes them in, but at that volume Brad is choosing between marking every hit and marking a seeded random sample of 30 per large rule (asked 2026-10-26). Counts below.

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

## Original perf rules (pending Brad's choice)

| Rule | Hits |
|---|--:|
| `bpm-perf-await-in-loop` | 412 |
| `bpm-perf-orm-call-in-loop-py` | 304 |
| `bpm-perf-string-concat-in-loop` | 144 |
| `bpm-perf-unbounded-promise-all` | 125 |
| `bpm-perf-string-concat-in-loop-py` | 101 |
| `bpm-perf-orm-call-in-loop` | 61 |
| `bpm-perf-java-db-call-in-loop` | 44 |
| `bpm-perf-go-string-concat-in-loop` | 38 |
| `bpm-perf-java-string-concat-in-loop` | 25 |
| `bpm-perf-regex-compile-in-loop` | 19 |
| `bpm-perf-go-defer-in-loop` | 15 |
| `bpm-perf-sync-io-in-async` | 12 |
| `bpm-perf-go-db-call-in-loop` | 8 |
| `bpm-perf-go-regex-compile-in-loop` | 7 |
| `bpm-perf-json-deep-clone` | 6 |
| `bpm-perf-await-in-loop-py` | 4 |
| `bpm-perf-unbounded-gather-py` | 1 |
| `bpm-perf-java-regex-compile-in-loop` | 1 |
