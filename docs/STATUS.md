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
- 2026-07-16 W1-01 done — Drizzle core schema live: 10 tables per DATABASE.md
  §2 Tenancy & identity + Sync machinery (workspaces, users, workspace_members,
  forge_connections, identities, repos, sync_cursors, forge_etag,
  webhook_delivery, job_failure). Text+CHECK for growable enum-shaped fields
  (provider, auth_kind, role, sync_status, entity_type) per DATABASE.md §5;
  custom `bytea` type for credential ciphertext/IV (no native drizzle-orm
  bytea column); self-referencing FK on identities.merged_into_id.
  `postgres` (postgres.js) added as the driver — not previously pinned,
  recorded in TECH_STACK.md. Migration 0000 generated then **actually
  applied** against the live compose Postgres: verified via psql that all
  10 tables/types/constraints are correct, CHECK constraints reject invalid
  values, the self-FK resolves, data survives a volume wipe + re-migrate,
  `drizzle-kit check` reports no drift. Root `drizzle.config.ts` folded
  into the typecheck gate (was previously uncovered by any workspace
  script — closed that gap). Two DATABASE.md spec-completion notes: added
  a surrogate `id` PK to webhook_delivery/job_failure (the doc's column
  list omitted one, unlike every other entity table); documented the
  webhook_secret_ciphertext nullability inference. Gate: 11 test files/11
  tests (new schema-shape sanity test), validate-arch rule 5 now actively
  validates (was skip-passing) and passes.
- 2026-07-16 W1-02 done — 16 more tables live (26 total): 9 fact tables
  (commits, commit_files, pull_requests, pr_reviews, pr_files, check_runs,
  deployments, releases, issues) + 7 read-model tables (metric_snapshots,
  analysis_runs, findings, finding_events, reports, saved_views,
  egress_audit — base shapes only, W8/D9-D13 delta columns explicitly
  excluded as later-wave additive migrations). Two acceptance-text
  reconciliations found and fixed: 'pr_comments' doesn't exist anywhere in
  DATABASE.md (zero FR/ER-diagram references) — implemented the doc's real
  9th fact table, pr_files, instead of inventing a comments table;
  'finding_status_history' was a plan.json-only name, canonical is
  finding_events (confirmed via SRS.md/RISK_MODEL.md). analysis_runs
  implemented even though omitted from the read-model acceptance list —
  it's a required NOT NULL FK target for findings and no other ticket
  creates it. SC-15 egress_audit append-only: migration 0002 creates a
  NOLOGIN repopulse_app role, grants SELECT/INSERT only on egress_audit
  (never UPDATE/DELETE) — new scripts/validate-egress-audit.sh proves this
  live (INSERT succeeds, UPDATE/DELETE denied), tested against a
  deliberately-broken grant first to confirm it isn't a rubber stamp. All
  3 migrations (0000/0001/0002) applied cleanly from a full volume wipe;
  `drizzle-kit check` reports no drift. Gate: 13 test files/13 tests.
  Small docs/design/METRICS.md fix: metric_snapshot/metric_id ->
  metric_snapshots/metric_key to match DATABASE.md's self-consistent
  naming.
