# GitHub API Ground Truth — Clone-Free Ingestion Reference

Verified 2026-07-07 against docs.github.com unless marked `UNVERIFIED`. All limits are
for github.com (GHEC differences noted). This doc backs C1 (no cloning) in the
[Founding Brief](../work/FOUNDING_BRIEF.md).

## 1. Rate limits

### Primary (REST)
Source: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api

| Auth mode | Limit |
|---|---|
| Authenticated user (PAT / OAuth user token) | **5,000 req/hr** (15,000 on Enterprise Cloud) |
| GitHub App **installation** | **5,000 req/hr** base; **+50/hr per repo beyond 20** and **+50/hr per org user beyond 20**; **cap 12,500/hr** (GHEC: 15,000) |
| OAuth app (client-credentials, public data) | 5,000 req/hr per app |
| Actions `GITHUB_TOKEN` | 1,000 req/hr per repo |

Headers on every response: `x-ratelimit-limit`, `x-ratelimit-remaining`, `x-ratelimit-used`,
`x-ratelimit-reset` (UTC epoch secs), `x-ratelimit-resource`. The rate budgeter module must
persist these per-installation, not guess.

### Primary (GraphQL) — point system
Source: https://docs.github.com/en/graphql/overview/rate-limits-and-node-limits-for-the-graphql-api

- **5,000 points/hr per user**; App installation 5,000 base + same +50/repo/+50/user scaling, **cap 12,500**; GHEC 10,000. **Separate bucket from REST.**
- **Cost formula:** count the sub-requests the query implies assuming max pagination across all connections, **divide by 100, round**; **minimum 1 point**. Example from docs: 5,101 sub-requests → 51 points. Practical upshot: a query fetching 100 PRs each with 100 nested review nodes ≈ (1 + 100)/100 ≈ **1 point**.
- **Node limit:** ≤ **500,000 nodes** per query; every `first`/`last` must be 1–100; nested connections multiply (50 repos × 100 PRs = 5,000 nodes).
- Check live cost: request `rateLimit { limit cost remaining resetAt }` in any query.

### Secondary limits (abuse detection) — apply on top of primary
Sources: rate-limits doc + https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api

- ≤ **100 concurrent requests** (REST+GraphQL combined).
- ≤ **900 points/min per REST endpoint**; ≤ **2,000 points/min for GraphQL**. Points: GET/HEAD/OPTIONS = 1; POST/PATCH/PUT/DELETE = 5; GraphQL query = 1, mutation = 5.
- ≤ **90 s CPU per 60 s real time**; ≤ 80 content-generating requests/min and 500/hr.
- Mitigation (build into the request queue): serialize writes with ≥1 s spacing; on 403/429 honor `retry-after`, else wait to `x-ratelimit-reset`, else ≥60 s exponential backoff. Ignoring this "may result in the banning of your integration."

### Search API
Source: https://docs.github.com/en/rest/search/search

- **30 req/min** authenticated (10/min unauthenticated); code-search endpoint has its own lower limit (fetched docs summary reported 9–10/min — confirm at runtime via `x-ratelimit-resource=search` headers).
- Hard cap **1,000 results per search** (10 pages × 100). Do **not** design backfill around Search; use it only for ad-hoc lookups.

## 2. Conditional requests (ETag)

Source: best-practices doc. "Making a conditional request does not count against your
primary rate limit if a `304` response is returned and the request was made while correctly
authorized." Send `If-None-Match: <etag>` (or `If-Modified-Since`). **304s are free** →
the sync scheduler should keep ETags per (installation, endpoint, params) and poll
hot endpoints cheaply as a webhook-miss safety net.

## 3. Endpoint catalog for RepoPulse

All list endpoints: `per_page` max **100** (default 30), cursor via `Link` header. No total
counts on most lists — paginate until empty page or missing `rel="next"`.

