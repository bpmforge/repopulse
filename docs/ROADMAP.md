# RepoPulse — Roadmap

> **MVP = W0–W4** (decision D5). The MVP gate is the W4 exit demo. W5–W10 are v1.x.
> W11 (self-hosting) and W12 (multi-forge + production wiring) were filed after this
> roadmap was written; W12 was executed out of order and its section says why.
> **Current wave: W18** (D16, 2026-10-15) — Repo Pulse restated as a self-hosted code
> security and quality platform; see the W18 section at the end.
> Gate rule (PLAYBOOK.md): no wave-N+1 ticket starts until wave-N exit criteria pass
> and are recorded in `docs/STATUS.md` (W0-* tickets always claimable).
> Points are rough, apportioned from USER_STORIES.md epic totals (213 total / 117 MVP).

## Sequencing rationale

Infra (W0) precedes everything because the fixture recorder and package-boundary law
must exist before the first line of forge code — recorded-fixture contract tests are
the only way to test forge behavior without hitting github.com (PLAYBOOK: CI never
calls live APIs). Foundation (W1) lands schema + auth + the budgeted forge client
before ingestion because every ingest job draws from that budget and writes
workspace-scoped rows. Ingestion (W2) precedes metrics because metrics read the
warehouse only (Law 4/6, FR-API-2) — there is nothing to compute until facts exist.
Metrics (W3) precede the dashboard because every W4 screen is a read-model consumer;
building UI against a live metric engine avoids mock-shaped UI bugs and lets W4
acceptance run on real seeded data. LLM analysis (W6) comes after the MVP gate per
D5: Tier-1 delivers the health dashboard value proposition on its own, LLM review is
additive, and its ops burden (LM Studio warm-up/retry, C2) must not block MVP.
Views/reports (W5) slot between: they consume only W3/W4 surfaces and are the
cheapest post-MVP value. Gitea + Tier-3 (W7) land late because both ride on
interfaces (ForgeProvider capabilities, analysis gateway) proven by then.
The security suite (W8, D8) comes after W6 because every scanner persists into
the W6 findings store/triage rails and the OWASP checklist scanners execute
through the W6 analysis gateway — the framework productizes those rails rather
than duplicating them.

---

## W0 — Infra (~8 pts, no epic stories)

**Goal:** a contributor (or cheap agent) clones, runs `pnpm i && pnpm dev:stack && pnpm test`, and everything is green with zero manual setup.

Ticket themes: pnpm monorepo scaffold (`apps/api`, `apps/web`, `packages/*`); ESLint +
tsc strict + vitest wiring workspace-wide; dev compose (Postgres 16 + Redis 7);
CI pipeline (lint → typecheck → unit → contract → integration); `scripts/validate-arch.sh`
enforcing the ARCHITECTURE.md §3 dependency matrix; GitHub-API fixture recorder harness
(record once against a scratch repo, replay forever).

**Exit criteria**
- [ ] Fresh clone → `pnpm i && pnpm lint && pnpm typecheck && pnpm test` green; compose stack up in one command.
- [ ] CI runs the full gate on a PR and blocks on failure; zero network calls to github.com in CI (nock/undici guard proves it).
- [ ] `scripts/validate-arch.sh` fails the build on a planted forbidden import (e.g. `metrics` → `forge`), passes clean tree.
- [ ] Fixture recorder records + replays one real GitHub endpoint round-trip (headers incl. `etag`, `x-ratelimit-*` preserved).

## W1 — Foundation (~21 pts: E1 auth/forge slice + tenancy from E9)

**Goal:** the load-bearing layers — schema, identity, tenancy, and the only door to GitHub.

Ticket themes: core Drizzle schema + migrations (workspaces, users, connections, repos,
sync_cursors, api_cache); GitHub OAuth + Redis sessions + workspace/roles (FR-AUTH-1..6);
`packages/forge`: ForgeProvider interface, GitHubProvider, budgeted client (dual REST/GraphQL
buckets, per-endpoint secondary-limit buckets, Retry-After), ETag cache; recorded-fixture
contract tests for every interface op; tenancy isolation test suite (two seeded workspaces).

