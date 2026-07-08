# RepoPulse — Test Strategy

Expands the PLAYBOOK.md testing-tier table. Non-negotiables: **CI never calls
github.com, LM Studio, or the Claude API**; tenancy suite runs every commit from W1;
wave gates require the soak tier. Runner: vitest (unit/contract/integration),
Playwright (e2e + PDF). `pnpm test` = all vitest tiers; `pnpm e2e` = Playwright.

## 1. Tier map (what runs at which gate)

| Tier | Scope | Runs at | Blocks |
|---|---|---|---|
| Unit + metric fixture vectors | pure logic, per package | every commit (CI) | commit |
| ForgeProvider contract (recorded fixtures) | packages/forge | every commit | commit |
| API integration (fastify.inject + test DB) | apps/api | every commit | commit |
| Tenancy isolation suite | all routes/queries | every commit from W1 | commit |
| Playwright e2e (seeded stack) | 6 core journeys + wave screens | pre-merge on web tickets + nightly | merge |
| Backfill soak + budget assertions | synthetic repo generator | pre-wave-gate | wave gate |
| axe/Lighthouse a11y | all routed pages | pre-merge on web tickets + W4/W7 gates | merge/gate |

Per-ticket definition of done (CLAUDE.md Law 3): `pnpm lint && pnpm typecheck &&
pnpm test` workspace-wide + the ticket's own acceptance; test counts in commit body.

## 2. Unit conventions (vitest)

- Co-located `*.test.ts` next to source (`churn.ts` / `churn.test.ts`); no `__tests__` dirs.
- No mocking of our own modules inside a package — mock only at the port boundary
  (ForgeProvider, LLM gateway, DB via test instance). If a unit test needs three mocks,
  the unit is wrong.
- **Fixture-history builders** for metrics: `packages/metrics/fixtures/` exposes builders
  like `repoHistory().commit({files, adds, dels, author, at}).pr({opened, firstReview,
  approved, merged}).build()` producing warehouse-shaped rows. Every FR-METRICS-1..12
  metric gets vectors: happy path, empty window, single-item, boundary (bucket edges,
  window edges inclusive/exclusive), bot-exclusion, and the SRS acceptance case verbatim
  (e.g. 60/30/10 authors → bus factor 1). Expected values hand-computed in a comment
  with the arithmetic shown — reviewers recompute, not trust.
- Property tests (fast-check) where SRS demands invariants: chunker coverage
  (every hunk exactly once), pagination round-trip, dedup fingerprint stability.

## 3. ForgeProvider contract tests (recorded fixtures)

W0 ships the recorder: run once against a scratch GitHub repo with a real token,
persist request+response (status, body, and headers incl. `etag`, `x-ratelimit-*`,
`retry-after`, `link`) under `packages/forge/fixtures/`; replay via undici MockAgent.
Every ForgeProvider method has contract tests; GiteaProvider (W7) must pass the same
suite via capability flags.

**REQUIRED fixture cases** (suite fails if any is missing — enumerated in a manifest test):
1. **Happy path** per interface op (list + get, ≥2 pages where paginated).
2. **304 Not Modified** — ETag sent, cache hit, zero budget spent, cached body served.
3. **202 stats-warmup** — stats endpoint returns 202; client retries after delay; 422/10k-commit fallback path queued.
4. **Truncated diff** — >300 files / >20k lines; client switches to paginated `/pulls/{n}/files`, never raw diff.
5. **Rate-limit 403 + `retry-after`** — primary exhaustion; budgeter pauses to reset, zero requests emitted meanwhile.
6. **Secondary limit** — 403 with `retry-after` on a single endpoint; only that endpoint's bucket drains; others proceed.
7. **Pagination edge** — last page exactly full, empty page, `link` header absent, cursor at end.

Budget assertions are first-class: each contract test asserts points spent and
requests emitted, not just response shape.

## 4. API integration (fastify.inject + ephemeral test DB)

- `fastify.inject()` against the fully-registered app — no HTTP listener, no port.
- **Per-worker schema isolation**: each vitest worker creates `test_w{N}` schema on the
  compose Postgres, runs migrations, truncates between files. Parallel-safe, no
  cross-test bleed; dropped at teardown.
- Runtime nock/undici guard active in every API test: any egress to a forge/LLM host
  fails the test (FR-API-2 enforcement, complements the static check).
- Route-walker tests: every registered route hit unauthenticated → 401; member on every
  admin route → 403 (FR-API-4/FR-AUTH-4). Walker reads the Fastify route table, so new
  routes are covered automatically — no opt-in.
