# RepoPulse — Software Requirements Specification (SRS)

Traces to: `docs/work/FOUNDING_BRIEF.md` (D1–D7, C1–C3, P1–P4). IEEE-lite format.
Priority values: **MVP** (roadmap wave 1, D5 slice) or **v1.x** (post-MVP waves).
Every requirement has a stable ID for plan.json traceability (C3).

## 1. Scope

Clone-free (C1) GitHub repo health/quality/delivery monitoring web service.
Single deployment on bpmforge infra, workspace-scoped SaaS-ready schema (D1).
Modules per brief: forge · ingest · metrics · analysis · insights · reports · auth · api · web.

### 1.1 Definitions

| Term | Meaning |
|------|---------|
| Warehouse | RepoPulse's own PostgreSQL store of ingested forge entities + computed metrics. The only data source for API/UI reads. |
| Window | Metric aggregation period; selectable 7/30/90/365 days, default 30d, ending "now" unless a report pins it. |
| Budget | Configured share of the forge rate limit RepoPulse may spend per hour (FR-FORGE-3); GitHub core = 5000 pts/h/token. |
| Cursor | Per (repo, entity-type) high-watermark (`updated_at` or delivery id) marking the last fully-ingested change. |
| Snapshot | Persisted (metric_id, repo, window, value, computed_at) row enabling trend charts without recomputation. |
| Tier 1/2/3 | D2: API-derived metrics (always on) / local-LLM diff review / opt-in Claude API deep review. |
| Finding | One analysis result item per FR-ANALYSIS-5 schema, with dedup fingerprint and lifecycle status. |
| View | Named, saved combination of repo filter + window + tile/metric layout (FR-API-6, FR-WEB-4). |
| Bot PR | PR authored by an account on the workspace's configurable bot list (default: `*[bot]` logins); excluded from human-flow metrics. |

### 1.2 Actors

P1 Engineering Lead · P2 Developer · P3 Security Engineer · P4 EM/Exec (personas per brief);
system roles: **admin** and **member** (FR-AUTH-4). External systems: GitHub (v1), Gitea (v1.x),
LM Studio LAN hosts (Tier 2), Claude API (Tier 3).

## 2. Functional Requirements

### 2.1 forge — ForgeProvider abstraction + GitHub implementation

| ID | Requirement | Acceptance sketch | Priority |
|----|-------------|-------------------|----------|
| FR-FORGE-1 | Define a `ForgeProvider` TypeScript interface covering: listOrgRepos, getRepo, listCommits, getCommit, listPullRequests, getPullRequest, listPRReviews, listPRComments, listPRFiles, getPRDiff, getFileContents, listCheckRuns, listWorkflowRuns, listReleases, listDeployments, listIssues, registerWebhook, verifyWebhookSignature. | Interface compiles in `packages/forge`; every ingest call site imports the interface, never a concrete client (enables D3 Gitea adapter). | MVP |
| FR-FORGE-2 | Implement `GitHubProvider` against REST v3 (+ GraphQL where one query replaces N REST calls, e.g. PR review threads). | Contract tests with recorded fixtures pass for every interface op. | MVP |
| FR-FORGE-3 | All GitHub calls go through a rate-limit-aware client: reads `x-ratelimit-*` headers, maintains a token budget, queues/delays when remaining < configurable floor, honors `Retry-After` on secondary limits. | Unit test: simulated 100-remaining response throttles queue; no request is emitted once budget floor is hit. | MVP |
| FR-FORGE-4 | ETag conditional-request cache: persist ETag per (endpoint, params); send `If-None-Match`; treat 304 as free (GitHub does not charge 304s against the core limit). | Repeat sync of an unchanged repo consumes ≥90% fewer rate-limit points than first sync (fixture test). | MVP |
| FR-FORGE-5 | Support both auth modes for forge access: user PAT and GitHub App installation token, selected per workspace connection. | Both credential types successfully list a private org repo in integration test. | MVP |
| FR-FORGE-6 | Targeted file-contents fetch (single path @ ref) for analysis context — never a tree/tarball clone (C1). | No code path calls tarball/zipball/git-clone endpoints; lint rule + code review gate. | MVP |
| FR-FORGE-7 | `GiteaProvider` implementing the same interface (D3). | Same contract-test suite passes against a Gitea fixture server. | v1.x |

