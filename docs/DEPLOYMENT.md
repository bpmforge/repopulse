# RepoPulse — Deployment (Podman on bpmforge infra)

Mirrors ThreatForge conventions: Podman + compose/quadlet on the bpmforge host,
reverse proxy terminating TLS at `repopulse.bpmforge.com`, dual-remote git
(Gitea origin + GitHub). Internal deployment per D1; SaaS flip is schema-ready
(ARCHITECTURE.md §7) and changes nothing here.

## 1. Images (three, one Containerfile each under `deploy/`)

| Image | Contents | Process |
|---|---|---|
| `repopulse-api` | apps/api build + shared packages | Fastify: `/api/v1`, SSE, OAuth, webhook receiver |
| `repopulse-worker` | worker build + Playwright/chromium layer (PDF, FR-REPORTS-6) | BullMQ consumers: ingest/metrics/analysis/reports queues |
| `repopulse-web` | apps/web Vite build → static files | served by the reverse proxy (or a slim nginx sidecar); no Node at runtime |

Multi-stage builds off `node:22-slim`, pnpm fetch layer cached, `--frozen-lockfile`.
Images tagged `repopulse-{api,worker,web}:<git-sha>` plus a moving `:prod` tag;
never deploy `:latest`.

## 2. Compose / quadlet layout

- `deploy/compose.prod.yml`: `api`, `worker`, `web`, `postgres:16`, `redis:7` on one
  internal network; only the reverse proxy is exposed. Postgres/Redis volumes are
  named Podman volumes (`repopulse-pgdata`, `repopulse-redis`).
- Quadlet units in `deploy/quadlet/` (`repopulse-pod.kube` or per-container
  `*.container` files) installed to `~/.config/containers/systemd/` → systemd manages
  restart-on-failure and boot-start, same as ThreatForge.
- `worker` scales by replica count (`podman-compose up --scale worker=2`); BullMQ +
  idempotent jobs (NFR-11) already tolerate N workers. api is stateless (sessions in
  Redis) and can scale the same way later.
- **Dev parity**: `compose.dev.yaml` (W0-02) uses the same Postgres 16/Redis 7.2 images and
  env names; prod compose differs in secrets sourcing, TLS, and restart policy, **plus**
  network reachability: prod's data tier sits on the internal pod network only (`DATABASE_URL`/
  `REDIS_URL` use the service hostnames, e.g. `postgres:5432`), while dev publishes both ports
  to `127.0.0.1` only (never `0.0.0.0`/LAN) so host-run `pnpm dev` processes can reach them via
  `localhost` — `.env.example` reflects the dev/loopback form.

## 3. Env / secret matrix (`.env.example`, committed; real `.env` never in git — Law 9)

| Var | Used by | Notes |
|---|---|---|
| `DATABASE_URL` | api, worker | `postgres://repopulse:***@postgres:5432/repopulse` |
| `REDIS_URL` | api, worker | sessions + BullMQ |
| `GITHUB_APP_ID` / `GITHUB_APP_PRIVATE_KEY` / `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` | api (OAuth), worker (installation tokens) | GitHub App mode (preferred, FR-FORGE-5) |
| `GITHUB_PAT` | worker | alternative auth mode; either App vars or PAT required |
| `WEBHOOK_SECRET` | api | HMAC for `X-Hub-Signature-256` (FR-INGEST-5) |
| `SESSION_SECRET` | api | cookie signing; rotate = re-login |
| `TOKEN_ENC_KEY` | api, worker | AES-256-GCM key for forge credentials at rest (FR-AUTH-5); loss = re-enter credentials, so back it up separately from pg_dump |
| `LMSTUDIO_BASE_URLS` | worker | comma-separated LM Studio hosts on the operator LAN; Tier-2 only. Blank disables Tier-2 — Tier-1 metrics need no LLM |
| `ANTHROPIC_API_KEY` | worker | **optional** — absent means Tier-3 disabled; presence still requires per-repo opt-in (NFR-9) |
| `PUBLIC_BASE_URL` | api, web | `https://repopulse.bpmforge.com` (OAuth callback, share links) |
| `DATA_DIR` | worker | Local-disk root for report/PDF artifacts (docs/design/REPORTS.md §3: `${DATA_DIR}/reports/{workspaceId}/{id}/`) |
| `LOG_LEVEL` / `NODE_ENV` | all | `info` / `production` |

