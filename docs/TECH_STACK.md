# RepoPulse — Tech Stack (Phase 3, pinned)

Traces to: FOUNDING_BRIEF.md (fixed stack + module boundaries), SRS FR/NFR IDs cited inline.
Rule (CLAUDE.md Law 2): versions below are LAW. Verify every API against these majors via
Context7 / node_modules before coding. Upgrades only per the policy at the bottom of this doc.

## Runtime & workspace

| Piece | Pin | Why (one line) |
|---|---|---|
| Node.js | **22.x (LTS)** | Brief-fixed; native `fetch`, stable `--watch`, V8 12.x perf; all packages target `"engines": { "node": ">=22" }`. |
| TypeScript | **5.x**, `strict: true` | Brief-fixed language; strict mode is the cheapest bug gate for cheap agents (C3). |
| pnpm | **9.x** workspaces | Brief-fixed; content-addressed store, strict node_modules prevents phantom-dependency imports across package boundaries (Law 6). |

**W0-01 resolved versions** (dev machine default toolchain is Node 24 / pnpm 11 via fnm+corepack —
neither matches the pin above; recorded here per Law 2 rather than silently building against the
wrong runtime):
- Node **22.23.1** (`.nvmrc`; `fnm use 22` before any install/lint/test/typecheck).
- pnpm **9.15.9** pinned via root `package.json` `"packageManager"` field + `corepack prepare
  pnpm@9.15.9 --activate` (latest 9.x at scaffold time, 2026-07-15).
- All other pins in this doc installed at the latest patch/minor within their pinned major as of
  2026-07-15 (e.g. Fastify 5.10.0, Vite 6.4.3, React 18.3.1, TypeScript 5.9.3, ESLint 9.39.5,
  vitest 3.2.7) — exact ranges live in each workspace's `package.json`, lockfile is the source of
  truth for resolved versions.

### Workspace layout (fixed — matches brief module boundaries)

```
apps/api          Fastify HTTP server: routes, plugins, SSE, webhook receiver; BullMQ workers in src/workers/** (separate entrypoint)
apps/web          React SPA (Vite build), consumes /api/v1 only (FR-API-1)
packages/auth     OAuth flow, Redis-session helpers, RBAC, workspace scoping, identity map, credential vault (FR-AUTH-1..6) — wired into HTTP by apps/api
packages/forge    ForgeProvider interface + GitHubProvider + budgeted client + ETag cache (FR-FORGE-1..6)
packages/ingest   Backfill, webhook event handlers, cursors, reconciliation, queue producers (FR-INGEST-*)
packages/metrics  Tier-1 computations + snapshot writer (FR-METRICS-1..15) — reads DB only
packages/analysis Tier-2/3 LLM gateway, chunker, dimension checklists (FR-ANALYSIS-*) — reads DB only
packages/insights Findings store, health score, trends (FR-INSIGHTS-*)
packages/reports  Report renderer (HTML) + PDF export (FR-REPORTS-*)
packages/shared   Drizzle schema, zod schemas, config, logger, typed errors — the only package everyone may import
```

The **auth** module lives in `packages/auth` (plan.json W1-03/W1-04/W2-01/W4-01 write there);
`apps/api` holds only the thin Fastify wiring (routes/plugins). Its data model lives in
`packages/shared` schema. auth imports `shared` only; `packages/forge` invokes the vault's
decrypt at use time so plaintext credentials exist only in forge memory (SC-1).
**Workers are not a separate workspace package**: BullMQ consumers live in
`apps/api/src/workers/**` and start via a dedicated entrypoint
(`pnpm --filter api start:worker`) — the `repopulse-worker` image (DEPLOYMENT §1) runs that
entrypoint. Dependency rules in ARCHITECTURE.md §3.

## Backend

