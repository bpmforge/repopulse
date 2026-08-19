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

- W0-05 SPLIT + DONE (2026-07-18) — the "GitHub App blocker" was
  dissolved, not cleared. Realization: the forge/ingest chain is
  fixture-driven with zero live network in CI (W0-04/W1-06/W2-03), so
  live GitHub access is needed exactly once — to *record* fixtures — and
  a `gh`/PAT read token records identical response bodies
  (FORGE_PROVIDER.md §5: "PAT = dev fallback"). None of the GitHub
  App / webhook / prod-domain ceremony gates any W1/W2 *code* ticket.
  So W0-05 was split: its dev half (read token + fixture repos) is now
  done; its prod half (production App + webhook + prod OAuth, which need
  `repopulse.bpmforge.com` live) became **W7-07**, gated on the W7-05
  deploy, with W7-06 depending on it.
  Concretely done: recording token = local `gh` token (bpmforge,
  repo+read:org); scratch repo `bpmforge/repopulse-fixture` created
  (private) and seeded with documented ground-truth counts — 3 PRs
  (2 merged, incl. one merge-commit + one squash; 1 open), 1 review,
  5 main commits (one a merge commit, for the §0 merge-exclusion
  fixture), 6 check runs, 1 deployment, 1 release, 2 issues; larger real
  repo = `bpmforge/repopulse` (25 PRs, 53 Actions runs with a real
  2/51 success/failure mix, large PRs for truncated-diff cases). Both
  named with the full count table in docs/research/github-app.md;
  .env.example reconciled (GITHUB_PAT dev / GITHUB_APP_* prod-deferred).
- Next: **W0-04 is now claimable** (fixture recorder + replay helper) —
  it unblocks W1-06 → W2-02 → W2-03, the ingest-and-metrics engine, all
  without any production GitHub App. That's the natural next ticket.
  Webhooks remain a polling optimization (backfill + nightly
  reconciliation cover correctness); live webhook delivery waits for a
  smee.io tunnel or the W7 deploy. The dev OAuth app (localhost login)
  is registerable any time but gates nothing.

