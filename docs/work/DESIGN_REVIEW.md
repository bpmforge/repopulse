# RepoPulse — Full Design Review (2026-07-14)

Whole-system review of the design package (all docs + plan.json) from four angles:
(1) modularity/coherence, (2) customer POV per persona with step-by-step journeys,
(3) customization surfaces (connections, LLM, tools), (4) licensing. Ends with the
gap register (G-x) and the launch runbook for cheap coding agents.

**Verdict: the design is launch-ready after the pre-flight fix pack in this commit.**
The architecture is genuinely modular (port/adapter forge, CQRS-lite warehouse,
registry-driven scanners), the traceability chain (D→S→FR→story→ticket→doc) is real,
and the docs are written at the density cheap agents need (worked examples, exact
enums, canonical JSON shapes). The gaps found were: 5 cross-doc contradictions that
would have burned the first W0/W1/W6 agents, 5 missing tickets (including the
wave-0 human prerequisite), one missing product surface (workspace settings UI),
one persona-need mismatch (P3 custom audit windows), and licensing constraints on
3 dependencies (Redis, TruffleHog, semgrep rules) that matter mostly at the SaaS flip.

---

## 1. Modularity assessment — PASS

| Property | Evidence | Verdict |
|---|---|---|
| Module boundaries machine-enforced | ARCHITECTURE §3 matrix → ESLint no-restricted-imports + `validate-arch.sh` rules 1–5 | ✅ enforced, not aspirational |
| Forge swap-ability | `ForgeProvider` + `ForgeCapabilities` flags; metrics branch on capability, never provider name; one contract suite for both adapters | ✅ Gitea lands without core changes |
| Analysis swap-ability | One `AnalysisGateway` owns all LLM egress; T2 is any OpenAI-compatible endpoint (baseURL); checklists are versioned assets | ✅ (see §4 for the config gap) |
| Scanner extensibility | `Scanner` interface + static registry; framework never branches on keys; backlog scanners = registry entry + rulepack + fixture | ✅ the W8 framework is the product |
| Read/write separation | Ingest writes facts; metrics writes snapshots; API reads warehouse only (nock guard + static check) | ✅ NFR-3 is structurally guaranteed |
| Tenancy | `workspace_id` everywhere + per-commit tenancy suite + RLS-ready | ✅ SaaS flip is config, not migration |
| Failure isolation | Per-queue workers; LLM down ⇒ park + banner; scanner crash ⇒ never blocks ingest (NFR-7/15) | ✅ |

Weak points (all fixed or ticketed in this commit): the `auth` module's location
contradicted between docs and plan (G-2); the worker process had no defined home
(G-9); the `security` package is absent from the dependency matrix until W8 —
acceptable, but `validate-arch.sh` must gain a security rule at the W8 gate
(noted in G-16).

---

## 2. Customer POV — step-by-step journeys per persona

Every step cites the FR/ticket that delivers it. **[GAP G-x]** marks where the
journey previously broke; all blockers are fixed/ticketed in this commit.

### 2.1 P1 Engineering Lead — day 0 (setup) through weekly use

**Day 0 — stand it up (admin hat):**
1. Ops registers the GitHub App (read-only permissions per SC-25) + localhost dev
   OAuth app — human prerequisite, C5. **[GAP G-1 — no ticket existed; added W0-05]**
2. Log in with GitHub (E1.1, FR-AUTH-1/2). First user auto-joins `default`
   workspace; promote to admin.
3. Admin → Connections: paste App installation (or PAT — UI warns on over-scoped
   tokens, SC-25), pick repos or "all + auto-add new" (E1.2, FR-INGEST-1).
4. Watch the backfill: org banner + per-repo % by phase; most-active repos land
   first; budget pauses show as `paused_budget`, never as breakage (E1.3, FR-INGEST-8).
5. **Tune workspace settings**: bot list (default `*[bot]`, `dependabot*`, …),
   stale-PR threshold N, health-score weights, budget share. The API existed
   (`PATCH /admin/workspace`) but **no UI ticket did — [GAP G-4; added W4-09
   Settings tab]**. Without this, P1 can't correct bot misattribution or tune the
   score — the two most likely first-week complaints.
6. Next morning: nightly reconciliation has healed any missed webhooks (E1.5);
   snapshots exist, so trend deltas appear from day 2.