Secrets injected via Podman secrets or a root-owned env file (`chmod 600`), never
baked into images; startup validates the full matrix with zod and refuses to boot on
missing/malformed values.

## 4. Reverse proxy, TLS, webhook ingress

- Proxy (bpmforge convention, same instance fronting ThreatForge) terminates TLS for
  `repopulse.bpmforge.com`: `/` → web static, `/api/` + `/api/v1/events` (SSE:
  buffering off, long read timeout) → api.
- **Split exposure**: GitHub must reach the webhook endpoint, so **only
  `POST /webhooks/github` is routed on the public vhost**; every other path is
  LAN/VPN-only (proxy allowlist by source or separate internal vhost). This is
  acceptable because the webhook handler authenticates every delivery by HMAC
  signature over the raw body and does nothing but verify + enqueue (ARCHITECTURE §4b)
  — worst case for an attacker is a rejected 401. Rotate `WEBHOOK_SECRET` via GitHub
  App settings + env bounce if ever suspected.
- Proxy adds HSTS + the usual security headers; api trusts `X-Forwarded-*` only from
  the proxy IP.

## 5. Migrations on deploy

- Drizzle migrations run as a **one-shot job before new containers start**:
  `podman run --rm repopulse-api:<sha> pnpm db:migrate` (advisory-lock guarded, safe
  if two deploys race). Old api/worker keep serving during migration → migrations must
  be backward-compatible one version (expand→migrate→contract; contract step ships in
  the *next* release). Rollback note per migration ticket (PLAYBOOK).

## 6. Backup + restore drill

- Nightly `pg_dump -Fc` via systemd timer to the bpmforge backup volume; retain
  14 daily / 8 weekly. Redis is not backed up (sessions re-login; queues rebuild from
  cursors — the warehouse + `sync_cursors` are the durable truth).
- Back up `TOKEN_ENC_KEY` out-of-band (dump without the key = unreadable credentials).
- **Quarterly restore drill** (scripted, `deploy/restore-drill.sh`): restore latest
  dump into a scratch container, run migrations, run the tenancy suite + a smoke
  query set, record result in docs/STATUS.md. A backup that hasn't been restored is a rumor.

## 7. Monitoring / health

- `GET /healthz` (api + worker): liveness + dependency checks (Postgres, Redis) →
  proxy and systemd health hooks.
- `GET /metrics` (Prometheus format, internal vhost only), per NFR-12:
  per-queue depth/failed/DLQ counts, forge budget spend + remaining gauge (both REST
  and GraphQL buckets), sync lag seconds per repo, webhook deliveries/s + 401 count,
  Tier-2 host availability, HTTP p95 by route.
- Alert thresholds (runbook): DLQ > 0 for 15m, budget remaining < floor for 2h
  (paused-for-budget is normal, *stuck* is not), sync lag > 24h, healthz failing.
  Structured JSON logs with request ids (NFR-12) via journald.

## 8. Upgrade / rollback

Upgrade: `git pull` → build images at `<sha>` → run migration job (§5) → restart via
systemd/quadlet → smoke: `/healthz` green, login, Org Overview renders, one webhook
delivery accepted (GitHub "redeliver" button) → retag `:prod`, append STATUS.md line.

Rollback: retag previous `<sha>` as `:prod`, restart units. DB rolls **forward** only
— that's why §5 mandates one-version backward compatibility; a contract migration is
only shipped after the release that stopped using the old shape has soaked. If a bad
migration must be undone, restore from dump (§6) and replay the gap via nightly
reconciliation (FR-INGEST-7) — the warehouse self-heals from the forge.
