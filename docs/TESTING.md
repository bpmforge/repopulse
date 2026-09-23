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

- **Login mocked** at the OAuth boundary (`e2e/helpers/fake-github.ts` — authorize,
  token, `/user`); session/cookie path itself is real. `e2e/server.ts` composes the
  production `buildApp` and overrides exactly one option, `githubEndpoints`; the
  shipping entrypoint has no env hook for it on purpose. The fake returns the
  seeder's `FIXTURE_LOGIN` as `id` — a **string**, since `fetchGithubIdentity` maps
  `String(body.id)` onto `forge_user_id`. If that drifts, login still succeeds
  against an orphan user and `/me/*` answers `{items: []}` with HTTP 200, so
  assert on **contents**, never on status alone.
- **Running it**: `pnpm e2e`. The dev stack must be up
  (`podman compose -f compose.dev.yaml up -d postgres redis`) — `globalSetup` seeds
  the warehouse and now throws rather than silently skipping if `DATABASE_URL` is
  unset. Port 3000 busy? `E2E_API_PORT=<n> pnpm e2e` moves the whole stack:
  Playwright derives the web dev server's `API_PROXY_TARGET` from it (W4-11).
  Never run `pnpm test` and `pnpm e2e` concurrently — they share one database and
  `globalSetup` wipes-and-reseeds it.
- **`pnpm test` LOGS YOU OUT OF A RUNNING DEMO.** packages/auth's
  accounts.test.ts deletes every row with `auth_provider = 'local'` in a
  `beforeEach`, because the first-boot bootstrap's rule is "does ANY local
  account exist" and it cannot be tested without owning that predicate. The
  demo account is a local account, so a `DEMO_MODE=1 pnpm dev` you left running
  starts answering 401 to a password that is definitely correct. Restart the
  demo — it recreates the account on boot. This caught the author three times
  in one session before it was written down; the underlying fix is W16-17.
- **`pnpm test` also EMPTIES a running demo's warehouse.** The seeder's own
  integration tests (`packages/shared/src/testing/seed/`) call
  `unseedWarehouse` in `afterAll` — they have to, since they assert on what a
  fresh seed contains. A demo you left running then shows "No repositories
  connected yet." on every screen, which reads exactly like a product that
  never ingested anything. Same remedy: restart the demo, which reseeds on
  boot. Related to W16-17 and the same root cause — one database shared
  between the suite and whatever you have open.
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

## 6a. The demo quickstart (`pnpm e2e:demo`, W16-14)

A SECOND Playwright config, `playwright.demo.config.ts`, testDir `e2e/demo/`.
Separate because Playwright attaches `webServer` to the config rather than to a
project: folding it into §6 would boot a whole second stack on every ordinary
e2e run.

- **What it boots**: `DEMO_MODE=1 pnpm dev` — the literal command in the
  README — on its own port block (`demoE2e*` in `ports.config.mjs`), so a demo
  someone left running in another terminal is neither mistaken for the stack
  under test nor killed by it. It runs `scripts/dev.mjs` rather than the API
  alone, because the demo's forge wiring lives in that file.
- **No `storageState`.** §6 authenticates once in `globalSetup` through the
  mocked OAuth boundary; this project signs in through the FORM, which is the
  screen a newcomer actually meets and the reason it had no coverage.
- **Why it exists**: nothing anywhere booted `apps/api/src/demo.ts`. Three
  demo-mode bugs shipped in one wave behind that gap — a forge credential the
  vault could not decrypt (W16-28), a worker that sent it to the real
  api.github.com (W16-29), and a fake forge with no archive endpoint (W16-30).
- **What it asserts**: the sign-in screen fills the credentials in and says
  why; the persona picker opens and can be dismissed (it is the second screen
  of the quickstart, since the demo reseeds `persona: null` every boot); the
  org overview is POPULATED rather than merely rendered; the three seeded
  repos and the PR list are there; and pressing *Run scans now* moves a scanner
  off "has never run" and records a real scanner VERSION — with no `401`, no
  `api.github.com` and no `archive request returned` anywhere in the coverage
  table.
- Shares the same database as §6 and `pnpm test`, and reseeds on every boot, so
  the same rule applies: never run two of them concurrently.
- `playwright.config.ts` carries `testIgnore: ['demo/**']`. `testDir: './e2e'`
  does NOT exclude a subdirectory, so without it `pnpm e2e` picks these specs
  up, runs them against the §6 stack — no demo banner, no pre-filled
  credentials — and fails for reasons that say nothing about the demo.

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
- **Live model tests are opt-in (W17-40).** `packages/analysis/src/t2/live.integration.test.ts`
  and `apps/api/src/workers/gateway.live.test.ts` run only with `LMSTUDIO_LIVE=1`
  (`LMSTUDIO_LIVE=1 pnpm test`). A plain `pnpm test` makes **zero** LM Studio requests —
  a configured `LMSTUDIO_BASE_URLS` is not consent, because `.env` carries it for the
  product, and the tests used to warm/load models on the developer's own LM Studio and
  evict other tools' models.