| Need | Endpoint | Gotchas |
|---|---|---|
| List org repos | `GET /orgs/{org}/repos` or `GET /installation/repositories` | latter is auto-scoped to the App install |
| Commits | `GET /repos/{o}/{r}/commits` | filters `since`/`until`/`path`/`author`/`sha`; list items have **no per-file stats** — churn needs `GET /repos/{o}/{r}/commits/{sha}` per commit (1 call each) or the stats endpoints |
| Commit detail | `GET .../commits/{sha}` | returns files+patch; **max 300 files first page, paginate to 3,000**; per-file `patch` omitted for very large files |
| Compare | `GET .../compare/{base}...{head}` | unpaged response caps at **250 commits**; changed files only on **page 1, max 300 files** — fine for release-to-release diffs, not big backfills |
| PRs | `GET .../pulls?state=all&sort=updated` | list item lacks `additions`/`deletions`/`merged_by` → `GET .../pulls/{n}` per PR when size metrics needed |
| PR reviews | `GET .../pulls/{n}/reviews` | states: APPROVED / CHANGES_REQUESTED / COMMENTED / DISMISSED |
| Review comments | `GET .../pulls/comments?since=` (repo-wide!) | repo-level `since` cursor = 1 call stream for incremental sync, vs per-PR loops |
| PR files | `GET .../pulls/{n}/files` | **max 3,000 files**; per-file `patch` text included (omitted for huge files). Raw-diff media type (`application/vnd.github.diff` on the PR) 406s when diff > **300 files** or > **20,000 lines / 1 MB** (per-file cap 20,000 lines / 500 KB) — prefer `/files` pagination over raw diff. Sources: repository-limits doc; community discussion #118311 |
| File contents | `GET .../contents/{path}` | base64; full JSON only ≤ **1 MB**; 1–100 MB via `raw`/`object` media type only; > 100 MB unsupported (use Git Trees/Blobs API); dir listing caps at **1,000 entries** |
| CI runs | `GET .../actions/runs?created=YYYY-MM-DD..YYYY-MM-DD` | **1,000-result cap per filtered query** → slice `created` into windows; duration from `run_started_at`→`updated_at`; `/timing` for billable ms |
| Checks/statuses | `GET .../commits/{ref}/check-runs`, `.../status` | per head SHA; use for merge-gate pass rate |
| Releases | `GET .../releases` | release cadence metric |
| Deployments | `GET .../deployments` + `.../deployments/{id}/statuses` | DORA deployment frequency + change-failure (status `failure`) |
| Stats | `GET .../stats/{contributors,code_frequency,commit_activity,participation,punch_card}` | **first call returns 202** while GitHub computes; retry after a short delay; cached by default-branch SHA. `code_frequency` **422s at 10,000+ commits**; `contributors` returns **zeroed add/del** at 10,000+ commits → treat stats as cheap-path optimization with REST fallback |
| Events | `GET .../events` | **300 events max, past 30 days only** (current docs say 30, not the older 90), latency "30s to 6h" — **unusable as an ingestion source**; webhooks only |

## 4. Webhooks

Events to subscribe (GitHub App default webhook): `push`, `pull_request`,
`pull_request_review`, `pull_request_review_comment`, `check_suite` (or `workflow_run`),
`deployment_status`, `release`, plus `issues` for throughput and `repository` for
rename/delete/visibility.

- **Verification** (https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries): `X-Hub-Signature-256` = `sha256=` + HMAC-SHA256 hex digest of the **raw UTF-8 body** with the shared secret. Compare with `crypto.timingSafeEqual`. Ignore legacy SHA1 `X-Hub-Signature`.
- **Delivery**: endpoint must respond < **10 s** or the delivery is marked failed (ack immediately, enqueue to BullMQ). Failed deliveries are listable and **redeliverable via REST** for repo, org, and App hooks (`GET/POST .../hook/deliveries[...]/attempts`). Delivery log retention window not stated on the fetched page (`UNVERIFIED`; widely cited as 30 days) — run a reconciliation poll regardless.
- Design rule: webhooks are a **hint**, cursors + ETag polling are the source of truth (deliveries can drop; GitHub does not auto-retry).

## 5. Auth model choice

