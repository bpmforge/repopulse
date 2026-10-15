# RepoPulse — Security Controls Catalog

Numbered controls mapped to THREAT_MODEL.md threat IDs. Each: implementation note, landing
wave/module, verification (test / validator / manual). Verification is a ticket acceptance
criterion — a control without its check green does not close (CLAUDE.md Law 3). Waves: W0 =
scaffold/infra/CI, W1+ = MVP (auth, ingest, dashboard, reports), W2 = analysis tiers (v1.x),
GT = Gitea adapter (v1.x).

## Credentials & crypto

- **SC-1 Forge-token encryption at rest** (T-13, T-25). AES-256-GCM via `node:crypto`
  (`createCipheriv`, random 12-byte IV per row, auth tag stored; columns per DATABASE.md
  forge_connections). Key: 32-byte `REPOPULSE_TOKEN_KEY` from env/secret store, `key_version`
  column enables rotation (decrypt-old/encrypt-new sweep job). Decryption only inside
  packages/forge memory; plaintext never returned by any API, never serialized to logs/errors.
  Same scheme for `webhook_secret_ciphertext`. *Lands:* W1 · packages/forge + shared schema.
  *Verify:* unit tests (roundtrip, wrong-key fail, IV uniqueness, tamper→auth-tag reject);
  validator greps API responses/log fixtures for token material.
- **SC-2 Key handling & no-log rule** (T-13, T-33, A2). Key only via env; process refuses to
  boot with missing/short key; key never in config files, git, or error payloads. Logger
  (packages/shared) has a redaction layer: denylist of field names (`token`, `credential`,
  `secret`, `authorization`, `x-hub-signature*`) + `gh[pous]_[A-Za-z0-9]{36,}`/PEM-block
  pattern scrub applied to every log line. *Lands:* W0 · shared logger. *Verify:* unit test
  feeds tokens through logger and asserts scrubbed output; CI validator scans repo for key
  literals (SC-18 tooling).
- **SC-25 Credential least-privilege** (T-13, T-14). Prefer GitHub App (short-lived
  installation tokens, ~1h) over PAT; docs + connect UI demand read-only scopes
  (`contents:read, metadata:read, pull_requests:read, checks:read, deployments:read,
  issues:read, security_events:read` + webhook; `security_events:read` reads
  code-scanning alerts for W18-24). Connect flow surfaces granted scopes and warns on write/admin.
  *Lands:* W1 · ingest connect flow + ADMIN_GUIDE. *Verify:* unit test on scope-warning
  logic; manual checklist item at first org connect.

## Web/auth surface

- **SC-3 Webhook HMAC verification** (T-9, T-11). `X-Hub-Signature-256` HMAC-SHA256 over the
  RAW body (Fastify raw-body capture before JSON parse), `crypto.timingSafeEqual`, secret
  decrypted per connection. Invalid ⇒ 401, nothing parsed/enqueued, counter metric.
  *Lands:* W1 · packages/forge verify + apps/api webhook route. *Verify:* integration tests
  (valid, bad sig, missing header, mutated-byte body, wrong secret).
- **SC-4 Webhook replay/dedup guard** (T-10, T-12). `X-GitHub-Delivery` id = BullMQ job
  idempotency key; persisted delivery watermark in sync_cursors; duplicate delivery ⇒ 202 +
  no-op job. Deliveries older than 10 min (payload timestamp where present) logged as
  anomalies. *Lands:* W1 · ingest webhook handlers. *Verify:* integration test posts same
  signed delivery twice, asserts single job + single upsert.
- **SC-5 OAuth state + PKCE + redirect hygiene** (T-1, T-2). Per-attempt random `state`
  (server-side in Redis, single-use, 10-min TTL), PKCE S256, callback validates state before
  code exchange; registered redirect URI exact-match; `returnTo` accepted only as same-origin
  relative path (regex `^/[^/\\]`). *Lands:* W1 · apps/api/src/auth. *Verify:* integration
  tests (missing/reused/foreign state ⇒ 403; `returnTo=https://evil` ⇒ stripped).
