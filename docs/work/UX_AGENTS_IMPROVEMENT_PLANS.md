# RepoPulse — Journey UX Review, Micro-Agent Architecture & Improvement Plans (2026-07-14)

Companion to `DESIGN_REVIEW.md`. Three questions from Brad:
(A) does the UX hold up when walked as a *process* per persona, (B) how do we port the
bpm-opencode-experts micro-agent/loop architecture into RepoPulse's analysis engine,
(C) how do reports become *improvement plans* — and what makes all of it look modern.

Sections B/C/D incorporate the experts-repo architecture mining and online research
(sources cited inline). Recommendations carry IDs (R-A/B/C/D-n) with effort tags
(S/M/L) and wave placement; anything conflicting with a NON_GOAL says so explicitly.

---

## A. Process-level UX review (journeys, not screens)

The screen specs (UX_SPEC §4) are strong. Walking them as *processes* exposes gaps
between screens — the moments where a user has nothing to do, no reason to return,
or no path from number to action.

### A1. First-run has a dead zone (minute 1 → hour 1)

The flow: login → (admin) connect → watch backfill. Honest progress is designed
(E3.6) — but there is nothing to *do*, and a member who logs in before data exists
hits "Ask an admin to connect" and leaves.

- **R-A1 (M, W4)** — Onboarding checklist card on Org Overview until dismissed.
  Admin variant: connect org ✓ → review bot list (W4-09) → assign roles → pick
  starter views → generate first report. Member variant: choose your focus →
  guided drill-down tour on the first synced repo. Checklist state in
  `workspaces.settings` / user prefs — no new tables.
- **R-A2 (S, W4)** — **Persona picker at first login.** UX §6 promises role-routed
  homes (P1→Org, P2→My Focus, P3→Findings, P4→Exec view) but nothing in the design
  actually *knows* a user's persona — admin/member roles don't map to P1–P4. One
  "What best describes you?" step (changeable in the user menu) stores
  `users.persona` and powers default home + starter-view suggestions. Without
  this, UX §6's routing is unimplementable.
- **R-A3 (S, W4)** — First-insight moment: recent-first backfill means the 30d
  window fills early; when a repo's 30d coverage completes, toast "last 30 days
  ready for repo-X — take a look" (sync phase per entity is already tracked;
  this is one SSE event + one banner rule).

### A2. The daily loop has no pull (P2)

My Focus is the right home, but nothing *brings* the developer back: no badge, no
delta, and N-4 (correctly) forbids email/Slack in v1.

- **R-A4 (S, W4/W5)** — Rail badge counts: review-queue count on "Pull Requests",
  new-findings count on "Findings" (per-user, since lastSeenAt — the zustand
  `lastSeenAt` infra already exists for the attention feed).
- **R-A5 (S, W5)** — My Focus gets its own "since your last visit" strip (new
  review requests, PRs that advanced/stalled, findings on my PRs).
- **R-A6 (L, v2 — requires brief amendment of N-4)** — Weekly digest to
  email/Slack is the single strongest retention loop in every competitor
  (see §C research). Keep it deferred, but design the digest *content* now as the
  in-app "Weekly Pulse" (R-A7) so the outbound channel later is a delivery detail,
  not a redesign.

### A3. The weekly ritual needs a narrative, not just a feed (P1)

The attention feed lists changes; a lead preparing standup/retro wants the *story*.