**Weekly use:**
1. Open Org Overview: 5 KPI tiles + health-tile grid + attention feed ("since last
   visit: repo-d CI ↓, 3 merged w/o review") (E3.1, UX §4.a).
2. Click any bad number → evidence (UX law: every number is a door): org cycle-time
   ▲ → Repo → PR Flow tab → reviewer-load matrix → the individual over-loaded
   reviewer's PR list (E3.2).
3. Save the team slice as a view ("Save as view…" captures URL filters + widgets,
   E4.1); pin "Review flow" and "Hotspot map" starter templates (UX §6).
4. Before retro: generate Repo Health report; history keeps every prior one
   comparable (E5.1/5.2).

### 2.2 P2 Developer — daily

1. Log in → lands on My Focus (role-routed home, UX §6): my open PRs with
   stage/time-in-stage, my review queue oldest-first with over-SLA amber, hotspots
   I own (E3.5, FR-WEB-7, via the D6 identity link).
2. ⌘K → jump to any repo/PR without the mouse (E3.4).
3. On my PR page: stage timeline vs repo median, size/risk badges, checks; from W6
   also Tier-2 findings with verbatim evidence quotes (E6.2).
4. Identity edge case: commits authored with a secondary email (no GitHub login
   attached) won't map to me. Identities design supports admin merge
   (`merged_into_id`) but **no UI ticket existed — [GAP G-10; added W5-05]**;
   also spec note for W2 (G-17): warehouse an email-keyed identity row as fallback
   so churn/ownership never silently drops those commits.

### 2.3 P3 Security Engineer — MVP through W8

1. MVP: "Security posture" saved view — merged-without-review offenders (E2.2),
   sensitive-path activity via hotspot/file drill-down, CI check health. In-app
   expectation-setting: Findings Explorer ships as a teaser explaining Tier-2/3
   (UX §4.e states) — good honesty design.
2. W5: PDF export — every report is a self-defending audit pack (cover, basis box,
   sync-lag flags, metric-definitions appendix) (REPORTS §5). This is the single
   best P3 feature in the design.
3. W6/W7: findings triage with lifecycle + FP-rate widget; egress audit log
   answers "what exactly left the LAN to Claude" (E7.2, NFR-9).
4. W8: secrets ≤60s post-push, SBOM/CVE/KEV/slopsquat daily, semgrep weekly,
   OWASP checklists, attack chains — all in ONE findings store with one triage
   flow. Framework quality is high (sandbox, shred, budgets).
5. **[GAP G-11 — open]**: P3's "Audit window" persona need is an *arbitrary date
   range* ("our audit period is Mar 3–Jun 2"), but reports only accept
   window ∈ {7,30,90,365}d + pinned end. Recommended v1.x extension (see G-11);
   not a launch blocker because 90d+`windowEnd` covers quarterly audits.

### 2.4 P4 EM/Exec — quarterly

1. "Exec rollup" starter view: DORA tiles + 12-month trends, org-level only
   (N-9: no per-developer rankings anywhere — enforced by design, not policy).
2. Every DORA number carries its heuristic basis label and MTTR honestly renders
   "needs incident data" (M12) — this is what makes the numbers defensible.
3. Quarter-end: generate Org Exec Summary + Delivery/DORA reports; regenerate with
   same scope next quarter for artifact-to-artifact comparison (E5.3/5.4,
   FR-REPORTS-7). Share the view URL in the wiki (E4.2).

---

## 3. Customization surfaces — what a customer can change, and where

### 3.1 Forge connections
| Knob | Where | Status |
|---|---|---|
| Auth mode (GitHub App / PAT) | connect flow, per connection | ✅ designed (FR-FORGE-5) |
| Repo selection / auto-add / pause / remove+purge | Admin → Connections | ✅ (FR-INGEST-1/9) |
| Rate-budget share, floor | workspace settings | ✅ schema; UI via W4-09 |
| Second forge (Gitea, self-hosted base URL) | connect flow forge-type | ✅ v1.x (W7-02), SSRF allowlist pre-built (SC-12) |
| GitHub Enterprise Server | — | ❌ not scoped. Cheap later: GHES = GitHubProvider + configurable base URL through the same SC-12 allowlist path. Recommend as v2 backlog note, not v1. |

### 3.2 LLM integration
| Knob | Where | Status |
|---|---|---|
| T2 host list + per-host concurrency | workspace settings (`LMSTUDIO_BASE_URLS` env + workspace config) | ✅ designed |
| T2 model | `modelSlot` per host in T2Config | ⚠️ config exists, no admin surface — fold into W4-09 Settings (analysis section appears W6) |
| Any OpenAI-compatible backend (Ollama, vLLM, LiteLLM) | baseURL override | ✅ works by construction; **recommendation:** treat "LM Studio" as the reference backend, keep crash-string matching (`model crashed`) as a pluggable quirk list, and rename env to `T2_BASE_URLS` before W6 so the abstraction is honest |
| T3 opt-in per repo + per-PR, monthly USD cap, escalation rules | Admin → Analysis (W7-01) | ✅ designed, audited |
| T3 model/provider | pinned to Claude API (D2) | by decision; the gateway interface is provider-shaped, so a future `t3Provider` config is additive |
| Dimension checklists | versioned repo assets | ⚠️ not workspace-customizable in v1 — fine (versioning/golden-prompt tests need controlled assets); note as v2: workspace checklist overrides with the same version-stamping |

### 3.3 Tools / scanners (W8)
| Knob | Where | Status |
|---|---|---|
| Per-repo enable/disable per scanner, workspace defaults | `repo_scanner_config`, admin-only | ✅ (FR-SEC-11) |
| Per-scanner budgets (wall-clock, CPU/mem, forge quota, LLM tokens) | same | ✅ |
| Custom semgrep rule packs (git URL + ref) | workspace config, host-side db-sync | ✅ (FR-SEC-6) |
| Custom secrets rules | versioned rulepack asset | ✅ format-compatible rulepacks drop in (see licensing §5 for the format choice) |
| New scanner types | registry entry + module | ✅ zero framework changes (FR-SEC-1 acceptance) |

---

## 4. Licensing review

Verified against my knowledge through early 2026; items marked VERIFY should be
re-checked against the license file at implementation time (Law 2 discipline).

| Component | License | Constraint | Action |
|---|---|---|---|
| **Redis 7.4+** | RSALv2 / SSPLv1 dual (7.2 was BSD-3; 8.x added AGPLv3 option) | Internal use: fine. SaaS flip: RSAL/SSPL terms are aimed at offering Redis itself as a service (we don't), but the licensing overhang is real | **Pin `redis:7.2`** (last BSD release) in compose now, or use **Valkey** (BSD-3, drop-in, BullMQ-compatible — VERIFY BullMQ+Valkey at W0-02). Recorded as the default in G-18. |
| **TruffleHog** | AGPL-3.0 | We never run or vendor the tool — design correctly says "TruffleHog-compatible **rule format**" only. Copying its detector regex corpus wholesale could be argued derivative | Write our own engine (designed); source rule content from **gitleaks (MIT)** patterns or write our own; keep "compatible format" as a format spec, not a code import. W8-04 acceptance already only names the format. |
| **semgrep** | Engine LGPL-2.1 (subprocess use = fine). **Registry/community rules: Semgrep Rules License v1.0 — prohibits use in products that compete with Semgrep** | Internal RepoPulse: fine. RepoPulse-as-SaaS running registry rules: likely violates | v1/internal: proceed. Pre-SaaS: switch full runs to **Opengrep** (2025 LGPL fork) or restrict to permissively-licensed packs + our custom pack repo (already a first-class config). Documented as a SaaS-flip prerequisite alongside the THREAT_MODEL residual list. |
| syft / grype | Apache-2.0 | none | — |
| OSV / GitHub Advisory data | CC-BY 4.0 | attribution when redistributed | Add one attribution line to the Security Posture report footer (W8-11). |
| CISA KEV | US-gov public data | free use; VERIFY current notice | — |
| **LM Studio** | Proprietary freeware; free for work/commercial use per 2025 announcement (VERIFY terms at W6) | No redistribution (it runs on separate LAN hosts — we never ship it) | Keep the OpenAI-compat abstraction so Ollama (MIT)/vLLM (Apache-2.0) are drop-ins if terms change. |
| Anthropic API | Commercial ToS; API data not used for training by default | Sending monitored-org code requires org sign-off | Already designed: per-repo opt-in + egress audit (NFR-9) is the compliance story. |
| k6 | AGPL-3.0 | Dev/CI tool only — AGPL doesn't touch our code | fine |
| Fastify, BullMQ, zod, Octokit, TanStack, shadcn/ui (vendored), Tailwind, Drizzle, vitest | MIT / Apache-2.0 | none | — |
| ECharts, Playwright | Apache-2.0 | none | — |
| Inter, JetBrains Mono | OFL-1.1 | embedding in PDFs fine | — |
| GitHub API ToS | — | Own-org analytics: fine. SaaS: each tenant connects their own credentials (already the design) — the compliant pattern | — |
| RepoPulse itself | undecided | — | Internal/proprietary for now; because AGPL components are kept at arm's length (no AGPL code linked), all future options stay open. Decide before any public release. |

---

## 5. Gap register

Severity: **B** blocker (agents/product break), **H** high, **M** medium, **L** low.
Status: `fixed` = corrected in this commit; `ticketed` = added to plan.json;
`open` = recommendation, decision needed.

| ID | Sev | Gap | Resolution | Status |
|---|---|---|---|---|
| G-1 | B | CONSTRAINTS C5 mandates a wave-0 GitHub App/OAuth registration ticket; none existed. W0-04 fixture recording and the W4 demo both need it. | Added **W0-05** (human-in-loop ticket); W0-04 now depends on it. | ticketed |
| G-2 | B | `auth` module location contradiction: ARCHITECTURE/TECH_STACK said "inside apps/api"; plan.json W0-01/W1-03/W1-04/W2-01/W4-01 all write `packages/auth/**`. First scaffold agent would have had to guess. | Canonical: **`packages/auth`** (matches all 5 tickets). TECH_STACK layout + ARCHITECTURE §3 table/matrix updated; auth imports `shared` only; forge invokes the vault's decrypt (SC-1 intact). | fixed |
| G-3 | H | SECURITY_CONTROLS SC-7 (CSRF header), SC-11 (rate limits), SC-22 (audit log), SC-23 (helmet/CSP) all say "lands W1 · api plugin" but no ticket carried them. Controls without a ticket don't exist. | Added **W1-08** API hardening ticket carrying all four + their verification tests. | ticketed |
| G-4 | H | Workspace settings (score weights, bot list, stale-N, budget share — all load-bearing for metric trust) had schema + `PATCH /admin/workspace` in API_DESIGN but no implementing ticket and no UI tab (UX §4.i lists only Connections/Sync/Analysis/Members). | Added **W4-09** Settings API + admin Settings tab. | ticketed |
| G-5 | H | Findings contract contradictions that would hit every W6/W8 agent: severity (`enum words` vs `int 1–5`), confidence (`0–1 numeric` vs `int 1–5`), dedup key (normalized-title vs evidence-quote hash), lifecycle (`acknowledged` vs `confirmed/dismissed`). W8 severity math (`max(member)+1`, "floor 4") requires numeric. | Canonicalized in DATABASE.md: severity/confidence **smallint 1–5** (labels are presentation), dedup key per ANALYSIS_TIERS §5, lifecycle **open → confirmed \| dismissed(reason) → resolved \| wont_fix** (UI "acknowledge" = confirmed). | fixed |
| G-6 | H | API_DESIGN §2 catalog missing ~9 endpoints that UX_SPEC/DASHBOARD/tickets reference: `/org/summary`, `/org/health-tiles`, `/org/attention`, `/repos/{id}/pr-flow|ci|trends`, `/me/review-queue|hotspots|stats`, `/findings/stats`. "Copy shapes exactly" fails without them. | Added to API_DESIGN §2. | fixed |
| G-7 | M | DATABASE.md lacked `webhook_delivery` + `job_failure` (required by INGESTION §4/§6 and ticket W1-01) and named the ETag store `api_cache` while FORGE_PROVIDER + W1-01 say `forge_etag`. | Tables added; canonical name **`forge_etag`** with FORGE_PROVIDER §3 columns; ARCHITECTURE ADR-1 reference updated. | fixed |
| G-8 | M | No ticket owned the Playwright e2e harness (config, mocked-OAuth boundary, `pnpm seed` warehouse seeder) that every W4 screen ticket assumes; W4 gate also requires axe before the W7-04 wiring existed. | Added **W4-00** harness ticket incl. axe smoke. | ticketed |
| G-9 | M | Worker deployable undefined: ARCHITECTURE C2 shows a third process, DEPLOYMENT builds `repopulse-worker`, TECH_STACK listed only apps/api+web, W2-02 writes `apps/api/src/workers/**`. | Decision recorded in TECH_STACK: workers live in `apps/api/src/workers/**` with a separate entrypoint (`start:worker`); the worker image runs that entrypoint. No new workspace package. | fixed |
| G-10 | M | Identity merge + bot flagging designed in DATABASE.md (merged_into_id, is_bot) and audited by SC-22, but no ticket/screen. Misattributed identities corrupt ownership/bus-factor trust. | Added **W5-05** identity admin UI ticket. | ticketed |
| G-11 | M | P3 "Audit window" needs arbitrary date ranges; reports accept only enum windows (+ pinned end). Global UI filters already support `${iso}..${iso}` custom ranges — reports don't. | Recommendation (v1.x, after W5): extend `ReportParams` with optional `windowStart` (evidence lists read facts directly; snapshot-backed trend sections render nearest enum window with a basis note). Not a launch blocker. | open |
| G-12 | L | W0-03 CI ticket didn't carry SC-18/SC-19 (gitleaks scan, `.npmrc` ignore-scripts, `pnpm audit`). | Acceptance amended. | fixed |
| G-13 | L | Research §6 flags GraphQL `PullRequestChangedFile.patch` as UNVERIFIED with "confirm in W0" — no ticket carried it. | W0-04 acceptance amended. | fixed |
| G-14 | L | Report status enum drift: `rendering` (DATABASE) vs `generating` (REPORTS) vs `running` (API/UX). | Canonical **`running`**; both docs fixed. | fixed |
| G-15 | L | ARCHITECTURE §3 matrix lacks `auth` row (fixed with G-2) and will lack `security` until W8. | auth row added; note added that the W8 gate must extend the matrix + validate-arch with the security package rules (scanners: shared+forge-types+analysis-gateway only). | fixed/noted |
| G-16 | L | Email-only commits (`authorLogin: null`) have no specified identity attribution; `identities` is keyed on forge_login. Silently dropping them skews churn/ownership. | Spec note added to DATABASE.md identities: fallback identity rows keyed `email:{addr}` (provider-scoped), mergeable via W5-05 UI. Implement in W2-03. | fixed (spec) |
| G-17 | L | LM-Studio-specific env naming (`LMSTUDIO_BASE_URLS`) undersells the OpenAI-compat abstraction; crash-string list is backend-specific. | Recommendation: rename to `T2_BASE_URLS` + pluggable quirk list at W6-01. Cosmetic; deferred to the W6 ticket notes. | open |
| G-18 | M | Licensing: Redis ≥7.4 (RSAL/SSPL), TruffleHog (AGPL — format only, never code), semgrep registry rules (no-compete clause ⇒ SaaS constraint), OSV/GHSA attribution in reports. | §4 table is the record. Concrete now: pin `redis:7.2` or Valkey in W0-02 (acceptance amended); keep gitleaks-format-or-own for secrets rules; semgrep→Opengrep is a SaaS-flip prerequisite. | fixed (W0-02) / documented |

Also verified — no action needed: NFR-2 budget math holds (research §8: ~250 REST
+ 20 GraphQL pts/repo ⇒ 20 repos/hr); webhook<10s + redelivery + reconciliation
triangle is sound; SSE-over-polling decision is right for the idle-dashboard
profile; PDF byte-stability approach (render stored JSON, mocked clock, embedded
fonts) is credible; threat model coverage map has no orphan threats.

## 6. Launch runbook — coding with cheap models, step by step

The board is the plan; this is the operating procedure around it.

1. **Human, once (~1h):** execute W0-05 — register the GitHub App (read-only
   perms per SC-25) + localhost dev app, create the scratch fixture repo, fill
   `.env` from `.env.example`. Nothing else in W0–W3 needs a human.
2. **Launch order = `plan.json` claim order.** Cheap agents follow
   `MASTER_PROMPT.md`: lowest-id claimable ticket, one at a time. Waves gate on
   ROADMAP exit criteria recorded in STATUS.md. Parallelism is safe only where
   `write_scope`s are disjoint AND deps are done — within-wave safe pairs:
   W1-03/W1-05, W3-02..W3-09 (after W3-01), W4-03..W4-08 (after W4-00/01/02),
   W8-04..W8-08 (after W8-01..03). Max 3 parallel (house rule).
3. **Model sizing per ticket type:** scaffolding/CRUD/screens (W0, W4 screens,
   W5-01) → cheapest tier; budgeter/chunker/metric math/snapshot service
   (W1-05, W2-03, W3-10, W6-02, W8-03) → mid tier with the design doc pasted in;
   nothing needs a frontier model — the docs made the decisions already.
4. **Trust the traps list:** TECH_STACK "Known traps" is the highest-value
   context to paste into every web/queue/forge ticket prompt.
5. **Gate discipline is the quality system:** full gate per ticket
   (`pnpm lint && pnpm typecheck && pnpm test`), soak at wave gates, tenancy
   suite from W1, zero live github.com/LLM calls in CI — a cheap agent that
   can't fake the gate can't fake the ticket.
6. **MVP = end of W4** (117 pts): login → connect → backfill → drill-down
   dashboard → My Focus → admin ops. W5 adds views/reports; W6–W8 are additive.
7. **At each wave gate, re-run the reviews this doc encodes:** W6 gate =
   re-check finding-contract consistency; W7 gate = SC-12 SSRF tests green
   before Gitea; W8 gate = extend validate-arch for `packages/security` + the
   semgrep licensing decision if SaaS is on the horizon by then.
