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

   *Decisions 1 and 2 taken as recommended on 2026-10-29* (owner: "continue working through
   this, make sure we complete our loops"; standing rule: proceed on the recommended option).
   AI judging is on by default only when every model the triage role routes to is local; a
   hosted link keeps the W19-12 opt-in and the monthly call cap; local models are bounded by a
   per-workspace time budget (wall-clock minutes over a rolling 24 hours, default 240) and a
   per-run cap (default 30 minutes), not by a call count. Built in W22-03, below.
3. **Bundle LGPL rule files unmodified, as separately licensed packs** (GitLab `rules/lgpl`
   from njsscan/mobsfscan: the only real Kotlin and Swift security rule volume). Opengrep
   itself is already LGPL. GPL, AGPL, Commons Clause and non-commercial rules are never
   bundled. *Alternative:* MIT/Apache/BSD only, and write Kotlin/Swift rules ourselves.
4. **Persist a code index of names, line spans, hashes and edges (no code bodies),** like
   the import graph already is. Embeddings (vectors computed from code bodies) are a later,
   separate decision under C1a.

   *Decision 4 taken by the owner on 2026-11-05* ("Yes, names and lines only"). Built in
   W22-01 slice 1, below.

5. **Licences of our own CPU tools.** *Decided by the owner 2026-10-28 ("Lodestone MIT,
   open the rules"):* Lodestone is MIT (bpmforge/lodestone#7), so an open-source RepoPulse
   can depend on it; the bpm-rulepacks rules go MIT (bpm-rulepacks#45) and are imported
   through the W22-07 ledger like any other pack (re-imported MIT at 8448116). Both repos stay private until release day (W22-13).

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

### W22-03 as built (2026-10-29)

- **When.** The worker's after-scan hook (the one that already queues a reprice) calls
  `queueJudgeAfterScan` (`apps/api/src/workers/ai-judge.ts`). It writes an `ai_pass_runs` row
  (mode `judge`, trigger `after_scan`, budget `time` or `calls`) and queues it on the `ai.pass`
  queue, so the judge runs in the worker through the gateway (Law 8), carries the pass's cancel
  check and call counter, and its calls are attributed on the egress audit. One waiting judge
  run per repository covers later scans (own one-active index); judge runs do not block or
  count against a person's pass or the daily pass limit. Nothing is queued, and no row
  written, when there is nothing to judge, AI is off, `AI_JUDGE=off`, or the budget is spent.
- **What.** Open, non-shadow findings a rule raised in `security`, `sast`, `performance` and
  `slop`, with stored code context and no AI verdict, riskiest first, grouped by rule (the rule
  with the riskiest hit first; at most 25 hits of one rule per run so a noisy rule cannot take
  the budget). Each goes to `runTriage` alone, so the budget is checked between findings.
- **Budget.** Every routed triage model local (decision 1): on, bounded by
  `ai_pass_settings.judge_minutes_per_day` (null = `AI_JUDGE_MINUTES_PER_DAY`, 240) over a
  rolling 24 hours, measured as the judge runs' started→finished wall clock, and at most
  `AI_JUDGE_SCAN_MINUTES` (30) per run; these calls are not on the monthly cap (decision 2).
  A hosted link: only for a repository with an enabled AI-pass schedule whose egress
  acknowledgement still matches the routing, never under local-only, and on the monthly cap
  (at most 30 calls a run). Admins set the minutes on `PUT /ai-pass/settings`
  (`judge_minutes_per_day`, 0-1440 or null); a screen for it is W22-11's.
- **Verdict.** Stored in `ai_triage_verdicts` (rationale and our copy of each cited line,
  shown by the existing suggestion panel on the finding, labelled "the open rule hits, judged
  after a scan"), and marked on the finding with `recordVerdicts`: real → `confirmed`,
  likely false positive → `contradicted`, needs a human → stays `unverified` with the reason.
  A reprice is queued when verdicts were written so the ×1.0/×0.7/×0.15 multiplier moves the
  ranking the same day. The status is never touched (DB test).
- **Failures.** A timeout or provider error on one finding is recorded on the run
  (`plan.judge.errors`, samples) and the loop goes on; that finding (and one whose answers the
  checklist rejected) is not retried for 24 hours. Five errors in a row, or local-only refusing
  the route, stop the run with the reason in words.
- **Impact of a real performance hit (2026-10-29).** On outline the judge confirmed two
  copy-on-append hits over small fixed lists (decorator fields per model, editor extensions),
  and fix drafting spent the local model's time on one. A performance hit's prompt now also
  asks for `impact` (`material` / `negligible`: small or bounded input such as a fixed list,
  config or a per-request constant / `unknown`) and a one-line `impact_reason` naming the line
  that shows the size; other dimensions' prompts are unchanged. It is optional (absent → null),
  kept only on `real`, and a `negligible` without a reason is recorded as `unknown`. Stored on
  `ai_triage_verdicts.impact` / `impact_reason` (migration 0062). Negligible stays `confirmed`
  and open; the run counts it as `real_but_negligible` (apart from `confirmed`), W22-09 passes
  it over (`negligible_impact`), and the finding reads "judged real, but small input" — the
  hand-check sheets' `small` mark.

- **Quick first look (2026-10-29).** Measured on outline: about 7 minutes per verdict on a
  local 27B model, so a 30-minute run judged 3 hits while 162 waited, and the W22-07 grading
  sheet put proposed precision near 4% (most rule hits are false positives). A workspace may
  now route the optional role `triage_fast` (Settings → Models → Routing, "Quick first look at
  rule hits (optional, a smaller faster model)"; migration 0063 widens the role check). Not
  routed by default and no env fallback: with no chain the judge is unchanged (same calls,
  same verdicts). With one, each hit goes first to that route through the same `runTriage`
  (same packet and prompt, `role: 'triage_fast'`); a `likely_false_positive` at confidence
  ≥ `AI_JUDGE_FAST_MIN_CONFIDENCE` (default 0.8 of the 1-5 scale, i.e. 4 of 5) is stored and
  the judge moves on. Anything else — real, needs a human, a less confident false positive, an
  answer the checklist rejects, a provider error — goes on to the `triage` route, whose answer
  is the stored verdict. Both passes spend the same run minutes and call cap (the triage call
  is skipped when the fast pass used them up), through the same background gateway. The verdict
  row records `pass` (`fast` / `full`; null on AI-pass rows), the finding's AI review line and
  "verified by" say "on a quick first look" for a fast one, and `plan.judge` counts
  `fast_cleared`, `escalated`, `fast_errors` and the wall clock of each pass (`fast_ms`,
  `full_ms`). The verify mapping is unchanged (contradicted, ×0.15) and no status moves.
  The fast route counts in the judge's egress check and in the pass egress digest only when
  routed, so existing acknowledgements stay valid.
- **Fast-vs-full agreement (W22-14, 2026-10-29).** Live on outline the 8B fast model took
  about 16 s a hit and escalated all 4; the 27B main model called all 4 real. The fast answer
  on an escalation was thrown away, so agreement could not be measured. Now a `full` verdict
  reached after an escalation keeps the fast answer beside it in
  `ai_triage_verdicts.fast_pass` (migration 0064): `{verdict, confidence, reason, model, ms}`,
  `reason` one of `low_confidence` (a likely false positive under the threshold),
  `not_false_positive` (real / needs a human), `rejected` (failed the checklist) or
  `provider_error` (verdict and confidence null for the last two). Null on `fast` rows (a check
  constraint), with no `triage_fast` route, and on AI-pass rows. It never feeds the stored
  verdict, verify_status or the finding's status. `plan.judge.fast_vs_full` tallies the run's
  escalations where both answered, keyed `"<fast>-><full>"` (e.g. `"needs_human->real": 2`).
  Across stored verdicts, `node scripts/judge-agreement.mjs --workspace <id> [--repo <id|org/name>]
  [--json]` (read-only transaction, workspace-filtered) prints the matrix, the agreement rate,
  the escalation reasons with mean fast-pass time, and the precision of a fast "likely false
  positive" by confidence: of escalated hits where the fast model said likely FP below
  `AI_JUDGE_FAST_MIN_CONFIDENCE`, how often the main model agreed. That is the evidence for
  lowering the threshold; hits cleared at or above it are never checked by the main model, so
  their precision is not measured (sample them by hand, or route a run with the threshold at 1).
- **Several hits of one rule per call (W22-14, 2026-10-30).** Live on outline each call was
  about 5 minutes on a local 27B model, much of it reading the same checklist, rule and answer
  shape, so a 30-minute run judged 3–4 hits with 160+ waiting. The judge now puts up to
  `AI_JUDGE_BATCH_SIZE` (default 4, 1–8; 1 = one hit per call, the same calls as before)
  consecutive queue entries of one rule (same scanner, rule and dimension) into one prompt
  (`buildTriageBatchPrompt`, recorded as `checklist_version` `triage.v1+batch`; a hit asked
  alone keeps `triage.v1`). The checklist, the rule and the answer shape are written once;
  each hit keeps its id (`H1`…), flagged lines, numbered file lines and evidence packet,
  prepared exactly as its single-hit call would be (`prepareTriageHit`). `packTriageBatch`
  adds whole hits while the prompt fits the probed window (`contextWindowForRole`); a hit
  that does not fit waits for the next call, and no hit's evidence is cut to make room for
  another. The model answers a JSON array, one object per hit id with the same fields as
  before; each item is checked on its own (`validateTriageAnswer` against that hit's own
  slice and packet lines, so a citation of another hit's lines is `citation_not_found`).
  A missing, doubled or failing item rejects that hit only: there is no batch-level retry,
  and the hit is asked again **alone** (today's single-hit call, with its corrective retry)
  in the same run, next in line, when the run's minutes and calls allow; only that answer
  is final (a rejection then is counted and the hit waits a day, as before). A batched call
  that throws re-asks its hits alone the same way; local-only refusing it stops the run.
  The quick first look batches the same way: per hit a confident false positive stands
  (`pass` `fast`) and the others escalate together to one main-model batch; a hit missing
  from the fast answer escalates with `fast_pass.reason` `rejected`, and `fast_pass.ms` is
  the batch's time divided by its hits. Time and calls are checked between calls: a call
  that would start after the deadline does not start. `plan.judge` adds `batch_size`,
  `batches` (`{pass, hits, rejected, ms}` per call, at most 200) and `batch_retried`. The
  stored verdict, verify_status mapping and finding status are unchanged. Still to measure
  on outline and saleor: verdicts per run at batch size 4, and agreement with one hit per call.

### W22-09: a verified fix never removes error handling (2026-10-30)

- On outline a "verified" fix for `bpm-ch-silent-fallback-return` (DragTarget.ts:130) deleted
  the try/catch around ProseMirror's `view.posAtDOM()`, which throws outside the document: the
  rule stopped firing, nothing new fired, and the function now threw. `verifyPatch` now runs a
  mechanical guard first (`patches/guard.ts`): a patch whose file has fewer error-handler sites
  after than before (catch / except / rescue / `if err != nil` / Rust `?` and `Err(..)` arms /
  Swift `try?` ...) is rejected `removes_error_handling`, and one that adds a force-unwrap
  (`.unwrap()`, `.expect(`, `!!`, `try!`, `as!`, `x!`, Go `panic(`) `adds_force_unwrap`; the
  drafting prompt forbids both, gives fallback-family rules "add handling, keep behaviour", and
  offers `{"no_safe_fix": "..."}` (rejected `no_safe_fix`, not re-asked).

### W22-02 slice 1 (2026-10-29): evidence packets captured at scan time

- **Why.** Live judge run on outline with a local 27B model: 6 verdicts in 31 minutes, all
  "needs a human", each saying the same thing: the ±8-line stored window around
  ``sequelize.query(`... ${this.workingTable} ... LIMIT ${BATCH_SIZE}`)`` did not show that
  `workingTable` is a class field set to a constant string and `BATCH_SIZE` a module constant.
  The snapshot is deleted after the scan (C1a), so the extra context has to be captured then.
- **What.** `attachExcerpts` (every scanner's excerpt hook) now also calls `capturePackets`
  (`packages/security/src/index/capture.ts`) for each finding that got context lines. The
  packet holds: the enclosing function (whole up to 80 lines, else its head plus ±20 lines
  around the hit); where each name on the flagged lines is defined (class field via
  `this.x`/`self.x`, module constant, local, parameter of the enclosing function, callee
  function, and one hop through a relative TS import, a Python `from`/`import`, or a Go
  package inside the module), each as path:line plus the definition line(s); names that
  could not be followed and why (a package or path alias); and the enclosing function's
  callers (8 shown, same file then product code then tests, total counted) with
  `crossFileGraphReliable: false` and `method: 'name-match'`. Capped at 12 KB per packet;
  what capture cut is listed in `omitted`. Lines that look like a credential are dropped
  (same check as the excerpt). Measured on this repository: 1,000 random hits over 1,430
  files in 2.9 s, 1.4 KB average, 4.6 KB largest.
- **Stored** on `findings.context_packet` (jsonb, migration 0061): customer code like
  `context_lines`, so it is set and replaced with it, NULL whenever it is NULL, and cleared by
  the same retention sweep (`insights/findings/context.ts`). The row is workspace-scoped
  already; no index of names/spans/edges is persisted yet (decision 4 is W22-01's).
- **Used.** `triageCandidateOf` reads it back (`parseContextPacket`; unknown shape = none) and
  `runTriage` renders it after the slice inside what the probed window leaves
  (`renderContextPacket`, at most 4,000 tokens): definitions first, then the function, then
  callers with the reliability flag spelled out; whatever does not fit is named under
  "Left out to fit". The model may cite a packet line (with `file` for another file); it is
  checked against and recorded from our copy, as slice lines are. A finding without a packet
  gets byte-for-byte the prompt it got before.
- **Lodestone, and why not yet.** This slice does not depend on Lodestone, and does not
  build an index: it reads the one file a hit is in (plus the files its imports name) on the
  masked text the in-process checks already share (`anti-slop/source-graph.ts`,
  `go-graph.ts`, `rust-graph.ts`), and makes one name-match pass over the snapshot for
  callers. Reasons, checked on Lodestone main 8cc1dff: (1) it is a private GitHub repository
  with no published package and an unbuilt `dist/` (`prepare` runs tsup), so
  `pnpm install --frozen-lockfile` in a Docker build without GitHub credentials cannot fetch
  it, and vendoring means committing a built tarball; (2) its runtime dependencies are
  better-sqlite3 (a native addon: a prebuilt download or a node-gyp toolchain in the worker
  image), sqlite-vec (a per-platform native extension) and the MCP SDK, all for a packet;
  (3) `evidencePacket` needs a `CodeSearchDb` its indexer builds, and (4) even wired, its
  symbol table (`src/symbols/extractor.ts`, a regex tier) records neither class fields nor
  non-exported module constants, Python module constants or Go `const (...)` groups, which are
  exactly the definitions the outline verdicts lacked. **What remains for W22-01/02:** add
  field/constant definitions to Lodestone's tree-sitter symbol table; ship it as a vendored
  tarball or a tagged release (W22-13) built in the worker image; run it in the scan-runner
  and swap it in behind `capturePackets` keeping the `ContextPacket` shape, so callers come
  from its graph (`crossFileGraphReliable` true where its refs are tree-sitter) and callees
  are listed; TS path aliases (tsconfig `paths`, e.g. outline's `@server/...`) followed; the
  route and middleware chain and the Opengrep dataflow trace added; and the before/after
  accuracy on the labelled eval set recorded (needs a live model run).

### W22-06 first slice (2026-10-29): AI false-positive verdicts feed the rule tweaks

- **When.** The weekly `rule_draft_pass` job (one per workspace) runs the dismissal drafter
  and then `runStoredVerdictTweakPass` (`packages/security/src/rules/triage-clusters.ts`) with
  the same workspace gateway, skipped by name when AI is paused or no model is set. One run
  row for both (`combineLearningPasses`): counts add up, errors carry the pass they came from.
- **What.** This workspace's `ai_triage_verdicts` from the last 30 days, newest first opinion
  per finding; verdicts a person dismissed, superseded ones and second opinions are left out.
  `runTriageTweakPass` clusters them (W19-06's guards unchanged) and asks for at most three
  narrower rules, Tier 2, triage role.
- **Nothing promotes or changes a rule.** A draft lands `proposed` with provenance
  `llm_draft:ai_triage`, set by `acceptDraft`, never by the model. It may not take an existing
  id: the source rule, any shipped pack id (read from the rulepack YAML), any registry row in
  the workspace or any rule that has raised a finding there. That matters because a registry
  row re-statuses a shipped rule by id (`effectiveStatus`), so a proposal named after a live
  rule would have put it back in shadow. A collision is counted and nothing is written.
- **Failures.** A timeout or provider error on one call is recorded on the run row and the
  next cluster runs; the pass reads `failed` only when every call failed.
- **Not yet.** Drafting a rule from a confirmed AI-found issue plus similar code (acceptance
  1) waits for the code index (W22-01) and the hunt (W22-04).

Embeddings (pgvector, Qwen3-Embedding-0.6B or CodeRankEmbed) are deliberately not a
ticket yet: the research found graph and fact tools help local models more than vectors,
and vectors need decision 4's follow-up.

### W22-01 slice 1 (2026-11-05): the code map, names and lines only

- **Lodestone, consumed.** Lodestone gained a graph-only entry, `@bpmforge/lodestone/graph`
  (bpmforge/lodestone#10, bd1e554): `extractGraph`, `languageForPath`,
  `isCrossFileGraphReliable`, with no SQLite, sqlite-vec or MCP SDK in its import graph
  (its test walks the graph) and those four as optional peers. RepoPulse vendors the packed
  tarball under `vendor/lodestone/` at that commit, so a Docker build needs no GitHub
  credentials and installs no native addon. It adds web-tree-sitter (MIT) and the
  tree-sitter-wasms grammars (Unlicense), about 50 MB.
- **Built** by `security/index/code-index.ts` in the scan batch, after the scanners, while
  the snapshot exists (`indexTree` hook; an error is logged and never fails the scan). It
  walks the snapshot through `SnapshotReader` (same size, binary and symlink rules as the
  scanners), skips generated files (`.min.js`, `.pb.go`, `_pb2.py`, `.d.ts`, ...) and keeps,
  per file, path, sha256, language and which tier read it; definitions (name, kind, span);
  references grouped per (file, name) and call edges, both only to names the repository
  itself defines; and import edges. No field holds source text; the test asserts it.
- **Stored** in six tables (migration 0068): `code_indexes` (one per repository: commit,
  extractor, counts, `truncated`, build time) and `code_index_files/defs/refs/calls/imports`.
  Every table carries `workspace_id` and leads its indexes with it. A newer commit, or a
  newer Lodestone on the same commit, replaces the map in one transaction (the old rows
  cascade); the same commit by the same Lodestone is skipped. `callersOf` and
  `definitionsOf` read it, workspace-filtered.
- **Measured on this repository** (cloud, 2026-11-05): 1,582 files in about 10 s; 6,908
  definitions; 39.7k reference rows (from 498k raw, most of them names the repository does
  not define); 45k call edges (from 114k).
- **Left for W22-01:** tree-sitter refs and imports for the 8 call-only grammars (so
  `crossFileGraphReliable` can be true for them), Kotlin and Swift grammars (they run on the
  regex tier today), receiver/import-qualified call resolution, the Opengrep fact rules, and
  size and build time on the six walkthrough repos (Mac). W22-02 then reads callers and
  callees from the map instead of name-matching.

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
