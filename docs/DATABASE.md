# RepoPulse — Database Design (PostgreSQL 16 + Drizzle)

Traces to: ARCHITECTURE.md ADR-2/3/7, SRS FR/NFR IDs inline. Conventions: `snake_case`;
PKs are `bigint generated always as identity` unless noted; timestamps `timestamptz`;
**every tenant-scoped table carries `workspace_id`** (Law 5, FR-AUTH-3, NFR-4) with
composite indexes leading on it. Forge-native ids are stored as `forge_id text` + natural
unique keys for idempotent upserts (FR-INGEST-6).

## 1. ER diagram

```mermaid
erDiagram
    workspaces ||--o{ workspace_members : has
    users ||--o{ workspace_members : joins
    workspaces ||--o{ forge_connections : owns
    forge_connections ||--o{ repos : provides
    workspaces ||--o{ repos : scopes
    repos ||--o{ sync_cursors : tracks
    repos ||--o{ commits : contains
    commits ||--o{ commit_files : changes
    repos ||--o{ pull_requests : contains
    pull_requests ||--o{ pr_reviews : receives
    pull_requests ||--o{ pr_files : touches
    pull_requests ||--o{ check_runs : gates
    commits ||--o{ check_runs : reports
    repos ||--o{ deployments : deploys
    repos ||--o{ releases : cuts
    repos ||--o{ issues : tracks
    workspaces ||--o{ identities : maps
    users ||--o{ identities : claims
    identities ||--o{ commits : authors
    identities ||--o{ pull_requests : authors
    workspaces ||--o{ metric_snapshots : snapshots
    repos ||--o{ metric_snapshots : measures
    repos ||--o{ analysis_runs : analyzed_by
    analysis_runs ||--o{ findings : produces
    pull_requests ||--o{ findings : flagged_in
    workspaces ||--o{ reports : generates
    users ||--o{ saved_views : owns
    workspaces ||--o{ egress_audit : audits
    forge_connections ||--o{ api_cache : caches
```

## 2. Tables

### Tenancy & identity

**workspaces** — `id, slug unique, name, settings jsonb, created_at`. `settings` holds
score weights (FR-INSIGHTS-2), bot-login list (SRS §1.1), stale-PR N days (FR-METRICS-8),
LM host list + concurrency cap, budget share. Seeded with `default` (D1).

**users** — `id, forge_user_id text, login, name, avatar_url, created_at`; unique
`(forge_user_id)`. Created on first OAuth login (FR-AUTH-1). Not workspace-scoped (a user
may join many workspaces).

**workspace_members** — `workspace_id, user_id, role enum('admin','member'), created_at`;
PK `(workspace_id, user_id)` (FR-AUTH-3/4).

**forge_connections** — `id, workspace_id, provider enum('github','gitea'), auth_kind
enum('pat','app'), credential_ciphertext bytea, credential_iv bytea, key_version int,
credential_fingerprint text (last-4/hash for UI), app_installation_id text null, webhook_secret_ciphertext bytea,
status, created_by, created_at`. AES-256-GCM, key from env — plaintext never in DB/logs
(FR-AUTH-5, NFR-6). Decryption only inside packages/forge memory.

**identities** — the forge-login→human map (FR-AUTH-6, FR-METRICS-3 ownership).
`id, workspace_id, provider, forge_login, forge_user_id text null, display_name,
user_id null FK users, is_bot bool default false, merged_into_id null self-FK`.
Resolution strategy: (1) auto-link on OAuth login by forge_user_id; (2) auto-flag bots by
`*[bot]` pattern + workspace bot list; (3) same-human-across-forges (v1.x Gitea) via admin
merge UI writing `merged_into_id` — all fact tables FK the RAW identity, queries resolve
through `COALESCE(merged_into_id, id)` so merges are non-destructive and reversible.
Unique `(workspace_id, provider, forge_login)`.

### Sync machinery

**repos** — `id, workspace_id, connection_id, forge_repo_id text, org, name, default_branch,
is_private, is_archived, sync_status enum('pending_backfill','backfilling','live','error',
'paused_budget','paused') , backfill_pct smallint, last_synced_at, last_error text,
tier2_auto bool, tier3_opt_in bool default false, pushed_at` (FR-INGEST-8, FR-ANALYSIS-1).
Unique `(workspace_id, connection_id, forge_repo_id)`.

**sync_cursors** — resumable checkpoints (FR-INGEST-3/6). `workspace_id, repo_id,
entity_type enum('commits','prs','reviews','pr_files','checks','issues','releases',
'deployments','workflow_runs'), cursor_value text (updated_at watermark | page cursor |
delivery id), backfill_done bool, updated_at`; PK `(repo_id, entity_type)`.

**api_cache** — ETag store (FR-FORGE-4, ADR-1). `connection_id, endpoint_key text
(method+path+params hash), etag text, last_modified text null, last_status smallint,
updated_at`; PK `(connection_id, endpoint_key)`. Not workspace-critical (derivable), but
carries `workspace_id` anyway for uniform RLS. Prunable cache — safe to truncate.

