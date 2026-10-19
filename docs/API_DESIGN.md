# RepoPulse — REST API Design (/api/v1)

Traces to: SRS FR-API-1..6, FR-AUTH-*, ARCHITECTURE.md §2/§4, DATABASE.md tables.
The SPA is the only consumer at v1 (SRS §4). Every read serves from Postgres only —
no live forge calls in any handler (FR-API-2, Law 4).

## 1. Conventions

- **Base**: `/api/v1`. **Versioning stance**: additive-only within v1 (new endpoints,
  new optional fields OK; renames/removals/semantic changes require `/api/v2`). OpenAPI
  spec generated from Fastify+zod route schemas (FR-API-1) is the contract.
- **Auth**: GitHub OAuth (FR-AUTH-1) → httpOnly secure session cookie backed by Redis
  (FR-AUTH-2). Every route (except `/auth/*`, `/webhooks/*`, `/healthz`) requires a session
  → 401 otherwise (FR-API-4 route-walker test).
- **CI tokens** (W18-18, SC-31): the one exception to session auth. A request carrying
  `Authorization: Bearer rpci_…` is judged as a CI-token request and nothing else (any
  session cookie is ignored). A token reaches only routes marked `config.ciToken` — today
  the two in "CI pull" below — and only with GET; every other route ⇒ 403, an unknown,
  expired or revoked token ⇒ 401. See docs/CI_INTEGRATION.md.
- **Workspace scoping**: active workspace resolved from session (v1 single `default`);
  all queries workspace-filtered (FR-AUTH-3, NFR-4). No workspace id in paths at v1 —
  additive `X-Workspace-Id` header override reserved for SaaS flip (ARCHITECTURE §7).
- **Roles**: `admin` vs `member` per FR-AUTH-4; admin-only routes marked 👑 below → 403.
- **Errors**: RFC 7807 `application/problem+json`: `{type, title, status, detail,
  instance, request_id}`; zod validation failures → 400 with field errors array.
- **Pagination**: cursor-based on all lists: `?cursor=<opaque>&limit=<≤100>` →
  `{items:[...], next_cursor|null}` (FR-API-3). Shared filter params on list endpoints:
  `window=7d|30d|90d|365d` (default 30d), `repo_ids=1,2,3`, `sort`, `order`.
- **IDs** in paths are RepoPulse DB ids (not forge ids), except PRs addressed as
  `repos/{repoId}/prs/{number}` for URL readability (FR-WEB-2 deep links).

## 2. Endpoint catalog

### auth (FR-AUTH-1/2, D6)
| Method+Path | Req → Res | FR |
|---|---|---|
| `GET /auth/login` | redirect to GitHub authorize (state in signed cookie) | FR-AUTH-1 |
| `GET /auth/callback` | `?code&state` → create/link user, set session cookie, redirect `/` | FR-AUTH-1/6 |
| `POST /auth/logout` | revoke session server-side, clear cookie → 204 | FR-AUTH-2 |
| `GET /me` | → `{user}` — the auth-surface identity check, outside `/api/v1` | FR-AUTH-3 |
| `GET /api/v1/me/context` | → `{workspace, role, identity_id, default_view_id}` — the SPA-facing projection (W4-14). Split from `/me` because the web client only builds `/api/v1` URLs (Law 4) and a second `/me` collides with the auth route; inside `api-v1` the guard has already resolved workspace+role, so this cannot disagree with what the guard enforces | FR-AUTH-3/4/6 |

### connections 👑 (FR-INGEST-1, FR-FORGE-5)
| Method+Path | Req → Res | FR |
|---|---|---|
| `POST /connections` | `{provider, auth_kind: pat\|app, credential\|installation_id}` → `{id, status, fingerprint}` (credential never echoed) | FR-FORGE-5, FR-AUTH-5 |
| `GET /connections` | → list `{id, provider, auth_kind, fingerprint, status, repo_count}` | FR-INGEST-1 |
| `GET /connections/{id}/available-repos` | → org/repo tree discovered at connect (cached discovery, not live per keystroke) | FR-INGEST-1 |
| `POST /connections/{id}/repos` | `{repo_forge_ids[] \| all_with_auto_add}` → repos created `pending_backfill`, backfill enqueued | FR-INGEST-1/2 |
| `GET /sync/status` | → org aggregate + per-repo `{state, backfill_pct, last_synced_at, last_error, budget:{remaining, reset_at}}` | FR-INGEST-8, NFR-12 |