### 2.2 ingest — connect, backfill, webhooks, sync

| ID | Requirement | Acceptance sketch | Priority |
|----|-------------|-------------------|----------|
| FR-INGEST-1 | Connect flow: admin supplies credential → RepoPulse lists accessible orgs/repos → admin selects repos (or "all + auto-add new") → connection saved per workspace. | E2E: connect fixture org, select 3 repos, connection row + repo rows exist with status `pending_backfill`. | MVP |
| FR-INGEST-2 | 12-month historical backfill per repo: commits, PRs (+reviews, comments, files), issues, check/workflow runs, releases, deployments. | After backfill of fixture repo, warehouse row counts match fixture ground truth; window = now−365d. | MVP |
| FR-INGEST-3 | Backfill is resumable: progress checkpoint per (repo, entity-type, cursor/page); a crashed or rate-paused job resumes from checkpoint, never restarts from zero. | Kill worker mid-backfill; restart; no duplicate rows, completion reached. | MVP |
| FR-INGEST-4 | Backfill is prioritized and budgeted: recently-active repos first; entity order PRs→commits→checks→issues→releases; each BullMQ job draws from the FR-FORGE-3 budget and yields when the floor is hit, rescheduling itself. | 50-repo simulated org completes within budget (NFR-2); queue drains most-active repo's PRs first. | MVP |
| FR-INGEST-5 | Webhook receiver endpoint: registers webhooks on connect (FR-FORGE-1), verifies HMAC signature on every delivery, rejects unsigned/invalid with 401, enqueues typed events (push, pull_request, pull_request_review, check_run, issues, release, deployment_status). | Tampered-signature fixture → 401 + no job enqueued; valid fixture → job enqueued. | MVP |
| FR-INGEST-6 | Incremental sync cursors: per (repo, entity-type) high-watermark (updated_at / delivery id) so webhook gaps are filled by cursor-based pulls, idempotent upserts on natural keys. | Replaying the same webhook twice produces identical warehouse state. | MVP |
| FR-INGEST-7 | Nightly reconciliation sweep: low-priority job re-lists entities updated since last sweep per repo, repairs drift (missed webhooks, force-pushes, deleted PRs), using ETag cache to stay cheap. | Inject a missed-webhook gap in fixtures; sweep restores parity; sweep of unchanged repo costs near-zero budget. | MVP |
| FR-INGEST-8 | Sync status surfaced to UI: per repo expose state (pending/backfilling/live/error/paused-for-budget), % complete, last-synced timestamp, last error; org-level aggregate banner. | API returns status objects; web shows progress during backfill E2E. | MVP |
| FR-INGEST-9 | Repo disconnect/pause: admin can pause or remove a repo; removal deletes webhook registration and (optionally) warehoused data. | Pause stops job scheduling; remove deregisters webhook in fixture. | v1.x |

### 2.3 metrics — Tier-1 computations (D2 Tier 1, always on)

Common contract for FR-METRICS-1..12 (asserted once, tested per metric): computed from
warehouse only (no live forge calls); parameterized by window (§1.1); available per-repo
and as org rollup (FR-METRICS-14); snapshotted for trends (FR-METRICS-13); bot PRs/commits
excluded where marked. All are **Priority: MVP**.

**FR-METRICS-1 — Commit churn.** Per repo, file, and author over window: gross churn =
additions + deletions; net churn = additions − deletions; rework churn = lines changed in
files the same or another author changed <21 days prior (approximated from the file-level
commit sequence in the warehouse — no clone, per C1).
*Acceptance:* fixture repo with known commit stats reproduces gross/net/rework to the line.

**FR-METRICS-2 — File hotspots.** hotspot(file) = norm(gross churn over window) ×
2^(−days_since_last_touch / 30) (recency half-life 30d). Top-N ranking per repo with the
score decomposition and contributing commits exposed for drill-down.
*Acceptance:* ordering matches hand-computed fixture scores; untouched-for-a-year file scores ≈0.