| Piece | Pin | Why |
|---|---|---|
| Fastify | **5.x** | Brief-fixed; schema-first routes → OpenAPI generation (FR-API-1), encapsulated plugins map 1:1 to route groups. |
| PostgreSQL | **16** | Brief-fixed; single source of truth for UI reads (FR-API-2); RLS available for SaaS flip (D1). |
| Drizzle ORM | **0.45.x** (was 0.39.x until the 2026-10-15 SC-19 refresh, below) | Brief-fixed; SQL-transparent (cheap agents can read generated SQL), `drizzle-kit` migrations are plain SQL files (DATABASE.md migration discipline). |
| postgres (postgres.js) | **3.x** | Not brief-fixed; added W1-01 as the Postgres driver paired with `drizzle-orm/postgres-js` — no driver was pinned in this doc previously. Standard/recommended Drizzle pairing for plain Postgres (vs. Neon/other serverless-specific adapters); reversible, additive choice. |
| Redis | **7.2 (pinned image)** | Brief-fixed; BullMQ backing store + server-side session store (FR-AUTH-2). **License pin**: 7.2 is the last BSD-3 release — 7.4+/8 are RSALv2/SSPLv1/AGPL (DESIGN_REVIEW.md G-18); Valkey 8 (BSD-3) is the sanctioned swap after a BullMQ-compat check. |
| ioredis | **5.11.1** | Not brief-fixed; added W1-03 as the Redis client for packages/auth's session store. Chosen over `redis`/`node-redis` because BullMQ (W2) mandates ioredis — one client library, not two. |
| @fastify/session + @fastify/cookie | **11.1.2** | Not brief-fixed; added W1-03. Official Fastify-maintained session plugin (fastify.dev), `>=10.x` compatible with Fastify `^5.x` per its own compat table. Store is hand-written against the verified `SessionStore` interface (`set`/`get`/`destroy`, express-session-compatible) rather than a third-party Redis-store adapter package — small enough surface to verify directly, avoids an unverified extra dependency. |
| @fastify/helmet | **13.1.0** | Not brief-fixed; added W1-08 (SC-23). `contentSecurityPolicy.useDefaults: false` is required — verified empirically that the default `true` merges helmet's own extra directives (font-src, form-action, img-src, style-src, upgrade-insecure-requests) on top of ours, which would drift from SECURITY_CONTROLS.md's exact CSP string. |
| @fastify/rate-limit | **11.1.0** | Not brief-fixed; added W1-08 (SC-11). Registered with `global: false` (verified: has zero effect on any route until that route opts in via `config: { rateLimit: {...} }}`) — named limit constants exported from `apps/api/src/plugins/rate-limits.ts` for future webhook/share-slug route tickets to reuse rather than re-deriving the SC-11 numbers. |
| pino | **10.3.1** | Not brief-fixed; added W1-08 as `packages/shared`'s direct logger dependency (previously only a transitive dep via Fastify). `hooks.streamWrite` (verified against the installed pino 10.3.1 API) is the SC-2 redaction layer's mechanism — it runs on the fully-serialized line, catching denylisted-field values and bare token/PEM patterns regardless of nesting depth, which pino's own path-based `redact` option can't do generically. Fastify's `loggerInstance` option (not `logger`) accepts this pre-built instance; pino child loggers (which `request.log` is one of) inherit the parent's `streamWrite` hook since it operates at the shared destination-stream level. |
| prom-client | **15.1.3** | Not brief-fixed; added W1-09 (NFR-12) as `packages/shared`'s Prometheus client — one process-wide `Registry` singleton (`packages/shared/src/metrics/registry.ts`) so every wave registers onto the same registry without new plumbing. A metric's `collect()` callback (verified against the installed 15.1.3 API) is the pull-based bridge for W1-05's `BudgetedClient.metricsSnapshot()` (a plain snapshot object, not a live prom-client instance) — **registration order matters**: verified empirically that `Registry.metrics()` serializes each registered metric in registration order, calling only that metric's own `collect()` first, so a metric registered *before* the one carrying the shared `collect()` side effect gets serialized from stale (pre-update) data. The metric with `collect()` must be registered first. Every metric constructor passes `registers: []` explicitly — omitting it silently auto-registers onto prom-client's own implicit default global registry too (verified), which this module must never touch. |