- W0-04 done (2026-07-18) — GitHub fixture recorder + replay helper. The
  ingest chain's zero-live-network foundation is now real. `tools/
  fixture-recorder/` records live GitHub REST/GraphQL into
  `packages/forge/fixtures/github/` as sanitized JSON; `packages/forge/
  fixtures/replay.ts` serves them through a `RequestExecutor`-shaped
  function (the W1-05 BudgetedClient seam) and THROWS `ReplayMissError`
  on any unmatched request — the guard proving nothing escapes to
  github.com. 7 fixtures: 5 recorded live via the `gh` token (200+etag,
  304 conditional, /rate_limit, PR files with patches, and a *real*
  truncated diff — a patch-less file found in `repopulse` PR #5) + 2
  synthetic (202 stats-warmup, secondary-403 — authored because forcing
  them live is impossible/abusive, marked `provenance: synthetic`).
  Sanitizer allowlists response headers (etag, x-ratelimit-*, link,
  retry-after) and deep-scrubs token-shaped strings; a test re-asserts no
  secret material survives. GraphQL introspection **VERIFIED** the
  github-api.md §6 UNVERIFIED item: `PullRequestChangedFile` has no
  `patch` field — ingest plan stands (diffs stay REST). One documented
  out-of-scope touch (precedent: metrics W3-06): forge tsconfig include
  widened to `[src,fixtures]`. Gate: lint/typecheck clean, 276/276 tests
  (64 files, +8), all 5 validators pass.
  W0 wave is now **complete (5/5 done)**.
- Next: **W1-06 is claimable** — the GitHubProvider adapter (REST +
  GraphQL, PAT + App auth) with recorded-fixture contract tests. It
  consumes these fixtures via the replay helper and, once done, unblocks
  W2-02 (queue topology) → W2-03 (backfill) — the ingest engine. The
  App-installation-token auth mode (JWT→access_token exchange) is the one
  piece needing a hand-authored fixture (documented in the W0-05 split);
  everything else replays the recorded set.

- W1-06 done (2026-07-18) — GitHubProvider adapter (REST + GraphQL, PAT +
  App auth) with recorded-fixture contract tests. The whole ForgeProvider
  interface is now implemented in `packages/forge/src/github/`: REST reads
  for repos/commits/commit-files/PRs/PR-files/reviews/check-runs/releases/
  deployments/issues/contents, GraphQL backfill for `listPullRequests`
  (~2pt query, yields the additions/deletions/changedFiles the REST list
  omits), `registerWebhook`, and `verifyWebhook`. **Both auth modes**: PAT
  (static Bearer) and App (JWT→installation token via `@octokit/auth-app`,
  cached with proactive re-mint ~50min, concurrent-mint coalescing,
  `invalidate()` for 401 recovery). **Contract tests** inject an in-memory
  `ForgeHttpClient` stub — zero Postgres, zero network — that THROWS on any
  unrouted request (the CI-never-hits-github guard); 15 contract tests
  cover every op, both auth modes end-to-end, `patchTruncated` via the
  *real* W0-04 recorded fixture (repopulse PR #5), the GraphQL path, and
  the webhook body seam. `verifyWebhook` is HMAC-SHA256 + timingSafeEqual
  with legacy SHA-1 rejected (5 tests).
  **One additive out-of-scope touch** (the real W1-05↔W1-06 gap, documented):
  `RequestExecutor`/`ForgeRequest` gained an optional `body?` so GraphQL/
  webhook POSTs carry a body — GET callers unaffected. The prod octokit
  executor defers ALL retry to our budgeter (throttle callbacks return
  false, retry disabled) and converts octokit's thrown HttpErrors back to
  `{status,headers,body}` so the BudgetedClient stays the single source of
  304/403/429/5xx handling (Law 7 intact). arch rules 3–4 green
  (octokit + api.github.com confined to `packages/forge`; no tarball/
  zipball/raw-diff/search paths). Gate: lint/typecheck clean, **301/301
  tests** (67 files, +25), all 5 validators pass. octokit deps match
  TECH_STACK majors.
  **W1 wave is now complete (9/9 done).**
- Next: **W2-01 and W2-02 are both claimable** — the credential vault +
  org connect flow + webhook registration (W2-01) and the BullMQ queue
  topology + backfill planner (W2-02). Together with W2-03 (backfill
  workers, unblocked once W2-02 lands) they are the ingest engine — the
  first point where real repo data flows into the warehouse. The 202-stats
  fallback orchestration lives in W2-03, not the provider.

- W2-02 done (2026-07-18) — BullMQ queue topology + DLQ + graceful
  shutdown + backfill planner/state machine. The ingest **harness** is up
  (the entity processors that pull GitHub data are W2-03). `packages/
  ingest/src/queues/`: 5-queue topology + DLQ with jobId idempotency keys,
  per-queue retry policies + priorities (INGESTION §6); a
  `ShutdownCoordinator` that on SIGTERM stops intake and drains workers
  ≤30s then force-closes (jobs resume from cursor); queue-depth/active/
  failed/DLQ Prometheus gauges on the W1-09 registry. `packages/ingest/
  src/plan/`: the backfill planner (now−365d window, pushedAt-desc repos,
  PRs→commits→checks→issues→releases→deployments) and the per-repo sync
  state machine (legal-transition-only, mapped to `repos.sync_status`).
  `apps/api/src/workers/`: `createWorkerRuntime` (builds queues, a worker
  per injected processor, wires each to the DLQ, returns a ready
  coordinator) + a worker `/healthz` + `/metrics` http server + the
  entrypoint.
  **A real bug the poison-message integration test caught**: BullMQ
  forbids `:` in custom job ids, but INGESTION §6 renders the idempotency
  keys with colons — switched the separator to `-` (same semantics),
  documented the constraint. The live `describeIfLiveInfra` DLQ test
  proves an exhausted job lands in *both* the DLQ queue and the
  `job_failure` ledger and never blocks the queue (NFR-11).
  Gate: lint/typecheck clean, **325/325 tests** (74 files, +25 incl. the
  live DLQ integration test), arch rules + all validators pass.
- Next: **W2-03 (backfill entity workers) is now claimable** — it plugs
  real processors into this harness: per-page cursor checkpoints in the
  same txn as the page's idempotent upserts, budget yielding (≤20 pages
  then re-enqueue), the 202-stats-warmup→per-commit-REST fallback, and
  identity attribution. **W2-01** (credential vault + connect flow) is
  also claimable and independent. Together they are the live ingest path.

- W2-03 done (2026-07-19) — backfill entity workers. Real repo data now
  flows into the warehouse through `packages/ingest/src/backfill/`. Every
  entity upserts idempotently on its documented natural key
  (onConflictDoUpdate), so a re-run produces **zero duplicates**. The
  per-page cursor checkpoint is written in the **same transaction** as
  that page's upserts, so a killed job resumes from exactly the last
  committed page — the live kill-resume test (ingest one page, stop,
  resume from the cursor) reaches completion with no dupes or gaps
  (FR-INGEST-3). Budget yielding: a job ingests ≤20 pages then re-enqueues
  with its cursor; on the `ForgeBudgetParkedError` floor it writes nothing
  that round, flips the repo to `paused_budget`, and re-enqueues with
  delay-to-reset — never busy-waits (FR-INGEST-4). Email-only commits
  (authorLogin null) get an `email:{address}` fallback identity so
  churn/ownership never silently drop them (DATABASE §2 note 4).
  Enrichment fills `commit_files` and rolls churn totals onto the commit
  (`stats_source=detail`); the 202-stats fast path is provider-internal,
  so enrichment uses the documented per-commit REST fallback. All proven
  against **live Postgres** with a deterministic fake provider (exact
  ground-truth row counts). Gate: lint/typecheck clean, **340/340 tests**
  (77 files, +15), arch rules + all validators pass.
- Next: **W2-01 (credential vault + org connect flow + webhook
  registration)** is the last independent W2 ticket — AES-256-GCM
  encryption at rest + the "connect your org" flow. Once it lands, W2-04
  (webhook receiver, reuses these upserters as delta appliers) and W2-05
  (nightly reconciliation) unblock, completing the ingest wave.

- W2-01 done (2026-07-19) — credential vault + org connect flow + webhook
  registration. Three parts across the boundary: the **AES-256-GCM vault**
  (`packages/auth/src/credentials/`) — random 12-byte IV per row, GCM auth
  tag prepended to the ciphertext blob, 32-byte `TOKEN_ENC_KEY`,
  key_version for rotation, `last4:sha` display fingerprint that never
  carries plaintext; the **connect flow** (`packages/ingest/src/connect/`)
  — dependency-injected so it never imports `auth` (ARCHITECTURE §3):
  smoke-list → classify `bad_token`/`bad_scope`/`no_repos` into distinct
  actionable errors → encrypt + persist → create `pending_backfill` repo
  rows + per-connection webhook secret + enqueue a plan per repo; and the
  **admin-only routes** (`apps/api/src/routes/connections/`) composing all
  three, with the credential **never echoed** and the list exposing only
  last4/fingerprint/repo_count. A status-aware discovery provider (thin
  client that throws on 4xx) surfaces auth failures for classification;
  real ingestion still goes through the BudgetedClient (Law 7). Gate:
  lint/typecheck clean, **357/357 tests** (80 files, +17), arch rules +
  all validators pass.
  Two documented follow-ons: live registration into `apiV1`/`app.ts`
  needs the `ingest.backfill` queue + `loadTokenKey` plumbed (deploy-wave
  wiring; the plugin is proven standalone like the W1-04 admin gate), and
  the `auto_add_new` flag needs a `forge_connections` column to persist
  future-repo pickup (W2-04/05).
- Next: **W2-04 (webhook receiver + typed delta jobs + push coalescing)**
  is claimable — it verifies `X-Hub-Signature-256` (the `verifyWebhook`
  built in W1-06), enqueues typed delta jobs that reuse the W2-03 upserters
  as delta appliers, and coalesces push bursts. Once it lands, W2-05
  (nightly reconciliation + sync status API/SSE) is the last ingest ticket.

- W2-04 done (2026-07-19) — webhook receiver + typed delta jobs + push
  coalescing. `POST /webhooks/github` (machine-facing, no session) captures
  the RAW body before JSON parse (SC-3), verifies the `X-Hub-Signature-256`
  HMAC (W1-06's `verifyWebhookSignature`) against the per-connection secret,
  dedupes on `delivery_id` (`ON CONFLICT DO NOTHING` → redelivery is a 200
  no-op, SC-4), and enqueues a typed delta job → 202. Tampered/absent/
  untracked → 401, nothing enqueued. The delta processor **pulls by
  watermark, not payload** (reuses W2-03's `ingestEntityPages`), so a replay
  leaves byte-identical state (FR-INGEST-6); `push` events coalesce per repo
  (`push:{repoId}` jobId + 30s debounce, NFR-10). All 10 §4 events routed.
  **Fixed a real W2-01 bug found here**: the per-connection webhook secret
  was stored without its IV (schema has one IV column, for the credential) —
  undecryptable, and reusing the credential IV would be a GCM nonce reuse.
  Added self-contained `sealSecret`/`openSecret` (iv‖tag‖ct, fresh IV per
  seal) and switched the connect flow + route to it. Gate: lint/typecheck
  clean, **371/371 tests** (83 files, +14), arch rules + all validators
  pass, `ingest`→`auth` boundary clean.
- Next: **W2-05 (nightly reconciliation sweep + sync status model/API/SSE)**
  is the last ingest ticket — a scheduled sweep that repairs any missed
  webhook via cursors + ETag, plus the `/sync/status` org+per-repo view.
  Once it lands, the entire ingest wave (W2) is complete and the warehouse
  stays fresh via three paths: backfill, webhooks, and the nightly sweep.

- W2-05 done (2026-07-19) — nightly reconciliation sweep + sync status
  model + `/sync/status` + SSE. **This completes the W2 ingest wave
  (5/5).** The reconcile sweep re-lists each entity from its high-watermark
  and upserts, so a **missed-webhook gap is repaired** (proven live) and
  re-running is idempotent; unchanged repos hit the BudgetedClient's ETag
  304-free path (~0 budget). `requeueErrorRepos` un-sticks error repos. The
  sync status model computes phase / 365-day time-coverage percentComplete
  / entities / lagSeconds **from the warehouse only** (FR-API-2);
  `GET /sync/status` serves the org aggregate + per-repo, and the SSE
  `GET /api/v1/events` relays a per-workspace Redis channel (SSE is the
  optimization, the GET read is the source of truth). Gate: lint/typecheck
  clean, **381/381 tests** (88 files, +10), arch rules + all validators
  pass, `ingest`→`auth` boundary clean.
  Documented follow-ons (deploy/schema wave): tombstoning needs a
  `superseded` column (METRICS §0 cites it, W1-02 lacks it); `auto_add_new`
  pickup needs its column; `RepoSyncStatus.budget` is a runtime gauge
  (served as zeros until a budget-snapshot table); and the live wiring of
  the reconcile cron + sync/events routes + worker `publishSyncEvent` calls
  is the same standalone-proven deploy wiring as connections/webhooks.

## Wave status (2026-07-19)

**W0, W1, W2 all complete.** The ingest engine works end-to-end: connect an
org (encrypted credentials) → backfill → webhooks (verified, deduped,
delta) → nightly reconciliation, with sync status + SSE surfacing progress.
The warehouse has three freshness paths. Next up is **W3 (metrics
compute)** — but note W3-10 closed `blocked` (scoped) earlier, so
W3-11/12/13 sit behind it; check `validate-plan.mjs` for the current
claimable set before picking up W3.

- W3-10 COMPLETED (2026-07-19) — was `blocked` since 2026-07-16 pending
  W2-02; now that the ingest wave is done, the **nightly metrics.snapshot
  compute job** is built and W3 is unblocked. `computeRepoSnapshots` reads
  the warehouse and computes **M1–M12 for every window**, writing one
  snapshot row per metric × window (numerator/denominator for the ratio
  metrics), two runs → two rows (append-only). ~9 warehouse readers adapt
  the fact tables to the pure W3-02…W3-09 metric-function inputs. Proven
  live incl. **merge exclusion** (M1 = 15 from the non-merge commit, not
  215) — the correctness fix that was the real blocker.
  **Cross-scope schema fix (user-approved):** the metric functions were
  built against inputs the W1-02 schema didn't fully provide — merge
  detection needs the commit parent count, which W2-03 backfill computed
  and dropped for lack of a column. Added `commits.is_merge` (migration
  0003) + set it in the backfill. Two documented conservative reads
  (correct today): `superseded=false` (nothing tombstoned yet) and review
  `hasContent=true` (body not warehoused). Gate: **384/384 tests**, all
  validators pass.

### Systemic finding (2026-07-19): metric-function ↔ schema fidelity gap

The W3-02…W3-09 metric functions were specified against **richer inputs
than the W1-02 warehouse schema stores**. W3-10 surfaced this while
building the warehouse→input readers. Handled so far: `is_merge` added
(migration); `superseded`/`hasContent`/issue-reopen-history read with
documented conservative defaults. **Future metric-fidelity work may need
more columns** — e.g. a `superseded` flag (when tombstoning lands, W2-05
follow-on), review-body content (for rubber-stamp detection, M5/M6), and a
PR review-event timeline / issue reopen history (M4/M10 exactness). Each
reader documents its approximation inline. Not blocking — the current
snapshots are correct within the documented bounds — but worth a schema
pass before the metrics are treated as exact.

- W3-12 done (2026-07-19) — metrics read API. Warehouse-only endpoints
  over the W3-10 snapshots + W3-11 insights: `/metrics/{catalog,series,
  current}`, `/org/{summary,health-tiles,attention}`, `/hotspots`. A
  **runtime nock guard** (mock `fetch` → throw) proves every handler
  completes with zero HTTP egress (C1, FR-API-2). Session-authed, zod-
  schema'd (OpenAPI auto-generates). Gate: **400/400 tests**, all
  validators pass. Health-tile deltas + the NFR-3 k6 p95 smoke +
  live route registration are deploy-wave follow-ons.
- Next: **W3-13 (retention sweep jobs)** is the last W3 ticket — nightly
  retention of `metric_snapshots` / `forge_etag` / `webhook_delivery`.
  Then W3 (metrics) is complete and W4 (web dashboard, which consumes the
  W3-12 read API) opens.

- W3-13 done (2026-07-19) — retention sweeps. `pruneMetricSnapshots`
  (metrics pkg, >400d, batched), `pruneForgeEtag` (90d LRU) +
  `pruneWebhookDelivery` (30d) (ingest pkg). **Immutability guard**: no
  sweep touches `reports`/`egress_audit` (enforced by construction +
  asserted + a seeded report survives; egress_audit DELETE also denied at
  the DB grant level). Live: out-of-policy swept, in-policy kept,
  idempotent. Split across packages because `ingest` can't import
  `metrics` (ARCHITECTURE §3). Gate: **405/405 tests**, all validators.
  Cron wrapper is deploy-wave.

## W3 (metrics wave) COMPLETE — 13/13 (2026-07-19)

W0, W1, W2, W3 all done. The pipeline is whole: connect → ingest
(backfill/webhooks/reconciliation) → nightly metric snapshots (M1–M12) →
health score / trends / cross-repo hotspots → warehouse-only read API →
retention. Next: **W4 (web dashboard)** consumes the W3-12 read API.

- W4-01 done (2026-07-19) — drill-down + personal API + identity mapping.
  The full chain (`/repos` → `/repos/{id}` → `/repos/{id}/prs` →
  `/prs/{number}` → `/files/*`) with children `links` at each level (an
  integration test walks it), plus per-repo hotspots/contributors. Identity
  mapping (`resolveUserIdentity`) links a workspace user → forge author so
  `/me/{prs,review-queue,hotspots,stats}` return their ground truth
  (FR-AUTH-6). Tenancy route-walker extended over the new routes. Gate:
  **409/409 tests**, all validators pass. Auxiliary repo endpoints
  (trends/pr-flow/ci) are a thin follow-on over existing metrics.
- Next: **W4-00 (Playwright e2e harness + deterministic warehouse seeder +
  axe)** and **W4-02 (web shell + component kit)** are the remaining W4
  foundations — the actual frontend. W4-02 is the big React/Tailwind shell
  (8 pts) consuming the W3-12 + W4-01 read API.

- W4-00 advanced, status BLOCKED (2026-07-19) — the **deterministic
  warehouse seeder** is done + verified (`seedWarehouse`: multi-repo org +
  second workspace + fixture identity + facts + M1–M12 snapshots, seeded-RNG,
  idempotent; 3 live tests; `pnpm seed` works). The **Playwright harness** is
  built + structurally verified (config parses, spec lists): mocked-OAuth
  login helper, runtime egress guard (fail on forge/LLM host), axe helper,
  global-setup=seed, shell smoke spec, `pnpm e2e`. **Gated on W4-02**: the
  browser run + axe-on-a-rendered-shell needs the shell to serve + a
  Playwright browser install — so W4-00 stays `blocked` (Law 3) until W4-02
  lands, then the smoke spec runs green and every screen ticket reuses this
  harness. Gate on committed work: **412/412 tests**, all validators pass.

- W4-02 done (2026-07-19) — **web shell + component kit + data/SSE layer**.
  `apps/web` foundation: `__root` shell (collapsible rail, topbar with
  URL-serialized window/repos/person filters, sticky breadcrumb, dark-first
  Tailwind 4 `@theme` tokens + light toggle); kit (WidgetFrame state machine,
  WidgetGrid + WidgetRegistry, ECharts Chart wrapper w/ theme-token bridge +
  view-as-table + reduced-motion + dispose, DataTable w/ TanStack Table +
  URL-synced sort/cursor + j/k/Enter/x, KpiTile/HealthBadge/TrendDelta/
  Sparkline/SeverityBadge/SyncStatusChip); typed client generated from a
  committed OpenAPI snapshot (openapi-typescript) + TanStack Query (30s
  staleTime, keepPreviousData); zustand UI store; SSE client (one EventSource,
  debounced invalidation, batched role=status toasts, reconnect + Last-Event-ID);
  URL params zod-validated via `packages/shared/src/urlState.ts`. Gate: **462
  tests / 106 files** (44 new web tests), lint + typecheck + validate-arch +
  validate-plan green, `vite build` succeeds (shell ~102KB gz, echarts out of
  the main chunk).
  - **Read-API mounting fix (closes a W3-12/W4-01 omission)**: the metrics-read
    + drill-down/personal route plugins were authored + contract-tested but
    never registered in the production app — their tests mounted them into
    throwaway apiV1 scopes, so the whole read API was unreachable and absent
    from the OpenAPI doc. Now mounted in `api-v1.ts` (double-registration in the
    affected tests removed).
  - **web↔shared boundary**: `urlState.ts` published as the runtime-safe subpath
    `@repopulse/shared/url-state` (barrel stays type-only) via a package.json
    `exports` map + an eslint `paths` carve-out — web value-imports only that
    pure-schema module (the boundary's real purpose, keeping DB/server code out
    of the browser bundle, is preserved).
  - **Deferred follow-ups** (documented in `api-v1.ts`): `GET /api/v1/events`
    (SSE) NOT mounted — its socket hijack hangs the W1-07 tenancy route-walker
    and it needs redisUrl threaded; the web SSE client is unit-tested against a
    mock, so live wiring is a small follow-up. Admin connections/sync + webhooks
    also stay unmounted (different auth surface). Routing is code-based for the
    foundation; @dnd-kit edit mode + ECharts variants land with the screens.
  - **Unblocks W4-00**: the shell now serves, so W4-00's browser e2e + axe run
    can proceed once a Playwright browser is installed (still `blocked` on that).
    W4-03..W4-08 now claimable.
  - **Known / carried forward**: (a) routing is code-based in `main.tsx` while
    DASHBOARD §1 + TECH_STACK specify file-based — flagged in the W4-03 ticket
    note to reconcile before the first screen diverges further. (b) With
    `/api/v1/events` unmounted, the SSE client reconnects with backoff against a
    404, so the rail sync chip reads "Reconnecting…" in the running app until the
    endpoint lands — honest (the stream genuinely isn't connected), not a bug.
    (c) The metrics/connections live tests share the `default` workspace and
    clean by `workspaceId`; they're sensitive to stale rows left by an
    interrupted prior run (a `dev-down --volumes` reset clears it). Pre-existing
    test-isolation fragility, not a W4-02 regression — CI on a fresh volume is
    unaffected.

---

## 2026-08-12 — Launch path assessment (what stands between here and running)

**The backlog is not the launch path.** 65 tickets / 314 points are open, but
ROADMAP decision D5 defines **MVP = W0–W4**, and W0–W3 are complete (32/32).
The path to a running system is **~52 points**:

| Lane | Tickets | Points | Why it is on the path |
|------|---------|--------|-----------------------|
| W4 remainder | 10 | 40 | The MVP gate itself (W4 exit demo) |
| W7-05/06/07 | 3 | 7 | The ONLY production-deployment tickets on the board |
| W7-04 | 1 | 5 | Standing a11y/perf CI gate; W4-12 is its prerequisite |

W5, W6, W8, W9 and W10 — **246 points** — are post-launch by the ROADMAP's own
definition. Nothing in them is required to deploy and run the MVP.

**Recommended departure from wave order:** pull W7-05 (containers/TLS/secrets),
W7-06 (runbook execution + prod smoke) and W7-07 (prod GitHub App + webhooks +
OAuth) forward, ahead of W5/W6. Every production-deploy ticket currently sits
four waves past the MVP gate, so as sequenced the project reaches "MVP demo
passed" long before it can reach "running". This is deliberate re-sequencing,
recorded here rather than done silently.

**Ticket order inside W4** — W4-13 first, and this ordering is load-bearing:
the fixture blocks W4-03 *and* every later screen ticket's e2e. W4-04/05/06/07
all assert against the same seeded warehouse and will each hit the single-point
series and the 30d-only window bucket. Fixing it once is the first domino;
fixing it after four more screens have worked around it is four reworks.
Then W4-12, then the screens (W4-04..W4-07), then W4-08/09/10.

**W4-12 is on the critical path, not polish.** W4's own exit criteria include
"axe passes on all MVP routes". W4-12 is a measured WCAG AA contrast failure in
shared primitives that render on those routes, so the badge-token decision gates
the MVP demo. It should not be triaged as cosmetic a11y cleanup.

**Open risks with no owning ticket:**
- **The connect flow has never run against real GitHub.** Every connect and
  webhook test mocks the forge, and `forge_connections` has never held a real
  row. W4's exit criteria require connecting the real bpmforge org through that
  flow. This is the highest-variance unknown on the launch path and deserves an
  early spike rather than discovery at the gate.
- **`GET /api/v1/events` (SSE) is still unmounted** (carried forward from
  W4-02). Until it lands, the Org Overview sync banner and per-repo progress
  chips cannot populate live — and "watch progressive backfill … tiles populate
  as data lands" is an explicit W4 exit criterion.
- **Caller role is not exposed to the SPA.** `api-v1.ts` sets `request.role`
  server-side and never returns it. Nearest owner is W4-08 (admin guard +
  Members tab), but exposing the *caller's own* role is not in its acceptance —
  confirm when scoping it. Blocks W4-03 acceptance 3.

**Founder-only actions (not buildable, and historically where this portfolio
stalls):** register the production GitHub App under the bpmforge org with C5 /
SC-25 scopes; provision `repopulse.bpmforge.com` + TLS + prod host access;
and decide the launch target — the ROADMAP's definition is an internal prod
smoke on bpmforge infra (W7-06), which is NOT the same as the customer-hostable
product framing (packaging, install docs, licensing, tenant onboarding). That
delta is a separate, currently unscoped lane.

### 2026-08-12 (same day) — launch path RE-COSTED against the real goal

The ~52-point figure above was measured against the ROADMAP's definition of
launch (D5 MVP + a prod smoke on bpmforge infra). Founder confirmed the actual
goal is different in two ways, both now recorded in the brief:

- **D1a**: the delivery model is **customer-hosted** — a customer runs RepoPulse
  in their own environment, against their own forge, with their own LLM.
  bpmforge's install becomes the first dogfood install, not the product.
- **D9a**: "fixes" means **recommend and verify**, not write. Ranked,
  evidence-linked plan items with machine-checkable verify criteria and a
  nightly done/regressed job. N-3 is NOT graduated; C5/SC-25 read-only App
  scopes stand. RepoPulse never opens a branch, patch or PR comment.

**Re-costed launch path: 21 tickets / 82 points** (of 70 open / 331 total):

| Lane | Tix | Pts | Why it is on the path |
|------|-----|-----|-----------------------|
| W4 remainder | 10 | 40 | The MVP gate |
| **W5-06/07 Improvement Plans** | 2 | 13 | This is "fixes" per D9a — moved ONTO the path |
| W7-04/05/06/07 | 4 | 12 | Deploy + the standing a11y/perf gate |
| **W11 self-host (new)** | 5 | 17 | Packaging, config, upgrade/restore, licensing, clean-host smoke |

W5-06/W5-07 moved from post-launch to launch-critical: under D9a they ARE the
fix half of "reports and fixes". W6 (Tier-2 LLM), W8 (security suite), W9 (code
health), W10 (risk registers) and the rest of W5 stay post-launch — 249 points.

**Sequencing** — W4-13 → W4-12 → W4 screens → W7-05/06/07 → W5-06/07 → W11.
W11-04 (licensing/distribution) is a founder decision that BLOCKS publishing any
image publicly, so answer it before W11-01 ships. W11-05 (clean-host smoke) is
the real acceptance test for D1a: not that we can deploy it, but that someone
else can from the docs alone.

**Unchanged and still the biggest risk:** the connect flow has never run against
real GitHub. Under D1a that failure would now land on a customer's infra, where
we cannot debug it. The early spike matters more, not less.

### 2026-08-12 — secret hygiene audit (Law 9)

Swept tracked files and history for credentials and internal infrastructure.
Two real findings, both fixed:

- **`.env.example` shipped the live `TOKEN_ENC_KEY`** — the committed value was
  byte-identical to the one in the working `.env`. That key decrypts every stored
  forge credential (FR-AUTH-5), so a committed key is a published key, and
  CLAUDE.md Law 9 says nothing secret goes in git. The template now ships the
  variable EMPTY with `openssl rand -hex 32` as the instruction. The live key was
  **rotated**, which is free today and expensive later: `forge_connections` holds
  zero rows with real ciphertext, so nothing had to be re-encrypted. The old key
  remains in git history permanently and must never be reused.
- **LAN addresses committed** — `LMSTUDIO_BASE_URLS` in `.env.example` and a line
  in `docs/DEPLOYMENT.md` named two internal hosts by IP. Removed: they are
  operator-specific, and under D1a (customer-hosted) a customer's install has no
  relationship to them. Both now describe the variable instead of prefilling it.

Verified clean: `.env` has never been committed (0 hits across all history) and
stays gitignored; no private-range IPs remain in any tracked file; every
`ghp_`/`sk-ant-` shaped string in the tree is a synthetic test fixture
(`ghp_example`, `'z'.repeat(36)`); remotes address Gitea by domain, not IP.
Recorded forge fixtures reference `bpmforge/repopulse-fixture`, a purpose-made
public fixture repo — no private repo content.

**Method note:** the first pass used a broad `git grep` for private IP ranges and
returned nothing. A direct `grep` on `.env.example` found two. The broad sweep
gave a false all-clear, so both findings above came from reading the files rather
than trusting the scan.

**Still open (not a leak, but the IP question):** the repo has no `LICENSE` and
`package.json` carries `private: true` with no `license` field. That is W11-04,
and it blocks publishing any image or artifact publicly.

### 2026-08-13 — MVP redefined (D3a): self-hosted AND multi-forge

Founder correction, recorded as brief amendments rather than left in a
conversation. **The MVP is: a customer runs RepoPulse in their own container
system and points it at their own repositories — GitHub, GitLab or Gitea.**

Three consequences, and one of them is a correction to this file's own advice:

- **A GitHub App is NOT required to connect, and never was.** The connections
  API accepts `auth_kind: 'pat'` and the Admin → Connections form already sends
  it: `authFor('pat', credential)` → `{kind: 'pat', token}`. Earlier entries
  here framed "register a production GitHub App" as the launch blocker. It is
  not — it is the richer path (org-scale webhooks, higher rate limits), while a
  personal access token is the ordinary self-host path and works today. The
  "never authenticated against a real forge" risk is unchanged and still real;
  what changed is that clearing it needs a token, not an App registration.
- **W11 self-host packaging moved from post-launch to the MVP itself**, and
  bpmforge's own production deploy (W7-05/06/07, 7 pts) moved OFF the path. If
  the product is customer-hosted, our own prod install is dogfood, not a gate.
- **N-6 is graduated for GitLab** (Bitbucket stays a non-goal). Gitea (W7-02)
  becomes MVP scope, and GitLab gets W12-01. The `ForgeProvider` interface and
  its capability flags do not change — this is adapter work plus the existing
  contract suite, which is exactly what that interface was built for.

**Corrected MVP: 15 tickets / 60 points** (of 324 open):

| Lane | Tix | Pts |
|------|-----|-----|
| W4 screens + the four API gaps | 6 | 20 |
| W11 self-host packaging | 5 | 17 |
| Forge: Gitea + GitLab + fake-forge e2e | 3 | 18 |
| W7-04 a11y/perf gate | 1 | 5 |

Also filed **W12-02**: a fake forge server for e2e, so the connect → backfill →
render path can be proven end to end with no credential from anyone. That is the
buildable half of the biggest open risk; a real token afterwards becomes a
confirmation rather than the first-ever execution of the product's most
important path.

### 2026-08-13 — wiring audit: the async tier has never run

Stepped back after the fourth built-but-never-mounted defect in a week and ran
the systematic check instead of finding a fifth by accident. Results:

- **Routes: 14/14 mounted.** That class is closed — the three gaps (SSE events,
  connections/sync, webhooks) were fixed this week.
- **Queues: 6 declared, 0 processors.** Not just backfill. `delta`, `enrich`,
  `reconcile`, `snapshot` and `dlq` are inert too. Accepted webhook deliveries
  are never applied; metric snapshots are never computed.
- `@repopulse/analysis` and `@repopulse/reports` are imported by no app — but
  those belong to W6 and W5, which have not started. Not a defect.

**What this means for the board.** W2 (ingestion, 5/5 done, 25 pts) and W3
(metrics, 13/13 done, 45 pts) are code-complete and fully unit-tested, and none
of that code executes in production. Today's dashboard is a view over a
warehouse the **seeder** fabricates — which is precisely why it has looked
healthy through every demo and every screen ticket. 70 points of "done" work is
real code that has never run outside its own tests.

The MVP count is unaffected in points (W12-03 was already on the path, re-sized
8 → 13) but the *character* of the remaining work is different from what the
"48 done" headline suggests: the screens are genuinely finished, and the engine
behind them has never been switched on.

**Prevention, not just repair:** `apps/api/test/wiring.test.ts` now fails the
build when a route module is unregistered, or when a queue is declared without a
processor and is not on an explicit `KNOWN_INERT` list. The list is
two-directional — landing a processor without removing its entry also fails — so
the debt cannot be re-accrued behind a stale allowlist. RED-checked both ways.
Every one of the four defects would have been caught by this on the day it
landed.

### 2026-08-13 — continuation handoff written

`docs/work/CONTINUATION_2026-08-13.md` is the clean-slate entry point for the
next session: product definition and the D1a/D3a/D9a MVP, current branch and
board state, what genuinely works versus what has never run, the exact W12-03
symptom with a two-minute reproduction, the six environment traps, and the
founder-only list. Start there rather than re-deriving any of it.

### 2026-08-13 — the engine is switched on: ingestion writes real rows

**RepoPulse ingested data for the first time.** `fixture-org/alpha-service`:
3 commits (REST) and 2 PRs (GraphQL), `sync_status` off `pending_backfill`, all
five `sync_cursors` at `backfill_done`, backfill queue completed 6 / failed 0 /
delayed 0, and the metric snapshot computed over those rows rather than over
nothing (M7 = 24.0, dims `{S: 2}` — the two ingested PRs).

**The blocker was SC-12, not the queue.** The handoff's diagnosis — five entity
jobs stuck unexecuted in BullMQ's `delayed` set — was wrong. They ran, threw,
and went to `delayed` awaiting exponential-backoff retry: `attemptsMade=1` with
`delay=30000` exactly matching `RETRY[ingest.backfill]`, and `failed=0` only
because attempts weren't exhausted. Every job died on `ForgeSsrfError: scheme
must be https, got http:` — the base-URL guard correctly rejecting the
`http://127.0.0.1` fake forge. One `HGETALL` of the job hash would have replaced
a session of theory; the guidance now recorded in the handoff is to read
`failedReason`/`stacktrace`/`atm` before reasoning about queue state.

Resolved with an operator-only, loopback-only escape hatch (off by default,
allowlist still enforced). It is defensible precisely because the forge base URL
is **not user input anywhere** — it comes from the operator's `FORGE_BASE_URL`
at the composition root and no route or UI accepts one. A LAN forge over plain
`http` stays rejected; that remains a founder posture decision.

**Two production bugs surfaced alongside, neither test-related.** The SC-12
allowlist entry was derived from `URL.host` (with port) but matched against
`URL.hostname` (without), so **any self-hosted forge on a non-default port —
`https://git.corp.com:8443` — could never match its own allowlist entry.**
Invisible on `api.github.com`, where 443 leaves `host` port-less, and squarely
in D1a MVP scope. The same mismatch appeared again with bracketed IPv6 hosts.

**A fifth built-but-never-called defect.** `plan/state-machine.ts` defines the
entire `queued → history → enrichment → live` lifecycle, is fully unit-tested,
and had no production caller: `setRepoStatus` was only ever invoked for
`paused_budget`, so **no repo had ever left `pending_backfill`.** Related, and
worse: the metrics snapshot was enqueued immediately after the plan fan-out, so
it ran *before* any entity job wrote a row and every metric persisted as
`0.000000` over an empty warehouse. That is the concrete mechanism behind "the
dashboard has always looked healthy."

**Verification is now automated, which is the whole point.** The worker runs as
a Playwright `webServer` using the shipping entrypoint, so the assertion runs on
every `pnpm e2e` instead of only when someone starts a worker by hand;
`globalSetup` flushes `bull:*` first, because BullMQ's jobId idempotency would
otherwise let a run inherit an earlier success and report green while ingesting
nothing. Negative control performed — flipping the SSRF opt-in off makes the new
test fail with `commits 0`.

Gate: lint 0, typecheck 0, **487 unit tests** (was 465), **40 e2e** (was 39),
all exit 0.

**W12-03 stays `in_progress`, deliberately.** Its acceptance requires all six
queues registered and `KNOWN_INERT` shrunk to `[]`; enrich, reconcile and dlq
are still inert. The core loop — the consequential part — is done and proven.
Recommend splitting the remaining three queues into their own ticket so the
proven loop can close; that is a founder call, not one to make silently.

### 2026-08-13 — the loop is closed end to end: forge → warehouse → screen

Merged to `main` (both remotes). The core loop now runs from a PAT typed into
the Admin UI all the way to rendered pixels, and every segment of it is asserted
on each `pnpm e2e` run.

**W12-02 acceptance 3 and 4 are met.** Two assertions of deliberately different
strength: the org overview renders a health tile for the ingested repo, and the
PR list shows PRs #11/#12. The second is the one that bites — a repo *row* comes
from repo **selection**, so a tile alone would still appear if the backfill wrote
nothing, whereas those PR rows exist only because the GraphQL backfill wrote
them. Negative control run: pointing the locator at never-ingested PR numbers
fails rather than passing vacuously. The egress guard now runs on this spec too —
it is the one flow that genuinely talks to a forge.

**What is deliberately NOT done.** The fake forge still does not serve reviews or
checks. Those are enrich-lane fetches and the enrich processor is unwired, so
fixtures for them would be unverifiable — which is precisely the pattern this
codebase keeps finding. They move to the enrich ticket, where they can be
asserted the same way PRs now are.

**W12-03 split into W12-05** (enrich, reconcile, dlq — 8 pts). The consequential
part of W12-03 is finished and proven; holding the ticket open for three unwired
lanes obscures that. W12-05 also unblocks the `live` phase — `enrichment_complete`
can only be raised by the enrich processor, so a fully backfilled repo today
correctly stops at `backfilling`, and shortcutting `history_complete` straight to
`live` would contradict INGESTION §2.

Both W12-02 and W12-03 are left `in_progress` rather than marked done against
their literal acceptance text. Re-scoping acceptance is a founder call; the
recommendation is recorded in each ticket.

Gate: lint 0, typecheck 0, 487 unit, 40 e2e, all exit 0.

### 2026-08-13 — W12-05: enrichment, reconciliation, and the DLQ-is-a-sink correction

Every queue now either has a consumer or is an asserted sink. `KNOWN_INERT` is
`[]` for the first time.

**The acceptance criteria were wrong and were corrected before any code.** They
had been written without reading INGESTION §2/§3/§6 and contradicted the design
three ways: enrichment is per-commit **file churn** (§6 payload
`commitFiles {repoId, sha}`), not reviews/checks; **checks are a history-phase
entity** (§3), not an enrichment one; and the **DLQ must not have a processor**
at all — `attachDeadLetter` feeds it and the ops page reads it, so a consumer
would drain the very failures it exists to preserve. That last point also made
`KNOWN_INERT == []` unreachable *by design* for W12-03, so `wiring.test.ts` now
distinguishes "inert because unwired" from "intentionally a sink" and asserts
both halves of the DLQ contract.

**enrich had neither a producer nor a consumer.** Registering a processor alone
would have been a consumer for a queue nothing feeds. `fanOutEnrichment` now
emits one churn job per commit from the history-complete hook, and the same
predicate that builds that work-list defines "enrichment drained" for the
`enrichment → live` transition — one definition, so the producer and the state
machine cannot disagree.

**A bug this nearly shipped with.** The predicate was first written as
`additions IS NULL`. That is wrong: the history backfill already populates
additions from the list payload and stamps `stats_source='graphql'`, so the
producer would have found no work, declared enrichment drained immediately, and
flipped repos to `live` with churn metrics still at zero — a silent, plausible
failure. The correct marker is `stats_source IS DISTINCT FROM 'detail'`, since
only `upsertCommitFiles` writes `'detail'`.

**Measured.** `fixture-org/beta-web` reaches `live` with 4 `commit_files` rows,
and the churn metrics that read `0.000000` for the first ingested repo now read
**M1 = 94.0** (`{net: 62, rework: 68}`) and **M2 = 0.954842**. Negative controls
run against the full path: unregistering the enrich processor fails the e2e with
`commit_files 0` and the repo stalls at `backfilling`.

**reconcile ships with its schedule**, not just a processor — a nightly
repeatable job whose own jobId keeps N worker replicas to one schedule. Its sweep
rescues errored repos (`requeueErrorRepos` had no caller since W2), sweeps live
ones under the §6 idempotency key, and deliberately leaves in-flight backfills
alone rather than fighting their cursors.

**Open, and genuinely a design question rather than missing work:** reviews have
no lane. `upsertReviews` and `listReviews` are fully built and called by nothing;
reviews appear in no entity order and no queue payload, yet `sync_cursors`
permits the type. PR detail renders an empty reviews section for ingested repos.
`checks` is related but distinct — it *is* in the history entity order but needs
a non-paginated path, since checks are fetched per head-SHA. Neither was resolved
by picking a lane.

Gate: lint 0, typecheck 0, **494 unit tests** (was 487), 40 e2e, all exit 0.

### 2026-08-13 — W12-06: enrichment broadened, and un-hookable repos survive connect

Founder decisions taken on all four open questions. W12-02 and W12-03 close;
**zero tickets in progress, 53 done.**

**Enrichment now covers every per-parent detail fetch** — commit churn, PR
reviews, and check runs — instead of churn alone. Reviews are keyed on a PR
number and checks on a head SHA, so neither can go through the paginated
repo-scope walk that history uses; `processBackfillJob` accepts only
`PaginatedEntity` for exactly that reason. This resolves the inconsistency where
INGESTION §3 listed `checks` in the *history* entity order. No new queue —
`ingest.enrich` already had the right priority and retry policy, so it gained
job kinds. **INGESTION §2/§3/§6 amended to match**, because a doc that disagrees
with the code is how the next session re-derives the same problem.

`upsertReviews` and `upsertCheckRuns` were both fully built, fully tested, and
called by nothing — the sixth instance of that pattern. The visible symptom was
PR detail rendering an empty reviews section for every ingested repo.

**Schema:** added `pull_requests.enriched_at` (migration 0004, one additive
nullable column). A **per-PR** marker, not a repo-level high-watermark: enrich
jobs run concurrently and finish out of order, so a watermark could advance past
PRs that never ran and report enrichment drained — flipping the repo to `live`
with reviews missing. Counting child rows fails differently: a PR with genuinely
zero reviews and zero checks would look permanently pending and hold the repo at
`backfilling` forever.

**Webhook registration is now non-fatal, and that was a real bug.** The repo row
is inserted *before* `registerWebhook` and `enqueuePlan` comes *after*, so an
unguarded throw left the repo parked in `pending_backfill` with no work ever
queued — stuck silently and permanently. It fails legitimately in two supported
cases: a **public repo the operator does not administer** (hook creation needs
admin; reading does not imply it) and a **self-hosted install with no publicly
reachable URL** (D1a), where deliveries could never arrive anyway. Webhooks are a
freshness optimisation; backfill loads the history and the nightly reconcile
sweep repairs what a missed delivery would have carried. The failure is recorded
on `repos.last_error` rather than swallowed.

**A fixture bug an exact count caught:** check runs were given per-PR ids
restarting at 1, and `check_runs` upserts on
`(repo_id, kind, forge_run_id, run_attempt)` — so PR 12's `build` silently
overwrote PR 11's and 2 of 3 rows landed. A `>0` assertion would have passed.

Measured: `fixture-org/beta-web` reaches `live` with 3 reviews, 3 check runs,
4 `commit_files`, 3 commits, 2 PRs, both PRs carrying `enriched_at`; PR detail
renders both sections.

Gate: lint 0, typecheck 0, **495 unit tests**, 40 e2e, all exit 0.

### 2026-08-14 — the nightly sweep I shipped yesterday broke the test suite

The e2e suite went from **9 seconds green to 33 minutes with 17 failures**, and
the failures pointed nowhere near the cause: `page.goto` timeouts, missing
locators, page-setup timeouts, spread across nearly every spec.

**Cause: the reconcile cron I added in W12-05 fired mid-run.** It is set to
`17 3 * * *`, the runs happened at ~03:17, and the sweep does the one thing this
worker does on a wall clock rather than on demand — re-list five entities for
every `live` repo. The seeder creates `live` repos, so the sweep flooded the
worker with work no test asked for, against the same database the suite was
asserting on.

Proven by the fix rather than argued: `RECONCILE_CRON=off` in the harness
returned the suite to **40 passed in 9.6s**, and the unit suite from timing out
at 10 minutes to **31 seconds**.

`RECONCILE_CRON=off` is now a supported operator switch, not a test hack — an
operator scheduling reconciliation externally needs exactly the same thing.
`apps/api/test/wiring.test.ts` pins the harness setting, with a negative control.

**Two other latent order-dependencies fixed on the way**, both the same shape:
`pr-screens` and `repo-detail` took "the first health tile" and assumed seeder
content (5 PRs, four metric charts). The ingest specs add real repos to the same
workspace, and since those now reach `live` they can render ahead of the seeded
ones. Both now target a seeded repo **by name** — `SEED_REPO_NAMES` is exported
for that. Position is not identity.

And a bug in my own e2e helper: `waitForIngestedRepo` required
`pullRequests > 0`, so a real repo with no PRs (`bpmforge/quarry`) could never
satisfy it and the poll ran to its deadline on a repo that had finished
perfectly. `live` alone is the completion signal — it already implies history
complete and both halves of enrichment drained. Row counts are the caller's
assertion, not the wait condition.

**Also filed, not fixed: W12-07.** The unit suite failed 3 auth-dependent tests
once and passed 497/497 on an immediate re-run with no change. The error is a
missing `oauth_state` cookie — the shape of a 429 from SC-11's 10/min/IP auth
limit, which parallel test files can trip. `e2e/global-setup.ts` documents the
same hazard and logs in once for the whole run; the unit suite has no
equivalent. Latent, not new, and deliberately not "fixed" by weakening a real
security control.

Gate: lint 0, typecheck 0, **497 unit**, 40 e2e + 1 skipped (real-forge smoke),
all exit 0.

### 2026-08-14 — Gitea adapter, a reliable gate, and images a customer can actually pull

Three tickets, sequenced rather than parallelised because W7-02 → W12-01 is a
hard dependency chain.

**W12-07 — the gate is trustworthy again.** The flake was not primarily a rate
limit: five test files each carried their own `loginAs` built on `!`
assertions, so any unexpected auth response surfaced as
`Cannot read properties of undefined (reading 'value')` **from a repo-route
test**. The evidence was being destroyed at the point of failure. One shared
helper now reports the real status, and caches sessions per app+user — each
login costs two requests against a 10/min cap and two suites sat exactly on it.
SC-11 is untouched: still 10/min/IP, still exercised directly. 11 consecutive
clean runs.

**W7-02 — GiteaProvider, verified against a live instance.** Every shape was
checked against `gitea.com/api/v1` rather than the swagger, and three of the
differences it surfaced would each have shipped as a silent data bug: Gitea has
no `pushed_at` (only `updated_at`, which the planner orders by); commits carry
**no per-file churn on any endpoint**; and the PR list omits churn while detail
carries it, so the list must normalize to *absent* rather than zero.

The webhook semantics the design doc flagged UNVERIFIED are resolved from
go-gitea source: `X-Gitea-Signature` is a **bare lowercase hex** HMAC-SHA256, no
`sha256=` prefix. A verifier written for GitHub would reject every genuine Gitea
delivery. Contract-tested both ways. Unblocks W12-01.

> **Product consequence worth a decision:** hotspot and ownership metrics that
> rank files by per-commit churn cannot be computed from Gitea commits. We
> record 0/0 per file plus the accurate commit totals; splitting the total
> across files would look plausible and be fiction.

**W11-01 — images cut 73%.** api and worker were **1.68 GB**, migrate 1.27 GB,
because every runtime stage inherited the full source stage and shipped vitest,
playwright, eslint, typescript and drizzle-kit to customers. Now **465 MB /
465 MB / 330 MB**.

Three bugs were found by *running* the images, each of which would have hit a
customer on first start: pnpm's isolated layout does not put a root-installed
`tsx` on a workspace package's bin path; invoking pnpm at runtime made corepack
try to **download itself over the network on every container start**; and the
migrate image could not run `drizzle-kit` at all — installing it into a `--prod`
workspace left `/app/node_modules/.bin` empty. Migrations now use drizzle-orm's
own migrator, already a production dependency, against the same SQL and the same
bookkeeping table.

Verified end to end, not inferred from a green build: migrate exits 0 twice
("up to date", 26 tables, 5 applied), the full stack comes up with migrate
finishing before api/worker, and through the only published port `/` serves the
SPA, `/repos/1/ci` deep-links, `/healthz` proxies 200 and `/api/v1/me/context`
returns 401.

W11-01 stays **todo**: acceptance 1 needs multi-arch CI publishing, which is
blocked on **W11-04 (licensing) — a founder decision** — and acceptance 4 is
W11-05.

Gate: lint 0, typecheck 0, **517 unit tests**, 40 e2e + 1 skipped, all exit 0.

### 2026-08-14 — W12-01: GitLab lands, multi-forge is complete

GitHub, Gitea and GitLab. All three adapters pass the same contract suite.

**Verified against a live instance** (`gitlab.com/api/v4`) rather than the docs —
the third time this week that check earned its keep. GitLab diverges further
from GitHub than Gitea does: project ids must be **URL-encoded** into the path
or requests 404 in a way that reads as a permissions problem; commits use `id`
not `sha` and carry **no user object at all**; `visibility` is a string where
`internal` is not public; merge requests use **`iid`** (project-scoped) as the
number while `id` is global — using `id` would have made every PR link in the
product wrong; `merged` is a first-class state; releases have **no id**, so the
tag is the identity; and `changes_count` is a string that becomes `"32+"` past a
display cap.

**Churn is counted, not guessed.** GitLab returns no per-file counts either, but
it *does* return the raw unified diff — so we count `+`/`-` lines for exact
numbers. Gitea returns neither and must record zero. File-level hotspot ranking
therefore works on GitHub and GitLab, but not on Gitea.

**A third webhook scheme.** GitHub signs with HMAC-SHA256, Gitea sends a bare hex
digest, GitLab sends `X-Gitlab-Token` — the secret itself, in plaintext, with no
signature over the body. Compared in constant time regardless, since a naive
`===` leaks a secret a byte at a time. Recorded as a property in the contract
test: a GitLab delivery proves the *sender* knew the secret but says nothing
about body integrity.

**Two things the ticket assumed existed and didn't.** Acceptance 3 cited a "grep
gate" that had never been written — now `capability-gate.test.ts`, which fails
the build if anything above the port branches on provider *name*, and asserts all
three adapters declare identical capability *keys* (a missing key is `undefined`,
which is falsy, so a forgotten flag silently disables a feature). It caught my
own change immediately; rather than weaken it, exactly one construction site is
allowlisted.

And acceptance 4 required a UI fix nobody had noticed: `Connections.tsx`
**hardcoded `provider: 'github'`**, so with the API and all three adapters in
place a customer could still only create a GitHub connection. The DB CHECK
constraint would also have rejected the insert. The e2e asserts the **request
body** carries the chosen forge, not merely that a dropdown renders.

Still unverified, same gap as Gitea: no real GitLab instance has been ingested.

Gate: lint 0, typecheck 0, **536 unit tests**, 41 e2e + 1 skipped, all exit 0.

### 2026-08-14 — W11-04: licensing decided (founder)

**Proprietary, all rights reserved. Nothing goes public until a clean
self-hosted install is proven working end to end.**

`LICENSE` written, `"license": "UNLICENSED"` applied to the root **and every
workspace manifest** — per-package, so a package extracted from the workspace
does not lose the licence along with the repo root. Reasoning recorded as **D10**
in `FOUNDING_BRIEF.md`.

Proprietary is the **reversible** choice, which is why it is right rather than
merely convenient: proprietary today can become any open-source license later,
but an OSS grant cannot be withdrawn from the copies it creates. Picking an OSS
license before the product is even distributable would be an irreversible
decision made to save writing one file.

Support: **no commitment while undistributed**, stated explicitly in the LICENSE
rather than left silent — "no commitment" and "unstated commitment" are
different things to a customer.

**The Lodestone risk the ticket flagged is not present** — checked, not assumed.
Every dependency resolves to public npm or `workspace:*`; there are no `file:`,
`git:` or `link:` specifiers in any manifest.

**Consequence for W11-01:** its acceptance 1 (publish multi-arch images to a
public registry) is no longer merely blocked — it is now *contrary* to the
decision. I deliberately did not write the publishing CI workflow: an unused
publish pipeline aimed at a public registry is exactly the kind of thing that
gets enabled by accident. Revisit after **W11-05** proves a clean install.

Not legal advice; a lawyer should review before any first distribution.

### 2026-08-15 — both board validators were red on main, and nobody knew

Not a ticket. A session opened by asking "what's the status", and the honest
answer turned out to be that the tools which report status had stopped working.

**`validate-plan.mjs` exited 1 and printed `Claimable now (0)`.** 22 tickets
filed mid-flight (W4-11..W4-20, W11-*, W12-*) were written without the schema's
`phase`, `module` and `stories` fields, and the id pattern predated waves 11
and 12. Since MASTER_PROMPT forbids hand-deriving the claimable set, the claim
protocol was unusable — which is presumably why the last several tickets were
picked by eye.

**`validate-arch.sh` also exited 1**, independently, on a clean tree. Rule 4
(no `api.github.com` outside `packages/forge`) caught one real violation — the
worker had its own hardcoded copy of the default forge base URL, the exact
divergence the rule exists to prevent — and five doc comments the line-wise
grep could not tell from a fetch.

Both are in CI (`.github/workflows/ci.yml:47,53). The CI gate has therefore been
failing on every push, and the local gate (`lint && typecheck && test`) never
included the validators, so nothing surfaced it.

**Correction to the claimable set.** With `phase` restored the wave gate applies
again: **5 tickets are claimable, not 11**. `depends_on` alone suggests W5-02,
W6-01, W7-05 and W11-01 are open; they are not — every W4 ticket must close
first. The real list is the entire W4 remainder: **W4-09, W4-10, W4-15, W4-16,
W4-17 (17 pts)**. Closing them reaches the **MVP gate**, which per PLAYBOOK
needs a CHALLENGER pass from a session that implemented none of them.

**Sizing guardrails now degrade after a ticket closes.** Two violations were
masked by the schema errors: W12-03 delivered at 13 points, W12-05 at 7
acceptance criteria. Neither was edited to fit. Those bounds exist to force a
split *before* work starts, so they hard-fail while a ticket is claimable and
warn once it is done — after that the board is a historical record, and
rewriting a delivered 13 into an 8 would falsify the ledger to please a
planning heuristic.

ROADMAP.md gained W11 and W12 sections; it had stopped at W10. W12's says
plainly that it ran out of order and carries forward the two unverified items:
no real Gitea or GitLab instance has been ingested, and a forge 404 still
completes a REST backfill job silently.

Gate: lint 0, typecheck 0, **543 unit tests**, 42 e2e + 1 skipped,
validate-arch / validate-plan / validate-traceability all exit 0 — the first
time all three validators have been green together.

### 2026-08-15 — W4-09 done: workspace settings, and a bot filter that was never on

The ticket was "add a Settings tab". The consequential half was a one-word bug
in the snapshot worker: `botGlobs: []`. That reads as "no override" and means
"nothing is a bot" — `isBotLogin` does `globs.some(...)`, so an empty list
matches no login. **METRICS.md §0's shared exclusion rule has never held for a
single number computed from real ingestion.** `DEFAULT_BOT_LOGIN_GLOBS` existed
and was passed by nobody, so every churn, hotspot and ownership figure counted
dependabot as a contributor. Because of that, "unset" and "deliberately
emptied" are now distinct states everywhere — optional schema fields, `??` not
`||`, both cases pinned by tests, and UI copy that says what an empty box does.

`write_scope` was amended in its own commit before any code: as filed it could
not satisfy its own acceptance 2, since snapshots are computed in
`workers/processors.ts` and the score breakdown in `routes/org/health.ts`,
neither of which was listed.

Two testing notes worth carrying: the weight assertion needs **two** sub-scores
present or renormalization makes every weight config produce identical numbers
(the test would pass against an unwired endpoint), and suites share the
`default` workspace — this one first left a second admin behind and broke
W4-20's last-admin assertion in a file it never touched. The unit suite is now
run twice to prove teardown.

Carried: W4-20's role change is still not audit-logged though SC-22 names it.
Noted on that ticket; not fixed from inside this one.

Gate: lint 0, typecheck 0, **562 unit tests** (was 543), 44 e2e + 1 skipped,
all three validators exit 0. On this machine e2e needs `E2E_API_PORT=3010 pnpm
e2e` — a compose dev stack holds port 3000, which is what W4-11's override is for.

### 2026-08-15 — W4-10 split, and W4-22: live sync has never worked

**W4-10 landed in part and is deliberately still open.** Persona picker +
migration 0006 (`users.persona`, `users.prefs`), onboarding checklist with
admin/member variants, review-queue rail badge, R-D1 typography. UX_SPEC §6's
role-routed homes were unimplementable before this: admin/member is an
*authorization* role and says nothing about which screen someone wants — a
security reviewer and a tech lead are both "member".

Three criteria were filed rather than faked, for three different reasons: the
first-insight toast had **no producer**, the findings badge has **no data**
(and a badge stuck at 0 is indistinguishable from a working one), and the
"hero tiles on the existing WidgetGrid" criterion is already true of the grid
engine and false of the screen — `OrgOverview.tsx` never uses `WidgetGrid`, so
that bullet is a rewrite of the MVP-gate landing screen. Filed as **W4-21**.
**Re-scoping acceptance is a founder call, so W4-10 stays `in_progress` and the
W4 gate is genuinely not reached until Brad rules.**

**W4-22 (done) is the reason the toast had no producer, and it is worse than a
missing event.** `grep -rn publishSyncEvent apps packages | grep -v test`
returned exactly one line — its own definition. The helper was built,
documented and unit-tested, the SSE route was mounted in W4-18, the browser
subscribes to all four event names, and **nothing in production ever called the
publisher**. Live sync had never worked. It degraded exactly as designed ("a
dropped event just means a slightly staler dashboard"), which is why nobody
noticed. The sixth built-but-never-called defect, same cause every time: the
unit tests supply the missing end themselves, so both ends are proven and the
join between them is exercised by nothing.

The wiring gate now covers transports, not just queues — and **its first
version was itself fake**: it asserted the file `includes('publishSyncEvent')`
and passed against a gutted publisher, because the import line satisfied it.
Negative controls were run on both the gate and the new e2e.

Also fixed: `playwright.config.ts` claimed to serialize ("shared seeded
warehouse") but `fullyParallel: false` only serializes *within* a file — 49
tests were running on 9 workers against one warehouse and one fixture user.
`workers: 1` is what the comment always meant, and it is **faster** (38s → 21s),
because the parallel run spent its time on 30s timeouts.

Gate: lint 0, typecheck 0, **566 unit tests**, 49 e2e + 1 skipped, all three
validators exit 0.

**Board state:** claimable = W4-15, W4-16, W4-17 (the API-gap trio). W4-21 is
blocked on the W4-10 ruling. Those four plus that decision are all that stand
between here and the MVP gate — which per PLAYBOOK needs a CHALLENGER pass from
a session that implemented none of the wave's tickets.

### 2026-08-15 — W4-15, W4-16, W4-17: the API-gap trio, and a seventh inert feature

All three tickets existed because W4-04/05/06 shipped what was reachable and
named the rest in visible empty states. Each turned out to be bigger than its
acceptance text implied, in a different way.

**W4-15 was written as a retrieval gap and was a compute gap.**
`computeCiDuration` and `computeCiFlakiness` were fully implemented against
METRICS.md §1, fixture-tested to the line, and **called by nothing** —
`snapshots/compute.ts` wrote `{value: passRate, dims: {passRate}}` and dropped
two thirds of M9. No endpoint could retrieve what was never persisted. This is
the **seventh** built-but-never-called defect, and the first to slip a wave
*gate*: W3's exit criterion asks that every metric reproduce its fixture
vector, which it did — in a unit test calling the function directly.

Found alongside, and more consequential: §1 says "default-branch vs PR runs
reported separately", but every run was pooled into one pass rate, which
`routes/org/health.ts` then read as `m9PassRate` and ramped under the comment
"M9 default-branch passRate". **The health score has been scoring a number that
is not the one it names** — every repo with noisy PR CI was marked down for a
default branch that was fine.

**W4-16** replaced the repo picker with one workspace-scoped, keyset-paginated
query. Every filter runs in SQL, which pagination makes mandatory rather than
tidy: a page of 25 filtered to 9 in JS is a short page the client reads as
"nearly the end".

**W4-17** needed per-touch rework attribution, because rework is defined by the
*previous* touch of the same file, which routinely falls in the previous week —
bucketing first and computing per bucket zeroes the rework of every touch that
happens to be first in its week, worst at exactly the cadence the chart shows.
`churn.ts` now exports `attributeRework` and `computeRework` reduces over it, so
the aggregate and the parts cannot disagree. The browser-side `toWeeklyChurn`
was **deleted** rather than left beside it.

Gate: lint 0, typecheck 0, **579 unit tests** (was 566), 54 e2e + 1 skipped,
all three validators exit 0.

**W4 is 21 of 23 done.** The only things left are **W4-10** (`in_progress`,
awaiting the founder ruling on its split) and **W4-21** (blocked on that
ruling). No ticket is claimable until it is made.

**The W4 gate section is deliberately NOT written here.** PLAYBOOK requires the
CHALLENGER pass to come from a session that implemented none of the wave's
tickets, and this session implemented six of them. Three items must be carried
into that gate entry as unverified: no real **Gitea** instance has been
ingested, no real **GitLab** instance has been ingested, and the new
**sync events** are proven against the fake forge only.

### 2026-08-17 — W4 is code-complete (23/23). The gate is NOT yet passed.

W4-10 was closed on the founder's instruction to proceed, with its remainder
superseded by W4-21 — recorded in its notes rather than shown as a clean `done`,
because it did not meet its acceptance as written. W4-21 then landed the three
carried criteria:

- **First-insight toast (R-A3)** on the sync events W4-22 made real. The
  threshold decodes the server's own `percentComplete` rather than defining
  coverage a second time. **The e2e caught a real bug in the premise:** a pct
  threshold alone never fires for a young repo — the fixture's commits are 1–3
  days old, giving 1% coverage, unreachable, while every day that repo has ever
  had is already ingested. Coverage measures how far *back* ingestion reached,
  not what is missing. It now also fires when history backfill completes. This
  would have shipped as "the toast never appears for new repos", which nobody
  reports as a bug.
- **Findings badge**: absent and zero provably render identically. A badge
  frozen at 0 looks like a working badge reporting no new findings, when nothing
  feeds it until W6.
- **Bento**: Org Overview composes through the same `WidgetGrid` saved views
  use, so layout is data. One deviation, stated: the five KPI tiles remain a
  single 12-wide widget rather than five 1×1 widgets — splitting them would
  change the DOM two existing specs assert against for no visual difference.

Gate: lint 0, typecheck 0, **586 unit tests** (543 at the start of this run), 56
e2e + 1 skipped, all three validators exit 0.

#### What the W4 gate still needs — for a FRESH session

`validate-plan.mjs` now reports W5-02/03/05 claimable, because its wave gate is
mechanical: every W4 ticket is `done`. **That is not the PLAYBOOK gate.** The
exit criteria in ROADMAP.md W4 are a live demo script, and the CHALLENGER
protocol requires a session that implemented **none** of the wave's tickets to
re-derive each criterion from the docs and try to refute the evidence. This
session implemented seven of them (W4-09, W4-10, W4-15, W4-16, W4-17, W4-21,
W4-22), so it cannot write that section. Maker ≠ verifier.

**Carry into the gate entry as unverified — none of these is covered by a
passing suite:**
1. No real **Gitea** instance has been ingested; the adapter passes recorded-fixture contract tests only.
2. No real **GitLab** instance has been ingested; same.
3. The new **sync events** are proven against the fake forge only.
4. The MVP demo script's first criterion asks for the **real bpmforge org** or a full-fidelity fixture twin. Everything green today runs against the fake forge and the seeder.
5. A forge **404 still completes a REST backfill job silently** (carried from W12-03) — indistinguishable from a genuinely empty repo.

**Do not start W5 until that section is written.** The board will let you; the
playbook will not.

#### One gate weakness noticed while running it, not fixed

An increasing share of the unit suite needs live Postgres (`describeIfLiveInfra`
→ `describe.skip` without `DATABASE_URL`). On a fresh clone with no `.env`, those
files **skip silently and the suite reports green** — the same zero-vs-absent
conflation this run caught three times in product code, now sitting in the gate
itself. A contributor could satisfy `pnpm test` while never running the admin,
settings, snapshot-settings or tenancy suites. Worth a ticket: either fail when
`DATABASE_URL` is absent (the e2e harness already refuses to run unseeded, for
exactly this reason) or report the skipped count as a gate number.

### 2026-08-17 — W12-08/09/10: the gate had been passing over a third of itself

The two items W4 carried out as noted-but-unfiled got filed. Filing them turned
up a third fact that is worse than either.

#### CI has never run a single integration test

`.github/workflows/ci.yml` provisions **no Postgres and no Redis**. 37 test
files gate themselves on both and become `describe.skip` without them — the
admin, workspace-settings, tenancy, security-header, rate-limit, audit-log,
snapshot, backfill, reconcile, DLQ and seed suites have only ever executed on a
developer's machine.

> **Correction, same day, found while closing W12-10.** This section first said
> "every green check this repo has ever shown covered 433 of 586 tests." That is
> wrong, and wrong in the reassuring direction. **CI has never been green because
> CI has never run.** All 100 workflow runs — the repo's entire history, from
> 2026-07-18 to now — failed in about three seconds with *zero steps executed*,
> annotated `The job was not started because an Actions budget is preventing
> further use` (the earliest: *"recent account payments have failed or your
> spending limit needs to be increased"*). The live-infra hole below is real and
> the fix stands on its own; it was simply never the reason CI passed over a
> subset. Nothing in CI has ever executed at all. **Every gate in this repo has
> been a local gate since day one.**

The previous STATUS entry called this a *silent* skip. **That was wrong, and
running it rather than trusting the note is what corrected it**: vitest prints
`Test Files 85 passed | 37 skipped (122)` perfectly plainly. Visibility was
never the problem — a reporter to restate the count would have been redundant
work justified by a stale observation. What was missing is that nothing
*failed*: CI reads the exit code, not the summary line.

It stayed invisible locally because every one of those files does
`import 'dotenv/config'`, and `.env` exists on a dev machine — so `env -u
DATABASE_URL pnpm test` still reports 586/586. Reproducing the CI condition
needs `DOTENV_CONFIG_PATH=/dev/null`.

**W12-08 (done).** `scripts/check-live-infra.mjs` preflights `pnpm test`. With
`REQUIRE_LIVE_INFRA` set, a missing service fails *before any test runs* and
names all 37 files; without it the run proceeds behind a warning that says which
suites are not covered. Unconditional failure was considered and rejected — CI
has no data tier yet, and a permanently-red gate is not an improvement on a
dishonest one. The 37 is counted from the source marker, not hardcoded, and
agrees independently with vitest's own skip count. RED-checked all three modes.

**W12-10 (implemented, BLOCKED — on billing, not on code).** `ci.yml` now runs
`postgres:16` and `redis:7.2` as services with healthchecks, exports
`DATABASE_URL`/`REDIS_URL`, runs `pnpm db:migrate` before lint, and sets
`REQUIRE_LIVE_INFRA=1`.

It is **not** marked done, because its acceptance asks for a zero skip count
*in CI* and no job in this repository has ever started. Marking it done would
assert a verification that has not happened — the same defect class this wave
has spent its time closing.

What could be verified offline was: the workflow parses with both services,
both healthchecks and the migrate step in the right order; and — more usefully
— the CI condition was **simulated**. A brand-new empty database, migrated from
scratch, then the full suite against it with `REQUIRE_LIVE_INFRA=1`: **122
files, 589 tests, zero skipped, zero failures.** The expected fallout from
running 37 never-in-CI suites did not materialise on a fresh DB. A strong proxy
for the CI environment; not a substitute for it.

Also observed, not fixed: **the nightly-e2e job has no data tier either** and
will fail the moment the budget is restored — `pnpm e2e` needs a seeded stack,
which is two servers and the seeder, not two service containers. Worth its own
ticket.

**User action required:** raise the Actions budget on the `bpmforge` org.
Nothing in `ci.yml` runs until that happens.

#### W12-09: the role change SC-22 already asked for

`SECURITY_CONTROLS.md` SC-22 lists its audited event classes literally, and
"admin role change" is one of them. W4-20 shipped `PATCH /admin/members/:userId`
with no audit line — control specified, endpoint built, log never written. The
`AuditEvent` union even carried `role.changed` in a comment listing what later
waves would add.

The entry records the role it changed **from**: "role changed to admin" cannot
be read as a privilege escalation without the previous value, which is the only
reason T-29 wants the record, and after the `UPDATE` it is gone. Emitted on the
success path only — an audit stream that logs refused attempts as though they
were changes would show a demotion that never happened.

DLQ replay is logged too and is **not** on the SC-22 list. Replaying re-runs
forge work on an operator's say-so, and `job_failure.replayed_at` records that
it happened but never who did it. Logged deliberately, and said so, rather than
left out because the list did not anticipate it.

The assertion captures at the pino **destination**. `request.log` is a child
logger, so stubbing `app.log.info` catches nothing and would pass against a
route that logs nothing at all — RED-checked by disabling the call, which failed
exactly the new assertion and nothing else.

Gate: lint 0, typecheck 0, **589 unit tests** (was 586), zero skipped under
`REQUIRE_LIVE_INFRA=1`, all three validators exit 0.

**W4's gate section is still unwritten and still cannot be written here.** None
of this changes that; W12 is out-of-band infrastructure work, not W4 verification.

### 2026-08-19 — W13: clone to running app, verified on a clean clone

Goal changed on 2026-08-18: not build/CI infrastructure, but **anyone can clone
this and run it**. Filed as W13 and worked overnight, unattended. All five
tickets done.

#### What a newcomer used to hit

Three walls, found by running the fresh-clone path rather than reading it.
`.env.example` could not boot the API (`missing required env var
GITHUB_APP_CLIENT_ID`, then `TOKEN_ENC_KEY is required`) — both blanks correct
per Law 9, which means **the documented setup file had never been able to start
the app**. Nothing in any `package.json` started the ingestion worker; the only
thing that ever launched it was `playwright.config.ts`. And login required a
registered GitHub OAuth app, so there was no way in at all.

#### The wave

- **W13-01** `pnpm bootstrap` — containers, `.env`, **generated** secrets,
  migrate, seed. Idempotent.
- **W13-03** `pnpm dev` — api + worker + web, one command, prefixed logs.
- **W13-02** demo mode — the whole product with no GitHub account.
- **W13-04** README quickstart + `docs/RUNNING.md`.
- **W13-05** the clean-clone verification below.

#### Four defects the work itself surfaced

1. **`pnpm setup` is a pnpm builtin.** Every doc telling a newcomer to run it
   would have run pnpm's own command and never touched this repo. The command
   is `pnpm bootstrap`.
2. **Published secrets.** `.env.example` *pre-fills* `SESSION_SECRET` and
   `WEBHOOK_SECRET` with `dev-insecure-…`, so a fill-only-blanks rule left every
   install signing session cookies and validating webhook HMACs with a secret
   **published in this repository**. Placeholders now count as unset.
3. **`pnpm --filter` gives children `cwd=apps/api`**, so their own dotenv found
   no root `.env` — API and worker both died on a machine where `.env` exists.
4. **Demo's OAuth `redirect_uri` came from `API_BASE_URL`** (pinned to :3000),
   so running the demo on any other port sent the callback to whatever else was
   listening. It presented as a login that does nothing, with nothing in the log.

#### W13-05: the clean-clone run

Fresh `git clone` into a scratch directory, then the quickstart exactly as
documented. `pnpm install`, `pnpm bootstrap` (all three secrets generated as
valid 32-byte hex; 3 repos, 24 commits, 15 PRs, 1536 snapshots seeded).

`DEMO_MODE=1 pnpm dev` then failed with `Port already in use: api (:3000)` —
**the documented troubleshooting entry, firing verbatim**, naming the right
cause (the `deploy/compose.yaml` stack) and the right fix.

That fix then exposed a **fifth defect, in my own advice**: `PORT=3010 pnpm dev`
moved the API but left the vite proxy on `API_PROXY_TARGET=http://localhost:3000`,
so the browser kept talking to whatever was still there. `dev.mjs` now derives
the proxy target from `PORT`. This is exactly why W13-05 exists — the
workaround was printed by our own tooling and documented in our own
troubleshooting, and it did not work.

Proof: a real browser logged in through the mocked OAuth boundary and rendered
the Org Overview — demo banner across the top, Delivery KPIs, Repo health
(payments 52, web-app 69, infra 47), Needs attention, Hotspots. Screenshot
captured. One "failure" in that check was **my assertion, not the product**: it
looked for "Health" where the widget is "Repo health".

Gate: lint 0, typecheck 0, **597 unit tests** (was 589), zero skipped under
`REQUIRE_LIVE_INFRA=1`, e2e 56 passed + 1 skipped, three validators exit 0.

#### Still true, and still needing you

- **CI has never run** — Actions budget. Every gate above is local.
- **W4's gate section** still requires a challenger session; nothing here
  changed that, and W12/W13 are out-of-band infrastructure, not W4 verification.
- **Not verified from scratch:** the `deploy/compose.yaml` container path is
  documented from the file and from the stack running on this machine, but no
  clean `cp deploy/.env.example deploy/.env && podman compose up` run has been
  done. Worth a ticket.

#### W5-08 deferred one acceptance item, deliberately (2026-08-19)

Acceptance 3 asks for an **Org Overview digest card** summarising active
agreements and exception counts. Not built. The Admin → Agreements tab carries
the same numbers with the actual offending pull requests beneath them, and the
plan tile already surfaces agreement-sourced items — a third surface for the
same counts is a third place for them to disagree. Recorded as a decision
rather than shipped half-built; cheap to add if the org screen turns out to be
where people look first.

#### W5-09 blocked on one e2e, not on the feature (2026-08-19)

The report diff, annotations, `previousSnapshotAt` threading and scheduled
generation are built and unit-tested (650 tests green). A probe proved the
whole flow works in a real browser and that the API returns `comparable: true`
with nine deltas.

The blocker is the **test**, and its shape is worth recording: it identifies
reports by **list position** (`.first()`) in a list other tests are adding to,
which refetches on a 3-second timer. Three separate races were found and fixed
— a poll landing late, `goBack()` returning to an unpopulated list, and a
baseline taken between two generations — and each fix made it pass alone and
fail in the file. Position is not a stable identifier here.

Next session should rewrite the test to drive the UI **by report id** captured
from the POST response, rather than adding a fourth wait.

It also found the most valuable bug of the wave: **every report from the Report
Center was empty**, because the form sends no `repo_ids` and an empty list meant
"no repositories" rather than "all of them". Fixed on the branch.

#### `pnpm --filter @repopulse/web test` had never worked (2026-08-19)

Found by a stop-hook running the tests differently from the way this session
had been running them. `apps/web/package.json` declares `"test": "vitest run"`
but never declared **vitest**, so under pnpm's strict isolation the binary is
not on that package's path:

```
sh: vitest: command not found
ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL  @repopulse/web@0.1.0 test
```

Root `pnpm test` always passed because vitest is a root devDependency and the
workspace config sweeps every package — so the broken script was invisible to
every gate this project runs. `pnpm -r test` and any per-package CI step would
have hit it immediately.

A declared script that cannot execute is the same defect class as a queue with
no processor: it looks like coverage and performs nothing. Fixed by declaring
vitest in `apps/web` at the root's version; `pnpm --filter @repopulse/web test`
now runs 63 tests.

#### `text-fg-faint` fails contrast in the light theme (2026-08-19, found in W6-06)

The Weekly Pulse card's provenance line used `text-fg-faint`, and the light-theme
axe spec went red with `color-contrast`. In light mode that token is `#818b98`
on white — roughly 3:1, under the 4.5:1 AA needs for body text. Switching that
one line to `text-fg-muted` (`#59636e`, ~5.7:1) cleared it.

**The token is used in 17 places across 13 components.** They do not currently
fail because axe only checks what is rendered and visible in the specs that run,
not because they are safe. This is W7-04's (WCAG 2.2 AA pass) to resolve
properly — either by darkening `--color-fg-faint` in the light palette or by
retiring the token. Recorded here so W7-04 starts from a known fact rather than
rediscovering it.

#### Tier-3 is built but has never run (2026-08-19, W7-01)

The Tier-3 client, escalation rules and egress audit are complete and tested —
but **no live Claude call has been made**, and none is possible here:
`ANTHROPIC_API_KEY` is unset. Every test injects the transport.

What that proves: the egress row is written before the call and survives a
throwing one, the digest matches what was sent, escalation badges instead of
sending without opt-in, and over-budget queues instead of dropping.

What it does **not** prove: that a real Claude response parses into the Finding
schema. That needs an API key from Brad. It is the Tier-3 twin of the
GiteaProvider gap — a contract suite green against a service it has never
touched.

#### W7-05/06/07 parked — they need production infrastructure (2026-08-19)

Three W7 tickets cannot be done by this loop, and faking them would be worse
than leaving them open:

- **W7-05 Production containers** — needs a real host, TLS certificates and
  somewhere to put secrets. `deploy/compose.yaml` already exists and runs
  locally; what is missing is a production target.
- **W7-06 Prod deploy runbook execution** — is, by definition, executing a
  deploy against that host and verifying observability on it.
- **W7-07 Production GitHub App** — needs an App registered under the bpmforge
  org with a callback and webhook URL pointing at a live
  `repopulse.bpmforge.com`. Only Brad can create it.

**From Brad:** a deploy target with DNS and TLS, and a registered GitHub App.
Until then these stay `blocked` rather than `todo`, so the claimable set does
not keep offering work nothing can finish.

Related and still outstanding: **W14-01** (a Gitea token — the product has
still never ingested a real repository), **W12-10** (the Actions budget), and a
live Tier-3 call (an `ANTHROPIC_API_KEY`).

#### Live secret verification is gated OFF and not implemented (2026-08-19, W8-04)

The secrets scanner ships the OFFLINE half of SECURITY_SUITE.md §3.1's
verified-secret escalation. A format verifier says "this is shaped like a real
`ghp_` token" and raises confidence to 4; it never sets `verified` and never
touches severity, because shape is not liveness — a revoked token and a live one
are the same string.

The LIVE half — an outbound probe to the issuer with someone else's credential —
is config-gated (`liveVerification`, default off) and **throws when enabled**
rather than quietly returning unverified. A switch that reads as on and does
nothing is worse than no switch.

What that costs: nothing in the product reaches severity 5 / confidence 5 with
the org banner today, because nothing can confirm a credential is live. The
escalation path itself is real and tested (a stub `verified` outcome produces
5/5 + `surfaceImmediately`), so turning it on is a verifier implementation, not
a rework.

What it needs from a person: a decision, not a token. Probing an issuer with a
credential found in a customer's repository is an outbound request carrying
someone else's secret — it belongs in the data-egress conversation alongside
Tier-3, not in a scanner ticket. When that decision is made, the verifier
registry in `packages/security/src/scanners/secrets/verify.ts` is where it goes.

GitHub's token checksum is deliberately NOT implemented either: this codebase has
no real token to verify the algorithm against, and an unverified checksum would
reject valid tokens while claiming rigour.

#### W8-06 parked — the dependency scanner has no tools to run (2026-08-19)

`syft`, `grype`, `osv-scanner` and a CISA KEV database are all absent from this
machine, and W8-06's acceptance is written entirely in terms of what they
produce. It is `blocked`, not `todo`.

The thing not to do here is obvious once stated: a hand-written CVE list would
make the fixture test pass and would report a repository as having no known
vulnerabilities the moment it met a real dependency tree. An empty Security tab
looks exactly like a good result.

**What it needs from you:** `brew install syft grype` (or `osv-scanner`), plus a
decision about where the vulnerability databases live. That second half is the
real design question — the scan sandbox runs with `--network=none` and cannot
fetch a CVE database at scan time, so the databases have to be pulled host-side
and mounted read-only. That is the "tool/rulepack db-sync job" in W8-12, which
is why the sensible order is W8-12 first, then W8-06.

The slopsquatting heuristics (registry age, download counts, edit distance to
popular package names) need a package-registry API and are a separate live-
network decision — noted so they are not forgotten when the CVE half unblocks.

#### W8-12: the scan sandbox is real; the prod smoke is not (2026-08-19)

The scan image builds and **was run** here: `podman build -f Containerfile.scan`
produces an Alpine image with Opengrep 1.27.1 pinned by sha256, and the sandbox
test drives it through the real §2.2 profile — no network, read-only root,
uid 65534, `/scan` mounted `ro,noexec` — and gets `1.27.1` back out.

Three failures on the way there, all fixed in the IMAGE rather than by loosening
the profile, because each one was the profile working as intended:

1. Opengrep unpacks its core into `$HOME` on first run — a 64 MB tmpfs was too
   small. Pre-extracted at build time instead.
2. It then **execs** what it unpacked — `/tmp` is `noexec`. Same fix.
3. It writes a log under `$HOME/.opengrep`, and the root filesystem is
   read-only. A small tmpfs is now mounted over exactly that path
   (`writablePaths` on the profile), rather than making `$HOME` writable, which
   would let one scan mutate the binary the next scan runs.

**What is NOT done, and why:** acceptance item 3, the production smoke ("manual
scan now on a connected repo, scratch dir provably deleted, result appended
here"). It needs the production host that W7-05 is blocked on. The shred and
sweeper behaviour it would confirm is covered against a real SIGKILL in
`packages/security/src/snapshot/snapshot.test.ts`, but that is a laptop, not
your host — treat the production smoke as outstanding.

**Also outstanding, needing you:**
- `cosign` is not installed, so the Opengrep binary's sigstore signature is not
  verified. The pinned sha256 catches a silent replacement; it is not a
  vendor-signed checksum and the deployment doc says so.
- syft/grype are absent from the image for the same reason W8-06 is parked. The
  db-sync script's vulnerability-database half fails loudly if enabled rather
  than pretending to sync.

#### W8-13 parked — nothing to validate until W8-06 runs (2026-08-19)

The CVE validation pipeline (alias dedup → dep scoping → usage detection →
reachability → EPSS/effective risk) operates on dependency findings, and there
are none: W8-06 is blocked for missing `syft`/`grype`/`osv-scanner`.

The deterministic halves could be written against fixtures today. They would be
eight points of code with no production callers, validated only against my own
idea of what grype emits — and built-but-never-called is the defect this
codebase has produced most often. The shape of that output should come from the
tool, not from me.

**Extra gaps beyond W8-06**, so they are not discovered later:
- `govulncheck` is not installed (V3's Go call-graph proof). Go itself is, so
  `go install golang.org/x/vuln/cmd/govulncheck@latest` closes it.
- The EPSS feed (V4) needs the nightly db-sync whose vulnerability half is
  already parked in W8-12 — scan containers are `--network=none`, so EPSS has to
  be fetched host-side and mounted read-only.

**Order when it unblocks:** install syft + grype (+ govulncheck) → finish
W8-12's db-sync → W8-06 → W8-13.