**FR-METRICS-3 — Ownership / bus factor.** Per file and directory over trailing 365d:
top-author share = % of lines-changed by the largest contributor; bus factor = minimum
number of authors covering ≥50% of lines-changed. Files with top-author share ≥80% are
flagged single-owner.
*Acceptance:* fixture with 3 authors at 60/30/10 yields bus factor 1 and no flag at 60%.

**FR-METRICS-4 — PR cycle-time stages.** Per merged PR: open→first-review (first non-author
review or review-comment), first-review→approved (first APPROVED review), approved→merged.
Report median + p90 per stage and end-to-end over window. PRs merged without review
contribute only to end-to-end. Bot PRs excluded.
*Acceptance:* stage math verified on fixtures incl. re-request/dismiss sequences (first
approval after last re-request counts).

**FR-METRICS-5 — Review coverage %.** merged PRs with ≥1 completed non-author review ÷ all
merged PRs over window. *Acceptance:* self-approved-only PR counts as uncovered.

**FR-METRICS-6 — Merged-without-review rate.** 1 − FR-METRICS-5, plus a drill-down list of
offending PRs (merger, author, size bucket, merged_at). *Acceptance:* list reconciles with
the rate to the PR.

**FR-METRICS-7 — PR size distribution.** Histogram of merged-PR gross line delta
(additions + deletions) in buckets XS<10, S<100, M<500, L<1000, XL≥1000; median size trend
across snapshots. *Acceptance:* bucket boundaries inclusive-lower/exclusive-upper, fixture-verified.

**FR-METRICS-8 — Stale PRs.** Open PRs with no commit, review, or comment for >N days
(default 7, workspace-configurable); count + age-sorted list with last-activity kind.
*Acceptance:* activity of any tracked kind resets staleness; draft PRs flagged separately.

**FR-METRICS-9 — CI pass rate + duration.** Per repo and per workflow over window:
pass rate = successful runs ÷ completed runs (default branch + PR runs, reported separately);
duration median + p90 trend; flakiness rank = rate of fail→pass on re-run of the same head SHA.
*Acceptance:* in-progress/cancelled runs excluded from denominator; flaky fixture ranks first.

**FR-METRICS-10 — Issue throughput.** Opened vs closed counts per window, median
time-to-close for issues closed in window, open-issue age distribution.
*Acceptance:* reopened issues count once per close; PRs never counted as issues.

**FR-METRICS-11 — Release cadence.** Releases (fallback ordering: releases, else tags-as-releases
if published) per window; median gap between consecutive releases; days since last release.
*Acceptance:* draft/prerelease handling configurable, default = published only.

**FR-METRICS-12 — DORA approximations.** Deployment frequency = deployments per window
(fallback: releases, basis labeled); lead time for changes = median merge→deployment time of
commits included in each deployment; change-failure rate = deployments followed <48h by a
revert/hotfix-heuristic commit (message `revert|hotfix|rollback` or GitHub revert linkage) ÷
deployments. Every DORA tile/report cites its heuristic basis (D5/P4 defensibility).
*Acceptance:* fixture org reproduces all three; basis label present in API payload.

**FR-METRICS-13 — Metric snapshots.** Nightly job writes per-repo snapshot rows
(metric_id, repo_id, window, value, numerator/denominator where ratio, computed_at);
retained ≥400d; trend endpoints read snapshots only.
*Acceptance:* two nightly runs produce two rows; trend endpoint never triggers recomputation.

**FR-METRICS-14 — Org rollups.** Every metric aggregates to org level with statistically
correct pooling (e.g. cycle-time percentiles pooled across PRs, never averaged per repo;
ratios summed numerator/denominator). Rollups honor the active view's repo filter.
*Acceptance:* pooled p90 ≠ mean-of-repo-p90s test; filter subset changes rollup.

**FR-METRICS-15 — Metric definitions catalog.** Machine-readable catalog endpoint
(id, name, formula text, unit, direction good/bad, heuristic notes) — single source of truth
consumed by UI tooltips (FR-WEB-1) and report footnotes (FR-REPORTS-*).
*Acceptance:* every FR-METRICS-1..12 id present; UI renders tooltip from catalog, not hardcoded strings.