**Exit criteria**
- [ ] Migrations apply + roll back clean on empty and seeded DBs; every tenant-scoped table has indexed `workspace_id` (schema test asserts).
- [ ] OAuth round-trip vs mocked GitHub creates user + session; cookie flags + expiry asserted; member→admin-route = 403 matrix green.
- [ ] ForgeProvider contract suite green against recorded fixtures incl. all REQUIRED cases in TESTING.md §3 (304, 202-warmup, truncated diff, 403+retry-after, secondary limit, pagination edge).
- [ ] Budget floor test: simulated 100-remaining response queues instead of emitting; zero requests once floor hit (FR-FORGE-3).
- [ ] Tenancy suite green: every existing endpoint asserted cross-tenant-blind (NFR-4); suite runs on every commit from here on.
- [ ] Credential encryption: DB dump grep finds no plaintext token; log-scrubber test green (FR-AUTH-5).

## W2 — Ingestion (~21 pts: E1 remainder + E9 ops slice)

**Goal:** connect an org and the warehouse fills itself — resumably, within budget, self-healing.

Ticket themes: connect flow (FR-INGEST-1); backfill planner + workers, recent-first,
per-(repo, entity) resumable cursors (FR-INGEST-2/3/4); webhook receiver — HMAC-verified,
delivery-id deduped, 202-fast (FR-INGEST-5/6); nightly reconciliation sweep (FR-INGEST-7);
sync-status model + API + DLQ ops surface (FR-INGEST-8, NFR-11).

**Exit criteria**
- [ ] Synthetic 500-PR fixture repo backfills to completion with budget assertions green: zero over-budget requests, entity order PRs→commits→checks→issues→releases observed.
- [ ] Kill/resume test passes: worker killed mid-backfill, restart resumes from cursor, zero duplicate rows, completion reached (FR-INGEST-3).
- [ ] Webhook→DB latency < 30s on the dev stack (measured in test); tampered signature → 401 + nothing enqueued; same delivery replayed twice → identical warehouse state.
- [ ] Reconciliation repairs an injected missed-webhook gap; sweep of an unchanged repo costs ~0 budget (ETag 304s).
- [ ] Sync-status API reports pending/backfilling/live/paused-for-budget/error with % complete; poison message lands in DLQ and is visible via API.

## W3 — Metrics (~32 pts: E2 29 + MVP insights slice)

**Goal:** every Tier-1 number a dashboard will show exists, is snapshotted, and is fixture-proven to the line.

Ticket themes: metric engine + append-only `metric_snapshots` (FR-METRICS-13); all Tier-1
metrics per `docs/design/METRICS.md` (FR-METRICS-1..12); metric definitions catalog
(FR-METRICS-15); org rollups with correct pooling (FR-METRICS-14); health score +
Tier-1-only degradation (FR-INSIGHTS-2/3); trend deltas (FR-INSIGHTS-4); hotspot ranking
(FR-INSIGHTS-5, Tier-1 inputs).

**Exit criteria**
- [ ] Every FR-METRICS-1..12 metric reproduces its hand-computed fixture-history vector exactly (per-metric acceptance in SRS §2.3).
- [ ] Pooling test green: org p90 ≠ mean-of-repo-p90s; ratio rollups sum numerator/denominator (FR-METRICS-14).
- [ ] Two nightly snapshot runs → two rows; trend endpoints read snapshots only, never recompute (query-count assertion).
- [ ] Health score endpoint returns value + full breakdown; documented formula reproduces the value in test; Tier-1-only renormalization labeled (FR-INSIGHTS-2/3).
- [ ] Metric catalog contains every FR-METRICS-1..12 id; no hardcoded formula strings outside it (grep gate).

## W4 — Dashboard MVP (~29 pts: E3 26 + E9 a11y/admin slice) ← **MVP GATE**