- 2026-07-16 W1-03 done — GitHub OAuth login + Redis sessions.
  packages/auth/src/oauth/**: authorize-URL builder (`read:user read:org`
  scope per D6/C5 — forge ingestion permissions are a separate admin
  connection, FR-AUTH-5, not this scope), code exchange, identity fetch,
  findOrCreateUser upsert. packages/auth/src/session/**: @fastify/session
  + @fastify/cookie wired to a hand-written ioredis Store (verified
  against the installed library source, not guessed) — idle timeout comes
  free from the library's `rolling: true` default (re-derives
  `cookie.originalMaxAge` every request, store.set() persists it as the
  Redis key's PX TTL); absolute lifetime has no library equivalent, so
  it's enforced independently by stamping `createdAt` at login and
  rejecting in `get()` once exceeded regardless of the Redis TTL still
  being live. apps/api/src/routes/auth/**: the four API_DESIGN.md §2 auth
  endpoints, RFC 7807 problem+json on no/expired session.
  **Real architectural gap found and resolved** (surfaced to Brad before
  building, not guessed): FR-AUTH-1's identity fetch needs
  `api.github.com/user`, which trips scripts/validate-arch.sh rule 4 (no
  api.github.com outside packages/forge) — but packages/auth can't depend
  on packages/forge (boundary matrix runs the other way). Resolved with a
  narrow, grepped rule-4 exception scoped to
  `packages/auth/src/oauth/**` rather than inverting the dependency;
  documented in SECURITY_CONTROLS.md (SC-12/AC-4: this call's base URL is
  a fixed literal, not admin/attacker-supplied input, so the SSRF
  allowlist's threat model doesn't apply). Verified the exception doesn't
  weaken the rule elsewhere by deliberately violating it in an unrelated
  file first and confirming the validator still failed.
  Scope-completion widenings (same class as W1-01's tsconfig.json gap):
  `packages/shared/src/index.ts` never actually re-exported the db module
  W1-01 built (package "main" pointed at the placeholder barrel) — fixed,
  since every future consumer needs it. `.env.example` gained
  `API_BASE_URL` (apps/api's own origin for the OAuth redirect_uri —
  `PUBLIC_BASE_URL` is the SPA, a different origin, and the doc had no var
  for the API's own URL at all). `GET /me` ships the minimal `{user}`
  shape only — `workspace/role/identity_id/default_view_id` need W1-04's
  workspace/RBAC infra that doesn't exist yet; documented in plan.json.
  authRoutes is `fastify-plugin`-wrapped so its session decorations reach
  the whole app once W1-04 registers it in app.ts (W1-04 doesn't need to
  separately register the session plugin — it's already composed in).
  E2E against a mocked GitHub (real http server, not a fixture/nock) walks
  login → callback → /me → logout → /me-401, plus state-mismatch and
  missing-state-cookie rejection; separate live-Redis unit tests prove
  the idle-timeout TTL renewal and absolute-lifetime rejection directly.
  Gate: 16 test files/26 tests, all validators (arch/plan/traceability/
  compose/egress-audit) pass.
- 2026-07-16 W1-04 done — Workspaces, roles, /api/v1 skeleton.
  packages/auth/src/workspace/**: `ensureMembership(db, userId)` — finds
  or creates the single `default` workspace (D1) and auto-creates a
  membership row on first authenticated request if absent (FR-AUTH-3).
  First-ever member of the workspace becomes `admin`, later members
  `member` — undocumented in SRS/UX_SPEC but necessary for bootstrap (no
  admin route is ever reachable otherwise) and consistent with UX_SPEC's
  "Connect your org (admin) / Ask an admin" empty-state copy; a narrow
  count-then-insert race between two concurrent first-ever logins is
  accepted (worst case: two admins, not a privilege escalation).
  apps/api: error-envelope plugin emits the RFC 7807 shape from
  API_DESIGN.md §4 exactly (`{type,title,status,detail,instance,
  request_id}`) — the ticket text's `{code,message,requestId}` and
  DASHBOARD.md's copy of the same are the *frontend's* surface
  representation after receiving this wire response, not a competing wire
  format; zod validation failures get a 400 with a field-errors array via
  fastify-type-provider-zod's `hasZodFastifySchemaValidationErrors` guard.
  `/api/v1` is a guarded, non-fastify-plugin-wrapped encapsulated scope
  (session → workspace → role preHandler, zod validator/serializer
  compilers) so `/auth/*`, `/healthz`, and `/api/v1/openapi.json` stay
  exempt by construction, not a special-case list. `requireAdmin` is the
  reusable 👑-route gate.
  **Real Fastify bug found and fixed via testing, not assumed**: an async
  preHandler that calls `reply.send()` and then implicitly returns
  `undefined` does not reliably short-circuit Fastify's remaining
  preHandler chain when there's more than one preHandler in it (plugin-level
  `addHook` + a route's own `preHandler` option) — manifested as a second,
  overlapping `onSend`/session-save cycle and an unhandled
  `ERR_HTTP_HEADERS_SENT` rejection, caught by the synthetic-route RBAC
  test, not by inspection. Fix: explicitly `return reply` on every
  early-exit preHandler path (both `requireAdmin` and apiV1's own guard).
  No admin (👑) feature routes exist yet (all later-wave tickets), so the
  "matrix test over all admin routes" acceptance criterion is proven
  against a synthetic guarded route registered the same way a real
  feature-route ticket would extend `/api/v1` (documented in api-v1.ts) —
  real admin routes get the same coverage for free once they exist.
  Scope-completion widenings: `vitest.config.ts` added with
  `fileParallelism: false` — two test files now mutate the shared
  `default` workspace's membership table (a genuine live-infra race,
  not a hypothetical); `apps/api/src/app.ts` rewritten (`/health` →
  `/healthz`, now checks live Postgres + Redis, unauthenticated) with a
  new `BuildAppOptions` config surface; `apps/api/src/index.ts` reads
  env (fails fast on any missing required var) and adds `API_BASE_URL`
  usage for the OAuth redirect_uri (added to `.env.example` in W1-03).
  Gate: 19 test files/42 tests (up from 16/26), all validators pass.
- 2026-07-16 W1-05 done — packages/forge core: ForgeProvider interface +
  BudgetedClient + ETag cache. Branched off `main` directly (not W1-04,
  which is still an unmerged PR) since W1-05 only depends_on W1-01 and
  touches disjoint files. `types.ts`/`provider.ts` are a verbatim port of
  FORGE_PROVIDER.md §1-2 (FR-FORGE-1). `packages/forge/src/client/**`:
  `BudgetedClient` is **transport-agnostic** — it takes an injected
  `RequestExecutor` rather than depending on Octokit, so the same class
  will serve both GitHubProvider (W1-06, Octokit-backed executor) and the
  future Gitea adapter (W7-02, fetch-backed executor) against one shared
  contract-test suite (FORGE_PROVIDER.md §5). Deliberately does NOT import
  any `@octokit/*` package even though those are already pinned in
  TECH_STACK.md — that wiring is W1-06's job.
  Composition: `PrimaryBudget` (per-bucket rest/graphql, seeded only from
  real `x-ratelimit-*` headers — never guessed, admits webhook/user down
  to a reserve below the configurable floor while parking backfill/
  reconcile), `RateBucket` (continuous-refill secondary per-endpoint-
  family bucket, 900pts/min REST / 2000/min GraphQL, writes cost 5pts
  serialized >=1s apart), `ConcurrencyQueue` (global <=100 semaphore,
  lane-priority FIFO for whichever queued call gets the next free slot),
  `EtagCache` (persists to `forge_etag`, `endpoint_key` = sha256 of
  method+path+sorted-params so param key order never busts the cache),
  `ForgeMetrics` (NFR-12 in-memory counters/gauges/histogram — no
  prom-client is pinned anywhere in the repo, so this is exposed via
  `metricsSnapshot()` for a future ops ticket, E9.3/`GET /metrics`, to
  render; not an HTTP endpoint itself).
  **SC-12 SSRF allowlist**: SECURITY_CONTROLS.md states this control
  "ships in W1 ... so the GT ticket [W1-06] inherits, not reinvents" and
  "Lands: W1 · packages/forge" — but it isn't in W1-05's own 4 acceptance
  criteria, and W1-06's acceptance criteria don't mention it either.
  Resolved as a scope split rather than skipping it or guessing it fully
  in: built the string-level half here (`client/base-url.ts` —
  https-only, exact-match hostname allowlist, reject bare IP literals
  (v4/v6) and disguised decimal/octal/hex-encoded IPs, reject
  `localhost`/`*.localhost`) with the canonical evil-URL corpus as unit
  tests (metadata IP, decimal IP, octal/hex IP, localhost, rebinding-
  suffix pattern). The other half — "resolve-then-pin the IP" (DNS
  rebinding defense) — needs actual socket-level control that only a
  concrete transport has, so it's left for whichever executor W1-06/
  W7-02 construct; flagged there so it isn't silently dropped.
  Acceptance-criteria verification: (1) types/provider compile exactly
  per §1-2. (2) unit test seeds a 100-remaining response at floor=100 —
  backfill/reconcile lane calls reject with `ForgeBudgetParkedError`
  and the mock executor's call count never increments for them; webhook/
  user still drain the reserve. (3) live-Postgres fixture syncs 10 repos
  twice against a stateful mock (first sync: 10 real 200s, primary
  remaining drops by 10; second sync: all 10 come back 304 from the
  ETag cache, primary remaining drops by 0) — 100% rate-limit-point
  savings on repeat sync, comfortably over the >=90% bar. (4) retry
  tests assert exact sleep durations for retry-after-present and
  x-ratelimit-reset-fallback secondary-limit cases, a 5xx path retried
  exactly 3 times then giving up, and a `metricsSnapshot()` read showing
  populated counters/points/queue-depth after traffic.
  Also fixed a stale doc reference: TECH_STACK.md's Octokit section said
  the budgeter "wraps Octokit" and persists ETags to an `api_cache`
  table — neither was ever true (no such table exists; forge_etag is the
  real one) — corrected to describe the transport-agnostic design above.
  Gate: 24 test files/71 tests workspace-wide (up from 16/26 after
  W1-03; +8 files/+45 tests from this ticket), all validators
  (arch/plan/traceability/compose/egress-audit) pass.
- 2026-07-16 W1-07 done — tenancy isolation test suite (route walker,
  two-workspace fixture). `packages/shared/src/testing/route-walker.ts`:
  `trackRoutes(app)` attaches Fastify's `onRoute` hook (must be called
  before `app.ready()` — verified empirically that `app.register()` only
  queues plugins via avvio, so a hook attached after registering but
  before `ready()` still sees every nested plugin's routes) and returns a
  getter for every discovered `{method, url}`, skipping the auto-added
  HEAD/OPTIONS pairs. `walkForTenancyLeakage(app, routes, probes)` takes
  N tenant probes (auth context + a marker string unique to that tenant),
  injects every parameter-free, non-exempt GET route once per probe, and
  flags any response whose body contains a *different* probe's marker —
  generic and route-shape-agnostic (string search, not schema-aware), so
  it needs no per-route knowledge and will automatically cover future
  feature routes as they're added.
  **Real structural finding, not guessed**: v1 ships a single `default`
  workspace (D1) and `ensureMembership` (W1-04) hardcodes that slug, so
  there is no way today for two different *real login sessions* to
  resolve to two different real workspaces — multi-tenant resolution
  doesn't exist yet by design. Rather than fake this with a stubbed
  `request.workspace` (which would test nothing about the real
  preHandler), `apps/api/test/tenancy/route-walker.test.ts` uses one
  real login (resolves to `default` via the real session -> workspace ->
  role preHandler) plus a *second workspace row inserted directly as
  data* (never resolved through any session) whose name is a unique
  marker — proving the walker against the real DB/session/preHandler
  stack rather than a synthetic harness. Two routes nested under the real
  `apiV1` guard: `scoped-ok` (`WHERE id = request.workspace.id`) passes
  with zero violations; `scoped-bad` (no filter, returns every workspace
  row) is caught by name — this is the literal acceptance criterion
  ("adding an unscoped route fails the walker"), demonstrated against
  real infrastructure, not a mock.
  Scope-completion widening: `packages/shared/src/testing/**` needs
  Fastify's `FastifyInstance`/`InjectOptions` types, so `fastify` was
  added to `packages/shared/package.json` as an *optional* peer +
  dev dependency (matching packages/auth's precedent of taking a
  framework peer dep without becoming a framework package) — packages
  that never import the testing barrel (metrics/analysis/insights/
  reports) aren't forced to install it. Also re-exported
  `./testing/index.js` from `packages/shared/src/index.ts` alongside the
  existing `./db/index.js` re-export, same barrel-completeness pattern
  as the W1-01/W1-03 gaps found earlier.
  Also has its own unit test (`packages/shared/src/testing/
  route-walker.test.ts`) proving the walker mechanism generically with
  zero DB/Fastify-app-under-test complexity — a fabricated scoped vs.
  unscoped route pair, no live infra required, runs everywhere.
  Gate: 29 test files/95 tests workspace-wide (up from 24/71 after
  W1-05), all validators (arch/plan/traceability/compose/egress-audit)
  pass.
- 2026-07-16 W1-08 done — API hardening: helmet/CSP, rate limits, CSRF
  header, security audit log (SC-7/11/22/23). Branched off
  feat/w1-07-tenancy-isolation rather than main (both PR #9 and this
  ticket touch `packages/shared/package.json`/`src/index.ts` — pino vs.
  fastify additions on the same files — stacking avoided a guaranteed
  merge conflict; this PR will show W1-07's commit too until #9 merges,
  then rebase clean). `apps/api/src/plugins/security-headers.ts`:
  `@fastify/helmet` with `contentSecurityPolicy.useDefaults: false` (SC-23) —
  verified empirically that the default `true` merges helmet's own extra
  directives on top of ours, which would drift from
  SECURITY_CONTROLS.md's exact CSP string. `apps/api/src/plugins/
  rate-limits.ts`: `@fastify/rate-limit` registered with `global: false`
  (verified: zero effect on any route until it opts in via
  `config.rateLimit`) plus exported `AUTH_FLOW_RATE_LIMIT`/
  `WEBHOOK_RATE_LIMIT`/`SHARE_SLUG_RATE_LIMIT` constants (SC-11) — only
  `AUTH_FLOW_RATE_LIMIT` is wired to a real route today (`/auth/login`,
  `/auth/callback` — the only routes that exist); the other two are
  exported now so the webhook (ingest wave) and share-slug (reports
  wave) route tickets apply them directly instead of re-deriving the
  SC-11 numbers. SSE-connections-per-session has no `@fastify/rate-limit`
  equivalent (not a request-rate limit) — left for whichever ticket adds
  SSE routes to implement as a connection counter.
  `apps/api/src/plugins/csrf-header.ts` (SC-7): global `onRequest` hook,
  every non-safe-method request needs `X-Requested-With: repopulse`
  except `/webhooks/*` (doesn't exist yet, prefix still declared so it's
  exempt the moment it ships) — this is a literal reading of
  SECURITY_CONTROLS.md's "all mutation routes... webhook route exempt"
  (only one exemption named), so it also covers `POST /auth/logout`,
  which is why that route now requires the header too. CORS needs no new
  plugin at all: no `@fastify/cors` is registered anywhere, so no route
  ever emits `Access-Control-Allow-Origin` — "no ACAO header" is the
  absence of a plugin, not a configuration.
  `packages/shared/src/logger/**` (SC-2/SC-22): `createLogger()` wraps
  pino with a `hooks.streamWrite` redaction layer (`redact.ts`) — chosen
  over pino's own `redact` path-option because that only catches values
  at pre-declared paths, while `streamWrite` runs on the fully-serialized
  line and catches denylisted-field values (token/credential/secret/
  authorization/password/x-hub-signature*) AND bare GitHub-token/PEM-block
  patterns wherever they appear, regardless of nesting depth or whether
  they're in a named field at all. Fastify's `loggerInstance` option
  (not `logger`) takes this pre-built pino instance; verified that pino
  child loggers (which `request.log` is one of) inherit the parent's
  `streamWrite` hook since it operates at the shared destination-stream
  level, so no per-route logger plumbing was needed. `auditLog()` (SC-22)
  emits actor/workspace/ip/ua/ts on every entry; wired into the ONLY real
  event classes that exist today — `auth.login.success`,
  `auth.login.failure` (with a `reason`: missing_code_or_state/
  missing_state_cookie/state_mismatch/oauth_exchange_failed/
  identity_fetch_failed), `auth.logout` — connection CRUD/role-change/
  share/report-download/etc. are explicitly deferred per the ticket's own
  acceptance text ("later event classes land with their waves"); no
  routes for any of those exist yet.
  ESLint rule (SC-23): plain `no-restricted-syntax` targeting
  `JSXAttribute[name.name="dangerouslySetInnerHTML"]` scoped to
  `apps/web/**/*.tsx` — no `eslint-plugin-react` dependency needed.
  Verified it actually fires: wrote a deliberately-violating probe file,
  confirmed `eslint` failed on it, deleted the probe (same
  verify-before-trust pattern as W1-03's Rule-4 exception).
  Type-checking snag (same root cause as W1-05/W1-07's `HTTPMethods`
  issue): `auditLog`'s logger parameter can't be typed as pino's own
  `Logger` - Fastify's `request.log` is `FastifyBaseLogger`, an
  intentionally-looser interface (Fastify's `loggerInstance` docs say
  any object conforming to a logger-shaped subset works, not literally
  pino), so the full pino type rejected a real `request.log` at the type
  level even though it's correct at runtime. Fixed by typing `auditLog`'s
  parameter as a minimal structural `AuditLogger` interface (just the
  `info(obj, msg)` shape actually used) instead of importing pino's type.
  Scope-completion widenings beyond the declared write_scope
  (`apps/api/src/plugins/**`, `packages/shared/src/logger/**`,
  `apps/api/test/security/**`) — each narrow and necessary for the gate,
  documented rather than silent: `apps/api/src/app.ts` (composition root
  wiring the three new plugins + switching to `loggerInstance` +
  `createLogger`, continuing the precedent W1-04 already set of this
  file evolving with each wave); `apps/api/src/routes/auth/index.ts`
  (added `config.rateLimit` to login/callback, `auditLog()` calls at
  every login success/failure/logout decision point — instrumenting the
  route handler directly was far more reliable than trying to infer
  login-success-vs-failure generically from a cross-cutting hook, which
  can't distinguish *why* a request failed from status code alone);
  `eslint.config.js` (the dangerouslySetInnerHTML rule has nowhere else
  to live); `packages/shared/package.json`/`apps/api/package.json` (pino
  as a direct dependency in both, not just transitive via Fastify).
  Gate: 35 test files/115 tests workspace-wide (up from 29/95 after
  W1-07), all validators (arch/plan/traceability/compose/egress-audit)
  pass.
- 2026-07-16 W1-09 done — ops endpoints: /healthz liveness + Prometheus
  /metrics registry. Branched off feat/w1-08-api-hardening (stacked
  again — `app.ts` is being actively evolved by each W1 ticket in
  sequence; basing off `main` risked a real conflict in the import list
  and `register()` call order, not just an append-only-file conflict
  like W1-07→W1-08's). `packages/shared/src/metrics/registry.ts`: one
  process-wide `prom-client` `Registry` singleton so every later wave
  (queue depth/DLQ — W2-02, sync lag — ingest, Tier-2 host availability
  — packages/analysis) registers onto it without new plumbing.
  `forge-metrics.ts`: bridges W1-05's `BudgetedClient.metricsSnapshot()`
  (a plain snapshot object, not a live prom-client instance — and
  packages/shared may not depend on packages/forge, ARCHITECTURE.md §3
  runs the other way) into the exact FORGE_PROVIDER.md §3 instrumentation
  names via a metric's `collect()` callback (pull-based, runs immediately
  before each scrape) that aggregates across however many
  `ForgeMetricsSource`s (`() => ForgeMetricsSource[]`) are currently
  active — zero, one, or many BudgetedClient instances, matching W1-05's
  one-per-connection design, with no re-registration needed per
  connection. `http-metrics.ts`: `http_request_duration_seconds`
  histogram labeled by method/route-PATTERN/status_code (never the
  concrete path — unbounded label cardinality) for NFR-12's "HTTP p95 by
  route" — Prometheus computes the percentile from bucket data via
  `histogram_quantile()` at query time, the app never computes it itself.
  **Two real prom-client bugs found via testing, not assumed**: (1)
  omitting `registers: []` on a metric constructor silently
  auto-registers it onto prom-client's own implicit default global
  registry too, in addition to wherever it's manually registered
  afterward — every metric here passes `registers: []` explicitly and
  is attached only to the shared registry via `registerMetric()`. (2)
  `Registry.metrics()` serializes each registered metric in
  *registration order*, calling only that metric's own `collect()`
  first — a metric registered *before* the one carrying the shared
  `collect()` side effect (here, `forge_budget_remaining`) gets
  serialized from stale data, since the side-effecting `collect()`
  hasn't run yet. Caught by a failing test (`forge_requests_total` and
  `forge_points_spent` silently missing their sample lines even though
  `.inc()` demonstrably ran), root-caused by an isolated 6-line
  reproduction against the real installed `prom-client` package, fixed
  by registering the `collect()`-carrying gauge first. A test-only
  `resetForgeMetricsForTest()` export was added after discovering the
  module-level delta-tracking state (needed for the "counters only
  increment by the delta since the last scrape" behavior real Prometheus
  counters require) persisted across test cases in the same file and
  produced order-dependent, coincidentally-passing assertions otherwise.
  `apps/api/src/routes/health/index.ts`: the existing W1-04 `/healthz`
  handler extracted out of `app.ts` verbatim (same behavior, same URL —
  W1-07's route-walker exemption for `/healthz` needed no change since
  the URL didn't move). `apps/api/src/plugins/metrics/index.ts`: the
  `onResponse` hook feeding the HTTP histogram, `GET /metrics` serving
  `registry.metrics()`, and an eager `registerForgeMetrics(() => [])`
  call — no real `BudgetedClient` exists in this process yet (W1-06 is
  still blocked on W0-05), but this makes the §3 metric names present in
  `/metrics` output at zero/empty values from day one (the ticket's own
  acceptance text), ready for whichever ticket constructs the first real
  forge connection to call `registerForgeMetrics()` again with the real
  connection-pool getter. "Internal vhost only" exposure (DEPLOYMENT.md
  §7) is a reverse-proxy/network-topology concern with no reverse proxy
  built yet — documented, not enforced in-app, same treatment as
  `/healthz`'s equivalent unauthenticated-by-design note.
  Gate: 38 test files/123 tests workspace-wide (up from 35/115 after
  W1-08), all validators (arch/plan/traceability/compose/egress-audit)
  pass.
  All three PRs merged (2026-07-16): W1-07 (#9), W1-08 (#11), W1-09
  (#12). W1 wave is now complete except W0-05.
- 2026-07-16 W3-01 done — Metrics engine core: shared rules, window
  handling, metric catalog, fixture harness. **Deliberate wave-gate
  bypass** (Brad, explicit instruction): with only W0-05 (human: GitHub
  App registration) left in W0/W1, every W2 ticket is substantively (not
  just formally) blocked — all five require W1-06 (GitHubProvider),
  which requires W0-04's fixture recorder, which requires real GitHub
  API access from W0-05; there is nothing real to build or test against
  in W2 even with a gate bypass. W3-01 was chosen because it is the only
  genuinely-unblocked candidate: depends only on W1-02 (done, merged
  long ago), and `packages/metrics` reads the warehouse DB only, never
  the forge — fully buildable and testable today with synthetic
  fixtures. Confirmed `validate-plan.mjs` doesn't hard-fail on an
  out-of-gate `in_progress`/`done` status before proceeding (the wave
  gate only affects the printed "claimable" list). W0-05 remains
  tracked as outstanding, unaffected by this detour.
  `packages/metrics/src/engine/**`: the six METRICS.md §0 shared rules,
  each a small pure function, unit-tested independently of any specific
  metric (M1–M12 themselves are separate, still-`todo` tickets W3-02
  onward) — `isBotLogin` (glob-matched against a workspace-configurable
  list, default `*[bot]`/`dependabot*`/`renovate*`/`github-actions*`),
  `isMergeCommit`/`isEligibleForChurn` (bot + merge-commit + superseded
  exclusion, combined), `nearestRankPercentile` (nearest-rank, not
  linear interpolation — pooled org rollups need this to stay correct
  per FR-METRICS-14), `ratio` (retains numerator/denominator, `null`
  never `0`/`100` on an empty denominator), and the `WINDOW_DAYS`
  constants (`7/30/90/365`, default 30).
  **Real schema gap surfaced, not silently patched**: METRICS.md §0
  requires excluding commits "tombstoned (`superseded=true`)" by the
  reconciliation sweep, but `packages/shared`'s `commits` table (W1-02)
  has no `superseded` column at all — the sweep that would set it
  (W2-05) doesn't exist yet either. `isEligibleForChurn`'s
  `ChurnEligibility` input type accepts `superseded: boolean` as a plain
  field (decoupled from the DB row shape), so the exclusion rule itself
  is fully unit-tested and ready; the actual migration adding the column
  is flagged here for whichever ticket (W2-05 or a dedicated migration)
  ships the reconciliation sweep.
  `packages/metrics/src/catalog.ts` (FR-METRICS-15): all 12 entries
  (M1–M12) with id/name/formula/unit/direction/heuristicNotes, each
  transcribed from METRICS.md §1's exact definitions (that doc is LAW —
  the catalog must never drift from it); test asserts every
  FR-METRICS-1..12 id is present exactly once.
  `packages/metrics/fixtures/harness/**`: the three METRICS.md §4 worked
  examples (E1 hotspot, E2 cycle-stages, E3 review-coverage) transcribed
  as fixtures + their documented expected outputs, for W3-02/W3-04/W3-05
  to consume directly rather than re-deriving the doc's example numbers
  when those metrics are implemented. W3-01 itself doesn't compute
  hotspot/cycle-stages/coverage (that's those tickets' job) — it proves
  the fixtures load with the exact documented inputs, AND cross-checks
  E1's `daysSince` and E3's M5/M6 using the shared `daysBetween`/`ratio`
  engine utilities against the doc's exact expected values (2d/27d;
  6/9 = 66.7%) as a real exercise of the shared rules, not just a data
  fixture smoke test.
  Gate: 45 test files/158 tests workspace-wide (up from 38/123 after
  W1-09), all validators (arch/plan/traceability/compose/egress-audit)
  pass — `validate-arch.sh` rule 2 (metrics/analysis/insights/reports
  never import forge) confirmed green.
- 2026-07-16 W3-02 done — M1 commit churn + M2 file hotspots. Continues
  the W3-01 wave-gate bypass (unaffected by W0-05/W2's blocker).
  `packages/metrics/src/metrics/churn.ts`: `computeChurn` (gross/net at
  file-touch granularity, filtered through the W3-01 `isEligibleForChurn`
  shared rule) + `computeFileChurn`/`computePersonChurn` (repo/file/person
  grains per METRICS.md §1 M1). Rework (touches on the same file <21d
  after a prior touch) is rename-chain-aware: a small union-find-style
  `previousPath` resolver canonicalizes a renamed file's history so
  `computeFileChurn('new.ts')` and `computeFileChurn('old.ts')` return
  identical results for a file renamed mid-window — verified with a
  hand-computed fixture (two independent touch chains, one with a
  rename) reproducing gross/net/rework exactly, per the ticket's own
  "to the line" acceptance wording.
  `packages/metrics/src/metrics/hotspots.ts`: `computeHotspots`
  (normChurn × 2^(−daysSince/30), max-gross-zero guarded against
  divide-by-zero) reproduces METRICS.md §4 E1 **exactly** — api.ts
  0.955, util.ts 0.100, in that rank order — plus a from-scratch
  untouched-for-a-year case scoring <0.001 and an all-excluded case
  returning zero hotspot entries (not zero-valued ones — an excluded
  file was never eligible to have a score at all). hotspot_v2 (complexity
  proxy) is explicitly NOT implemented, per the ticket's own acceptance
  criterion.
  **Real tooling gap found and fixed, not the ticket's own feature
  work**: `packages/metrics/src/metrics/churn.test.ts` (living under
  `src/`, `rootDir` was pinned to `"src"`) importing a fixture from
  `packages/metrics/fixtures/churn/**` (declared write_scope, outside
  `src/`) hit a real `tsc` `TS6059` rootDir violation — verified via
  `--listFiles` that `fixtures/harness/**` (W3-01, which only imports
  *from* fixtures *into* src, never the reverse) was silently excluded
  from the program entirely, while this ticket's fixtures (imported *by*
  a file under `src/`) got pulled in and immediately violated the
  `rootDir` constraint. Since `noEmit: true` is set globally
  (`tsconfig.base.json`) — no output path is ever written, so `rootDir`
  was serving no purpose except to reject a legitimate cross-directory
  import — removed the `rootDir: "src"` override and widened `include`
  to `["src", "fixtures"]` in `packages/metrics/tsconfig.json`. This is
  a real fix any future ticket writing `src/**/*.test.ts` importing
  `fixtures/**/*.ts` in this package needs, not scope creep.
  Gate: 47 test files/167 tests workspace-wide (up from 45/158 after
  W3-01), all validators pass.
- 2026-07-16 W3-03 done — M3 ownership / bus factor. Continues the
  W3-01 wave-gate bypass. `packages/metrics/src/metrics/ownership.ts`:
  `computeOwnership` (fixed **trailing 365d** per METRICS.md §1 M3 —
  deliberately not the configurable §0 window; a stale-touch test proves
  a >365d-old touch is excluded even though it would fall inside a
  hypothetically larger W) + `computeFileOwnership`/
  `computeDirectoryOwnership` (directory = recursive sum of files, exact
  path-prefix match with a trailing-slash boundary so `src-other/` never
  matches a `src` query). `linesChanged(author)` = Σ(additions+deletions)
  over eligible touches (same W3-01 `isEligibleForChurn` filter);
  `topShare` via the shared `ratio` utility (`null` on zero eligible
  activity, never `0`); `busFactor` = smallest author set summing to
  ≥50% (sorted desc); `singleOwner` flags at `topShare >= 0.80`.
  Reproduces METRICS.md's own two worked cases exactly: 60/30/10 ⇒
  busFactor 1, no flag (0.60 < 0.80); 85/15 ⇒ busFactor 1, flagged
  (0.85 ≥ 0.80) — plus an even-split (30/30/40) case proving busFactor
  correctly reaches 2 when the top author alone doesn't cover 50%.
  Gate: 48 test files/174 tests workspace-wide (up from 47/167 after
  W3-02), all validators pass.
- 2026-07-16 W3-04 done — M4 PR cycle-time stages. Continues the W3-01
  wave-gate bypass. `packages/metrics/src/metrics/cycle.ts`:
  `computeCycleStages` (open→firstReview / firstReview→approved /
  approved→merged / e2e, METRICS.md §1 M4) reproduces worked example E2
  exactly (6h/27h/15h/e2e 48h). Bot-authored and unmerged PRs return
  `null` (excluded entirely, not zeroed); merged PRs with zero reviews
  return `null` for every stage except `e2e`, per the ticket's own
  acceptance wording. `computeCycleStagePercentiles` pools stage
  durations across PRs via the W3-01 `median`/`nearestRankPercentile`
  engine utilities.
  **Documented simplification** (not silently guessed): dismissal
  handling voids ALL of a reviewer's approvals on a PR once any
  `dismissed` event for that reviewer exists — the flat event-list shape
  used here carries no per-review identity to link a specific dismissal
  to one specific prior approval. Exact for the common case (one
  approval per reviewer, which the doc's own worked example never even
  exercises); a reviewer who approves, gets dismissed, then re-approves
  would need richer event data than the ticket's fixture shape carries.
  Flagged in the code and here rather than silently building a more
  elaborate state machine the doc doesn't actually specify.
  Gate: 48 test files/176 tests workspace-wide (up from 48/174 after
  W3-03), all validators pass.
- 2026-07-16 W3-05 done — M5 review coverage % + M6 merged-without-
  review rate (pair). Continues the W3-01 wave-gate bypass.
  `packages/metrics/src/metrics/review-coverage.ts`:
  `computeReviewCoverage` reproduces METRICS.md §4 E3 exactly (bot PR
  excluded from the denominator entirely, self-approval uncovered, M5 =
  6/9 = 66.7%, M6 = 33.3%). Covered = ≥1 non-author review in
  {APPROVED, CHANGES_REQUESTED, COMMENTED-with-content}; `DISMISSED`
  never counts (a dismissed review's opinion no longer stands — not
  explicitly excluded in the doc's state list, judgment call documented
  in code); an empty/no-content `COMMENTED` review never counts either.
  `uncoveredDrillDown` reconciles exactly with `merged − covered` — a
  test asserts the list's length and PR-number membership directly
  against the fixture, not just the M6 percentage.
  Also exports `prSizeBucket` (METRICS.md §1 M7's XS/S/M/L/XL
  thresholds) from this file — needed now for the drill-down's
  `sizeBucket` field, single-sourced here so W3-06 (PR size
  distribution) reuses it rather than re-deriving the same thresholds.
  Gate: 50 test files/192 tests workspace-wide (up from 48/176 after
  W3-04), all validators pass.
- 2026-07-16 W3-06 done — M7 PR size distribution + M8 stale PRs
  (pair). Continues the W3-01 wave-gate bypass.
  `packages/metrics/src/metrics/pr-size.ts`: `computePrSizeDistribution`
  buckets a PR set via W3-05's `prSizeBucket` (imported, deliberately
  not redefined — a barrel re-export of the same name from two modules
  would collide, so it's imported and used internally only) — a fixture
  seeds one PR at *every* boundary value (9/10, 99/100, 499/500,
  999/1000) and asserts exactly 2 PRs land in each of the five buckets,
  per the ticket's "fixture-verified at every boundary" wording.
  `packages/metrics/src/metrics/stale-prs.ts`: `computeStalePrs`
  consumes `lastActivityAt` directly rather than recomputing it from raw
  activity events — that denormalization already exists on the
  `pull_requests` table (W1-02) specifically so staleness is an index
  scan, not per-request aggregation; "any tracked activity resets the
  clock" is therefore the ingest layer's job (a later wave), not this
  ticket's. Threshold is strictly `>` N days (default 7, workspace-
  configurable) — a fixture PR at exactly 7 days proves the boundary
  itself is NOT stale. Drafts land in a wholly separate `staleDrafts`
  series, never mixed into `stale`; closed PRs are never candidates
  regardless of activity age.
  Gate: 52 test files/202 tests workspace-wide (up from 50/192 after
  W3-05), all validators pass.
- 2026-07-16 W3-07 done — M9 CI pass rate, duration and flakiness.
  Continues the W3-01 wave-gate bypass.
  `packages/metrics/src/metrics/ci.ts` mirrors the real
  `check_runs` schema (W1-02) exactly — `runAttempt` is that column's own
  documented purpose ("Powers flakiness"), `pullRequestId` null/non-null
  is the default-branch/PR split. `computeCiPassRate` = success ÷
  (completed − cancelled − skipped); in-progress runs are filtered out
  before cancelled/skipped are even considered, so they can't leak into
  the denominator through any path. **A real fixture-driven correction
  during testing, not silently patched**: an initial test assumed
  `computeCiDuration` would exclude cancelled runs the same way
  `computeCiPassRate` does, and failed — re-reading METRICS.md §1 M9
  confirmed duration's definition carries no such exclusion (only
  passRate's does), so the cancelled fixture run's real 1-minute
  duration correctly enters the pooled median/p90 alongside the
  10/20/30-minute runs; fixed the test's wrong assumption, not the
  (correct) implementation. `computeCiFlakiness` groups by
  (workflowName, headSha); a "rerun group" only exists once ≥2 attempts
  share a head SHA — a workflow run exactly once never enters the
  denominator at all, not even as a non-flaky data point. Fixture
  exercises three distinct cases (flip fail→pass, rerun-but-no-flip,
  rerun-both-succeeded) and asserts the flaky workflow ranks first.
  Gate: 53 test files/212 tests workspace-wide (up from 52/202 after
  W3-06), all validators pass.
- 2026-07-16 W3-08 done — M10 issue throughput + M11 release cadence
  (pair). Continues the W3-01 wave-gate bypass.
  `packages/metrics/src/metrics/issues.ts`: **real schema gap surfaced,
  not silently worked around** — the real `issues` table (W1-02) stores
  only the CURRENT `closedAt` plus a `reopenedCount` counter with no
  per-cycle timestamps, so "reopen+reclose = 2 closes" genuinely can't
  be reconstructed from that row alone; `IssueThroughputInput.closeEvents`
  is deliberately richer (a full per-event history with each event's own
  `openPeriodStartedAt`) than what the current schema can supply —
  whichever ticket ingests GitHub's Issue Events API (not built yet)
  is what would actually populate it. `computeIssueThroughput`/
  `computeOpenIssueAgeDistribution` reproduce the doc's rules exactly on
  a hand-computed fixture (opened=2, closed=2 — one issue's two close
  events, only one of which falls in the window — medianTimeToCloseDays
  =14, single open issue aged 20d).
  `packages/metrics/src/metrics/releases.ts`: `computeReleaseCadence`
  excludes drafts and (by default) prereleases, falls back to pushed
  tags (`basis: 'tags'`) only when there are zero eligible releases at
  all, and matches a hand-computed 3-release fixture exactly (median
  gap 59d, 36d since last).
  Gate: 55 test files/223 tests workspace-wide (up from 53/212 after
  W3-07), all validators pass.
- 2026-07-16 W3-09 done — M12 DORA approximations with basis labels.
  Continues (and closes out) the W3-01 wave-gate bypass sequence for
  the metrics engine — every M1–M12 metric now has a real implementation.
  `packages/metrics/src/metrics/dora.ts`: `computeDeploymentFrequency`
  falls back to releases (`basis: 'releases'`) only when zero deployment
  records exist at all (matching Gitea's real always-fallback case,
  research §7) — a repo with deployment records that are merely all
  failed/pending still reports `basis: 'deployments'` with a 0 count,
  never silently switching sources. `computeLeadTimeForChanges` pools
  every (deployment − commit) interval across *all* deployments into one
  sample before taking median/p90 — a deliberate reading of the doc's
  "per deployment D: median over commits C" wording, applying
  FR-METRICS-14's own pooling principle (percentile metrics pool raw
  samples, never average pre-computed per-group values) rather than
  computing a median-of-medians; documented as an interpretation, not
  guessed silently. Resolving which commits belong to which deployment
  window needs the real git commit graph — the caller's (ingest) job,
  not this pure function's; it receives already-attributed
  `{deployedAt, changeTime}` pairs. `computeChangeFailureRate` matches
  the doc's `/\b(revert|hotfix|rollback)\b/i` heuristic or a GitHub
  revert-link flag, strictly *after* the deployment and within 48h,
  same environment; failed deployment ids are exposed for drill-down.
  `computeMttr` always returns `{status: 'needs_incident_data', value:
  null}` — the literal honesty-caveat acceptance criterion. Every result
  type carries the doc's own caveat text verbatim (not paraphrased) as
  the "basis label" the acceptance asks for.
  Gate: 56 test files/235 tests workspace-wide (up from 55/223 after
  W3-08), all validators pass.
- 2026-07-16 W3-10 **partially done, closed as `blocked` not `done`**
  (Brad, explicit scope-reduction instruction after W3-09): the full
  ticket needs a real nightly BullMQ job (jobId `snap:{repoId}:{yyyymmdd}`
  per docs/design/INGESTION.md §6), which needs W2-02's queue topology —
  itself still blocked on W1-06/W0-05, so the job-scheduling half is not
  bypassable the way W3-01..W3-09 were. Built the genuinely
  job-independent half instead: `packages/metrics/src/rollups/**` (org
  rollup math, FR-METRICS-14) and `packages/metrics/src/snapshots/**`
  (the append-only row writer + snapshots-only trend reader). **Per
  CLAUDE.md Law 3, a ticket without its own acceptance criteria fully
  met does not close as `done`** — status set to `blocked` (on W2-02),
  not `done`, so this doesn't silently read as complete.
  `rollupPercentileMetric` pools raw samples across repos rather than
  averaging each repo's own pre-computed percentile — proven with a
  fixture specifically constructed so the two approaches diverge (pooled
  p90 = 10 vs. naive mean-of-repo-p90s = 54.5), not just asserted.
  `rollupRatioMetric` sums numerators/denominators before taking one
  ratio, same divergence-proof pattern (naive average-of-ratios badly
  misweights a low-volume repo against a high-volume one). Both honor an
  `activeRepoIds` filter (FR-API-6).
  `writeMetricSnapshot`/`readMetricTrend`: `metric_snapshots` lives under
  packages/shared's `read` schema barrel, not `core` — a real, caught
  mistake (first pass imported `core.metricSnapshots`, which doesn't
  exist; fixed after `tsc` reported it, not guessed). The table is
  append-only by the schema's own design (its header comment: "never
  updated, never deleted inside retention"), so the writer is a plain
  insert — "two nightly runs produce two rows" falls out for free,
  verified against live Postgres. `readMetricTrend` imports nothing from
  `../engine` or `../metrics`, structurally incapable of triggering
  recomputation. Numeric column value/numerator/denominator round-trip
  as fixed-scale strings (verified against real Postgres, e.g.
  `"0.667000"`) — drizzle-orm 0.39.3's `numeric()` has no `mode: 'number'`
  option in this version, confirmed from the installed type declarations
  before writing the conversion code.
  Gate: 59 test files/245 tests workspace-wide (up from 56/235 after
  W3-09), all validators pass.
- W5-01 (Saved views CRUD API + sharing semantics) done, 2026-07-18 —
  another wave-gate bypass (same standing decision as W3-01..W3-10): the
  W1-06/W2-0x forge-ingest chain is still blocked on W0-05, and the
  metrics-package vein was mined out (W3-10 closed `blocked`, so
  W3-11/12/13 stay genuinely dependency-blocked, not just wave-gated —
  confirmed by walking `plan.json`'s full dependency closure, not
  assumed). W5-01 was the next ticket with a fully-satisfied real
  dependency chain (W1-02, W1-04 both `done`) and a verifiable-now
  acceptance bar (live-Postgres route tests) — same bar that justified
  the metrics bypass. W7-05 (prod containers/TLS/backup) was the other
  zero-real-blocker candidate, rejected as unverifiable without a real
  deploy target.
  Built `apps/api/src/routes/views/**`: GET/POST/PATCH/DELETE `/views`
  (cursor-paginated, scoped to the caller's own views — FR-WEB-4's
  "switcher in nav" reads as personal; shared access is exclusively via
  `GET /views/shared/{slug}` per FR-WEB-5, since the endpoint catalog
  doesn't specify a workspace-wide "shared with me" list), `POST
  /views/{id}/share` (mints a fresh 128-bit slug every call — also how
  revocation works, since the catalog has no separate unshare endpoint:
  the old slug simply stops being the one stored), `PATCH
  {is_shared:false}` as the second revocation path (gates the resolve
  query closed even though the row keeps the slug), and `PUT
  /me/default-view` (owner-only, since `isDefaultForOwner` lives on the
  view row itself, not a separate preference table).
  SC-17: `serializeSharedView` is its own schema — not a `.pick()` of
  the owner-facing shape — allowlisting exactly `{id,name,config}`;
  `serializer.test.ts` snapshot-asserts that exact key set so a future
  field added to the owner shape fails closed instead of leaking.
  `GET /views/shared/{slug}` deliberately stayed inside the
  session-guarded `/api/v1` scope rather than becoming a public link —
  v1 shares are workspace-member-only, not unauthenticated.
  Real bug found and fixed (verified empirically, not assumed): an
  async route handler that calls `reply.send()` after a prior `await`
  and then resolves with `undefined` made `@fastify/session`'s onSend
  hook run a second time — a second `Session.save()`/`store.set()`
  racing the first, throwing `ERR_HTTP_HEADERS_SENT` ~500ms later.
  Reproduced outside vitest with a standalone `tsx` script first;
  confirmed via temporary `redis-store.ts` instrumentation that
  `store.set()` fired twice per request (instrumentation reverted after,
  `git diff` clean). Same failure class as W1-04's documented
  `requireAdmin`/`api-v1.ts` preHandler bug, but this time in a terminal
  route handler rather than a chained preHandler — fixed with a local
  `fail()` helper (`sendProblem` + explicit `return reply`) across all
  17 early-return call sites.
  Two small touches outside this ticket's strict write_scope, both
  necessary and documented in `plan.json`: `api-v1.ts` gained a one-line
  child registration (its own HANDOFF comment invites this); W1-07's
  `apps/api/test/tenancy/route-walker.test.ts` gained a real walk of
  `GET /views` — v1's single-workspace design means two real logins
  can't land in two different *workspaces*, so this walk exercises
  owner-scoping (the actual boundary `GET /views` enforces) using two
  real sessions, the same substitution pattern that file's own existing
  tests already use. Workspace-level (Law 5) foreign-tenant coverage
  lives in `views/index.test.ts` itself, via a second workspace + view
  seeded directly in the DB.
  Gate: 63 test files/268 tests workspace-wide (up from 59/245 after
  W3-10), all validators pass. No new dependencies.
- Next: W0-05 (human: GitHub App registration) is the only remaining
  ticket that unblocks the rest of the board on its own merits. Within
  W5, every other ticket depends on W5-01 only indirectly or not at all
  per `plan.json` — check `validate-plan.mjs` for the current
  wave-gate-aware claimable set (still just W0-05) before picking the
  next bypass target. W3-10's nightly-job half (jobId scheduling,
  INGESTION.md §6 wiring) is the natural next increment once W2-02
  lands — its rollup/snapshot pieces are already done and ready to be
  called from that job. W3-11 through W3-13 (health score, metrics read
  API, retention sweeps) all sit behind either W3-10's remaining half or
  the wave gate and haven't been attempted. W2 (all five tickets) and
  W1-06 stay substantively blocked on W0-05 regardless of wave-gate
  bypasses.