### 2.4 analysis — Tier-2/3 LLM review (D2; roadmap wave 2)

| ID | Requirement | Acceptance sketch | Priority |
|----|-------------|-------------------|----------|
| FR-ANALYSIS-1 | Tiered dispatch: analysis requests carry tier T2 (local LLM) or T3 (Claude API); T2 is default for bulk PR review; T3 only for repos/PRs explicitly opted in (D2). | Dispatcher unit tests route by tier + opt-in flag; T3 without opt-in is rejected. | v1.x |
| FR-ANALYSIS-2 | T2 local-LLM client honors C2: 45000 maxTokens per call, retry + model warm-up on LM Studio "model crashed", diff chunked so expected output ≤10k tokens per chunk. | Chunker property test: no chunk's prompt projects >10k output; crash fixture triggers warm-up+retry then succeeds. | v1.x |
| FR-ANALYSIS-3 | Diff chunking: PR diff split by file, large files by hunk groups; each chunk carries PR title/description + file path context; chunk results merged per PR. | 5000-line fixture diff → all hunks covered exactly once across chunks. | v1.x |
| FR-ANALYSIS-4 | Dimension checklists ported from bpm-opencode-experts: code health, security, performance, test coverage; each dimension = versioned checklist prompt; runs record checklist version. | Four dimension prompts exist as versioned assets; run rows reference version. | v1.x |
| FR-ANALYSIS-5 | Finding schema: severity (critical/high/medium/low/info), confidence (0–1), dimension, repo, PR, file, line-range, title, evidence excerpt, recommendation, tier, model id, checklist version. | Zod schema validates model output; malformed output → retry once then dead-letter with raw payload kept. | v1.x |
| FR-ANALYSIS-6 | Dedup across runs: stable fingerprint (dimension + file + normalized title + line-bucket); re-analysis updates last_seen/occurrence count instead of duplicating; resolved findings that reappear reopen. | Re-running analysis on unchanged PR yields 0 new finding rows. | v1.x |
| FR-ANALYSIS-7 | T3 Claude API deep review: whole-PR context (within model limits), same finding schema, per-call cost recorded; opt-in flag per repo and per-PR override. | T3 run on fixture PR produces findings + cost row; egress log written (NFR-9). | v1.x |
| FR-ANALYSIS-8 | Analysis scheduling: auto-analyze new/updated PRs on webhook (T2) per repo policy; manual "analyze now" from UI; org-level concurrency cap on LAN hosts. | Policy matrix test: repo with auto=off never enqueues; cap respected under burst. | v1.x |

### 2.5 insights — findings store, scoring, trends

| ID | Requirement | Acceptance sketch | Priority |
|----|-------------|-------------------|----------|
| FR-INSIGHTS-1 | Findings store: persist all analysis findings (FR-ANALYSIS-5) with lifecycle status (open/acknowledged/resolved/wont-fix) and audit of status changes. | Status transition API + history rows; filters by dimension/severity/status. | v1.x |
| FR-INSIGHTS-2 | Repo health score: 0–100 composite with transparent formula — weighted sub-scores (delivery = cycle time + CI; quality = review coverage + hotspot concentration + churn; security = open security findings when T2/T3 enabled; freshness = stale PRs + release cadence). Weights configurable per workspace; formula + sub-scores always shown in UI (no black box). | Score endpoint returns value + full breakdown (each input, its normalization, weight, contribution); doc'd formula reproduces value in test. | MVP |
| FR-INSIGHTS-3 | Health score degrades gracefully: with only Tier-1 data, security sub-score is excluded and weights renormalized, labeled "Tier-1 only". | Score computes without any analysis rows; UI badge states basis. | MVP |
| FR-INSIGHTS-4 | Trend deltas: for score and every Tier-1 metric, delta vs previous equal-length window (▲/▼ + %) from FR-METRICS-13 snapshots. | Delta math verified against fixture snapshots incl. missing-prior-window case. | MVP |
| FR-INSIGHTS-5 | Hotspot ranking page data: cross-repo ranked list combining file hotspot score (FR-METRICS-2) with open finding density; links into drill-down. | Endpoint returns ranked entries with score components. | MVP (Tier-1 inputs) / v1.x (finding density) |