**Goal:** the D5 slice, end to end, on real data.

Ticket themes: web shell (TanStack routes, dark-first theme, layout, breadcrumb spine per
UX_SPEC §3.2); Org Overview (4.a); Repo Detail (4.b); PR Detail (4.c); File drill-down (4.d);
My Focus (4.f, FR-WEB-7); Admin/sync status (4.i, FR-INGEST-8 surfacing); ECharts wrappers +
empty states; ⌘K palette shell if cheap, else W5.

**Exit criteria — the MVP demo script, run live and recorded in STATUS.md**
- [ ] Connect the real bpmforge org (or full-fidelity fixture twin in CI) via the connect flow.
- [ ] Watch progressive backfill: Org Overview shows sync banner + per-repo progress ticking; tiles populate as data lands — never a misleading empty state (FR-WEB-8).
- [ ] Drill org → repo → PR → file entirely by click, breadcrumb intact; paste any deep link into a fresh session → full state restores (FR-WEB-2).
- [ ] Every tile/chart shows real warehouse data with trend deltas; health score shows its breakdown; zero live forge calls during the demo (nock guard on).
- [ ] My Focus lists the logged-in user's actual PRs + review load (FR-AUTH-6/FR-WEB-7).
- [ ] Playwright suite covering the 6 core journeys (TESTING.md §6) green on the seeded stack; axe passes on all MVP routes.

## W5 — Views & Reports (~29 pts: E4 8 + E5 21)

**Goal:** persist what P1/P4 look at; export what P3/P4 must file.

Ticket themes: saved views CRUD + switcher + per-user default (FR-API-6, FR-WEB-4); share
links (FR-WEB-5); command palette complete (FR-WEB-6); report center — generate, immutable
history, scope params (FR-REPORTS-1/7); Repo Health, Org Exec Summary, Delivery/DORA report
types (FR-REPORTS-2/3/5); Playwright PDF packs (FR-REPORTS-6).

**Exit criteria**
- [ ] E2E: create view → reload → persists; second fixture user opens share link → identical rendering.
- [ ] Keyboard-only: ⌘K → type repo → Enter → repo page.
- [ ] Three MVP report types render from fixture warehouse; regenerated report with same scope is byte-identical; PDF exports ≤30s with headers/footers/page numbers and extractable headings.

## W6 — Tier-2 Analysis (~24 pts: E6)

**Goal:** local-LLM bulk review with C2 discipline; findings become first-class data.