**W1-07**: `packages/shared/src/testing/**` (the NFR-4 route walker) takes an `optional` peer +
dev dependency on `fastify` (`^5.10.0`, matching apps/api's pin) — the only place
`packages/shared` touches a framework type, kept optional so packages/metrics/analysis/
insights/reports (which never import the testing barrel) aren't forced to install it.

**W0-02 resolved images** (`compose.dev.yaml`, 2026-07-16): `docker.io/library/postgres:16`
resolved to PostgreSQL 16.14; `docker.io/library/redis:7.2` resolved to Redis 7.2.14 (both
floating within-major tags, same reproducibility model as the npm `^` ranges above — re-pull
to pick up patches). Both containers run their actual server process as an explicit non-root
`user:` (verified via `podman top`/`podman exec id` — the official postgres/redis entrypoints
support this directly, no root-then-drop-privileges step needed), `cap_drop: [ALL]`,
`security_opt: no-new-privileges:true`, and publish ports bound to `127.0.0.1` only (never
`0.0.0.0`/LAN) — host-run `pnpm dev` processes reach them via `localhost`, the LAN interface
gets connection-refused (verified with `nc` from the host's LAN IP). Postgres auth is pinned
explicit `scram-sha-256` (`POSTGRES_HOST_AUTH_METHOD` + `POSTGRES_INITDB_ARGS`) rather than
relying on the implicit PG16 default; Redis sets `--requirepass`. `scripts/validate-compose.sh`
asserts all of the above statically; `scripts/dev-up.sh` polls both healthchecks.

**W1-01 resolved versions**: `drizzle-orm@0.39.3` + `drizzle-kit@0.31.10` + `postgres@3.4.9` —
verified compatible by actually running `drizzle-kit generate` → `migrate` → `check` against
the live compose Postgres (not just installed side by side). `drizzle.config.ts` needs
`dotenv@17.4.2` (new root devDependency, `import 'dotenv/config'`) since neither drizzle-kit
nor its `defineConfig` auto-loads `.env` — verified empirically (no such behavior in
drizzle-kit's own dependency tree). DATABASE.md §5's "text + CHECK over pg enum for anything
likely to grow" rule is followed uniformly for all of W1-01's ten core tables (`provider`,
`auth_kind`, `role`, `sync_status`, `entity_type`) — none of that section's tables are in the
`metric_key`/`dimension` pg-enum exception. No native `bytea` column exists in
drizzle-orm's pg-core (verified: no `bytea.ts` under `pg-core/columns/`) — defined via
`customType` in `packages/shared/src/db/schema/core/custom-types.ts`; confirmed it round-trips
as a real `bytea` column against live Postgres (`\d forge_connections`), not just at the
TypeScript level.
| BullMQ | **5.x** | Brief-fixed; per-queue concurrency, repeatable jobs (nightly snapshot/reconciliation), DLQ pattern for NFR-11. |
| zod | **3.x** (currently `^3.25.76`) | One validation library everywhere: route bodies, LLM output (FR-ANALYSIS-5), config parsing. **W1-04 note**: zod 4.x is current upstream, but 3.x is brief-fixed — not relitigated. `fastify-type-provider-zod@^4.0.2` (not the current v7, which requires zod ^4) is the zod-3-compatible major that wires zod schemas into Fastify's validator/serializer + OpenAPI generation (verified via installed `.d.ts`: `jsonSchemaTransform`/`validatorCompiler`/`serializerCompiler`). |
| @fastify/swagger | **9.8.1** | Not brief-fixed; added W1-04 for OpenAPI generation from Fastify+zod route schemas (FR-API-1), served at `GET /api/v1/openapi.json` (no UI/`@fastify/swagger-ui` — not required by API_DESIGN.md §5). |

## GitHub access (packages/forge only — Law 7)

| Piece | Pin | Why |
|---|---|---|
| @octokit/core | **6.x** | Minimal core; we compose exactly the plugins we need, no kitchen-sink `octokit` meta-package. |
| @octokit/plugin-throttling | **9.x** | Implements GitHub's own secondary-limit best practices (Retry-After, per-endpoint backoff) — research §1 secondary limits. |
| @octokit/plugin-retry | **7.x** | Transient 5xx retry with jitter; complements, never replaces, our budgeter (FR-FORGE-3). |
| @octokit/auth-app | **7.x** | App JWT → installation token (1h expiry, refresh ~50min per research §8); PAT fallback via `createTokenAuth`. |
| @octokit/graphql | **8.x** | Backfill PR metadata at ~2 points/50 PRs (research §6); separate rate bucket from REST — budgeter tracks both. |

`BudgetedClient` (W1-05, `packages/forge/src/client/`) is transport-agnostic: it takes an
injected request-executor rather than depending on Octokit directly, so the same class
serves both GitHubProvider (W1-06, Octokit-backed executor) and the future Gitea adapter
(W7-02, fetch-backed executor) per the shared contract-test suite (FORGE_PROVIDER.md §5).
Octokit's throttling plugin is the last-line safety net on top of whatever executor W1-06
wires up; the budgeter (FR-FORGE-3, NFR-1) is the primary control. ETag store (FR-FORGE-4)
persists to the `forge_etag` table (not `api_cache` — corrected stale reference) —
304s are free per research §2.

## LLM tiers (packages/analysis only — Law 8)

| Piece | Pin | Why |
|---|---|---|
| openai (SDK) | **4.x** | Tier 2: LM Studio exposes an OpenAI-compatible API; official SDK + `baseURL` override beats hand-rolled fetch and satisfies the NFR-8 lint (no direct HTTP to LAN hosts). |
| @anthropic-ai/sdk | **0.119.x** (pinned W7-01, 2026-08-19) | Tier 3 Claude API deep review (FR-ANALYSIS-7). Verified against node_modules at install: `client.messages.create` is the call used. Model id `claude-sonnet-5` is the default and is workspace-configurable. |

Tier-2 wrapper hard-codes C2 discipline: `max_tokens: 45000`, retry + warm-up on
"model crashed", chunks sized for ≈10k real output tokens (FR-ANALYSIS-2/3).

## Frontend

| Piece | Pin | Why |
|---|---|---|
| React | **18.x** | Brief-fixed; broadest ecosystem/agent familiarity; 19 upgrade deferred (no feature need). |
| Vite | **6.x** | Brief-fixed; instant dev server, single `build` output served by api container or static host. |
| TanStack Router | **1.x** (file-based) | Brief-fixed; typed routes make every drill-down level a URL with typed params (FR-WEB-2 deep links). |
| TanStack Query | **5.x** | Brief-fixed; cache/invalidations keyed per endpoint; pairs with SSE cache-bust for NFR-10 freshness. |
| Tailwind CSS | **4.x** | Brief-fixed; CSS-first config (see traps), dark-first theme via CSS variables (FR-WEB-1). |
| shadcn/ui | **latest (vendored)** | Brief-fixed; components are copied into `apps/web/src/components/ui` — no runtime dep to version-drift. |
| ECharts | **6.x** (was 5.x until the 2026-10-15 SC-19 refresh, below) | Brief-fixed; sparklines, treemap heatmap, histograms (FR-WEB-3) in one lib; canvas renderer handles 50-repo org rollups. |

## PDF generation — decision

**Playwright print-to-PDF from report HTML** (not pdfkit). Rationale:
1. Reports are already React/HTML (FR-REPORTS-1..5) — reusing the dashboard's chart and
   table components means one rendering codepath, zero chart re-implementation in a
   canvas-drawing API (pdfkit would force hand-drawing every ECharts viz).
2. Byte-stable output for an immutable stored report (FR-REPORTS-6) is achievable by
   rendering from the stored HTML snapshot with fixed viewport/fonts.
3. Playwright is already a project dependency (E2E), so no new engine; the worker runs
   `chromium.launch()` headless with `page.pdf({ headerTemplate, footerTemplate })` —
   page numbers and generated-at footer for free.
Cost: ~300MB Chromium in the worker image; acceptable on Podman infra (D1). pdfkit remains
rejected: no HTML/CSS layout, every report section would be bespoke drawing code — hostile
to cheap agents (C3).

## Test & tooling

| Piece | Pin | Why |
|---|---|---|
| vitest | **4.x** (was 3.x until the 2026-10-15 SC-19 refresh, below) | Brief-fixed; one runner for all packages, workspace projects config. |
| Playwright | **1.x (latest)** | Brief-fixed; E2E vs seeded stack + doubles as the PDF engine. |
| nock / msw | latest | Forge-call guard in api tests (FR-API-2 runtime check) + recorded GitHub fixtures (FR-FORGE-2). |
| ESLint | **9.x flat config** | Carries the law-enforcing rules: no `packages/forge` import outside ingest/api-webhook wiring, no raw fetch to forge/LM hosts (FR-FORGE-6, NFR-8). |
| drizzle-kit | matching Drizzle | SQL migration generation; migrations committed, never edited after merge. |
| k6 | latest | NFR-3 p95<500ms latency gate against seeded 50-repo dataset. |
| prettier | **3.x** | Not brief-fixed; added W0-01 to back `.prettierrc.json`/`format`/`format:check` scripts. Not part of the Law-3 gate (`lint && typecheck && test`) — `pnpm format:check` is a separate, non-blocking script. |
| gitleaks | **8.30.1 (pinned, checksummed download)** | Not brief-fixed; added W0-03 for SC-18 (secrets-in-CI gate). Full-history scan (`--log-opts="--all"`, `fetch-depth: 0`) on every CI run, not just a one-time "first run" — cheap at this repo's current size. `.gitleaks.toml` allowlists `.env.example` (dev-only placeholder values, not secrets). |
| osv-scanner | **2.4.0 (pinned, checksummed download)** | SC-19 dependency-vulnerability gate — **replaces `pnpm audit`**, added W0-03 (Brad approved 2026-07-16). `pnpm audit` is broken against the current npm registry for pnpm 9.x/10.x: npm retired the legacy audit endpoints it calls (HTTP 410), only fixed in pnpm 11 (github.com/pnpm/pnpm#13033); this repo stays on the brief-fixed pnpm 9.x pin, so bumping to fix `audit` was out of scope for a CI ticket. osv-scanner reads `pnpm-lock.yaml` directly, never touches the retired endpoint. **Known deviation** from the original SC-19 wording ("pnpm audit --prod ... fail on high/critical"): osv-scanner has no `--prod`-only filter (scans the full lockfile incl. devDependencies) and fails on any detected, "important" (its own call-graph-aware heuristic, not a raw severity cutoff) vulnerability rather than a strict high/critical-only threshold — broader coverage, not a narrower gate. |

## Known traps for cheap coding agents (read before touching each area)

- **Tailwind 4 is CSS-first.** There is no `tailwind.config.js` by default. Theme tokens go
  in `@theme { ... }` inside the CSS entry; plugin is `@tailwindcss/vite`, import is
  `@import "tailwindcss";` — NOT the v3 `@tailwind base/components/utilities` triplet.
  shadcn/ui must be installed with its Tailwind-v4/CSS-variables preset.
- **Drizzle relational queries need the `relations` objects.** `db.query.repos.findMany({ with: { pullRequests: true }})`
  only works if `relations()` are defined in the schema AND passed to `drizzle(client, { schema })`.
  Otherwise use explicit `select().from().leftJoin()`. Never mix query-builder `.where()` with
  relational `where` callback syntax — different signatures.
- **BullMQ repeatable jobs**: `queue.upsertJobScheduler()` (v5 API) — not the removed
  `queue.add(..., { repeat })` patterns from v3 blog posts. Workers MUST implement graceful
  shutdown: `await worker.close()` on SIGTERM so in-flight backfill jobs checkpoint
  (FR-INGEST-3) instead of dying mid-page. One `Worker` per queue, `concurrency` set
  explicitly, `QueueEvents` for progress, not deprecated global events.
- **TanStack Router file-based routes**: routes live in `apps/web/src/routes/`, the route
  tree is GENERATED (`routeTree.gen.ts` — never hand-edit, commit it), path params are
  `$repoId` file naming, and loaders get typed `params`. Use `@tanstack/router-plugin` for
  Vite; forgetting it means stale route trees and “route not found” confusion.
- **Octokit throttling plugin config is mandatory**: `throttle: { onRateLimit, onSecondaryRateLimit }`
  callbacks must be provided (return `true` to retry ≤N times); omitting them throws at
  construction in recent majors. Our budgeter decides scheduling; callbacks only log + defer.
- **Fastify 5 plugin encapsulation**: decorators/hooks registered in a plugin are scoped to
  that plugin unless wrapped in `fastify-plugin`. Auth decorators (`fastify.authenticate`)
  must be `fp()`-wrapped; route-group plugins (e.g. `/api/v1/repos`) must NOT be, so their
  hooks don't leak. Also: Fastify 5 requires `avvio`-compatible async register — no
  callback-style plugins.
- **LM Studio "45000 maxTokens" is headroom, not throughput** (C2): real usable output is
  ~10k tokens on qwen3.6-class models. Never size a chunk assuming 45k output.
- **GitHub stats endpoints return 202 first** and degrade ≥10k commits (research §3) —
  always code the retry-after-202 loop AND the REST per-commit fallback path.
- **vitest 4.x has no `vitest.workspace.ts`**: projects are the `test.projects` array in the root
  `vitest.config.ts` (moved there in W16-17). Pool options are top-level (`poolOptions`,
  `singleFork`, `maxThreads` are gone); the root `fileParallelism: false` still serialises files
  across every project (checked on 4.1.11 with timestamp probes in two packages). A `vi.fn`
  called with `new` needs a `function`/`class` implementation, not an arrow.

## SC-19 dependency-audit refresh (2026-10-15)

osv-scanner 2.4.0 reported 59 advisories across 21 packages against the lockfile. Fixed under
upgrade-policy rule 4 (security advisories override). Every version below was checked against
registry.npmjs.org and installed; the Law-3 gate was run after each step.

**Step 1: patch/minor, no overrides.** Direct ranges raised: `fastify` ^5.10.0 → ^5.12.7
(apps/api dep; packages/auth and packages/shared dev + peer, in lockstep), `@fastify/swagger`
^9.8.1 → ^9.9.2. Transitive versions refreshed in the lockfile within their parents' existing
ranges (no `pnpm.overrides` entry is left behind): find-my-way 9.6.0 → 9.10.0, fast-uri
3.1.3 → 3.1.8 and 4.1.0 → 4.2.2, js-yaml 4.2.0/4.3.0 → 4.3.2 (4.2.0 came from
`@redocly/openapi-core` 1.34.17's exact pin; openapi-typescript's `^1.34.6` range now resolves
1.34.21), nanoid 3.3.16 → 3.3.20, postcss 8.5.19 → 8.5.30, seroval/seroval-plugins
1.5.5 → 1.6.9, source-map-js 1.2.1 → 1.2.2, brace-expansion 1.1.16/2.1.2/5.0.7 →
1.1.21/2.1.7/5.0.12, browserslist 4.28.6 → 4.29.3, baseline-browser-mapping
2.10.43 → 2.11.28. TanStack Router stays at 1.170.18: seroval is fixed inside router-core's
own `^1.5.4` range, and moving the router to 1.170.44 in the same step broke three
repo-layout navigation tests (apps/web `routes/repos/$repoId/route.test.tsx`), which is a
router upgrade of its own, not an audit fix.

**Step 2: drizzle-orm ^0.39.3 → ^0.45.2** (resolved 0.45.4) in every workspace that declares it
(root, apps/api, auth, forge, ingest, insights, metrics, reports, security, shared), with
drizzle-kit ^0.31.10 → ^0.31.11 alongside it. Fixes GHSA-gpj5-g38j-94v9 (`sql.identifier()` /
`sql.as()` escaping, fixed in 0.45.2). Changelogs 0.40.0–0.45.4 read
(github.com/drizzle-team/drizzle-orm/tree/main/changelogs/drizzle-orm). What mattered here:
- **0.44.0 wraps every driver error in `DrizzleQueryError`**: the message becomes
  `Failed query: <sql>\nparams: <values>` and the postgres.js `PostgresError` (SQLSTATE `code`,
  `constraint_name`) moves to `.cause`. Matching a constraint name in the message no longer
  works: the admin LLM-provider route returned 500 instead of 409 for a duplicate name. Fixed by
  `pgErrorOf` / `isConstraintViolation` in `packages/shared/src/db/pg-error.ts`, which walk the
  `cause` chain. Side effect to keep in mind: an `err.message` that is logged or stored now
  carries the SQL text and bound parameter values instead of the Postgres reason.
- 0.41.0 dropped drizzle's own postgres-js parsers for `numeric[]`, `timestamp[]`,
  `timestamptz[]`, `interval[]`, `date[]`. The schema has no such array columns (only
  `bigint[]`), so nothing changes here.
- `drizzle-kit check` passes and `drizzle-kit generate` reports "No schema changes" against
  the existing migrations, so no migrations were regenerated.

**Step 3: echarts ^5 → ^6.1.0** (apps/web; resolved 6.1.0). Fixes GHSA-fgmj-fm8m-jvvx (fixed
in 6.1.0, no 5.x fix). Read the v6 upgrade guide
(echarts.apache.org/handbook/en/basics/release-note/v6-upgrade-guide). Our tree-shaken imports
(`echarts/core`, `/charts`, `/components`, `/renderers`) and `init`/`setOption` are unchanged.
What changed for us:
- **The default legend moved from the top edge to the bottom.** Our theme
  (`apps/web/src/components/chart/chartTheme.ts`) now sets `legend.top: 0`. Without it the
  file-churn legend rendered at y=186 of a 220px chart, on the x-axis labels (measured with
  ECharts' SSR SVG renderer and pinned by `chartTheme.test.ts`).
- The new default palette does not apply: the theme sets `color` from our tokens.
- Axis-label overflow/overlap prevention is on by default, so axes can move a few pixels.
  `grid.containLabel` is still honoured. Rich text labels are not used.
- Initial JS stays at 140.8 KB gz (budget 200 KB); ECharts is in a lazy chunk.

**Step 4: vitest ^3.2.7 → ^4.1.11** (root + apps/web; resolved 4.1.11; vite stays 6.4.3, inside
vitest 4's `^6 || ^7 || ^8` peer range). Fixes GHSA-82fw-gwwq-j7x9 (vitest, @vitest/mocker) and
GHSA-5gmw-xhrv-c9v3 / GHSA-85c8-ppgw-ccpr (tinypool, which vitest 4 no longer depends on). Read
the v4 migration guide (vitest.dev/guide/migration#vitest-4). The repo already used
`test.projects`, so the config is unchanged. The run collects the same 332 files as before
(the narrower default `exclude` did not pick up anything new). What broke:
- vitest 4's typings stopped pulling in `@types/node` by accident. Five apps/web test files use
  `node:fs`/`process`, so apps/web now declares `@types/node` (^22.20.1, same as every other
  workspace) and names `"node"` in its tsconfig `types`.
- `ReturnType<typeof vi.spyOn>` is now too loose to type `mock.calls`. packages/auth
  `session/plugin.test.ts` uses `MockInstance<typeof console.error>`.
- A teardown race the new module runner exposed: `Chart.test.tsx` unstubbed `ResizeObserver`
  before the setup file's `cleanup()` unmounted a chart whose lazily imported echarts instance
  arrived after the test body. That file now unmounts first, then unstubs.

**Step 5: esbuild 0.18.20 → 0.25.12 by `pnpm.overrides`** (the only override in the repo).
`"@esbuild-kit/core-utils>esbuild": "^0.25.12"`. Reason: drizzle-kit (latest stable 0.31.11)
still declares the deprecated `@esbuild-kit/esm-loader` → `@esbuild-kit/core-utils`, which pins
`esbuild ~0.18.20` (GHSA-67mh-4wv8-2f99), and no drizzle-kit release fixes it. drizzle-kit's
own code never loads `@esbuild-kit` (it uses tsx and esbuild ^0.25), and core-utils'
`transformSync` was checked to work on 0.25.12 anyway. Remove the override when drizzle-kit
drops the dependency. `drizzle-kit check`/`generate`/`migrate` were re-run clean with it.

Result: `osv-scanner scan source --lockfile=pnpm-lock.yaml` reports no issues.

## Version upgrade policy

1. Majors in this doc are pinned; `package.json` uses `^` within the pinned major, lockfile
   commits make builds reproducible.
2. Upgrading a MAJOR of anything in this doc requires: a ticket, this doc updated in the
   same PR, workspace-wide `pnpm lint && pnpm typecheck && pnpm test` green (Law 3), and a
   note in docs/STATUS.md. No drive-by major bumps inside feature tickets.
3. Minors/patches: allowed via scheduled dependency-update tickets only; `pnpm update`
   output reviewed, never auto-merged.
4. Security advisories override: patch immediately on any branch, backfill the paperwork.
5. shadcn/ui components are vendored — "upgrading" a component is a diff-reviewed re-copy,
   never a blind regeneration.