### 2.6 reports — report center + PDF (D7)

| ID | Requirement | Acceptance sketch | Priority |
|----|-------------|-------------------|----------|
| FR-REPORTS-1 | Report center: generate on demand, list history (type, scope, window, generated_by, generated_at), view any past report in-app; reports are immutable snapshots. | Generate → appears in history; reopening renders identical stored content. | MVP |
| FR-REPORTS-2 | Report type: Repo Health — score + breakdown, key Tier-1 metrics with trends, hotspots, stale PRs, top findings (when present). | Fixture repo renders all sections; sections with no data state "no data", never blank. | MVP |
| FR-REPORTS-3 | Report type: Org Exec Summary (P4) — org rollups, DORA trends, per-repo score table, notable deltas. | Renders for multi-repo fixture org. | MVP |
| FR-REPORTS-4 | Report type: Security Posture (P3) — open security-dimension findings by severity/repo, merged-without-review rate, dependency/secret-signal summary; audit-ready pack framing. | Renders with Tier-1-only data (review-bypass section) and enriches when findings exist. | v1.x |
| FR-REPORTS-5 | Report type: Delivery/DORA — deployment frequency, lead time, CFR, cycle-time stages, throughput, with heuristic-basis footnotes (FR-METRICS-12). | Renders; footnotes present. | MVP |
| FR-REPORTS-6 | PDF export: any report exports to paginated PDF (header/footer, generated-at, workspace, page numbers); byte-stable for the same stored report. | Playwright downloads PDF; text extraction contains section headings; ≤30s generation. | MVP |
| FR-REPORTS-7 | Report scoping: every report is parameterized by repo set + time window at generation time; parameters stored with the report. | History row shows scope; regenerate-with-same-scope action works. | MVP |

### 2.7 auth — identity, workspace, credentials (D6, D1)

| ID | Requirement | Acceptance sketch | Priority |
|----|-------------|-------------------|----------|
| FR-AUTH-1 | GitHub OAuth login (authorization-code flow); on first login create user linked to GitHub identity (id, login, avatar). | E2E vs mocked GitHub: login round-trip creates session + user row. | MVP |
| FR-AUTH-2 | Sessions: httpOnly secure cookie, server-side session store (Redis), idle timeout + absolute lifetime, logout revokes. | Cookie flags asserted; expired session → 401 → login redirect. | MVP |
| FR-AUTH-3 | Workspace membership: every user belongs to ≥1 workspace; all tenant-scoped queries filter by workspace_id (D1); launch ships single `default` workspace with auto-membership. | Tenancy isolation test (NFR-4) passes; membership join enforced in repo-layer helpers. | MVP |
| FR-AUTH-4 | Roles: admin (manage connections, credentials, members, T3 opt-in, weights) vs member (read dashboards, generate reports, manage own views). Route-level enforcement. | Member calling admin endpoint → 403; matrix test over all admin routes. | MVP |
| FR-AUTH-5 | Forge credential storage: PATs / GitHub App private keys encrypted at rest (AES-256-GCM, key from env/KMS, never in DB or logs); decrypted only in forge module memory; UI shows last-4/fingerprint only. | DB dump contains no plaintext token (test greps); log scrubber test. | MVP |
| FR-AUTH-6 | Identity mapping for personalized views: link workspace user → forge author identity so "my PRs" / "my review load" resolve (D6). | Logged-in fixture user's PR list matches ground truth. | MVP |

### 2.8 api — REST surface

