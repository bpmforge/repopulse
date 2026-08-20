# Configuration reference

<!-- GENERATED FILE — do not edit by hand.
     Source: apps/api/src/routes/setup/env-registry.ts
     Regenerate: node scripts/generate-config-doc.mjs
     A test fails if this file drifts from the registry, or if a variable is
     read in source without being registered. -->

Every environment variable RepoPulse reads is listed here: what it is for,
whether it is required, its default, and **what breaks if it is wrong** — which
is the column that actually helps at 2am.

🔒 marks a secret. Secrets are never logged, never returned by the API, and
never echoed back by the setup screen.

**Wrong or missing configuration fails at startup**, with a message naming
every variable at fault. The API will not half-boot.

## Shared (API and worker)

| Variable | Required | Default | Purpose | If it is wrong |
| --- | --- | --- | --- | --- |
| `DATABASE_URL` 🔒 | yes | — | Postgres 16 connection string. Every read and write goes here. | The API and worker refuse to start. A wrong database means an empty product, not an error page. |
| `REDIS_URL` 🔒 | yes | — | Redis connection for sessions and the BullMQ queues. | The API refuses to start; without it nothing is ingested and nobody can log in. |
| `NODE_ENV` | no | `development` | Set to 'production' in a real install: it turns on secure cookies. | Left unset behind TLS, session cookies are sent without the Secure flag. |
| `DATA_DIR` | no | `./data` | Writable directory for generated reports. | Report generation fails at write time, after doing all the work. |

## API

| Variable | Required | Default | Purpose | If it is wrong |
| --- | --- | --- | --- | --- |
| `SESSION_SECRET` 🔒 | yes | — | Signs session cookies. | Changing it logs every user out. A short or shared value makes sessions forgeable. |
| `TOKEN_ENC_KEY` 🔒 | yes | — | AES-256-GCM key encrypting forge tokens at rest (Law 9). | Boot fails unless it is 32 bytes of hex. LOSING IT makes every stored forge credential undecryptable — they must be re-entered. |
| `API_BASE_URL` | yes | — | Where the API is reachable. Builds the OAuth callback URL. | OAuth fails after the forge redirects back, because the callback it was told about does not match this. |
| `PUBLIC_BASE_URL` | yes | — | Where users reach the web app. Builds the webhook URL and the post-login redirect. | Webhooks are registered against the wrong host and deliveries never arrive. |
| `GITHUB_APP_CLIENT_ID` | yes | — | OAuth client id of YOUR GitHub App (see docs/INSTALL.md). | Login fails at the forge with an unhelpful "application not found". |
| `GITHUB_APP_CLIENT_SECRET` 🔒 | yes | — | OAuth client secret of your GitHub App. | Login fails at the token exchange, after the user has already approved. |
| `GITHUB_APP_ID` | no | — | Numeric App id, used for App-authenticated (installation) calls. | App-token flows are unavailable; PAT connections still work. |
| `FORGE_BASE_URL` | no | — | Self-hosted Gitea base URL. Absent means github.com. | Gitea connections point at the wrong host and every sync fails with 404s. |
| `FORGE_TOKEN` 🔒 | no | — | Read ONLY by the headless `pnpm connect:forge` bootstrap, never by the running server. Supply it on that one command line, not in a file. | The bootstrap refuses to run without it and prints where to generate one. A wrong token is reported by name (bad_token / bad_scope / no_repos) before anything is stored, so a bad credential never reaches the database. |
| `FORGE_ALLOW_INSECURE_LOOPBACK` | no | `unset` | Permits an http:// loopback forge URL. FOR LOCAL DEVELOPMENT ONLY. | Set in production, it allows an unencrypted forge connection. |
| `PORT` | no | `3300` | API listen port. | The reverse proxy cannot reach the API. |
| `DEMO_GITHUB_PORT` | no | `4010` | Port for the demo-mode fake GitHub. Development only. | Demo mode fails to start. Not read in a normal install. |
| `DEMO_FORGE_PORT` | no | `4011` | Port for the demo-mode fake forge. Development only. | Demo mode fails to start. Not read in a normal install. |