- **R-A7 (M, W6)** — **Weekly Pulse**: an auto-generated 5-bullet narrative per
  repo group ("cycle time rose 18% — driver was first-review wait on repo-b;
  hotspot src/ingest/budgeter.ts gained 3 contributors; 2 merges bypassed
  review → list"). Deterministic template over warehouse deltas first; T2 polish
  pass optional (same gateway, `initiator: 'narrative'`). Rendered as a pinned
  card on Org Overview and as the opening section of every report (§C).

### A4. Numbers → action is a dead end today (all personas)

Every number is a door to *evidence* (UX §1.3) — but no surface answers
"so what do we do?". This is the product's biggest UX gap and the subject of §C:
**Improvement Plans** become the fourth pillar (dashboard → report → plan → track).

### A5. Findings triage: add a queue mode (P3, W6)

Explorer bulk-ops are designed; what's missing is flow. **R-A8 (M, W6)**: a
full-screen triage stepper ("12 new findings") — j/k advance, one-key
confirm/dismiss/escalate, evidence inline, exit summary ("dismissed 4 as FP —
checklist v3 candidate"). Feeds the same FP-rate metric. Modeled on the
REAL/FP/UNVERIFIED triage discipline from bpm-opencode-experts semgrep-runner.

### A6. Reports are documents; consumption needs three verbs (P3/P4, W5/W7)

Immutability + audit framing are excellent. Add:
- **R-A9 (M, W5.5)** — Report **diff view**: open two reports of the same type/scope
  → per-section deltas ("review coverage 71%→84%"). The determinism pin
  (snapshotAt) makes this trivially computable from stored ReportData JSON.
- **R-A10 (S, W5)** — **Scheduled generation**: monthly/quarterly auto-generate via
  BullMQ repeatables into the same in-app history (no delivery channel — N-4
  safe). "Reports that make themselves" was a P4 north-star.
- **R-A11 (S, W7)** — Report **annotations**: a free-text "context" block the
  generator writes at creation (stored in params, rendered on the cover) so the
  exported PDF can say *why* it was generated ("Q2 board pack").

### A7. Verdict on the existing screens

No changes needed to: drill-down spine, URL-as-state, WidgetFrame state machine,
skeleton-first, honest sync states, saved-views engine, ⌘K, density modes,
"signals not grades" framing. These are all validated by the §D research as
current best practice. The gaps above are *between* screens, not in them.

---

## B. Micro-agent & loop architecture — porting bpm-opencode-experts into the product

Source: architecture mining of `~/Code/bpm-opencode-experts` (agents/shared/MICRO_LOOP.md,
RALPH_WIGGUM_LOOP.md, GATE_SCORING_PROTOCOL.md, FIX_VERIFY_LOOP.md, CHALLENGER_PROTOCOL.md,
agents/security/attack-chainer.md, agents/code-review/code-health-synthesizer.md,
skills/review/SKILL.md). The expert system's thesis — **micro-agents in macro-loops,
every loop bounded, coverage owned by the macro loop, correctness owned by the micro
loop** — translates directly into BullMQ job graphs over the existing analysis gateway.
The interactive parts (HANDOFF paste, fresh sessions) become jobs; the discipline
(hard caps, maker≠verifier, objective coverage validators) ports unchanged.

### B1. Pattern → product mapping

| Experts pattern (mechanic) | RepoPulse equivalent | Status |
|---|---|---|
| Coordinator dispatches specialists in **conditional waves**, each in a fresh context, returning only artifact-path + count | W8 scanner registry + trigger matrix already IS this (dispatch by registry metadata, owasp_llm gated on SBOM). Extend the same shape to T2 PR review: 4 dimension passes = wave 1 (parallel chunks), verify = wave 2, synthesize = wave 3 | designed (W8) / extend (W6.5) |
| **Micro-loop**: CRITERION → PRODUCE → SELF-VERIFY → REVISE, hard cap 2, no-progress kill | Every gateway call already has a criterion (zod schema + evidence-substring check) and a bounded retry (malformed → retry once → DLQ). Formalize: the retry prompt appends the validator error — that IS the revise step | designed (FR-ANALYSIS-5) |
| **Maker ≠ verifier** — scores must come from a different model with "re-ran independently" evidence | We have two LAN hosts (M5 Max `.48`, M2 Max `.114`) — natural maker/verifier split. **Verify pass** (new): each finding re-judged by the *other* host with a refute-first prompt; verdict CONFIRMED / CONTRADICTED / UNVERIFIABLE stored on the finding | **new — R-B1** |
| **Asymmetric confidence gate**: <5 auto-fail, 5–6 revise (≤3×), ≥7 pass; verdict only when all passes ≥7 | Findings ledger: confidence <3 (of 5) ⇒ hidden-by-default (R-4 mitigation already); verify-pass CONTRADICTED ⇒ auto-dismiss with reason `challenger_refuted`, never shown | **new — R-B1** |
| **Challenger gate**: triggers on HIGH/CRITICAL only, gathers refuting evidence, cap 4 calls/claim | **Product challenger**: any severity ≥4 finding, verified secret, or chain gets ONE adversarial "try to refute; cite the diff" pass before it may hit the org banner / Security-tab top. Bounded: 1 call, sev≥4 only. Directly attacks RISKS R-4 (FP erosion of trust) | **new — R-B2** |
| **Ralph Wiggum loop-until-dry**: INVENTORY → DISCOVER → VERIFY (objective validator) → GAP-fill only flagged rows → cap 3, no-progress halt (gap set identical ⇒ stop) | **Deep Repo Audit mode** (post-W8): inventory = warehouse-derived units (top-N hotspots, entry-point files, manifests, auth-touching files); DISCOVER = one T2 run per unit; VERIFY = SQL coverage check (every inventory row has a run + schema-valid findings); GAP = re-run flagged rows only. Caps/exit codes map to scan_run statuses (`done`, `iterate`, `cap_exhausted`, `no_progress`) | **new — R-B5 (v2)** |
| **Synthesizers consume file artifacts, never conversation**; run LAST; escalate compound risk | RepoPulse equivalent of "files" is the findings store — already the design (attack chainer reads priorFindings). Add the code-health twin: **compound-risk detector** — same file/module flagged by ≥3 distinct dimensions/scanners ⇒ `compound` finding at max(member)+1. Pure SQL, no LLM, runs with the chainer | **new — R-B3** |
| **FIX_BACKLOG with a verify criterion per item** (grep/test/threshold that proves the fix) | The core of §C: every improvement-plan item carries a **machine-checkable verify criterion over warehouse data** — and because RepoPulse ingests continuously, it can auto-verify plan items (something session-based expert systems can't do) | **new — R-C1** |
| **Error memory is highest-ROI**; FP dismissals feed tuning; loop-exhaustion lessons captured | Already half-designed: `analysis_false_positive_rate{dimension,model,checklist_version}` is the tuning signal. Add per-repo suppression memory: a dismissal with reason `false_positive` on an unchanged dedup_key is never re-surfaced (occurrence bump only) — the product's "memory_store" | designed + **R-B4 (S)** |
| **Delegation log** (who ran what, verdict, evidence) | `analysis_runs` + `scan_runs` already are it; add `pass_kind` + `parent_run_id` so find/verify/challenge/synthesize passes chain auditable | **R-B1 schema delta** |

### B2. Concrete design delta (small, additive — no rearchitecture)

1. **R-B1 (M, W6.5)** — Verify pass: `analysis_runs.pass_kind
   enum('find','verify','challenge','synthesize','narrate','plan')` + `parent_run_id`.
   Scheduler rule: after a PR's find-passes complete, enqueue one verify job per
   finding with severity ≥3, pinned to the *other* LAN host (host affinity in
   T2Config). Verdict column on findings: `verify_status
   enum('unverified','confirmed','contradicted') default 'unverified'`.
   Explorer facet + "verified by second model" badge in the UI.
2. **R-B2 (S, W6.5)** — Challenger gate as a dispatch rule (not a new engine):
   severity ≥4 ⇒ challenge job before surfacing; CONTRADICTED ⇒
   `dismissed(challenger_refuted)` + admin-visible; CONFIRMED ⇒ eligible for
   banner. One call, hard cap.
3. **R-B3 (S, W8)** — Compound-risk detector rides the chainer job: SQL group-by
   (file/module × distinct dimension count ≥3) ⇒ `compound` finding, severity
   max(member)+1 cap 5, auto-resolve when a member resolves (same rails as chains).
4. **R-B4 (S, W6)** — FP-suppression memory: dismissed-FP dedup_keys never
   re-surface while the evidence is unchanged (one WHERE clause on the upsert path).
5. **R-B5 (L, v2)** — Deep Repo Audit (loop-until-dry) as a manual "audit this repo"
   button; ships after W8 since it composes scanners + T2 + the coverage validator.
   Positioning note: this deliberately overlaps NON_GOALS N-8 (ThreatForge-style
   deep audits) — frame it as "attention-routing depth", or amend N-8 when it lands.

The loop-discipline rules port verbatim and should be quoted in the W6.5 design doc:
**hard caps (2 micro / 3 macro), no-progress halt (identical output set ⇒ stop),
refuse-to-loop when the criterion isn't machine-checkable, maker ≠ verifier.**

---

## C. Reports → Improvement Plans (research-backed design)

Web research summary (sources per claim; full citations at the end of this section):
every serious competitor now closes the metrics→action loop with one or more of five
mechanics — and one obvious gap is unclaimed.

| Mechanic | Who does it | Rules or AI? |
|---|---|---|
| Period narrative + next-period recommendations, pushed to Slack | LinearB "AI iteration summary" | AI narrative over rule-derived stats |
| **Working agreements**: numeric threshold + the actual exception list ("the 6 PRs that broke it in 2 weeks") + daily digest | Swarmia | pure rules, socially enforced |
| **Goals bound to artifacts** (this file/hotspot: refactor / supervise / no-problem) with time-aware "no improvement in N months" warnings, CI-gateable | CodeScene augmented analysis | rules over code-health deltas |
| Recommendation cards with evidence attached, accept/dismiss, playbooks, chat-with-your-data | DX AI, Amplitude agents, Datadog Watchdog | AI investigation → human accepts |
| Finding → proposed fix → PR | Sentry Seer, LinearB gitStream | AI, human-merged |

**The whitespace: a ranked, persistent improvement backlog with tracked progress
("you fixed 3 of 7; cycle time −12% since the plan was created") barely exists
anywhere.** And RepoPulse has a structural advantage no session-based tool has:
continuous ingestion means plan items can be **auto-verified from warehouse data** —
the FIX_BACKLOG "verify criterion" pattern from bpm-opencode-experts
(FIX_VERIFY_LOOP.md), running itself nightly.

### C1. The Improvement Plans pillar (proposed scope addition — needs a brief amendment, see C4)

**Concept**: a plan is a generated, evidence-linked, ranked set of actions for a repo
set + window, born from a report or on demand, tracked until done — team-scoped,
never person-scoped (NON_GOALS N-9 holds).

**Generation is rules-first, LLM-second** (the research's clearest convergence, and
the only trustworthy option for self-hosted Tier-1-only installs):
1. **Recommendation catalog** (deterministic, versioned like the metric catalog):
   condition over warehouse data → recommendation template + verify criterion.
   Seed catalog: review coverage < target ⇒ review SLA + reviewer-load rebalance
   (evidence: M6 offender list, reviewer matrix) · first-review p90 > Xh ⇒ WIP/
   review-window agreement · bus factor 1 ∩ top-10 hotspot ⇒ pairing/doc action
   (CodeScene-style artifact goal) · stale-PR count ⇒ triage ritual · flakiness
   top workflow ⇒ quarantine/fix action · CFR > ramp ⇒ deploy-window review ·
   open sev≥4 findings cluster / KEV / chain ⇒ remediation item (links straight
   into Findings Explorer) · compound-risk module (R-B3) ⇒ refactor item.
2. **T2 narration pass** (`pass_kind='plan'`, W6+): orders ties, writes the
   one-paragraph "why now" per item, drafts the plan summary — **never invents
   items**; the catalog is the source of truth (anti-hallucination by construction).
3. **Verify criterion per item, machine-checkable**: `{metric_key, op, target,
   window}` or `{finding_ids ⊆ resolved}` — evaluated by a nightly job off the
   existing snapshots; items flip to `done` (or **`regressed`**) automatically.

**Data model (additive)**: `improvement_plans(id, workspace_id, repo_ids, window,
created_from_report_id null, catalog_version, status, created_by, created_at)` +
`plan_items(id, plan_id, workspace_id, rank, source enum('metric','finding','chain',
'compound','agreement'), evidence jsonb (metric keys / finding ids / PR ids),
recommendation text, effort enum('S','M','L'), status enum('proposed','accepted',
'in_progress','done','regressed','dismissed'), verify_criterion jsonb,
verified_at, status_changed_by/at)` — same lifecycle/audit rails as findings.

**Surfaces**: Plans page (rail item) with progress bars per plan; plan section
closing every report ("open items + movement since last report"); Org Overview
tile ("plan: 3/7 done ▲"); accept/dismiss per item (DX card pattern).

### C2. Working agreements (the Swarmia mechanic, rules-only, cheap)

**R-C2 (M, W5.5)** — `agreements(workspace_id, repo_ids, kind, threshold, active)`
over existing metrics: max PR size, review-within-Nh, no-merge-without-review,
stale ceiling, CI pass floor. Each renders threshold + **the exception list**
(the actual offending PRs, last 14d) + a trend chip — artifacts to discuss, not a
score to game (the anti-Goodhart pattern, consistent with N-9/R-5). In-app daily
digest card; outbound Slack/email stays v2 behind the N-4 amendment (A2/R-A6).
Agreement violations are also a plan-item source (`source='agreement'`).

### C3. Artifact-bound goals (the CodeScene mechanic)

**R-C3 (M, W6.5)** — intents on hotspots/files: `refactor` (warn if hotspot score
hasn't improved in N months — snapshots make this one query), `supervise` (alert on
any decline), `acknowledged` (suppress from leaderboards). Lives on the file
drill-down + hotspot list. Pairs naturally with compound-risk findings (R-B3).

### C4. Sequencing + governance

- **W5.5 (rules-only, no LLM needed)**: plans engine + catalog v1 + agreements +
  plan section in reports. This is buildable straight after W5 and delivers the
  headline differentiator early.
- **W6+**: T2 narration, Weekly Pulse (R-A7), triage queue (R-A8).
- **W6.5**: verify/challenger passes (R-B1/2), artifact goals (R-C3).
- **v2**: deep audit loop (R-B5), chat-with-your-metrics panel (research: now
  category table-stakes; scope a v1 to "ask about this repo's trends" over the
  metric catalog + snapshots only), Slack/email digests (N-4 amendment).
- **Governance**: Improvement Plans is a genuine scope addition (new pillar), not a
  ticket — it needs a **brief amendment (proposed D9)** adding S-4x scope items and
  an E11 epic before any plan.json reflow. This doc is the input to that decision.

Sources: linearb.io/blog/ai-powered-iteration-summaries · docs.gitstream.cm ·
help.swarmia.com/features/working-agreements.md · getdx.com/ai-recommendations ·
codescene.io/docs/guides/technical/augmented-analysis.html · sleuth.io/metrics ·
graphite.com/features/insights · amplitude.com/ai-agents ·
docs.datadoghq.com/watchdog · docs.github.com (Copilot metrics GA 2026-02).

---

## D. Modern visual direction — validation + deltas

Research verdict first: **UX_SPEC §1–2 is already the 2026 target aesthetic.**
Dark-first with elevated surfaces, borders-over-shadows (`shadow-sm` max), one
accent, severity-only color, ⌘K-first nav, skeleton-first loading, density modes —
all match the Geist/Linear direction the research identifies as the category
reference (vercel.com/geist; shadcn/Radix as the component base — which we pinned).
Do not restyle; apply these deltas:

- **R-D1 (S, W4)** — Numerals: use `font-variant-numeric: tabular-nums` on **Inter**
  for all metric columns and KPI values; reserve JetBrains Mono for SHAs, paths,
  and code evidence only. (UX_SPEC §2.1 currently sets KPI values in mono —
  research: tabular-nums on the UI face reads better in dense tables; mono stays
  for identifiers.) One-line token change.
- **R-D2 (S, W4)** — Bento composition on Org Overview: allow 1–2 hero tiles
  (2×2: health-tile grid, attention/Weekly-Pulse card) among 1×1 KPIs on the
  existing 12-col WidgetGrid — sizing variety is what makes a grid read "bento"
  rather than "spreadsheet". Zero engine work (layout w/h already per-widget).
- **R-D3 (S, W6)** — The AI surface is part of looking modern: the Weekly Pulse
  narrative card (R-A7) and "explain this finding" (R-A8) are visible
  intelligence; style them as a distinct quiet-accent card family (sparkle-free —
  no gradient "AI shimmer"; a labeled `T2 · local` provenance chip instead, which
  doubles as the privacy story).
- **R-D4 (S, W5)** — PDF cover polish: the audit-pack framing (REPORTS §5) is the
  credibility content; add the visual layer — light theme, generous cover
  whitespace, tabular numerals, per-section method footnotes already designed.
  Keep charts SVG (already decided) for print crispness.
- **R-D5 (—)** — Explicitly rejected: glassmorphism/translucency layers (contrast
  risk vs WCAG 2.2 AA gate), gradient AI branding, 3D/decorative charts (UX §2.3
  already bans chart-junk), OLED pure-black (elevated surfaces are the research
  recommendation and already our token model).

---

## E. Consolidated recommendation index

| ID | What | Effort | Wave | Needs brief amendment? |
|---|---|---|---|---|
| R-A1 onboarding checklist · R-A2 persona picker · R-A3 first-insight toast · R-A4 rail badges | first-run + daily pull | S–M | W4/W5 | no |
| R-A5 My-Focus deltas · R-A7 Weekly Pulse · R-A8 triage queue | rituals | S–M | W5/W6 | no |
| R-A9 report diff · R-A10 scheduled reports · R-A11 annotations | report consumption | S–M | W5–W7 | no |
| R-B1 verify pass (maker≠verifier) · R-B2 challenger gate · R-B3 compound risk · R-B4 FP suppression | analysis quality loops | S–M | W6–W8 | no |
| R-B5 deep repo audit (loop-until-dry) | audit mode | L | v2 | N-8 framing |
| **R-C1 Improvement Plans engine + catalog** · R-C2 agreements · R-C3 artifact goals | metrics→action pillar | M–L | W5.5–W6.5 | **yes — D9 + S-4x + E11** |
| R-A6 Slack/email digests · chat-with-metrics | outbound + copilot | L | v2 | N-4 amendment |
| R-D1..D4 visual deltas | modern polish | S | W4–W6 | no |

Suggested immediate actions: fold R-A2 + R-D1 + R-D2 into existing W4 tickets'
acceptance at reflow; draft the D9 brief amendment for Improvement Plans; leave
everything else as the post-MVP backlog this doc records.