| ID | Requirement | Acceptance sketch | Priority |
|----|-------------|-------------------|----------|
| FR-API-1 | Versioned REST API (`/api/v1`) exposing all dashboard data: orgs, repos, metrics, snapshots/trends, PRs, files, findings, scores, sync status, reports, views. UI consumes only this API. | OpenAPI spec generated from Fastify schemas; schemathesis/contract suite green. | MVP |
| FR-API-2 | All read endpoints serve exclusively from PostgreSQL warehouse — zero live forge calls in any request handler (C1, NFR-3). | Static check: `packages/forge` is not a dependency of route handlers; runtime nock guard in API tests. | MVP |
| FR-API-3 | Uniform list semantics: cursor pagination, sort, time-window and repo-set filter params shared across list endpoints. | Shared schema fragment; pagination round-trip test. | MVP |
| FR-API-4 | AuthZ on every route: session required, workspace scoping, role checks (FR-AUTH-4); consistent error envelope (code, message, request id). | Unauthenticated request to every route → 401 (route-walker test). | MVP |
| FR-API-5 | Drill-down endpoints: org summary → repo detail → PR list/detail (stages, reviews, checks, files) → file detail (churn, owners, hotspot history, findings) → finding detail. | Each level returns children links; E2E walks the chain. | MVP |
| FR-API-6 | Saved views CRUD: named view = filter set (repos, window, metrics) + layout; private by default, shareable per FR-WEB-5. | CRUD tests + ownership enforcement. | MVP |

### 2.9 web — dashboard UI

| ID | Requirement | Acceptance sketch | Priority |
|----|-------------|-------------------|----------|
| FR-WEB-1 | Dashboard shell: org overview (health scores, key metric tiles with sparklines, sync status banner) as landing page; dark-first theme with light toggle; Tailwind 4 + shadcn/ui. | Playwright: landing renders tiles + sparklines from fixture warehouse. | MVP |
| FR-WEB-2 | Drill-down navigation org→repo→PR→file→finding with persistent breadcrumb; every level is a routed URL (TanStack Router) — deep links restore full state. | E2E walks all levels via clicks and via direct URL paste. | MVP |
| FR-WEB-3 | Visualizations: trend line/sparkline charts (ECharts) for all snapshot-backed metrics; hotspot heatmap (treemap by directory, intensity = hotspot score); PR-size histogram; cycle-time stage bars. | Each viz renders from fixtures; empty-state designed. | MVP |
| FR-WEB-4 | Custom saved views: create/rename/delete named views (repo filter + window + metric/tile layout); switcher in nav; per-user default view. | E2E: create view, reload, view persists and applies. | MVP |
| FR-WEB-5 | Shareable view links: stable URL per saved view; any workspace member opening it sees the same filters/layout. | Second fixture user opens link → identical rendering. | MVP |
| FR-WEB-6 | Command palette (⌘K): fuzzy quick-nav to repos, PRs, views, report types, admin pages. | Keyboard-only E2E: ⌘K → type repo name → Enter lands on repo page. | MVP |
| FR-WEB-7 | Personalized widgets (D6): "my open PRs", "my review load" on the developer view. | Fixture identity mapping drives correct lists. | MVP |
| FR-WEB-8 | Sync/analysis transparency: repo pages show sync state (FR-INGEST-8) and, in v1.x, analysis tier/status per PR incl. Tier-2-degraded notice (NFR-7). | Backfilling repo shows progress instead of misleading empty metrics. | MVP |
| FR-WEB-9 | Findings UX (v1.x): finding list with dimension/severity/status filters, finding detail with evidence + file/line context, status transitions per FR-INSIGHTS-1. | E2E: filter, open, acknowledge a finding. | v1.x |

## 3. Non-Functional Requirements

