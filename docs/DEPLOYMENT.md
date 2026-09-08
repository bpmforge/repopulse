# RepoPulse — Deployment (Podman on bpmforge infra)

> **This document describes the bpmforge DOGFOOD install, not the product.**
> Under D1a the delivery model is customer-hosted; a customer's install path is
> the bundle produced by W17-28 and documented by W17-33. Hostnames, TLS
> termination and backup volumes below are one operator's specifics.
> Superseded framing recorded 2026-09-08 in
> `docs/work/product-completion/DECISIONS.md` (D15); the customer-facing rewrite
> is W17-33 (RP-33), which has not run yet.

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

## 9. Scan sandbox (W8-12, SECURITY_SUITE.md §2.2, NFR-14)

The scan sandbox is a fourth image, built from `Containerfile.scan`. It holds
the scan tools; the runtime half of the trust boundary is the podman argv in
`packages/security/sandbox/profile.ts`. Both must be in place — the image
without the profile runs a tool with the host's network, and the profile
without the image has nothing to run.

### Build

```
podman build -f Containerfile.scan -t repopulse/scan:$(git rev-parse --short HEAD) .
```

The Opengrep binary is pinned by version **and** sha256. Opengrep publishes
sigstore `.sig`/`.cert` files but no checksum manifest, so the recorded sha256
was computed from the downloaded artefact and is verified on every build: a
silently replaced upstream binary fails the build. That is not the same as a
vendor-signed checksum, and it is worth upgrading to `cosign verify-blob` when
cosign is available on the build host.

### What the container may do

Nothing but read `/scan` and write two tmpfs mounts:

- `--network=none` — a scan tool with a network is an exfiltration path for the
  source it is reading.
- `--read-only` root, `--cap-drop=ALL`, `--security-opt=no-new-privileges`,
  `--user=65534:65534`, `--pids-limit`.
- the snapshot at `/scan:ro,noexec` — a repository is full of executable files
  someone else wrote.
- `/tmp` (256 MB) and any path the scanner declares in `writablePaths`, each a
  `noexec,nosuid,mode=1777` tmpfs. Opengrep needs `/opt/opengrep/.opengrep` for
  its log; it is mounted individually rather than by making `$HOME` writable,
  which would let one scan mutate the binary the next scan runs.
- **no environment at all** — not a filtered copy of the worker's.

The image pre-extracts Opengrep's core at build time, because the launcher
otherwise unpacks it into `$HOME` and execs it, which fails under `noexec`. The
fix belongs in the image; loosening the mount would have traded the boundary for
convenience.

### Scratch space (`SCAN_SCRATCH_ROOT`, NFR-13)

Snapshots are extracted into a **tmpfs** mounted at `/var/tmp/repopulse-scan`
(`SCAN_SCRATCH_SIZE`, default 2 GB). A tmpfs, not a volume, so a customer's
source never reaches a disk that survives a reboot or a volume backup.

Size it for the largest single repository you scan plus headroom — extraction
aborts with `size_cap` rather than filling the mount, and a repository that will
not fit is a raised `SCAN_SCRATCH_SIZE`, not a redirect onto disk.

Two cleanup mechanisms, for two different failures:

- the scan brackets its own snapshot and deletes it in a `finally` — covers
  returning and throwing;
- the worker's orphan sweeper runs at boot and hourly, removing `snap-*`
  directories older than the longest allowed scan — this is the **SIGKILL**
  path, which no in-process cleanup can cover.

Check for leftovers with `ls /var/tmp/repopulse-scan` on a quiet host: anything
older than six hours means the sweeper is not running.

### Rulepacks and vulnerability databases (`deploy/scan-db-sync.sh`)

The scan container cannot fetch anything. `deploy/scan-db-sync.sh` runs on the
**host**, nightly, and populates `SCAN_RULES_DIR`, which is mounted read-only
into the worker:

```
0 3 * * * /opt/repopulse/deploy/scan-db-sync.sh >> /var/log/repopulse-scan-sync.log 2>&1
```

It syncs the in-house rulepacks (Semgrep registry packs `p/*` and `--config
auto` are licence-barred for service use, so our packs travel with the code) and
writes `rulepacks.sha256` next to them. The vulnerability-database half is **not
implemented**: grype/OSV/KEV belong to the dependency scanner, which is blocked
on those tools being installed at all (W8-06). Setting `SCAN_SYNC_VULN_DB=1`
fails loudly rather than pretending to sync.

A partial sync exits non-zero. A scanner running against a stale rulepack still
produces findings and still looks green, which is why this is noisy.
