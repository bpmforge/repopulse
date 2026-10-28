# Close the loop (W22, planned 2026-10-28)

Owner request (Brad, 2026-10-28): "we need to close the loop". Rules scan the whole
repository; the AI finds what the rules missed and judges whether each rule hit is real
in *this* code; confirmed issues get a verified fix; and the rules learn from the AI's
reviews so the cheap mechanical layer catches more over time. Free MIT/Apache rule sets
should be used where they exist, and the AI needs a better way to search code than
"whole files picked by name".

Inputs, all in `/mnt/project-files/repopulse/review-2026-10-27/`:
`VISION_GAP.md` (what is and is not wired, checked in code at 8964662),
`THIRD_PARTY_RULES.md` (licence-checked rule sets and tools),
`AI_CODE_SEARCH.md` (retrieval research and a three-tier recommendation).

## Where we are (measured on the end-user test install, 2026-10-28)

About 8,300 open findings across six public projects. The AI checked 39 of them, all CVEs.
None of the 580 performance, 492 slop, 110 logging or 36 security-rule findings was ever
AI-checked, and the AI review pass ran zero times: it is off per repository until an admin
enables it, then covers named paths or new pull requests, capped at 30 calls a pass and
300 a month. Learning runs one way only (people's dismissals → narrower rule drafts,
`rules/draft-run.ts`); AI false-positive verdicts never feed it (`runTriageTweakPass` has
no caller) and nothing turns an AI-found issue into a new rule. Triage sees ±25 lines
(`triage/slice.ts` `DEFAULT_RADIUS`). Security rules on the real Rust and Kotlin projects
found nothing, and nothing has measured whether that is clean code or missed issues.

## The loop

```
 snapshot ─▶ code index (symbols, refs, facts) ─────────────┐
    │                                                       │ retrieval
    ▼                                                       ▼
 mechanical rules ──hits──▶ AI judge (every hit, ranked) ─▶ verdict on the finding
 (ours + permissive          │ confirmed                     (confirmed / contradicted,
  third-party packs)         ▼                                feeds risk via verify_status)
    ▲                    verified fix drafted ─▶ rescan proves it
    │                                                        
    │                    AI hunt (ranked files, per-language checklists)
    │                        │ new issue ─▶ second model verifies ─▶ finding
    │                        ▼
    └── shadow rule ◀── rule drafted from the confirmed issue + similar code,
        (measured,        proven on the snapshot (fires on it, not on its fix)
         promoted by
         the existing lifecycle)
```

Unchanged rules: the AI never dismisses, resolves, suppresses or writes to a repository
(D9a); verdicts mark `verify_status`, which already moves the ranking (×1.0 / ×0.7 /
×0.15, RISK_MODEL.md); new rules start shadow and promote on evidence (D11, hand-checked
bar for rules with no public benchmark); every model call goes through the gateway.

## Decisions for the owner (recommended option first)

1. **AI review on by default when every routed model is local.** No code leaves the
   network, so the W19-12 egress acknowledgement has nothing to acknowledge. A hosted link
   in the chain keeps today's opt-in. *Alternative:* keep opt-in everywhere.
2. **Local models are bounded by time, not a monthly call count.** A nightly window per
   workspace (default 4 hours) and a per-scan budget; the 300-call cap stays for hosted
   links. *Alternative:* keep the call cap and raise it.
3. **Bundle LGPL rule files unmodified, as separately licensed packs** (GitLab `rules/lgpl`
   from njsscan/mobsfscan: the only real Kotlin and Swift security rule volume). Opengrep
   itself is already LGPL. GPL, AGPL, Commons Clause and non-commercial rules are never
   bundled. *Alternative:* MIT/Apache/BSD only, and write Kotlin/Swift rules ourselves.
4. **Persist a code index of names, line spans, hashes and edges (no code bodies),** like
   the import graph already is. Embeddings (vectors computed from code bodies) are a later,
   separate decision under C1a.

5. **Decided 2026-10-28 (owner: "Lodestone MIT, open the rules"):** Lodestone, its
   concept ontology and the bpm-rulepacks rules are MIT, so RepoPulse can ship them and
   stay open source. Branches `chore/mit-licence` in both repositories; the 2026-07-28
   decision to keep Lodestone private is reversed.

## Tickets