**GitHub App** is the right primary model:
installation tokens are created from an app JWT (JWT max age 10 min) via
`POST /app/installations/{id}/access_tokens`, **expire after 1 hour**, and can be
down-scoped to specific repos (≤500) and permissions
(https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).
Benefits vs PAT/OAuth: org-admin grant (not tied to an employee account), rate limit
**scales to 12,500/hr** with repo/user count, built-in webhook, fine-grained permissions
(contents:read, pull_requests:read, checks:read, deployments:read, metadata).
D6 login remains **user OAuth** (the App's user-authorization flow works) — user tokens
power "my PRs" views; the installation token powers ingestion. PAT is acceptable only as a
dev-mode fallback.

## 6. GraphQL vs REST for backfill

- **GraphQL wins for PR metadata history**: one query = `repository.pullRequests(first:50, states:[MERGED,CLOSED,OPEN])` with nested `reviews(first:50)`, `timelineItems`, `commits(first:1)`, `files(first:100){ path additions deletions changeType }`. Cost ≈ (1 + 50 + 50 + 50)/100 ≈ **2 points** for what would be ~150+ REST calls. 500 PRs ≈ 10 pages ≈ ~20 points total.
- **REST is mandatory for patch text**: the GraphQL `PullRequestChangedFile` object has path/additions/deletions/changeType but **no `patch` field** (`UNVERIFIED` against live schema — confirm by introspection in W0; if wrong, simplify the ingest plan). Tier-2/3 LLM review therefore pulls diffs via REST `GET /pulls/{n}/files` on demand.
- REST is simpler for commits-with-churn (GraphQL commit history also lacks per-file patches) and for Actions runs (not fully exposed in GraphQL).
- Recommended split: **GraphQL for backfill + nightly reconciliation of PR/review/issue metadata; REST for diffs, contents, checks/runs, stats; webhooks for steady-state.**

## 7. Gitea parity (v1.x adapter)

Source: https://docs.gitea.com/development/api-usage

- Swagger 2.0 API at `/api/v1` (spec at `/swagger.v1.json`); token or OAuth2 bearer auth with scoped tokens. Pagination `page`/`limit`, `x-total-count` header (a real total count — nicer than GitHub), default page size `MAX_RESPONSE_ITEMS` = 50.
- **No documented rate limits** (self-hosted); **no GraphQL**; **no stats/202 endpoints**; no Search-API equivalent constraints.
- Exists: repos, commits (list + single with files), pulls, PR files endpoint, reviews, statuses, releases, issues, org/repo/system **webhooks** (push/PR/release/etc.). Webhook HMAC signature header is `X-Gitea-Signature` (`UNVERIFIED` exact semantics — confirm against our Gitea 1.x instance). Actions runs API coverage varies by version (`UNVERIFIED`).
- ForgeProvider consequences: total-count pagination and no rate budgeting needed; deployments API and check-suites likely absent → DORA deploy signal must come from releases/webhooks on Gitea.

## 8. Budget math

**Backfill: one repo, 12 months, 500 PRs, 2,000 commits, ~5,000 CI runs.**

| Work item | Strategy | Calls / points |
|---|---|---|
| PR metadata + reviews + file paths/sizes | GraphQL, 50/page | ~10 queries ≈ **20 points** (GraphQL bucket) |
| PR diff text for LLM tiers | REST `/pulls/{n}/files`, on-demand only | 0 at backfill (deferred to Tier-2 queue) |
| Commit list | REST, 100/page | 20 calls |
| Per-file churn | Option A: per-commit detail = **2,000 calls**. Option B: stats endpoints (3 calls + 202 retries) + PR `files` additions/deletions from GraphQL = **~10 calls** | choose B; A only for repos where stats 422s and file-level precision is required |
| Workflow runs | `created` sliced monthly, 100/page | ~60–120 calls |
| Releases + deployments + statuses | paged | ~20–50 calls |
| **Total (option B)** | | **≈ 250 REST calls + 20 GraphQL points** |
| **Total (option A)** | | **≈ 2,250 REST calls** |

Against a fresh-org installation budget of 5,000/hr: option B backfills **~20 repos/hr**;
option A ~2 repos/hr. A 20-repo org backfill is a same-day job either way, but option B is
the default; schedule option A per-repo as a low-priority queue drained by leftover budget.

**Steady state (webhook-driven), 20-repo org, ~50 PR events + ~200 CI runs/day:** each PR
event triggers ≤3 REST calls (PR detail, files if review queued, checks); pushes batch into
one commits-since-cursor call per repo per hour (ETag'd, 304 = free). Realistic burn:
**~50–150 calls/hr ≈ 1–3% of budget**. The binding constraints are the **900 points/min
per-endpoint secondary limit during backfill bursts** (throttle to ≤10–13 req/s per endpoint,
≤100 concurrent) and the **one-hour installation token lifetime** (refresh at ~50 min).