### Facts (normalized ingest writes — ADR-2 write side)

**commits** — `id, workspace_id, repo_id, sha, author_identity_id, committer_identity_id,
authored_at, committed_at, message_head text (first line), is_revert_heuristic bool,
additions int null, deletions int null, files_count int null, stats_source
enum('detail','stats_api','graphql') null`. Unique `(repo_id, sha)`. `is_revert_heuristic`
precomputed at ingest for FR-METRICS-12 CFR. additions/deletions nullable: filled by the
churn path chosen per research §8 (stats-first, per-commit fallback).

**commit_files** — churn fact granularity = per file per commit (FR-METRICS-1/2/3 need
file-level additions/deletions to compute churn, hotspots, ownership without cloning — C1).
`workspace_id, repo_id, commit_id, path text, additions int, deletions int, status
enum('added','modified','removed','renamed'), previous_path text null`;
PK `(commit_id, path)`. This is the biggest table (~files-per-commit × commits); no patch
text stored (diff text is fetched on demand for LLM tiers, never warehoused — ADR-1).

**pull_requests** — `id, workspace_id, repo_id, number int, forge_pr_id text, title,
author_identity_id, state enum('open','closed','merged'), is_draft bool, is_bot bool,
created_at, updated_at, closed_at, merged_at, merged_by_identity_id, base_ref, head_sha,
additions int, deletions int, changed_files int, first_review_at, first_approval_at,
last_activity_at, last_activity_kind text`. Unique `(repo_id, number)`.
`first_review_at/first_approval_at/last_activity_*` are ingest-maintained denormalizations
so cycle-time (FR-METRICS-4) and staleness (FR-METRICS-8) are index scans, not per-request
review-table aggregation.

**pr_reviews** — `id, workspace_id, repo_id, pull_request_id, forge_review_id text,
reviewer_identity_id, state enum('APPROVED','CHANGES_REQUESTED','COMMENTED','DISMISSED'),
submitted_at`. Unique `(pull_request_id, forge_review_id)` (FR-METRICS-4/5/6).

**pr_files** — `workspace_id, repo_id, pull_request_id, path, additions, deletions,
change_type text`; PK `(pull_request_id, path)`. From GraphQL backfill (research §6);
feeds PR-size (FR-METRICS-7) and file↔PR drill-down. No patch text.

**check_runs** — `id, workspace_id, repo_id, forge_run_id text, kind
enum('check_run','workflow_run'), workflow_name text null, head_sha, pull_request_id null,
status, conclusion, run_attempt smallint, started_at, completed_at, duration_ms bigint`.
Unique `(repo_id, kind, forge_run_id, run_attempt)`. `run_attempt` powers flakiness
(fail→pass same head SHA, FR-METRICS-9).

**deployments** — `id, workspace_id, repo_id, forge_deployment_id text, environment, sha,
created_at, latest_status text, status_updated_at`. Unique `(repo_id, forge_deployment_id)`
(FR-METRICS-12).

**releases** — `id, workspace_id, repo_id, forge_release_id text, tag, name, is_draft,
is_prerelease, published_at`. Unique `(repo_id, forge_release_id)` (FR-METRICS-11).

**issues** — `id, workspace_id, repo_id, number, author_identity_id, state, created_at,
closed_at, reopened_count smallint, is_pull_request bool (always excluded from issue
metrics — FR-METRICS-10)`. Unique `(repo_id, number)`.

### Read models & analysis (ADR-2 read side)

**metric_snapshots** — append-only time series (ADR-7, FR-METRICS-13/14).
`id, workspace_id, repo_id bigint null (NULL = org-level rollup row), metric_key text
(FR-METRICS-1..12 + insights score keys, from the FR-METRICS-15 catalog), window
enum('7d','30d','90d','365d'), dims jsonb default '{}' (e.g. {"author":..,"workflow":..,
"basis":"releases"}), value numeric, numerator numeric null, denominator numeric null,
computed_at`. Never updated, never deleted inside retention. Index:
`(workspace_id, repo_id, metric_key, window, computed_at DESC)`; org rollups indexed via
partial index `WHERE repo_id IS NULL`. numerator/denominator kept so org pooling stays
statistically correct (FR-METRICS-14) and deltas are auditable (FR-INSIGHTS-4).

**analysis_runs** — `id, workspace_id, repo_id, pull_request_id null, tier smallint (2|3),
dimension text, checklist_version text, model_id text, status enum('queued','running',
'succeeded','failed','dead_letter'), chunk_count int, prompt_tokens int, output_tokens int,
cost_usd numeric null (T3), started_at, finished_at, error text` (FR-ANALYSIS-4/7).