- **SC-6 Session hardening** (T-3, T-27). Redis-backed opaque session ids (128-bit random);
  cookie `HttpOnly; Secure; SameSite=Lax; Path=/`; session id rotated on login; idle 24h +
  absolute 7d expiry; logout destroys server-side. *Lands:* W1 · apps/api/src/auth.
  *Verify:* integration tests assert cookie flags, rotation-on-login, revocation.
- **SC-7 CSRF stance** (T-4). SPA is same-origin (api serves bundle) ⇒ primary defense =
  `SameSite=Lax` + no CORS wildcard (CORS disabled; API is same-origin only). All mutations
  additionally require `X-Requested-With: repopulse` custom header (preflight-protected
  cross-origin). Webhook route exempt (SC-3 covers it). *Lands:* W1 · api plugin.
  *Verify:* integration test: mutation without header ⇒ 403; CORS probe ⇒ no ACAO header.
- **SC-8 Server-side RBAC** (T-6). Route-level `requireRole('admin'|'member')` preHandler on
  every /api/v1 route — declared in the route table, not ad hoc; admin-only: connections CRUD,
  Tier-3 opt-in, identity merge, workspace settings, bulk finding export, egress report.
  *Lands:* W1 · apps/api/src/auth + every route wave. *Verify:* route-inventory validator
  fails CI if any route lacks an explicit role declaration; per-route 403 tests as member.
- **SC-9 Tenancy enforcement** (T-7, T-26). Repo-layer query helpers force
  `workspace_id = session.workspaceId` on every tenant-scoped table (Law 5); RLS policies
  written (not enabled) per ADR-3. Tenancy test suite: seeds two workspaces, asserts every
  endpoint + every repo helper returns zero cross-tenant rows; suite is a CI gate.
  *Lands:* W1 · packages/shared db helpers; suite grows with every new table/route.
  *Verify:* tenancy suite in CI (NFR-4); validator greps for raw `db.select` bypassing helpers.
- **SC-10 Input validation everywhere** (T-5, T-16, T-26). zod schema on every route
  (params/query/body) via fastify-type-provider-zod — unvalidated route fails a CI validator.
  Ingest-side: forge payloads normalized through zod contracts in packages/shared (length
  caps, `path` sanitized — reject `..`, NUL; identity logins NFC-normalized). Drizzle
  parameterizes all SQL; raw `sql` fragments require review-gate justification.
  *Lands:* W0 pattern · every route/ingest wave. *Verify:* validator (route↔schema
  inventory); fuzz tests on webhook + connect payloads.
- **SC-11 Rate limiting public endpoints** (T-8, T-11, T-17). @fastify/rate-limit:
  login/OAuth start+callback 10/min/IP; webhook 100/min/connection (429 after, GitHub
  redelivers); share-slug views 60/min/IP; SSE connections capped per session. Job-size caps:
  backfill pages and analysis chunk counts bounded per job (ADR-4 keeps forge budget safe).
  *Lands:* W1 · api plugins. *Verify:* integration tests hit limits and assert 429 + headers.

## SSRF & egress