- **The vitest suite owns its database (W17-42).** `vitest.config.ts` (via
  `scripts/test-db.mjs`) points `DATABASE_URL` at `<dev name>_test` on the same server,
  creating and migrating it on first use; the seed reset wipes the Default workspace, so it
  must never run against the dev DB. `pnpm e2e` is separate: it drives and reseeds the dev stack.

## 9. Coverage expectations

- Packages `metrics`, `insights`, `forge` budgeter/ETag, `ingest` cursor logic,
  `analysis` chunker/dedup: **≥90% line / ≥85% branch** (pure logic, no excuse).
- `apps/api` route handlers: ≥80% via integration tier; `apps/web` covered by e2e +
  targeted component tests for chart wrappers/empty states (no % gate, journey gate instead).
- Coverage enforced in CI per package (`vitest --coverage` thresholds in each
  package's config); a threshold drop is a failing gate, not a warning.
- Coverage is a floor, not a goal: every SRS acceptance sketch for the wave must map
  to a named test (traceability check at wave gate — grep FR ids in test titles).

## 10. Scanner tests (W8) — seeded fixtures, NO live tool DBs in CI

- **Seeded-vuln fixture repos**: synthetic, checked-in fixture trees under
  `packages/security/fixtures/` (tarballs assembled at test time — nothing dangerous in
  git, secrets are canary-format tokens). One per scanner: planted secrets (stream-diff
  case + history-only committed-then-removed case), manifests/lockfiles with a known
  CVE/KEV/slopsquat set, semgrep-rule-triggering source, OWASP checklist bait, plus a
  chain-composable pair with matching yields→preconditions vocabulary.
- **Scanner unit tests against fixtures**: each scanner asserts its expected finding set
  to the rule id (FR-SEC-3..8 acceptance verbatim); rulepack/tool versions stamped on the
  scan_run asserted; dedup re-run yields 0 new rows (FR-ANALYSIS-6 extension property test).
- **NO live tool-DB downloads in CI, ever**: vendored mini grype/OSV/KEV databases and
  pinned rulepack snapshots are committed test assets; the `db-sync` job is tested against
  a local file server (checksum-mismatch case asserts refusal — SC-28). Same rule class as
  the github.com/LLM bans above.
- **Sandbox integration test** (NFR-14): the scan container profile is asserted live —
  network egress attempt fails (`--network=none`), write to `/scan` fails (ro,noexec),
  process runs non-root; lint gate proves no scan-tool spawn outside
  `packages/security/sandbox`.
- **Snapshot lifecycle test** (NFR-13): success, crash, and SIGKILL paths all leave zero
  snapshot bytes on disk/DB/logs (post-run filesystem sweep assertion); orphan sweeper
  clears a planted stale `snap-*` dir.
- **Chainer golden test**: the seeded finding pair produces exactly the expected chain
  finding (members, severity = max+1 capped at 5) — snapshot-tested; member resolution
  auto-resolves the chain with an audit row.
- **Gateway rules from §8 apply to `owasp_*` scanners**: mocked at the gateway boundary,
  no live LLM calls; `meta.initiator = 'scanner:{key}'` asserted on accounting rows.

## 11. Test-host resources and the contention failure mode (W17-03)

### Measured configuration

Recorded 2026-09-08 on the development host (Apple silicon, **128 GB RAM,
18 CPUs**, Podman 6.1.0, Node 22.23.1, pnpm 9.15.9), so a later run has
something to compare against rather than a feeling.

| Setting | Value | Why |
|---|---|---|
| `fileParallelism` | `false` (root `vitest.config.ts`) | Load-bearing, verified W16-17: test files share the single `default` workspace and two files delete every local user. Sequential is what keeps that dormant. |
| Vitest pool | default, one forked worker in practice | Peak RSS of the parent process **0.23–0.24 GB** across six full runs; peak of any node process ~1.2 GB. |
| Playwright `workers` | `1` | Same shared-state reason. |
| Playwright `webServer` | three, all `reuseExistingServer: false` | Deliberate ownership separation — e2e starts and owns its own API, worker and web, so it never depends on a developer's running stack. |
| Data tier | shared compose Postgres + Redis (`scripts/dev-up.sh`) | The one piece of pre-existing state `pnpm test` requires. `scripts/check-live-infra.mjs` fails fast rather than letting suites die on ECONNREFUSED. |

**Full unit/integration run: 268 files, 1922 tests, ~140–157s.** Host free
memory never dropped below 36 GB of 128 GB. Redis `connected_clients` stayed
**flat at 1** for an entire run (one sample of 2) — the suite accumulates no
connections, and `rejected_connections` was 0 throughout.

### What the intermittent failure actually was

W16-34 recorded three sightings of a full suite failing intermittently, always
alongside `[ioredis] Unhandled error event: Error: write EPIPE`, and had already
ruled out the data tier with measurements. W17-03 reproduced the **symptom**
deterministically and found its source:

| Condition | Unhandled ioredis events |
|---|---|
| Three clean runs, nothing else on the host | **0, 0, 0** |
| Run with a `DEMO_MODE=1 pnpm dev` stack live on the same data tier | **6** |
| Same contended condition, after the fix | **0** (5 handled warnings instead) |

`packages/auth/src/session/plugin.ts` held the only Redis client in the codebase
with **no `error` listener and an unguarded `quit()`** — which is precisely what
makes ioredis classify the event as *unhandled* and print it via `console.error`.
`routes/health/index.ts` and `routes/events/index.ts` had guarded theirs long
before. Under contention a session socket dies mid-flight, and the teardown
write lands on a dead socket.

The fault is now **routed to the app logger, not swallowed** — ioredis
reconnects on its own, so a genuine Redis outage still has to be visible rather
than hidden behind quietly broken sessions.

> **This is not a proven fix for W16-34's test failures.** The 15-test
> `accounts.test.ts` + `auth/local.test.ts` failure was **never reproduced** —
> not in six full runs, and not with a dev stack competing for the same
> Postgres. What is fixed is the unhandled-error hazard that accompanied every
> sighting. Treat a recurrence as still-open, and do not close it on these
> three green runs alone. Regression coverage:
> `packages/auth/src/session/plugin.test.ts`, which fails on the unfixed plugin.

### The podman VM dies on this host (observed twice, 2026-09-08)

Recorded during W17-06, and it is the strongest lead W16-34 has ever had.

The VM went down **twice in one working session**: once before any test ran
(`podman machine` reported `last up 2 weeks ago`, and the infra guard failed
fast) and once mid-session, where a running worker died with
`AggregateError [ECONNREFUSED] ... 127.0.0.1:5432` and `podman ps` answered
`Cannot connect to Podman ... dial tcp 127.0.0.1:53314: connect: connection
refused`. Nothing was asking the VM to stop either time.

A VM that dies underneath a running suite drops **every** Postgres and Redis
socket at once. That produces exactly what W16-34 recorded — an ioredis
`write EPIPE` from a client- or host-side teardown, with the Redis server
itself showing no rejected connections, no memory pressure and no timeout,
because from the server's point of view nothing went wrong: it went away with
the VM.

This does not close W16-34 — the 15-test `accounts`/`auth-local` failure still
has not been reproduced, and "the VM sometimes dies" is a hypothesis about the
host, not a demonstrated cause of that specific failure. But it is a far better
explanation than memory pressure, and it is checkable: when a run fails,
`podman machine list` and the VM's own log say whether it restarted.

`scripts/dev-up.sh` already starts the VM when it is down, which is why the
recovery is one command.

### Capturing the next occurrence

W16-34's own stated next step was to capture resources at the moment of failure
rather than raise a timeout. Run the suite alongside a sampler:

```bash
# terminal 1 — sample every 3s while the suite runs
PW=$(grep -m1 REDIS_URL .env | sed -E 's|.*://[^:]*:([^@]*)@.*|\1|')
while true; do
  echo "$(date +%H:%M:%S) $(podman exec repopulse-redis redis-cli -a "$PW" --no-auth-warning \
    INFO clients | grep -m1 connected_clients | tr -d '\r') \
    free=$(vm_stat | awk '/Pages free/ {gsub("\\.","",$3); print int($3*16384/1048576)}')MB"
  sleep 3
done

# terminal 2
pnpm test 2>&1 | tee /tmp/run.log
grep -c 'Unhandled error event' /tmp/run.log
```

A 3-second poll of `connected_clients` cannot see a socket that is dropped and
re-established between samples, so treat a flat client count as *no
accumulation*, never as *no drop*. The `Unhandled error event` grep is the
sensitive signal; the sampler is the context around it.

### Do not

- Raise a timeout or add an ioredis retry to make an intermittent failure go
  away. Both hide the next occurrence, and W16-34 forbids them by name.
- Raise `fileParallelism` or the Playwright worker count to speed the suite up.
  Both are load-bearing against shared-state races, not performance choices.
- Run a `pnpm dev` / demo stack against the same data tier while running the
  suite. It is the one condition demonstrated to change the failure profile.