### org composites (dashboard landing; UX_SPEC §4.a)
| Method+Path | Req → Res | FR |
|---|---|---|
| `GET /org/summary` | `?window&repo_ids` → 5 KPI tile values w/ deltas + sparkline series | FR-INSIGHTS-4, FR-METRICS-14 |
| `GET /org/health-tiles` | → per-repo `{id, name, health:{score, basis, delta}, spark}` grid payload | FR-INSIGHTS-2/3/4 |
| `GET /org/attention` | `?since=<iso>` → change items vs the client's last visit (score band changes, new stale PRs, CI regressions, unreviewed merges); `since` supplied by the client (persisted lastSeenAt) | UX §4.a |

### repos (FR-API-5 drill-down levels 1–2)
| Method+Path | Req → Res | FR |
|---|---|---|
| `GET /repos` | filters + sort=score → list `{id, org, name, sync, health:{score, basis, delta}, key_metrics}` | FR-INSIGHTS-2/3/4 |
| `GET /repos/{id}` | → detail: score breakdown (every input/weight/contribution), metric tiles w/ deltas, sync state | FR-INSIGHTS-2, FR-WEB-8 |
| `GET /repos/{id}/trends` | `?window` → snapshot series bundle for the Pulse tab chart grid | FR-METRICS-13, FR-INSIGHTS-4 |
| `GET /repos/{id}/pr-flow` | `?window` → stage funnel (median+p90/stage), reviewer×week load matrix, size histogram | FR-METRICS-4/5/6/7 |
| `GET /repos/{id}/ci` | `?window` → pass-rate + duration trends, flaky-workflow ranking | FR-METRICS-9 |
| `GET /repos/{id}/review-bots` | `?window` → per known AI review bot: PRs reviewed/reach, reviews and inline comments per PR, time to first comment, share followed by a code change, repeat-after-dismiss; `forge` + `line_data` say why comment columns are null. Tools only, never people (N-9) | W18-23, METRICS.md §5 |
| `GET /repos/{id}/hotspots` | `?window` → ranked files `{path, hotspot_score, decomposition, finding_density, contributing_commit_ids}` | FR-METRICS-2, FR-INSIGHTS-5 |
| `GET /repos/{id}/contributors` | → identities w/ churn share, bus factor per directory, single-owner flags | FR-METRICS-3 |
| `GET /repos/{id}/files/{path}` | → file detail: churn series, owners, hotspot history, findings | FR-API-5 |

### metrics (FR-METRICS-13/14/15)
| Method+Path | Req → Res | FR |
|---|---|---|
| `GET /metrics/catalog` | → `[{id, name, formula, unit, direction, heuristic_notes}]` — UI tooltips + report footnotes read this, never hardcode | FR-METRICS-15 |
| `GET /metrics/series` | `?metric_key&window&repo_ids&dims(json)&from&to` → snapshot time-series `{points:[{computed_at, value, numerator, denominator}], basis_label}` — org rollup when repo_ids omitted (pooled, never averaged) | FR-METRICS-13/14, FR-INSIGHTS-4 |
| `GET /metrics/current` | same params → latest value + delta vs previous equal window | FR-INSIGHTS-4 |

### prs (drill-down level 3; FR-METRICS-4..8)
| Method+Path | Req → Res | FR |
|---|---|---|
| `GET /repos/{id}/prs` | filters `state, stale=true, unreviewed=true, size_bucket, author=me` → list w/ cycle-time fields `{number, title, author, size_bucket, opened_at, first_review_at, first_approval_at, merged_at, stage_durations, review_covered}` | FR-METRICS-4/5/6/7/8, FR-WEB-7 |
| `GET /repos/{id}/prs/{number}` | → detail: stages, reviews, checks, files (paths+churn), findings summary, analysis status | FR-API-5, FR-WEB-8 |
| `GET /me/prs` · `GET /me/review-queue` | personalized widgets via identity map (review queue age-sorted; a.k.a. review-load) | FR-AUTH-6, FR-WEB-7 |
| `GET /me/hotspots` | hotspots ∩ files the user owns ≥ threshold (My Focus) | FR-METRICS-2/3, FR-WEB-7 |
| `GET /me/stats` | personal cycle-time/size vs repo distribution (own data only, N-9) | FR-METRICS-4/7, FR-WEB-7 |