- Error envelope + pagination semantics tested once via shared schema fragment (FR-API-3).

## 5. Tenancy isolation suite (NFR-4)

- Fixture seeds **two workspaces** (`ws_a`, `ws_b`) with parallel data: same repo names,
  overlapping logins, near-identical PRs — so a leak produces plausible-looking rows,
  not an obvious crash.
- Route walker: every list/detail endpoint called as `ws_a` member asserts **zero**
  `ws_b` rows (checked by seeded sentinel ids), and direct-id probes for `ws_b`
  resources return 404 (not 403 — no existence oracle).
- Query-layer check: repo-layer helper tests prove the `workspace_id` predicate cannot
  be omitted (helper API requires it); schema test asserts `workspace_id` + leading
  composite index on every tenant-scoped table (Migration tickets, PLAYBOOK).
- Runs every commit from W1. A tenancy failure is a stop-the-line event, never waived.

## 6. Playwright e2e (seeded stack)

- **Login mocked** at the OAuth boundary (fake GitHub authorize/token endpoints);
  session/cookie path itself is real.
- Runs against the compose stack seeded by the synthetic generator (§7) — real API,
  real DB, no component mocks.
- **The 6 core journeys** (UX_SPEC §4, W4 gate):
  1. Login → Org Overview: tiles, sparklines, health scores, sync banner (4.a).
  2. Org → Repo Detail: tabs, hotspot treemap, cycle-time bars (4.b).
  3. Repo → PR Detail: stage timeline, reviews, checks, files (4.c).
  4. PR → File drill-down: churn/owners/hotspot history (4.d).
  5. My Focus: my PRs + review load match seeded identity (4.f).
  6. Admin/sync status: progress %, paused-for-budget state, DLQ visibility (4.i).
  Each journey runs twice: click-through with breadcrumb assertions, and deep-link
  paste restoring full state (FR-WEB-2).
- W5 adds: saved-view persistence, share-link second-user, ⌘K keyboard-only, PDF
  download + text extraction. W6 adds findings triage. axe scan per routed page.

## 7. Backfill soak harness (pre-wave-gate)

- **Synthetic repo generator** (`packages/ingest/testkit/`): deterministic (seeded RNG)
  generator emitting fixture-recorder-format responses for a parameterized repo —
  N PRs (default 500) with reviews/comments/files, commits, check runs, issues,
  releases — served by a local mock GitHub that enforces rate-limit headers and
  injects 403/secondary-limit/304 behavior.
- Soak run asserts: completion, zero over-budget requests, entity priority order,
  kill/resume with zero duplicates (row-count + natural-key uniqueness), webhook
  replay idempotency, reconciliation gap-repair, wall-clock budget per ROADMAP W2 exit.
- Regression in any soak assertion blocks the wave gate (PLAYBOOK table).

## 8. LLM tests (W6/W7) — NO live LLM calls in CI, ever

- **Gateway mocked** at the OpenAI-compatible/Anthropic SDK boundary; fixtures include
  success, "model crashed" (asserts warm-up ping + retry), timeout, malformed JSON
  (asserts retry-once → DLQ with raw payload), host-down (asserts park + banner state).
- **Golden-prompt snapshot tests**: rendered prompt per (dimension checklist version ×
  chunk shape) snapshotted; any prompt drift is an explicit reviewed diff. Checklist
  version bumps require new snapshots.
- **JSON-schema (zod) validation of findings**: FR-ANALYSIS-5 schema round-trip; fuzzed
  near-miss payloads rejected; dedup fingerprint stable across reruns (property test).
- Chunker: property test per §2; budget math (45000 maxTokens set, ≤10k projected
  output) asserted on every mocked call.
- A manual smoke script (`scripts/llm-smoke.mjs`, not in CI) exists for live LM Studio
  verification on LAN; its results go in STATUS.md, never in the gate.

## 9. Coverage expectations

- Packages `metrics`, `insights`, `forge` budgeter/ETag, `ingest` cursor logic,
  `analysis` chunker/dedup: **≥90% line / ≥85% branch** (pure logic, no excuse).
- `apps/api` route handlers: ≥80% via integration tier; `apps/web` covered by e2e +
  targeted component tests for chart wrappers/empty states (no % gate, journey gate instead).
- Coverage enforced in CI per package (`vitest --coverage` thresholds in each
  package's config); a threshold drop is a failing gate, not a warning.
- Coverage is a floor, not a goal: every SRS acceptance sketch for the wave must map
  to a named test (traceability check at wave gate — grep FR ids in test titles).