- **SC-12 Forge base-URL allowlist (SSRF)** (T-15). packages/forge constructor validates
  every base URL: https only, hostname on workspace-config allowlist, deny IP literals,
  localhost, RFC1918/link-local/metadata ranges; resolve-then-pin the IP for the request
  (rebinding defense); redirects not followed cross-host. GitHubProvider hardcodes
  `api.github.com`. Control + tests ship in W1 so the GT ticket inherits, not reinvents.
  *Lands:* W1 · packages/forge (activated fully in GT). *Verify:* unit tests with the
  canonical evil-URL corpus (metadata IP, decimal IP, `localhost`, rebinding stub).
  **Rule-4 exception (W1-03):** `scripts/validate-arch.sh` rule 4 (no `api.github.com`
  outside packages/forge) carves out `packages/auth/src/oauth/**` for the post-login
  identity fetch (`GET /user` with the user's own OAuth token, FR-AUTH-1/D6). SC-12's
  allowlist defends against an admin-supplied, attacker-controlled base URL — this call's
  base URL is a fixed literal, not configurable input, so there is no SSRF surface to
  allowlist. `packages/auth` cannot depend on `packages/forge` (dependency matrix runs the
  other way), so routing this call through the budgeted client isn't structurally possible
  without inverting that boundary; a narrow, grepped, documented exception was judged
  lower-risk than that inversion.
- **SC-13 LLM prompt-injection defenses** (T-18, T-19, T-20). Structural, per
  ANALYSIS_TIERS §4: (1) all analysis calls JSON-mode, zod `Finding` schema, malformed ⇒
  retry once ⇒ DLQ; (2) `evidence_quote` must be a verbatim substring of the supplied chunk —
  non-substring ⇒ finding rejected; (3) review prompts define **no tools**; T3 requests carry
  no `tools` param; (4) model output is data: never eval'd, templated into shell/SQL/forge
  calls, or used to pick files to fetch (context selection is checklist-driven code, not
  model-driven); (5) context minimization — chunk + checklist only, no credentials/env/other
  repos in any prompt; (6) findings HTML-escaped at render (SC-23). *Lands:* W2 ·
  packages/analysis. *Verify:* unit tests with injection corpus (instruction-override,
  fake-JSON-in-diff, fabricated evidence) asserting reject/DLQ; validator greps analysis
  package for `tools:`/exec patterns.
- **SC-14 Tier-3 egress gate + minimization** (T-22, T-24). Gateway enforces:
  `repo.tier3_opt_in` checked server-side at enqueue AND again in worker before send
  (TOCTOU); payload assembler whitelists content classes (diff hunks, PR title/desc ≤1k tok,
  ≤40-line targeted excerpts — each excerpt fetch itself logged); workspace monthly USD cap ⇒
  exceed = park as `needs-T3`, never silent send. Lint forbids `@anthropic-ai/sdk` outside
  packages/analysis (Law 8). *Lands:* W2 · packages/analysis. *Verify:* unit tests
  (opt-in=false ⇒ reject; payload-class allowlist; cap breach ⇒ parked); lint rule in CI.
- **SC-15 Egress audit integrity** (T-23). `egress_audit` append-only: INSERT-only grant for
  the app DB role (no UPDATE/DELETE), row written BEFORE send with sha256 digest, finalized
  fields via companion row not mutation if send fails. Admin egress report (per repo/PR:
  when, bytes, tokens, cost, initiator) on the ops page + Security Posture report.
  *Lands:* W2 · shared schema (grants) + reports. *Verify:* migration test asserts
  UPDATE/DELETE on egress_audit fails as app role; integration test: T3 call ⇒ exactly one row
  pre-send even when the API call errors.
- **SC-24 LM Studio boundary discipline** (T-20, T-21). Host list is admin workspace config
  (not per-request input), private-range LAN addresses only; requests carry zero credentials;
  responses pass the full SC-13 pipeline. Deployment note: LLM VLAN reachable from worker
  only (Podman network policy); revisit mTLS proxy pre-SaaS (residual risk #4).
  *Lands:* W2 · packages/analysis + infra compose. *Verify:* config zod test (rejects
  public IPs/hostnames unless explicitly flagged); manual network-reachability check in
  deploy runbook.

## Findings & sharing (exfil surface)

- **SC-16 Findings need-to-know** (T-29). v1: read = member, bulk export + cross-repo
  security rollup = admin; findings API always workspace-filtered (SC-9) and paginated —
  no unauthenticated or unbounded listing. Per-repo ACL is a documented SaaS-flip
  prerequisite (THREAT_MODEL residual #3). *Lands:* W2 · insights routes. *Verify:* RBAC
  tests (member export ⇒ 403); pagination-cap test.
- **SC-17 Share links & report delivery** (T-30, T-31). `share_slug` = 128-bit
  crypto-random; shared views render metrics only — finding evidence/recommendations
  excluded from shared payloads by serializer allowlist; shares revocable + listable per
  owner; optional expiry. Report HTML/PDF stored on private volume, streamed only through
  session-authenticated `GET /reports/{id}/pdf` (RBAC + workspace check); report templates
  receive warehouse data only — never tokens/config/internal URLs. Share creation and every
  report download audit-logged. *Lands:* W1 (views/reports) · reports + api. *Verify:*
  serializer snapshot test proves no finding fields in shared payload; entropy/uniqueness
  unit test; integration test: unauthenticated PDF fetch ⇒ 401.

## Pipeline, platform, ops

- **SC-18 Secrets in CI** (T-33). All secrets via forge-CI secret store (Gitea Actions /
  GitHub Actions secrets), masked in logs; no secrets in compose files committed to git
  (`.env` gitignored, `env.example` documents names only); gitleaks (or trufflehog) scan as
  CI gate incl. history on first run. *Lands:* W0 · CI workflows. *Verify:* gitleaks job
  green; manual: rotate any secret ever printed by a failed run.
- **SC-19 Dependency policy** (T-32). pnpm lockfile committed + `--frozen-lockfile` in CI;
  `pnpm config set ignore-scripts true` repo-wide (`.npmrc`) — lifecycle scripts individually
  allowlisted via `pnpm.onlyBuiltDependencies` when unavoidable; dependency-vulnerability
  CI gate (fail on detected vulnerabilities) via **osv-scanner**, not `pnpm audit` — `pnpm
  audit` is broken against the current npm registry for the pnpm major this repo is pinned
  to (retired legacy endpoint, only fixed in pnpm 11; docs/TECH_STACK.md has the full
  writeup, Brad-approved 2026-07-16); new deps verified against registry + docs before
  import (CLAUDE.md Law 2 — anti-slopsquatting); renovate/dependabot weekly. *Lands:* W0 ·
  repo root + CI. *Verify:* CI job asserts `.npmrc` flags + runs osv-scanner; validator diffs
  package.json deps against an APPROVED_DEPS note in the ticket.
- **SC-20 Container hardening** (T-25, T-27, T-34). Podman: non-root UID in all three
  images, `--read-only` rootfs + explicit tmpfs (worker gets a writable Playwright dir),
  `--cap-drop=ALL`, `no-new-privileges`, distinct network for data tier — Postgres/Redis not
  published to host/LAN; Redis `requirepass` + Postgres scram-sha-256, app role owns only its
  schema objects (and INSERT-only on egress_audit per SC-15). *Lands:* W0 compose baseline,
  hardened in deploy wave. *Verify:* compose-file validator (asserts flags present); manual
  deploy checklist: `nmap` data-tier ports from LAN ⇒ closed.
- **SC-21 Backups + restore drill** (T-25, T-28). Nightly `pg_dump` (custom format) to a
  second host, age/gpg-encrypted at rest, 30-day retention; quarterly restore drill into
  scratch Postgres + tenancy suite run against the restore, result noted in docs/STATUS.md.
  Backup artifacts covered by SC-1 (tokens are ciphertext in dumps). *Lands:* deploy wave ·
  infra scripts. *Verify:* restore-drill runbook executed + dated note (manual, scheduled).
- **SC-22 Security audit logging** (T-12, T-29, T-31, T-33). Structured `audit` log stream
  (and `finding_events`-style rows for security-relevant mutations): login success/failure,
  logout, session revocation, connection create/update/delete, Tier-3 opt-in toggle, share
  create/revoke, report download, bulk export, identity merge, admin role change. Every entry:
  actor, workspace, ip, ua, ts. No-token-in-logs rule enforced by SC-2 redaction layer.
  *Lands:* W1 · shared logger + api hooks, grows per wave. *Verify:* integration tests assert
  audit entries for each event class; redaction unit tests (SC-2).
- **SC-23 Security headers + CSP** (T-3, T-5, T-20). @fastify/helmet baseline +
  `Content-Security-Policy: default-src 'self'; script-src 'self'; object-src 'none';
  frame-ancestors 'none'; base-uri 'self'; connect-src 'self'` (ECharts/Tailwind build must
  not require unsafe-inline — build-time CSS, no inline handlers); HSTS at the reverse proxy;
  `X-Content-Type-Options: nosniff`; React escaping + explicit ban on
  `dangerouslySetInnerHTML` (lint rule) — forge-sourced strings and LLM evidence render as
  text only. Report HTML (Playwright print context) uses the same CSP.
  *Lands:* W1 · api plugin + web lint config. *Verify:* integration test snapshots headers;
  ESLint rule in CI; Playwright smoke asserts CSP header on served SPA.

## W8 security-scanner suite (D8, C1a — docs/design/SECURITY_SUITE.md)

- **SC-26 Snapshot extraction guards + size caps** (T-35). Streaming tar extraction
  (SECURITY_SUITE.md §2.1): reject absolute paths, `..` traversal, symlink/hardlink entries
  escaping the root — dropped + counted, never written; per-file cap 50 MB, total cap 2 GB
  (workspace config) — breach ⇒ abort, scan_run `failed(size_cap)`; scratch dirs under
  `SCAN_SCRATCH_ROOT` (tmpfs preferred), shredded in `finally` + startup/hourly orphan
  sweeper (NFR-13). *Lands:* W8 · packages/security snapshot service. *Verify:* traversal +
  zip-bomb fixture archives; kill-mid-scan (crash + SIGKILL) zero-residual-bytes test;
  sweeper clears a planted orphan.
- **SC-27 Scan container sandbox profile** (T-36). Per SECURITY_SUITE.md §2.2: tool-running
  scanners execute in a locked-down Podman container per scan — non-root UID, snapshot
  mounted read-only `noexec` at `/scan`, `--network=none`, `--pids-limit`, CPU/mem/wall caps
  from `ScanBudget`, no forge credentials or env secrets mounted (host fetches the tarball;
  container sees only extracted files); findings exit only as schema-validated JSON on
  stdout. Lint gate: no scan-tool `child_process` spawn outside `packages/security/sandbox`
  (NFR-14). *Lands:* W8 · sandbox module + deploy units. *Verify:* integration test asserts
  network deny + read-only fs + non-root; lint gate in CI.
- **SC-28 Scan-tool & data pinning** (T-37). Sandbox image pins tool versions
  (semgrep/syft/grype) with checksums at build; vulnerability data (grype/OSV, CISA KEV) and
  custom semgrep packs are fetched ONLY by the nightly host-side `db-sync` job from pinned,
  checksum-verified sources into read-only volumes — scan containers never download;
  tool + rulepack versions stamped in `scan_run.tool_versions` for reproducibility and audit
  (FR-SEC-12). *Lands:* W8 · deploy db-sync + Containerfile.scan. *Verify:* image build
  asserts digests; db-sync checksum-mismatch test refuses the volume swap; scan_run rows
  carry versions in fixture runs.
- **SC-29 Secret-value redaction** (T-38). Secrets findings never store the matched value:
  fingerprint hash (sha256), rule id, and file/line location only; evidence rendered as
  masked context; rule applies to findings rows, scan_run payloads, logs (SC-2 layer
  extended with scanner field names), and reports. Live verification probes are
  config-gated, default OFF. *Lands:* W8 · secrets scanner + shared findings helper.
  *Verify:* DB-dump + log grep with a planted fixture secret finds zero plaintext
  occurrences; serializer snapshot test on Security tab/report payloads.
- **SC-29a Stored code excerpts** (W18-32, T-38). A finding may keep up to 60 lines of the scanned file around it (8 either side, 300 characters a line) so the app can show the code without a clone. Never for a secrets finding or a rule whose id names a credential; never when the window matches a credential shape (private-key header, AWS, GitHub, Slack, JWT, key-assignment); never outside the snapshot directory (path and symlink checked) or for files over 1 MiB or with a NUL byte. Cleared `FINDING_CONTEXT_RETENTION_DAYS` (default 90) after the finding closes. *Verify:* `packages/security/src/excerpt.test.ts`, `packages/insights/src/findings/context.test.ts`.
- **SC-30 Per-scanner budgets + scan lane** (T-39). `ScanBudget` per scanner (workspace
  defaults, per-repo override): wall-clock timeout, container CPU/mem caps, forge-call quota
  drawn from a new low-priority `scan` lane in the budgeted client (FR-FORGE-3 budget), LLM
  token budget via gateway accounting; exhaustion ⇒ scan_run `budget_exceeded`, partial
  findings kept + flagged. Scans run on the dedicated `security.scan` queue with its own
  workers, priority below `analysis.review`, DLQ per NFR-11 — a crashing or budget-blown
  scanner never blocks ingestion, Tier-1 metrics, or other scanners (NFR-15, FR-SEC-11).
  *Lands:* W8 · scanner framework. *Verify:* budget-breach fixture keeps flagged partial
  findings; chaos test crashes every scanner with ingest lag + dashboards unaffected.

## Customer-CI pull (W18-18, D16)

- **SC-31 CI read tokens** (T-13, T-6, T-29). The customer's own CI reads PR findings
  with a RepoPulse-minted token and acts on them with its OWN forge token; RepoPulse
  posts nothing (D9a, N-3). Token: `rpci_` + 32 random bytes (base64url), shown once in
  the create response, stored only as `sha256` in `ci_tokens.token_hash` (a high-entropy
  secret needs no slow KDF, and lookup must be by indexed equality); revocation keeps the
  row. Scope is a closed list with one member, `pr_findings:read`, enforced by a CHECK
  constraint; `repo_ids` is a non-empty list of the workspace's own repositories, checked
  at mint time. Default and maximum lifetime 365 days. The `/api/v1` guard judges any
  request with an `Authorization` header as a token request and nothing else (a session
  cookie riding along is ignored), in `onRequest` — before body parsing and validation —
  and admits it only to routes that opt in with `config.ciToken` AND only for GET/HEAD;
  everything else ⇒ 403, unknown/expired/revoked ⇒ 401, a repository outside the token ⇒
  404. Mint and revoke are admin-only and audited (`ci_token.created`, `ci_token.revoked`,
  SC-22); `last_used_at` is stamped per request; the SC-2 scrubber redacts `rpci_…` by
  shape. *Lands:* W18-18 · apps/api `lib/ci-token.ts`, `plugins/api-v1.ts`,
  `routes/pulls`, `routes/admin/ci-tokens`. *Verify:* `routes/pulls/pulls.test.ts` (a
  route walk over every `/api/v1` route with a token ⇒ 403 except the two allowed; writes
  refused; revoke/expiry ⇒ 401; secret absent from DB row, list and logs);
  `test/security/no-forge-write-scope.test.ts` (no forge write scope, SC-25 list and the
  forge port unchanged).

## Coverage map (threat → control)

| Threats | Controls |
|---|---|
| T-1..T-8 (auth surface) | SC-5, SC-6, SC-7, SC-8, SC-9, SC-10, SC-11, SC-23 |
| T-9..T-12 (webhook) | SC-3, SC-4, SC-11, SC-22 |
| T-13..T-17 (ingest/creds) | SC-1, SC-2, SC-10, SC-12, SC-25, SC-31 |
| T-18..T-24 (LLM tiers) | SC-13, SC-14, SC-15, SC-24 |
| T-25..T-28 (data tier) | SC-1, SC-9, SC-10, SC-20, SC-21 |
| T-29..T-31 (findings/share) | SC-16, SC-17, SC-22 |
| T-32..T-34 (supply chain/platform) | SC-18, SC-19, SC-20 |
| T-35..T-39 (W8 scanners: snapshot/sandbox/tools/secrets-at-rest/exhaustion) | SC-26, SC-27, SC-28, SC-29, SC-30, SC-19, SC-20, SC-11 |
