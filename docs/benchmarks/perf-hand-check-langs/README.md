# Performance hand-check: Rust, Swift, Kotlin (2026-10-26)

The W21-20 hand-check had no Rust or Swift repository and one Kotlin repository with 7 hits, so the performance rules for these languages had never been measured on real code. This sheet does that for the rules as they ship after this change. Brad marks it; nothing here changes what is live until he does.

**Marking:** fill the `brad` column with `true`, `wrong` or `small` (the same meaning as `../perf-hand-check/SHEET.md`). Each row has a GitHub link to the exact line at the scanned commit. `proposed` and `reason` are Claude's reading of each hit in context.

## Corpus

Shallow clones at these commits, deleted after the scan (public source, measurement only):

| Repository | Commit | Language |
|---|---|---|
| atuinsh/atuin | `d4aa798494dc` | Rust (async, sqlx) |
| lldap/lldap | `99c510a7a603` | Rust (actix, sea-orm) |
| BurntSushi/ripgrep | `6892bc2b7efe` | Rust (sync) |
| wikimedia/wikipedia-ios | `2031b8955e61` | Swift (Core Data) |
| home-assistant/iOS | `9122b55644e2` | Swift |
| kickstarter/ios-oss | `5f5463cfb830` | Swift |
| mihonapp/mihon | `060663475037` | Kotlin (Android) |
| thunderbird/thunderbird-android | `de8a03268415` | Kotlin (Android) |
| android/nowinandroid | `2982e63cb691` | Kotlin (Android) |

Method: semgrep 1.176 with `perf.rust.v1`, `perf.swift.v1` and the Kotlin rules of `perf.java.v1` / `perf.complexity.java.v1`; the product's own exclusions (`DEFAULT_EXCLUDED_GLOBS`, which this change extends with the Rust, Swift and Kotlin test conventions) plus vendored and generated paths. Semgrep's Swift parser partly fails on a share of modern Swift files (407 partial-parse errors on home-assistant/iOS): rules still run on what parses, so Swift coverage is a floor.

## Proposed (92 hits)

| Rule | true | wrong | small |
|---|---|---|---|
| rs-blocking-in-async | 3 | 4 | 13 |
| rs-find-in-loop | 2 | 3 | 8 |
| rs-db-call-in-loop | 2 | 0 | 1 |
| rs-remove-front-in-loop | 0 | 1 | 1 |
| sw-find-in-loop | 6 | 0 | 23 |
| sw-fetch-in-loop | 1 | 1 | 6 |
| sw-remove-front-in-loop | 1 | 0 | 4 |
| kt-find-by-key-in-loop | 1 | 0 | 7 |
| kt-regex-compile-in-loop | 2 | 0 | 0 |
| kt-db-call-in-loop | 0 | 0 | 2 |

No rule would reach the live bar (5 true at 80%) on this corpus: the rules mostly find the right SHAPE on lists that are small by design (servers, categories, CLI one-offs). `sw-find-in-loop` is closest (6 true, 0 wrong). The new Kotlin rules (`kt-blocking-in-suspend`, `kt-formatter-in-loop`) and the Swift regex and formatter rules had no hits at all here: they are untested on real code, not proven clean.

## Fixed before the sheet was drawn

The first scan read every hit, and the forms that were plainly not the defect were fixed in the rules (each with a clean-fixture near-miss):

- Rust test code: `tests.rs`, `*_tests.rs`, `benches/` excluded product-wide, and every Rust perf rule skips `mod tests` and any item under a `#[cfg(test)]`/`#[test]` attribute (the anti-slop pack's TEST REGIONS regex). 30 of atuin's 48 first-scan blocking hits were tests.
- The `for` header, not just the body, was matched (Rust find/db, Swift fetch): the iterable runs once.
- Literal lists and literal-bounded ranges (`for sql in [..]`, `for attempt in 0..10`) are not data-sized.
- A collection owned by the loop's own item (`row.content.iter().any(..)`), a Vec built fresh in the loop body, a `while s.hasPrefix(..) { s.removeFirst() }` trim, and `firstIndex(of: ":")` on a String.

## Left for the marks

- `rs-blocking-in-async`: 4 proposed wrong are blocking calls inside a closure handed to a blocking pool (`pool.run(move || ...)`), which is the fix; the pool's method name is too generic to exclude by form.
- Most "small" rows are a judgement about list size the code does not state.
