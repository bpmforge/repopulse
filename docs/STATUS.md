# RepoPulse — Status ledger

- 2026-07-07 — project created; founding brief locked (D1–D7, C1–C3).
- 2026-07-07 — design package complete (SRS, ARCHITECTURE, design/*, UX_SPEC, ROADMAP, TESTING, DEPLOYMENT).
- 2026-07-14 — full design review (docs/work/DESIGN_REVIEW.md): pre-flight fix pack applied.
  5 tickets added (W0-05 GitHub App registration, W1-08 API hardening, W4-00 e2e harness,
  W4-09 workspace settings, W5-05 identity admin); doc reconciliation (auth → packages/auth,
  forge_etag naming, webhook_delivery/job_failure tables, findings severity/dedup/lifecycle
  canonicalized, report status, 9 missing API endpoints); Redis pinned 7.2 (licensing);
  board now 67 tickets / 305 pts, validators green.
- 2026-07-14 — journey UX review + micro-agent/loop architecture port + improvement-plans
  research (docs/work/UX_AGENTS_IMPROVEMENT_PLANS.md): 30+ recommendations (R-A/B/C/D),
  Improvement Plans proposed as new pillar (needs D9 brief amendment), verify/challenger
  passes for T2 (maker≠verifier across the two LAN hosts), agreements + artifact goals.
- 2026-07-14 — D9 + D10 ADOPTED (Brad): Improvement Plans + quality loops (D9) and CVE
  validation & VEX (D10 — SBOM false-positive funnel: alias dedup → dev/prod scoping →
  import/usage detection → reachability (govulncheck / generated semgrep symbol rules) →
  EPSS+KEV effective risk → justification-gated OpenVEX suppression, version-bump reopen).
  Threaded: SCOPE S-40..46 · SRS FR-PLANS-1..6 / FR-ANALYSIS-9,10 / FR-INSIGHTS-6 /
  FR-SEC-13..15 · design/IMPROVEMENT_PLANS.md · SECURITY_SUITE §3.6 · DATABASE D9/D10 ·
  USER_STORIES E11/E12 (total 250 pts) · ROADMAP addendum · plan.json W4-10, W5-06..09,
  W6-05..07, W8-09(+compound), W8-13..15. Board: 78 tickets / 360 pts, validators green.
- 2026-07-14 — D11 ADOPTED (Brad): Code Health Suite, wave W9 on the W8 scanner framework.
  30-rule anti-slop taxonomy mined from bpm-opencode-experts (≈12 deterministic → OUR
  semgrep rulepack; rest T2 checklist behind the maker≠verifier verify pass), lizard/jscpd
  with canon thresholds, LDR structural-slop measure, net-new logging-hygiene ruleset
  (OWASP A09/CWE-117), M13/M14 debt signals (14d rework, revert rate), Code Health
  tab/report/sub-score + plan-catalog v2. Evidence: GitClear 2026 (copy-paste 15.7%,
  refactoring −70%), Veracode 2025 (45% fail; log injection 88%), USENIX 2025 (19.7%
  hallucinated pkgs), Apiiro (+322%). New: design/CODE_HEALTH_SUITE.md, SRS §2.12
  FR-CH-1..7 + FR-REPORTS-8, SCOPE S-50..56, E13, ROADMAP W9, plan W9-01..06 (validator
  now allows W9). Board: 84 tickets / 399 pts, validators green.
- 2026-07-14 — D11 extended (Brad): rule lifecycle + shadow mode + intake (FR-CH-8/9 —
  30 rules = seed not cap; experimental findings excluded from scores until FP-gated
  promotion; field-lesson + LLM-drafted + license-gated external-pack intake, all land
  proposed), tool adapter registry (FR-CH-10 — ruff/Biome W9; actionlint/hadolint/
  shellcheck/sqlfluff/vale/gocyclo backlog; standalone-only sandbox admission), and
  per-language perf/correctness/framework semgrep packs (Opengrep-swappable engine
  contract). Tickets W9-07/08. Board: 86 tickets / 409 pts, validators green.
- 2026-07-14 — Part 1 architecture completion pass: ARCHITECTURE.md updated for D9/D10/D11
  (six queue families, security package row + matrix + graph, sequences 4f quality-loop /
  4g plans / 4h CVE-funnel+VEX / 4i scanner-dispatch+shadow, ADR-8..12, 5 new failure
  rows); lifecycle state diagrams added to CODE_HEALTH_SUITE §8.2 + IMPROVEMENT_PLANS §2.
  NEW scripts/validate-traceability.mjs (dangling-ref hard fails + FR-coverage report) —
  Ralph Wiggum loop run over the design package, converged iteration 3: 122/122 FR/NFR
  cited by tickets, 0 dangling refs. Wave-gate coverage loop + challenger protocol
  (maker≠verifier, "re-ran independently" evidence) codified in PLAYBOOK.md; traceability
  validator added to W0-03 CI gate. All validators green. Part 2 = story/epic/ticket
  refinement on this verified base.
- 2026-07-14 — Part 2 complete: story linkage (`stories: []` on all tickets, validated
  F5/F6/W3) + CHALLENGER pass run per PLAYBOOK protocol (fresh agent, maker≠verifier).
  Challenger verdict: features fully covered; 9 operational gaps confirmed — all closed:
  3 new tickets (W1-09 healthz+/metrics registry, W3-13 retention sweeps, W6-08 SC-24
  T2 host hardening) + 7 amendments (W0-01 frozen-lockfile/renovate, W0-02 SC-20 compose
  baseline, W0-03 nightly e2e cron, W1-01 identities table, W1-02 egress_audit
  INSERT-only grant, W2-02 worker healthz/queue metrics, W2-03 email-fallback identity
  rows, W5-01 share-slug endpoints, W7-05 SC-20 prod hardening + backup timer/drill
  script, W7-06 executed restore drill). Re-ran independently: validate-plan (89 tickets
  / 415 pts, OK), validate-traceability (122/122 FR, 65/65 stories, 0 dangling, exit 0),
  validate-arch (PASS). Board is coding-ready.
- 2026-07-15 — D12 Unified Risk Model ADOPTED and threaded (Brad approved): every open
  finding priced `effective_risk = 100·H·L·X` (docs/design/RISK_MODEL.md — refactors
  D10's dependency-only formula; likelihood from EPSS/KEV or confidence×verify×D11
  rule-precision prior; exposure from M2 hotspot percentile or dep_scope×reachability),
  SSVC-style act/schedule/track bands with audited nightly reprice, plans rank swap,
  Top Risks cards, A–E risk axes over existing sub-scores, report top-risk openers.
  New: SRS §2.5b FR-RISK-1..6, S-59..61, Epic E14 (3 stories/13 pts), tickets
  W9-09..W9-12 (+16 pts). Validators re-run: plan (93 tickets / 431 pts, OK),
  traceability (128/128 FR, 68/68 stories, 0 dangling). D13 (non-security risk
  registers: knowledge/bus-factor, dependency-health+EOL, architecture drift, test-gap)
  PROPOSED in docs/work/D13_ENGINEERING_RISK_REGISTERS_PROPOSAL.md — awaiting Brad.
- 2026-07-15 — D13 Engineering Risk Registers ADOPTED and threaded (Brad: "adopt"):
  four non-security risk sources through the findings contract, priced by D12 —
  knowledge-concentration/bus-factor (warehouse SQL, N-9-safe), dependency-health
  (libyear/abandonment/deprecation/license via release_meta db-sync) + runtime EOL
  (eol_products/endoflife.date), architecture drift phase A (config-free cycles/
  god-modules/orphans via D11 adapters), test-gap co-change signal (coverage
  ingestion PARKED behind a forge-budget review). New: wave W10 (+5 tickets/24 pts,
  validate-plan wave regex extended), SRS §2.13 FR-REG-1..7, S-62..66, Epic E15
  (4 stories/24 pts), supply_chain sub-score + Supply Chain risk axis. Decisions:
  Supply Chain own axis; knowledge/architecture/test_gap under Code Health axis;
  license flags = findings only. Validators: plan OK (98 tickets / 455 pts),
  traceability OK (135/135 FR, 72/72 stories, 0 dangling).
- 2026-07-15 W0-01 done — monorepo scaffold live: pnpm workspaces (apps/api Fastify 5
  stub, apps/web Vite 6/React 18 stub, packages/{shared,forge,ingest,metrics,analysis,
  insights,reports,auth} placeholders), ESLint 9 flat config + typescript-eslint 8,
  Prettier 3, strict TS 5.9 base config, vitest 3 workspace. Toolchain pinned Node
  22.23.1 / pnpm 9.15.9 (dev machine defaults were Node 24/pnpm 11 — recorded in
  TECH_STACK.md per Law 2, not silently used). `.npmrc` (ignore-scripts, engine-strict)
  + renovate.json (weekly, automerge off) land SC-19; CI enforcement of
  --frozen-lockfile is W0-03's write_scope, not this ticket's — noted in plan.json.
  Gate: `pnpm lint && pnpm typecheck && pnpm test` — 10/10 workspaces typecheck clean,
  0 lint errors, 10 test files / 10 tests passing. validate-arch: all 5 rules PASS.
  validate-traceability: 135/135 FR, 0 dangling. HANDOFF note left on the ticket:
  write_scope widened to include repo-root `.npmrc`/`renovate.json` (unclaimed by any
  other ticket, required by this ticket's own acceptance #4).
- 2026-07-16 W0-02 done — dev data tier live: `compose.dev.yaml` (Postgres 16.14 +
  Redis 7.2.14, both BSD-licensed per G-18), `.env.example` (full DEPLOYMENT.md §3
  matrix + DATA_DIR, dev-only placeholder secrets, localhost URLs matching the dev
  compose ports), `scripts/dev-up.sh`/`dev-down.sh` (healthcheck polling, `--volumes`
  wipe). SC-20 baseline: non-root `user:` on both services (verified via `podman top`
  — official entrypoints support this directly, no root-then-drop-privileges step),
  `cap_drop: [ALL]`, `no-new-privileges`, explicit `scram-sha-256` (Postgres) +
  `requirepass` (Redis), ports bound `127.0.0.1` only. New `scripts/validate-compose.sh`
  asserts all of this statically (tested against a deliberately-broken compose copy to
  confirm it isn't a rubber stamp). Verified live, not just by file inspection: both
  healthchecks green, DATABASE_URL/REDIS_URL from .env.example actually authenticate,
  data persists across down/up and is wiped by `--volumes`, LAN interface confirmed
  connection-refused via `nc` from the host's LAN IP while 127.0.0.1 accepts. Small
  doc fixes: DEPLOYMENT.md `compose.dev.yml`→`.yaml` typo, missing DATA_DIR row added,
  dev-vs-prod hostname/port split documented. Naming reconciliation: used DEPLOYMENT.md's
  canonical `TOKEN_ENC_KEY` rather than the ticket text's `CREDENTIAL_KEY` (unused
  anywhere else). Also: narrowed the local `block-env-write.sh` safety hook (Brad's
  own hook, edited with his explicit approval) to allow `.env.example`/`.env.sample`/
  `.env.template` by exact basename while still blocking real `.env*` files.
- 2026-07-16 W0-03 done — `.github/workflows/ci.yml`: gate job (lint/typecheck/test +
  validate-arch/validate-compose/validate-plan/validate-traceability) on every
  push/PR; supply-chain job (SC-18/SC-19); nightly-e2e job (cron, no-ops until
  W4-00 lands the Playwright harness — checks for playwright.config.ts first).
  eslint.config.js: data-driven `@typescript-eslint/no-restricted-imports`
  boundaries enforcing the full docs/ARCHITECTURE.md §3 allowed-dependency
  matrix per package (not just the metrics/analysis/insights/reports→forge
  rule) — verified against real bad-import/good-import test files, not just
  config inspection (metrics→forge blocked, forge→auth+shared allowed,
  apps/web value-import of shared blocked vs. type-only allowed, apps/api→
  apps/web blocked). Cross-package relative-path escapes are caught by tsc's
  `rootDir` check instead (verified via TS6059), not duplicated in ESLint.
  **Acceptance #4 deviation (Brad-approved)**: `pnpm audit --prod` is broken
  upstream for our pinned pnpm 9.x — npm retired the legacy audit endpoint
  it calls (HTTP 410, verified live), only fixed in pnpm 11
  (github.com/pnpm/pnpm#13033); bumping pnpm was out of scope for a CI
  ticket (brief-fixed pin). Replaced with **osv-scanner 2.4.0** (pinned,
  checksum-verified download) — reads pnpm-lock.yaml directly, never touches
  the retired endpoint; known gaps vs. the literal ask (no --prod-only
  filter, importance-heuristic gate rather than a strict CVSS cutoff)
  recorded in TECH_STACK.md and SECURITY_CONTROLS.md SC-19. New
  `.gitleaks.toml` allowlists `.env.example` (gitleaks flagged the
  TOKEN_ENC_KEY placeholder hex value as a generic-api-key finding — tested
  locally, confirmed a real false positive, not hypothetical). ci.yml
  validated with `actionlint` (0 errors) and every curl/checksum/detect
  shell command dry-run locally before landing in CI.
- Next: W0 tickets — W0-05 (human: GitHub App) still open, last W0 ticket.
  W1-01 claimable (W0-01/W0-02/W0-03 all done).