| ID | Requirement | Verification | Priority |
|----|-------------|--------------|----------|
| NFR-1 | Rate-limit compliance: RepoPulse never exceeds its configured forge budget; on exhaustion, jobs pause and resume — no 403-secondary-limit bans in steady state. | Load test with mock GitHub enforcing limits: zero over-budget requests. | MVP |
| NFR-2 | Backfill throughput: 12-month backfill of a 50-repo org completes in ≤24h within a single-token GitHub budget (5000 pts/h), using ETag + GraphQL batching. | Simulated-org benchmark in CI (scaled) + documented capacity math. | MVP |
| NFR-3 | Dashboard latency: p95 < 500ms server time for any page's data endpoints from the warehouse; UI never triggers a live forge call on page load. | k6 against seeded 50-repo dataset; nock guard (FR-API-2). | MVP |
| NFR-4 | Tenancy isolation: automated cross-tenant test suite proves no API route or query returns another workspace's rows (D1 SaaS-ready). | Two-workspace fixture; route walker asserts zero leakage. | MVP |
| NFR-5 | Accessibility: WCAG 2.2 AA across all pages incl. dark theme contrast, keyboard-complete navigation (incl. ⌘K palette and charts' data-table fallbacks). | axe + Lighthouse in CI, manual checklist per release. | MVP |
| NFR-6 | Security of credentials: all forge tokens/keys encrypted at rest (FR-AUTH-5); TLS in transit; tokens never logged. | Secret-scan + log-scrub tests in CI. | MVP |
| NFR-7 | Graceful Tier-2 degradation: when LAN LLM hosts are unreachable, analysis jobs park and retry with backoff, Tier-1 dashboards remain fully functional, and UI states "Tier-2 analysis paused — host unreachable". | Chaos test: kill LM Studio endpoint mid-run; no data loss; banner shown. | v1.x |
| NFR-8 | Local-LLM call discipline (C2): every Tier-2 call sets 45000 maxTokens, uses retry+warm-up wrapper, chunks to ≈10k expected output. | Enforced by shared client wrapper; lint forbids direct HTTP to LM Studio hosts. | v1.x |
| NFR-9 | Tier-3 egress minimization + audit: only the minimum diff/context needed is sent to Claude API; every T3 call writes an audit row (timestamp, repo, PR, byte/token counts, content digest, model, initiator) queryable by admins. | Audit table populated in T3 integration test; egress payload snapshot reviewed. | v1.x |
| NFR-10 | Data freshness: webhook-driven changes visible in dashboards ≤60s after delivery (event→warehouse→cache-bust). | E2E timer on fixture webhook. | MVP |
| NFR-11 | Job reliability: all BullMQ jobs idempotent with bounded retries + dead-letter queue surfaced on an admin ops page. | Poison-message test lands in DLQ, visible in UI. | MVP |
| NFR-12 | Observability: structured logs with request ids, job/queue metrics, forge budget gauge, sync lag metric — sufficient to answer "is ingest healthy" without DB spelunking. | Metrics endpoints scraped in staging; runbook references them. | MVP |

## 4. External interface requirements (summary)

- **GitHub REST v3 / GraphQL v4** — via FR-FORGE-2/3/4 client only; webhook deliveries per
  FR-INGEST-5. No other module may import HTTP clients for forge hosts (lint-enforced).
- **LM Studio (LAN hosts, OpenAI-compatible API)** — via the shared Tier-2 wrapper only
  (NFR-8); host list + concurrency cap are workspace config.
- **Claude API** — via Tier-3 gateway only (FR-ANALYSIS-7), gated by opt-in + egress audit (NFR-9).
- **Browser** — evergreen Chrome/Firefox/Safari; UI is the only API consumer at v1 (FR-API-1).

## 5. Assumptions & data retention

- A1: A single GitHub credential's budget is the binding backfill constraint (NFR-2 math is per token; multiple credentials scale linearly, out of scope v1).
- A2: Deployment/release events exist for DORA; where absent, labeled fallbacks apply (FR-METRICS-12).
- A3: Raw ingested entities retained indefinitely at launch (D1 internal); snapshots ≥400d (FR-METRICS-13); reports immutable (FR-REPORTS-1); a retention policy knob is a v1.x concern, schema must not preclude it.

## 6. Traceability

- Decisions: D1→FR-AUTH-3/NFR-4 · D2→§2.4/FR-INSIGHTS-* · D3→FR-FORGE-1/7 · D5→MVP flags · D6→FR-AUTH-1/6, FR-WEB-7 · D7→§2.6.
- Constraints: C1→FR-FORGE-3/4/6, FR-API-2, NFR-1/2/3 · C2→FR-ANALYSIS-2/3, NFR-8 · C3→this ID scheme; USER_STORIES.md maps stories→FRs.