| Id | What | Depends |
|---|---|---|
| W22-01 | Code index: tree-sitter symbols, references and call edges per snapshot, plus Opengrep "fact" rules (routes, auth middleware, sanitizers, sinks); stored as metadata only | — |
| W22-02 | Context packer for triage: enclosing function, callee bodies, callers, route and middleware chain, Opengrep dataflow trace; replaces the ±25-line slice | 01 |
| W22-03 | AI judges every rule hit on each scan, ranked by risk and grouped by rule, within the time budget; verdict stored on the finding and shown with its evidence; local-by-default switch (decisions 1, 2) | 02 |
| W22-04 | AI hunt by default: a ranked repo map picks files (changed, hotspots, entry points, near confirmed findings), full coverage over a rolling window; per-language checklists for C/C++ memory safety, Rust unsafe/FFI, Swift/Kotlin mobile, Java web; second model verifies | 01, 03 |
| W22-05 | Missing-authorization (IDOR) review: route + auth-middleware facts from 01, a specialist that compares each handler with its neighbours, and mechanical heuristics for Express, Spring, Django/Flask, Rails, Gin, ASP.NET | 01, 04 |
| W22-06 | Learning loop: a confirmed AI-found issue drafts a rule from the issue plus similar code, proven on the snapshot (fires on the issue, not on its fix), stored `proposed` → shadow; wire `runTriageTweakPass` to stored AI verdicts | 03, 04 |
| W22-07 | Import permissive third-party packs with a per-file licence ledger, all shadow-first: 0xdea (C/C++, MIT), GitLab sast-rules MIT/Apache folders (Java, Scala, Python, C#, JS, Go), elttam (Java, MIT), gitleaks rules (MIT); LGPL packs per decision 3 | — |
| W22-08 | Own rules where nothing free exists: Swift and Kotlin injection/taint, Rust unsafe/FFI and injection, Ruby; fix the two noisy web rules (open redirect, SQL by concatenation) to require request data | 07 |
| W22-09 | Fixes ready by default: verified fixes drafted for the top confirmed findings within the budget, listed as "ready to apply" | 03 |
| W22-10 | Measure each stage per language on deliberately vulnerable apps (Juice Shop, WebGoat, Damn Vulnerable C Program, and Swift/Kotlin/Rust samples) plus Juliet: precision and recall for rules alone, + AI judge, + AI hunt; published per release | 03, 04, 07 |
| W22-11 | Findings UX: each finding shows file and line, current code, the AI verdict with its evidence, and the fix as a diff; one list sorted by risk with filters for security, performance and slop | 03, 09 |
| W22-12 | Product site rebuilt KryptKeeper-style (hubs, per-finding pages with diffs, role paths) showing this loop, from W22-10's measured examples | 10, 11 |
| W22-13 | Open-source release: RepoPulse to Apache 2.0 with a NOTICE, history secrets audit of all three repos, and Lodestone and bpm-rulepacks made public **on release day, not before** (owner: "do it with release") | 01, 07 |

Embeddings (pgvector, Qwen3-Embedding-0.6B or CodeRankEmbed) are deliberately not a
ticket yet: the research found graph and fact tools help local models more than vectors,
and vectors need decision 4's follow-up.

## Build on what we own (added 2026-10-28)

The owner asked that our own CPU tools be used and extended rather than rebuilt.

**Lodestone** (`bpmforge/lodestone`, CPU-only, zero model calls) already does most of
W22-01 and W22-02: tree-sitter chunking for 11 languages, a symbol table, a call graph,
references, imports, and `evidencePacket(finding)` which returns the enclosing chunk,
callers and callees, with a `crossFileGraphReliable` flag that says when an empty caller
list is not evidence of anything. Run on gin (107 files) it indexes in 2.7 s: 1,713
symbols, 2,038 references. W22-01 and W22-02 build on it instead of a second indexer.

Measured defects, and their state:

| Defect on gin | State |
|---|---|
| Go/Rust/Java/C/C++/C#/Ruby/PHP calls came from an `identifier(` regex: 1,100 `func` callees, comments, strings, interface declarations | Fixed, `fix/packet-neighbors` a174b02: tree-sitter call sites; 12,216 edges → 9,370, every dropped edge read |
| Markdown examples recorded as callers (1,247 edges; README/CHANGELOG "called" `RunUnix`) | Fixed in the same commit: no graph for prose |
| Calls resolve by name only: `c.Request.Cookie()` is listed as a caller of gin's own `Cookie` | Open (W22-01): receiver/import-qualified resolution where the grammar gives it |
| Refs and imports for those 8 languages still come from the regex tier, so `crossFileGraphReliable` is false | Open (W22-01) |
| No Kotlin or Swift (grammars ship in `tree-sitter-wasms`, not wired) | Open (W22-01) |
| Index lives in SQLite with code bodies; RepoPulse persists metadata only (decision 4) | W22-01 runs Lodestone in the scan-runner on the snapshot and exports names, spans, hashes and edges to Postgres; packets are built from the snapshot at triage time |

**bpm-rulepacks** (232 Opengrep rules, separate from RepoPulse's 479; no rule id in
common). On gin it raised 7 hits, all slop, all read, none real (4 nil-check returns
called "fallback hides failure", 2 in generated `.pb.go`, 1 `Error()` method). It goes
into W22-07 as one more pack under the same bar as third-party packs: graded hit by hit
on the walkthrough repos, shadow first, promoted on evidence.