Ticket themes: LLM gateway (LM Studio client — 45000 maxTokens, warm-up/retry on "model
crashed", chunker to ≤10k expected output; FR-ANALYSIS-2/3, NFR-8); 4 dimension checklists
as versioned prompt assets (FR-ANALYSIS-4); findings store + dedup + lifecycle
(FR-ANALYSIS-5/6, FR-INSIGHTS-1); Findings Explorer + triage UI (FR-WEB-9); scheduling
policy + concurrency cap (FR-ANALYSIS-8); Tier-2-degraded banner (NFR-7).

**Exit criteria**
- [ ] Chunker property test: 5000-line fixture diff → every hunk covered exactly once; no chunk projects >10k output tokens.
- [ ] Crash-fixture test: "model crashed" → warm-up + retry → success; host-down chaos test parks queue, Tier-1 dashboards unaffected, banner shown.
- [ ] Re-analysis of unchanged PR → 0 new finding rows (dedup); malformed LLM output → retry once → DLQ with raw payload kept.
- [ ] E2E: filter findings by dimension/severity/status, open detail with evidence, acknowledge (FR-WEB-9). NO live LLM calls in CI (TESTING.md §7).

## W7 — Tier-3 + Gitea + Polish (~27 pts: E7 11 + E8 11 + hardening)

**Goal:** close the v1.x surface: opt-in deep review, second forge, ship-quality polish.

Ticket themes: Claude API deep review via gateway (FR-ANALYSIS-7); egress audit rows +
admin query (NFR-9); T2→T3 escalation policy per docs/design/ANALYSIS_TIERS.md;
GiteaProvider passing the same contract suite with capability flags (FR-FORGE-7, ADR-5);
Security Posture report (FR-REPORTS-4); a11y/perf/polish pass (NFR-3 k6, NFR-5 full manual checklist).

**Exit criteria**
- [ ] T3 without opt-in → 403; T3 run writes audit row BEFORE send (bytes, tokens, digest, initiator) + cost row; egress payload snapshot review recorded.
- [ ] Gitea fixture server passes the shared ForgeProvider contract suite; metrics branch on capability flags, never provider name (grep gate).
- [ ] k6: p95 < 500ms on all data endpoints against seeded 50-repo dataset (NFR-3); axe + Lighthouse + manual WCAG 2.2 AA checklist recorded (NFR-5).
- [ ] STATUS.md v1.x gate section written; both remotes pushed.

## W8 — Security Suite (~45 pts: E10, decision D8)

**Goal:** the productized scanner framework — five scanners over sandboxed C1a snapshots, attack chains, and a Security surface — with every finding living on the SAME store, triage lifecycle, and report rails as Tier-2/3 analysis (docs/design/SECURITY_SUITE.md).

Ticket themes: scanner framework + registry + per-repo enablement/budgets + `security.scan`
queue (FR-SEC-1/9/11); findings-store delta migration + scan_run/sboms (FR-SEC-12);
snapshot service + Podman sandbox + `getTarball`/scan lane (FR-SEC-2, C1a, NFR-13/14);
secrets stream + history modes (FR-SEC-3/4); dependency SBOM/CVE/KEV/slopsquat audit
(FR-SEC-5); semgrep full + incremental (FR-SEC-6); OWASP Web/LLM checklist scanners via
the gateway (FR-SEC-7); attack chainer (FR-SEC-8); Security tab + Explorer facets + org
rollup (FR-SEC-10); Security Posture report enrichment (FR-REPORTS-4); deploy delta
(sandbox image, tool-DB/rulepack db-sync).

**Exit criteria**
- [ ] Seeded-vuln fixture repo produces the expected findings per scanner — planted secret (stream ≤60s post-webhook AND history-only case), known CVE set + KEV floor + slopsquat flag, semgrep rule hits, schema-valid OWASP checklist findings with preconditions/yields — tool/rulepack versions stamped on every scan_run.
- [ ] Snapshot lifecycle: scan killed mid-run (crash and SIGKILL cases) leaves zero snapshot bytes on disk/DB/logs; sweeper clears a planted orphan `snap-*` dir; scratch dir provably deleted after every successful scan (NFR-13).
- [ ] Sandbox integration test: scan container denied network (`--network=none`) and write access (ro,noexec mount) with non-root UID; lint gate proves no scan-tool spawn outside `packages/security/sandbox` (NFR-14).
- [ ] Chain golden test: two seeded findings with matching yields→preconditions build one chain finding at severity max(member)+1 (cap 5); resolving a member auto-resolves the chain with an audit row.
- [ ] Chaos: crash every scanner — ingestion lag and Tier-1 dashboards unaffected; UI shows per-scanner error state, never a broken page (NFR-15).
- [ ] E2E: admin enables a scanner → manual "scan now" → finding faceted by scanner/CVE/KEV/chain in the Explorer → Security tab posture + chain graph → enriched Security Posture PDF; DB-dump grep proves no plaintext secret value at rest (SC-29).

---

## 2026-07-14 additions (D9/D10) — extra exit criteria per wave

Tickets: W4-10 (journey pack), W5-06..09 (plans engine/surfaces, agreements, report
consumption), W6-05..07 (quality loops, Weekly Pulse/triage, intents), W8-09 amendment +
W8-13..15 (CVE validation, VEX, T2 CVE verify). Wave gates gain:

**W4 +** persona picker routes each persona to its home; onboarding checklist renders per
role; rail badges live; metric columns render tabular-nums (mono only for SHAs/paths).

**W5 +** plan generated from a fixture report contains the expected catalog-v1 item set
with working evidence links; nightly verify flips a fixture item done AND a crafted
regression flips it back (audit rows both ways); agreement exception list reconciles to
the PR; report diff view shows per-section deltas between two same-scope reports.

**W6 +** verifier host ≠ finder host asserted on verify runs; contradicted fixture finding
never surfaces; sev-4 fixture blocked from the org banner until its challenge passes;
Weekly Pulse renders deterministically with T2 polish mocked (no live LLM in CI).

**W8 +** CVE funnel on the seeded-vuln fixture: raw > deduped (alias fixture collapses) >
scoped (dev-only downgraded, not dismissed) > affected; unused-dep proposes not_affected;
Go fixture proven_unreachable via govulncheck in the sandbox; not_affected without a VEX
justification rejected; version-bump reopens; OpenVEX + CycloneDX export validate against
their schemas; compound-risk golden test (3 dimensions, one module ⇒ severity max+1).

## W9 — Code Health Suite + Unified Risk Model (~65 pts: E13 + E14 + surfaces; decisions D11, D12)

**Goal:** the AI-slop era's code-cleanliness rails — deterministic rulepack + source
tools + T2 judgment checklists, all on the W8 framework, surfaced with the same
tab/report/plan machinery (docs/design/CODE_HEALTH_SUITE.md) — then price EVERY open
finding with the unified risk model (docs/design/RISK_MODEL.md): hazard × likelihood ×
exposure, act/schedule/track bands, Top Risks surfaces, risk axes (D12 closes the wave
because it consumes W8 findings, D10 funnel outputs, and D11 rule-precision stats).

Ticket themes: code-health rulepack (FR-CH-1); code_health_tools scanner — lizard +
jscpd + posture snapshots (FR-CH-2); anti_slop scanner — pack + LDR + T2 checklist
(FR-CH-3); logging_hygiene scanner (FR-CH-4); performance/code_health checklist v2
(FR-CH-5); Code Health tab + report + score sub-score + plan catalog v2 (FR-CH-6,
FR-REPORTS-8); M13/M14 debt signals (FR-CH-7); rule lifecycle/shadow mode + intake
workbench (FR-CH-8/9); tool adapters ruff/Biome + per-language perf packs (FR-CH-10);
risk pricing engine + reprice job (FR-RISK-1/2/3/4); band-driven plans rank + Top Risks
surfaces (FR-RISK-5); risk axes + report top-risk sections (FR-RISK-6).

**Exit criteria**
- [ ] Fixture trees reproduce every PACK rule (trigger + non-trigger cases) and every threshold boundary (CC 10/11, cognitive 15/16, fn 50/51, LDR 0.29/0.31, jscpd edge); pack + tool versions stamped on scan_runs; zero Semgrep-registry rules in the pack (license grep gate).
- [ ] anti_slop judgment findings carry substring-validated evidence and only surface after the FR-ANALYSIS-9 verify pass; a verifier-refuted fixture finding never appears.
- [ ] Scanner + T2 checklist findings on the same evidence dedupe to one row (FR-CH-5 key alignment).
- [ ] Code Health tab renders all sections with scanners enabled AND degrades per-scanner to "not enabled" (never blank); org tile + code_health sub-score basis label live.
- [ ] Code Health report snapshot-tested enriched and Tier-1-only; M13/M14 reproduce fixture vectors; a duplication plan item auto-verifies when ch_duplication_pct crosses its target.
- [ ] Shadow-mode fixture rule produces `experimental` findings that move NO score/banner/plan; promotion requires the workbench evidence gate; a non-allowlisted-license rule import is refused with a logged reason; an LLM-drafted rule arrives `proposed` with valid YAML + passing fixtures.
- [ ] Adapter routing test: Python-only fixture repo runs ruff and never Biome (and vice versa); ruff/Biome findings overlapping pack rules collapse via dedup key; tool versions + checksums stamped on scan_runs.
- [ ] Risk model: every open fixture finding (all dimensions) carries effective_risk + decomposition that reproduces the score; band fixtures incl. KEV/chain overrides and the cold-file floor; nightly reprice writes exactly one audited transition per band crossing and is idempotent.
- [ ] Risk surfaces: explorer default-sorts by effective_risk with the popover arithmetic matching the API decomposition; plans fixture reorders on risk (not raw severity) with KEV/chain pins intact; Top Risks card movement reconciles to reprice audit rows; axis letters reproduce from sub-score fixtures (incl. Tier-1-only renorm); report top-risk section snapshot-tested.

## W10 — Engineering Risk Registers (~24 pts: E15; decision D13)

**Goal:** non-security risk sources through the same findings contract, priced by D12
for free (docs/work/D13_ENGINEERING_RISK_REGISTERS_PROPOSAL.md, docs/design/RISK_MODEL.md §4):
knowledge concentration (bus factor, warehouse SQL, N-9-safe), dependency health
(libyear / abandonment / deprecation / license posture) + runtime EOL, architecture
drift phase A (config-free: cycles, god modules, orphan clusters via D11 tool
adapters), test-gap co-change signal. Coverage ingestion stays a parked decision
(forge-budget review required before any design).

Ticket themes: knowledge register (FR-REG-1); dependency-health + EOL + license
registers with release_meta/eol_products db-sync (FR-REG-2/3/4); architecture
import-graph adapters (FR-REG-5); test-gap warehouse signal (FR-REG-6); supply-chain
sub-score + axis wiring + plan catalog entries (FR-REG-7).

**Exit criteria**
- [ ] Knowledge fixture: single-maintainer hot module produces a `knowledge` finding with counts only (payload grep proves no author names/logins — N-9); the same concentration on a cold module lands track band (D12 exposure floor test).
- [ ] Dependency-health fixtures: libyear/abandonment/deprecation/major-lag each reproduce from a pinned release_meta fixture; EOL findings reproduce from an eol_products fixture (past-EOL prod ⇒ sev 4; ≤90d-ahead ⇒ sev 2); license flags follow the workspace policy list and never gate anything; scan sandbox stays `--network=none` (all registry/EOL data via nightly db-sync).
- [ ] Architecture phase A: cycle + god-module + orphan-cluster fixtures reproduce per language adapter (JS/TS, Python, Go); adapters pass the D11 standalone-only admission filter; declared-boundary checking provably absent (phase B deferred).
- [ ] Test-gap: hot-file-without-test-co-change fixture produces the finding; a repo with no test directory produces a repo-scoped basis-labeled finding, not per-file noise.
- [ ] D12 integration: all four new dimensions carry effective_risk + decomposition; supply_chain sub-score reproduces from fixtures and renormalizes when absent (FR-INSIGHTS-3 pattern); Supply Chain axis letter + contributors render; new-dimension findings appear in Top Risks / plans / reports with zero surface-specific code.

---

## W11 — Customer self-hosting (~17 pts: no new epic; D10)

**Goal:** a customer can install, configure, upgrade and recover RepoPulse on
their own host. Nothing here adds product surface — it is the difference between
"runs on Brad's machine" and "is a thing someone else can run". D10 (proprietary,
all rights reserved) means no artifact is published to a public registry until
W11-05 proves a clean install works end to end; W11-01's publish step is
therefore deliberately unbuilt, not merely deferred.

Ticket themes: portable multi-arch images + a generic compose artifact (W11-01);
customer forge-App setup flow and config reference (W11-02); upgrade, backup and
restore runbook (W11-03); the licensing/distribution/support decision, closed by
the founder as D10 (W11-04); self-host smoke on a clean host (W11-05).

**Exit criteria**
- [ ] A clean host with only a container runtime reaches a working install from docs/INSTALL.md alone, with no repo checkout and no step that exists only in someone's shell history.
- [ ] The upgrade path is exercised, not described: install version N, upgrade to N+1, and the warehouse survives with migrations applied.
- [ ] Backup and restore round-trips: a restored instance serves the same org overview the backup was taken from.
- [ ] No public distribution of any artifact until the above pass (D10).

## W12 — Multi-forge and production wiring (~42 pts: E8 remainder; unplanned)

**Goal:** an unplanned wave, filed and executed 2026-08-13/14 out of roadmap
order because a systematic audit found that built-and-tested code was not
reachable in production. Recorded here as a wave rather than folded into W2/W4
so the out-of-order execution stays visible: seven tickets closed while W5-W10
had not started.

The defect class it exists to close — **built but never mounted** — appeared five
times: the SSE events route (W4-18), connections/sync/webhooks (W4-19), all six
queue processors (W12-03/W12-05), and the ingest state machine, which had no
production caller at all. Root cause each time: unit tests mount the subject
themselves into a throwaway scope, so the production entrypoint is exercised by
nothing. W12-04 is the standing answer — a two-directional wiring gate that fails
the build when a built processor or route is absent from the shipping composition
root, and when a queue is neither consumed nor asserted as a sink.

Ticket themes: GitLabProvider against the shared contract suite, completing
multi-forge (W12-01); a fake forge server so e2e proves connect + backfill with
no real credentials (W12-02); worker processor wiring, core loop then remaining
lanes (W12-03, W12-05, W12-06); the wiring gate (W12-04); auth rate-limit test
flake (W12-07).

**Exit criteria**
- [x] All three providers (GitHub, Gitea, GitLab) pass one shared contract suite, and nothing above the port branches on provider name (`capability-gate.test.ts`).
- [x] Every declared queue is either consumed by a registered processor or asserted as a sink; `KNOWN_INERT` is `[]`.
- [x] Ingestion is proven end to end in CI: the worker runs from the shipping entrypoint as a Playwright webServer, and the assertion fails when a processor is unregistered (negative control performed).
- [ ] **Unverified, carried:** no real Gitea or GitLab instance has been ingested — both adapters pass recorded-fixture contract tests only.
- [ ] **Carried defect:** a 404 from the forge still produces a COMPLETED backfill job with no error and no cursor on the REST paths, indistinguishable from a genuinely empty repo. Only the GraphQL path was hardened.

---

## W17 — Product completion (standalone release)

Added 2026-09-08. Executes the handoff in `IMPLEMENTATION-PLAN.md` (RP-01–RP-34
→ W17-01–W17-34) under D15; see `docs/work/product-completion/DECISIONS.md`.
This wave exists because D1a made self-hosting the MVP and the gate is that a
**customer** can stand the product up.

**This wave's gate is not the historical wave-exit pattern.** Earlier waves
close against criteria written for that wave. W17 closes against the handoff's
§6 acceptance matrix, evidenced at a **single final commit** by W17-34. That is
a documented difference, not an undocumented process exception: waves W7 and
W14 carry blocked internal-infrastructure tickets which D1a already ruled out
as launch gates, so a criterion-per-wave rollup would either stall on the
dogfood deployment or quietly waive it.

**Ticket themes.** Baseline and board reconciliation (01–02); test reliability
(03); container start, install configuration, health and heartbeat, status API
and Settings surface, real first-run (04–09); analysis capability/freshness and
gateway auditing (10–11); visual primitives, brand, navigation, responsive grid
(12–15); top actions and the overview redesign (16–17); repository list, detail,
code-health/security, performance review (18–21); reviews, actions, plans,
verification, reports (22–26); packaged scanner execution, install bundle,
backup/restore/upgrade (27–29); full journey, accessibility, product
performance, documentation, final acceptance (30–34).

**Exit criteria**
- [ ] `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm e2e`, `pnpm check:bundle`, and all three validators pass against the SAME final commit (W17-34).
- [ ] A customer install is proven from an extracted bundle with locally loaded versioned images, no source checkout and no host Node/pnpm (W17-28), and the README walked literally reproduces it (W17-33).
- [ ] Supported scanners actually execute in the packaged worker and persist findings (W17-27). **Release gate** — unavailable execution is not waived by hiding a button.
- [ ] The full customer journey runs from an empty disposable installation against fixture forge and model services using production auth and ingestion paths (W17-30).
- [ ] Backup, restore and upgrade are demonstrated with data checks before and after (W17-29).
- [ ] No unsupported capability is presented as working; coverage ingestion, IaC scanning and runtime APM read as explicitly unavailable (W17-33).
- [ ] `RELEASE-CHECKLIST.md` records every §6 acceptance item PASS/FAIL/BLOCKED with evidence (W17-34).

**Carried in, not resolved by this wave**
- `W11-01` and `W11-05` stay blocked until W17-28 and W17-30 produce their evidence.
- `W16-34` (intermittent full-suite failure) is superseded by W17-03 and stays blocked, not done — it was never diagnosed.
- `W16-09` (model auth beyond API keys) is parked: out of release scope.
- `W7-05/06/07`, `W14-01`, `W14-03`, `W12-10` remain internal-infrastructure work and are **not** release gates (D1a).

---

## W18 — Code security and quality platform (D16)

Added 2026-10-15. Tickets W18-01–W18-44 in `plan.json` (W18-33–44: deterministic-coverage gaps against Snyk, see the gap analysis in the shared project folder). Executes **D16**: Repo Pulse
is a self-hosted code security and quality platform for teams shipping AI-written
code, with delivery metrics as context. The wave closes the gaps a SAST buyer
checks first (language coverage, PR-time results, fix suggestions, IaC, proof of
accuracy, ingesting other tools) and builds what the market lacks.

**Constraints carried into every ticket.** D9a stands: Repo Pulse never writes to a
customer repo, so PR-time results are pulled by the customer's CI (W18-18) and fixes
are verified patches the developer copies (W18-19). N-3 and N-9 stand. Every new
rule ships in shadow mode with triggering and clean fixtures; precision over recall.

**Phases**
- **Phase 1, fast lane (W18-01–W18-10, W18-30):** mechanical, no-LLM checks over a
  shared import/export index — unused exports, phantom names and modules, test
  integrity, suppression density and disabled safety, structural slop, dependency
  hygiene, leftover content, speculative generality and async smells, pattern-lane
  taint — then anti-slop.v2, where the LLM judges only fast-lane candidates. W18-30
  makes the bpm-ch-* anti-slop pack surface findings at all.
- **Phase 2, languages (W18-11–W18-16):** Python, Go, Java/Kotlin, Rust, C/C++ (with
  cppcheck), C#, PHP and Ruby packs and import graphs.
- **Phase 3, differentiators (W18-17–W18-26):** benchmark harness and published
  accuracy; customer-CI pull API and `repopulse check` CLI; verified patches; AI-code
  governance report; sensitive-change radar; per-rule precision and coverage map;
  AI-reviewer measurement; SARIF and code-scanning ingest; import-graph exposure and
  Tier-2 context; IaC, Dockerfile, Actions and shell adapters.
- **Phase 4, product and story (W18-27–W18-29):** D16 recorded in the brief and the
  vision documents; UI/UX review with screenshots, then UI for the new capabilities.

**Exit criteria** (from the tickets' acceptance; each ticket closes on its own full gate)
- [ ] Every W18 rule has triggering and clean fixtures and landed in shadow; the licence-gate tests stay green.
- [ ] Precision and recall per rule and dimension are published per release with method and corpus versions (W18-17).
- [ ] A customer's CI gets new PR findings through a scoped read-only token, and a test asserts no forge write scope was added (W18-18).
- [ ] A verified patch is shown only when the target finding clears and no new finding appears on re-scan; nothing is written to the forge (W18-19).
- [ ] The AI-code governance report compares AI-authored and human changes with no per-developer ranking (W18-20).
- [ ] The coverage map says what a scan did not check; IaC moves from unavailable to supported only when W18-26 ships.