### findings & analyses (v1.x; FR-ANALYSIS-*, FR-INSIGHTS-1)
| Method+Path | Req → Res | FR |
|---|---|---|
| `GET /findings` | filters `dimension, severity, status, repo_ids, pr` → list | FR-WEB-9 |
| `GET /findings` — shadow + rule facets | `?experimental=exclude\|only\|include` (default **exclude**; unknown values fall back to it) `&rule_id=` → adds `experimental` (the mode applied) and `shadow_hidden` (shadow findings matching the other filters that the default held back; `null` when the mode cannot hold any back). Shadow-mode findings are never mixed into the default list, the same as risk, top actions and the CI pull (W18-29) | W18-29, CODE_HEALTH_SUITE §8.2 |
| `GET /findings/facets` | → `{rules:[{rule_id, scanner_key, active, shadow, lifecycle: rule_registry status \| null}], shadow_total}` — the rule facet, built from what findings carry so in-process fast-lane rules with no registry row are filterable; active and shadow counts kept apart | W18-29 |
| `GET /security/sensitive-changes` | `?repos=` → `{repos:{total, enabled, disabled[]}, runs:{window_days, recent, failed, ever, last_finished_at}, rules:[{rule_id, what, category, lifecycle, open_active, open_shadow}], totals:{active, shadow}, active[], shadow[]}` — the radar's review list (open/confirmed, ≤200 each, newest first), split active vs shadow, with the coverage facts the screen needs to tell "nothing loosened" from "nothing read" (radar off, no runs yet) | W18-29, W18-21 |
| `GET /findings/stats` | disposition counts + false-positive rate (wont_fix÷dispositioned) trend for the Explorer header widget | FR-INSIGHTS-1, UX §4.e |
| `GET /findings/{id}` | → detail: evidence, file/line, run/model/checklist version, status history. Findings (list and detail) also carry `context: { start_line, lines } \| null` (W18-32): the scanned file's lines around the finding, stored at scan time, `null` for secrets, repo-level findings, old rows and findings closed past retention | FR-INSIGHTS-1 |
| `GET /findings/{id}` | → detail: evidence, file/line, run/model/checklist version, status history | FR-INSIGHTS-1 |
| (finding shape, additive) | `external: {tool, source: sarif\|code_scanning, tool_version\|null} \| null` — set when another tool raised the finding (`scanner_key` starts `external:`), null for RepoPulse's own | W18-24 |
| `POST /findings/{id}/status` | `{to: acknowledged\|resolved\|wont_fix, reason}` → 200 + event row | FR-INSIGHTS-1 |
| `POST /repos/{id}/external-findings/sarif` 👑 | body: a SARIF 2.1.0 log (`application/json` or `application/sarif+json`, ≤10 MiB → 413); query `commit_sha?` (hex; else the log's `versionControlProvenance`), `sweep=true\|false` (default true: the upload is each tool's full result set and closes that tool's findings it no longer reports), `source_root?` (absolute checkout path for tools writing absolute `file://` URIs) → 201 `{repo_id, commit_sha\|null, results, skipped:{reason:n}, tools:[{scanner_key: "external:<tool>", tool, tool_version, scan_run_id, results, created, updated, reopened, folded, auto_resolved, superseded_by_pack:[{rule_id, pack_rule, file, line}]}]}`; invalid log → 400 with `errors[{path,message}]` and nothing stored; member → 403; other workspace's repo → 404. Audited `external_findings.sarif_uploaded`. See SECURITY_SUITE.md §8 | W18-24 |
| `POST /analyses` | `{repo_id, pr_number, tier:2\|3}` → 202 `{run_id}`; tier 3 without repo opt-in → 403 | FR-ANALYSIS-1/7 |
| `GET /analyses/{run_id}` | → `{status, chunk_count, findings_count, cost_usd?, error?}` | FR-ANALYSIS-8 |
| `GET /findings/{id}/patch` | → `{eligible, reason?, commit_sha?, patch: null \| {id, status: pending\|verified\|rejected\|failed, commit_sha, tier, created_at, finished_at, diff?, filename?, model_id?, verification?: {rule_sets[], runs}, reason?, reason_code?}}`. `diff` only when `verified` (any role); a `rejected` patch is `{id, status, …timestamps}` to a member — no diff, no reason; `reason`/`reason_code` (and a rejected diff) only to an admin. Ineligible finding (model finding, repo-level, no scanned commit) → `eligible:false` + why. Other workspace's finding → 404 | W18-19, D16 |
| `POST /findings/{id}/patch` | `{tier?: "t2"\|"t3"}` (default `t2`, the workspace's own model) → 202 `{patch}` (pending, enqueued on `patches.draft`). Idempotent per finding × scanned commit: pending → 202 same row, verified/rejected → 200 the decided row (no new model call), failed → reset and re-enqueued. `t3` needs admin (403) **and** the repo's Tier-3 opt-in (409). Ineligible → 409; > 50 requests per workspace per rolling 24 h → 429; 10/min per caller (rate limit); no Redis → 503. **Writes nothing to the forge (D9a)** — no branch, commit, PR or comment; the developer copies/downloads the diff | W18-19, D16 |
| `POST /repos/{id}/ai-pass` | **admin.** Exactly one of `{paths: string[]}` (files or directory prefixes; 1-50 - a pass is bounded and never reads the whole repository), `{pull_request: n}` (a pull request already ingested; reviews its diff) or `{base, head}` (commit ids, 7-64 hex; the ingested commits after base up to head, oldest first, at most 10, merges skipped) → 202 `{run}` (pending, enqueued on `ai.pass`). One active pass per repository: a second click returns the first. > 10 per workspace per 24 h → 429; no Redis → 503. The worker snapshots the repository (read only, D9a), runs the planned specialists through the workspace's routing chain, then evidence-fed triage on open rule-raised findings in scope (typed paths) or on lines the change adds (diff modes) that have stored context. Diff modes read through the budgeted forge client, never a clone. **Writes nothing to the forge** | W19-09, W19-11 |
| `GET /repos/{id}/ai-pass` | → `{runs:[{id, status, mode, trigger, paths, base_ref, head_ref, pr_number, commit_sha, reason_code, reason, plan, specialists, triage_funnel, triage_skipped, calls, requested_by, created_at, started_at, finished_at}]}` — the last 10 passes. A repository nobody has run a pass on returns `runs: []`; the screen says *not yet run*, never *clean* | W19-09 |
| `GET /repos/{id}/ai-pass/schedule` | → `{schedule, egress, acknowledgement_stale, monthly, limits, runs}`. `schedule` is `null` when nobody has configured one (scheduling is off). `egress` is where a scheduled pass would send source, from the server's own facts (`{local_only, destinations:[{provider_id, provider_name, host, leaves_network, roles}], leaves_network, digest, sentence, sends}`), `leaves_network` by the same host definition as the egress audit. `runs` = the last 10 scheduled passes, skipped ones included with their `reason`. Readable by any member | W19-12 |
| `PUT /repos/{id}/ai-pass/schedule` | **admin.** `{enabled:false}` turns it off (configuration kept, next run cleared). Enabling: `{enabled:true, frequency:"daily"\|"weekly", scope:{kind:"paths", paths:[...]} \| {kind:"new_pull_requests"}, acknowledged_egress:<digest from GET>}`. 409 if no model is configured, if local-only forbids a hosted link, or if the digest is missing or stale (the destinations changed since the admin was shown them). The first run is one interval away, never at once. Audited (`ai_pass_schedule.enabled/disabled/updated`) with the acknowledged destinations | W19-12 |
| `GET /ai-pass/settings` / `PUT /ai-pass/settings` | The workspace's monthly model-call cap for scheduled passes: `{monthly_call_cap, used, remaining, default_cap}`; PUT is admin-only, `{monthly_call_cap: 0..100000}` (0 stops every scheduled pass). Default 300. `used` counts this calendar month's (UTC) calls from all of the workspace's passes | W19-12 |
| `GET /findings/{id}/ai` | → `{raised_by: {specialist, checklist_version, model, route, pass_id} \| null, suggestions:[{id, verdict, confidence, rationale, citations:[{file, line, text}], vex, patch:{status, reason, diff}, model, checklist_version, route, pass_id, created_at, decision, decided_by, decided_at}]}`. `citations[].text` is **our copy** of the line, never the model's. Suggestions are labelled AI on every screen; none is a decision | W19-09 |
| `POST /findings/{id}/ai-verdicts/{verdictId}/decide` | `{decision: "accepted"\|"dismissed"}` → 200. Any signed-in member. Compare-and-set on an undecided suggestion of this workspace and finding (409 if already answered, 404 otherwise). **Stores the answer on the suggestion and changes nothing about the finding** — moving the finding is `PATCH /findings/{id}`, by the same person, with a note (D9a) | W19-09 |

### CI pull (W18-18, D16 — read by the customer's own CI; RepoPulse never writes)
| Method+Path | Req → Res | FR |
|---|---|---|
| `GET /repos/{id}/pulls/{number}/findings` | `?new=true\|false` (default true) `&include_experimental=true\|false` (default false) `&cursor&limit≤100` (default 50) → `{pull:{number,title,state,head_sha,base_ref}, head:{sha, scanned, scanners:[{scanner_key, scanned_at}]}, items:[{id, rule_id, scanner_key, dimension, severity 1-5, severity_label, confidence, title, file, line_start, line_end, evidence, suggested_fix, experimental, status, introduced_by_pr, seen_at_head, first_seen_at, last_seen_at}], next_cursor}`. Session **or** CI token (repo must be in the token's `repo_ids`, else 404). Ordered severity desc, id desc; keyset cursor. **new=true** = findings first seen on this PR (stamped `pull_request_id`, or first seen by a `pr_synced` scan run at the PR head) that are still present on the head (not dismissed/resolved/wont_fix; and bumped by their scanner's latest succeeded run at the head when it has one — a finding whose scanner has not run at the head is kept with `seen_at_head:false`). **new=false** adds pre-existing live findings on files the PR touches (`introduced_by_pr:false`). Experimental (shadow-mode) findings excluded unless asked. 404 when the PR is not in the warehouse yet. No grades or scores (N-9). | E10.8, E6.3 |
| `GET /cli/repopulse.mjs` | → the `repopulse check` CLI (one dependency-free file), session or CI token | E10.8 |

### admin → CI tokens 👑 (W18-18, SC-31)
| Method+Path | Req → Res | FR |
|---|---|---|
| `POST /admin/ci-tokens` | `{name, repo_ids[1..100], expires_in_days? 1..365 (default 365)}` → 201 `{id, name, token, prefix, scope:'pr_findings:read', repo_ids, expires_at}` — `token` appears here once and never again; audited `ci_token.created` | E10.8 |
| `GET /admin/ci-tokens` | → `{items:[{id, name, prefix, scope, repo_ids, created_by, created_at, expires_at, last_used_at, revoked_at}]}` (never the token or its hash) | E10.8 |
| `DELETE /admin/ci-tokens/{id}` | revoke (row kept) → 204; already revoked/unknown → 404; audited `ci_token.revoked` | E10.8 |

### reports (FR-REPORTS-*)
| Method+Path | Req → Res | FR |
|---|---|---|
| `POST /reports` | `{type: repo_health\|org_exec\|security_posture\|delivery_dora, repo_ids[], window, pinned_at?}` → 202 `{id, status:queued}` | FR-REPORTS-1/7 |
| `GET /reports` | history list `{id, type, params, status, generated_by, generated_at}` | FR-REPORTS-1 |
| `GET /reports/{id}` | → stored HTML (immutable) rendered in-app | FR-REPORTS-1 |
| `GET /reports/{id}/pdf` | → `application/pdf` stream (Content-Disposition attachment) | FR-REPORTS-6 |
| `POST /reports/{id}/regenerate` | same stored params, new report row | FR-REPORTS-7 |

### views (FR-API-6, FR-WEB-4/5)
| Method+Path | Req → Res | FR |
|---|---|---|
| `GET /views` · `POST /views` · `PATCH /views/{id}` · `DELETE /views/{id}` | `{name, config:{repo_ids, window, layout}, is_shared}`; owner-only mutation | FR-API-6 |
| `POST /views/{id}/share` | → `{share_slug}`; `GET /views/shared/{slug}` resolves for any workspace member | FR-WEB-5 |
| `PUT /me/default-view` | `{view_id}` → 204 | FR-WEB-4 |

### admin 👑 (FR-AUTH-4, NFR-11/12)
| Method+Path | Req → Res | FR |
|---|---|---|
| `GET/PATCH /admin/workspace` | settings: score weights, bot list, stale-N, LM hosts+cap, budget share | FR-INSIGHTS-2, SRS §1.1 |
| `GET /admin/members` · `PATCH /admin/members/{userId}` | role changes | FR-AUTH-4 |
| `PATCH /admin/repos/{id}` | `{tier2_auto?, tier3_opt_in?, paused?}` — the T3 opt-in flag lives here only | FR-ANALYSIS-1, FR-INGEST-9 |
| `GET /admin/egress-audit` | filterable T3 audit rows | NFR-9 |
| `GET /admin/dlq` · `POST /admin/dlq/{jobId}/retry` | dead-letter queue ops page | NFR-11 |
| `GET /admin/budget` | forge budget gauges (REST + GraphQL buckets), sync lag | NFR-12 |
| `GET /admin/patches` | → `{counts:{verified?, rejected?, failed?, pending?}, items:[{id, finding_id, status, reason_code, reason, model_id, tier, created_at, finished_at, finding:{title, file}, repo:{id, name}}]}` (counts over every attempt; `finding`/`repo` added in W18-29, null when since deleted) — the last 100 verified-patch attempts with reasons, so an admin can see why fixes are rejected (W18-19) | W18-19 |

### webhooks (machine-facing, no session)
| Method+Path | Behavior | FR |
|---|---|---|
| `POST /webhooks/github` | verify `X-Hub-Signature-256` (timingSafeEqual, raw body) → 401 invalid / 202 + enqueue | FR-INGEST-5 |

## 3. Progress streaming: SSE (chosen) vs polling

**Decision: one SSE endpoint** — `GET /events` (`text/event-stream`), session-authed,
emitting typed events: `sync.repo` (state/pct changes), `analysis.run` (status),
`report.status`, `budget.paused`. Client = TanStack Query invalidation on event.

Why SSE over polling/WebSockets:
- NFR-10 wants webhook→dashboard ≤60s; 5s polling across sync + N analysis runs + report
  jobs multiplies request load for a dashboard that mostly idles — one SSE connection
  replaces all of it and pushes within ~1s.
- SSE is plain HTTP: works through the existing Podman reverse proxy, auto-reconnects with
  `Last-Event-ID`, no ws upgrade handling in Fastify; we have zero client→server streaming
  needs, so WebSockets buy nothing.
- Fallback: every SSE event type has a GET status endpoint (listed above), so a degraded
  client can poll — the UI treats SSE as an optimization, correctness comes from reads.
Worker→api transport: Redis pub/sub channel per workspace (ARCHITECTURE §4b).

## 4. Canonical shapes (copy these exactly — cheap-agent reference, C3)

```jsonc
// List response (every list endpoint)
{ "items": [ /* ... */ ], "next_cursor": "b2Zmc2V0OjEwMA" }        // null when exhausted

// RFC 7807 error (every non-2xx)
{ "type": "https://repopulse.bpmforge.com/errors/tier3-not-opted-in",
  "title": "Tier-3 analysis not enabled for this repo",
  "status": 403, "detail": "repo 42 has tier3_opt_in=false",
  "instance": "/api/v1/analyses", "request_id": "req_01J..." }

// Metric series point (GET /metrics/series)
{ "computed_at": "2026-07-06T02:00:00Z", "value": 0.82,
  "numerator": 41, "denominator": 50 }                              // ratio metrics only

// SSE event (GET /events)
// event: sync.repo\nid: 1029\ndata: {"repo_id":7,"state":"backfilling","backfill_pct":63}
```

## 5. Cross-cutting guarantees

- **Nock guard** in api tests: any HTTP egress from a request handler fails the suite
  (FR-API-2). Static check: route modules must not import `packages/forge`.
- **Route-walker tests**: every route × {no session → 401, member on 👑 → 403,
  foreign-workspace row → 404/empty} (FR-API-4, NFR-4).
- **Request ids** on every response + structured logs (NFR-12); `/healthz` liveness
  (checks Postgres + Redis) unauthenticated.
- **OpenAPI** served at `/api/v1/openapi.json` in dev/staging; contract suite
  (schemathesis) runs in CI (FR-API-1).
