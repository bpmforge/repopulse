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
| `GET /me` | → `{user, workspace, role, identity_id, default_view_id}` | FR-AUTH-3/4/6 |

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
| `GET /findings/stats` | disposition counts + false-positive rate (wont_fix÷dispositioned) trend for the Explorer header widget | FR-INSIGHTS-1, UX §4.e |
| `GET /findings/{id}` | → detail: evidence, file/line, run/model/checklist version, status history | FR-INSIGHTS-1 |
| `POST /findings/{id}/status` | `{to: acknowledged\|resolved\|wont_fix, reason}` → 200 + event row | FR-INSIGHTS-1 |
| `POST /analyses` | `{repo_id, pr_number, tier:2\|3}` → 202 `{run_id}`; tier 3 without repo opt-in → 403 | FR-ANALYSIS-1/7 |
| `GET /analyses/{run_id}` | → `{status, chunk_count, findings_count, cost_usd?, error?}` | FR-ANALYSIS-8 |

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