**findings** — `id, workspace_id, repo_id, analysis_run_id, pull_request_id null,
dimension enum('code_health','security','performance','test_coverage'), severity
enum('critical','high','medium','low','info'), confidence numeric(3,2), title, file text,
line_start int, line_end int, evidence text, recommendation text, tier smallint,
dedup_key text (dimension+file+normalized-title+line-bucket, FR-ANALYSIS-6), status
enum('open','acknowledged','resolved','wont_fix') , status_changed_by, status_changed_at,
first_seen_at, last_seen_at, occurrence_count int`. Unique `(workspace_id, repo_id,
dedup_key)` — re-analysis upserts, resolved-that-reappear reopen (FR-INSIGHTS-1).
Status history in **finding_events** (`finding_id, from_status, to_status, actor, reason, at`).

**reports** — immutable snapshots (FR-REPORTS-1/7). `id, workspace_id, type
enum('repo_health','org_exec','security_posture','delivery_dora'), params jsonb
(repo_ids[], window, pinned_at), status enum('queued','rendering','ready','failed'),
html_uri text, pdf_uri text, generated_by, generated_at`. `*_uri` point at object/file
storage (local volume v1); DB stores pointers, not blobs.

**saved_views** — `id, workspace_id, owner_user_id, name, config jsonb (repo filter,
window, tile layout), is_shared bool default false, share_slug text unique null,
is_default_for_owner bool, created_at, updated_at` (FR-API-6, FR-WEB-4/5).

**egress_audit** — append-only, Tier-3 only (NFR-9). `id, workspace_id, repo_id,
pull_request_id, analysis_run_id, initiator_user_id, model_id, bytes_sent int,
tokens_sent int, tokens_received int, content_sha256 text, sent_at`. No content stored —
digest only. Admin-queryable, never deleted.

## 3. Hot-path indexes (NFR-3: p95 < 500ms on every dashboard endpoint)

| Query (drill-down level) | Index |
|---|---|
| Org rollup tiles + trends | `metric_snapshots(workspace_id, repo_id, metric_key, window, computed_at DESC)` + partial `WHERE repo_id IS NULL` |
| Repo detail metrics | same snapshot index with `repo_id =` |
| PR list w/ cycle-time sort/filter | `pull_requests(workspace_id, repo_id, state, merged_at DESC)`; `(workspace_id, repo_id, last_activity_at)` for stale (FR-METRICS-8); `(workspace_id, author_identity_id, state)` for "my PRs" (FR-WEB-7) |
| Review-load widget | `pr_reviews(workspace_id, reviewer_identity_id, submitted_at DESC)` |
| File hotspot ranking | `commit_files(workspace_id, repo_id, path, commit_id)` + covering `(repo_id, path) INCLUDE (additions, deletions)`; hotspot scores precomputed into `metric_snapshots(metric_key='hotspot', dims->>'path')` nightly — ranking page reads snapshots, not raw commit_files (FR-METRICS-2, FR-INSIGHTS-5) |
| Churn by author | `commits(workspace_id, repo_id, author_identity_id, authored_at)` |
| CI pass rate | `check_runs(workspace_id, repo_id, workflow_name, completed_at)` |
| Findings filters | `findings(workspace_id, repo_id, dimension, severity, status)` |
| Webhook idempotency | unique natural keys listed per table above |

Why `metric_snapshots` instead of on-the-fly aggregation: org rollup = 50 repos × 12
metrics × trend points; aggregating raw facts per request would scan millions of
commit_files rows and blow NFR-3. Snapshots make every tile/trend a narrow index-range
scan; correctness is preserved by storing numerator/denominator for pooled re-aggregation
(FR-METRICS-14). Current-window "live" values are recomputed only on ingest events
(webhook → recompute affected metric), not on read (ADR-2).

## 4. Retention (SRS §5 A3)

- Raw facts (commits, commit_files, prs, …): indefinite at launch; every fact table keys on
  `(workspace_id, repo_id, time)` so a future retention knob is a ranged DELETE / partition
  drop — schema does not preclude it. commit_files is the candidate for pg_partman
  partitioning by month if it outgrows ~100M rows (defer until measured).
- `metric_snapshots`: ≥400 days (FR-METRICS-13); nightly prune beyond policy.
- `reports`: immutable, kept forever (FR-REPORTS-1); `egress_audit`: never deleted (NFR-9).
- `api_cache`: prunable LRU, 90-day sweep.

## 5. Migration discipline (Drizzle)

- Schema lives in `packages/shared/src/db/schema/*.ts`; `drizzle-kit generate` produces SQL
  in `packages/shared/drizzle/` — committed, sequential, NEVER edited after merge.
- Every migration PR states: forward SQL, rollback note (explicit down-SQL in the PR
  description — Drizzle has no auto-down; destructive changes require a two-step
  expand→migrate→contract sequence across releases), and data backfill plan if any.
- Additive-first rule: new columns nullable-or-defaulted; renames = add + backfill + drop
  in separate migrations so old worker/api versions never break mid-deploy.
- `drizzle-kit migrate` runs as a one-shot job before api/worker start (compose/Podman
  dependency); CI gate applies all migrations to a scratch Postgres 16 + runs the tenancy
  suite (NFR-4) before merge.
- Enums: prefer text + CHECK constraint over Postgres enums for anything likely to grow
  (metric_key, dimension stays enum — checklist-bound).