## Worker

| Variable | Required | Default | Purpose | If it is wrong |
| --- | --- | --- | --- | --- |
| `WORKER_HEALTH_PORT` | no | `3301` | Port for the worker /healthz endpoint. | Container health checks fail and the orchestrator restarts a healthy worker. |
| `SNAPSHOT_ROOT` | no | `the system temp directory` | Scratch directory for C1a scan snapshots. Cleared by the sweeper. | Scans fail to extract; a non-ephemeral path retains customer source longer than intended. |
| `SCAN_IMAGE` | no | `localhost/repopulse/scan:dev` | Container image the sandboxed scanners run in. | Every tool-based scan fails to start; findings silently stop appearing. |
| `RECONCILE_CRON` | no | `17 3 * * *` | Nightly reconcile sweep schedule. 'off' disables it. | Drift between the forge and the warehouse is never corrected. |
| `SECRETS_HISTORY_CRON` | no | `23 4 1 * *` | Monthly secrets history sweep. 'off' disables it. | Credentials committed and later deleted are never found. |
| `SECURITY_WEEKLY_CRON` | no | `41 2 * * 0` | Weekly full security and code-health pass. 'off' disables it. | Findings only ever come from pull requests, so unchanged code is never reviewed. |
| `SECURITY_CHAIN_CRON` | no | `41 3 * * 0` | Attack-chain recompute, deliberately an hour after the weekly pass. | Chains are built from findings the weekly scan is about to replace. |
| `REGISTERS_NIGHTLY_CRON` | no | `17 3 * * *` | Nightly W10 register pass (knowledge, supply chain, architecture, test gap). 'off' disables it. | Register findings never refresh; EOL dates in particular go stale silently. |
| `EOL_PRODUCTS` | no | `nodejs,python,go,ruby,php,java,dotnet,debian,ubuntu,alpine,postgresql,redis,nginx` | Comma-separated endoflife.date products the nightly sync tracks. | A runtime you use is not tracked, so no EOL finding is ever raised for it. |
| `LMSTUDIO_BASE_URLS` | no | — | Comma-separated LM Studio endpoints for Tier-2 analysis (http://host:1234/v1). Absent means no Tier-2: the whole Tier-1 product still works. | Scheduled judgement passes skip with reason no_gateway. Pointing at an unreachable host is worse than leaving it unset — the passes then FAIL rather than skip, which is deliberate: a host you configured and cannot reach is a fault, not a choice. |
| `LMSTUDIO_MODEL` | no | — | The loaded model id to request, e.g. qwen3.8-27b. Required whenever LMSTUDIO_BASE_URLS is set. | LM Studio answers 400 "Invalid model identifier" on every call. There is no default because a guessed model name is a guess about your machine; with it unset the gateway refuses to build and says which variable is missing. |
| `LMSTUDIO_CONCURRENCY` | no | `1` | Per-host concurrent Tier-2 request cap (FR-ANALYSIS-8). | Set too high, a local model thrashes and calls time out; the scheduler parks instead of queueing invisibly. |

## Web (build/dev only)

| Variable | Required | Default | Purpose | If it is wrong |
| --- | --- | --- | --- | --- |
| `API_PROXY_TARGET` | no | `http://localhost:3300` | Dev-server proxy target for /api. Not used in a container install. | The dev server cannot reach the API; production uses nginx instead. |

## Generating the secrets

```sh
# TOKEN_ENC_KEY — 32 bytes of hex. LOSING THIS makes every stored forge
# credential undecryptable; they have to be re-entered.
openssl rand -hex 32

# SESSION_SECRET — any long random string. Changing it logs everyone out.
openssl rand -base64 48
```

See [INSTALL.md](INSTALL.md) for the full walkthrough, including registering
your own GitHub App or Gitea token.
