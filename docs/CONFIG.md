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
| `LISTEN_HOST` | no | `127.0.0.1` | Interface the API and the worker /healthz server bind. Loopback by default so a host-run process is not on the LAN; the container images set 0.0.0.0 so the web proxy can reach the api over the compose network (only the web port is published, on REPOPULSE_BIND). | 0.0.0.0 on a host-run process exposes the API and the worker's /metrics to every network the machine is on. 127.0.0.1 inside a container makes the api unreachable from the web proxy (502). |
| `NODE_ENV` | no | `development` | Set to 'production' in a real install: it turns on secure cookies. | Left unset behind TLS, session cookies are sent without the Secure flag. |
| `DATA_DIR` | no | `./data` | Writable directory for generated reports. | Report generation fails at write time, after doing all the work. |
| `NODE_EXTRA_CA_CERTS` | no | `unset` | Path INSIDE the container to a PEM file of extra CA certificates, added to Node's built-in roots. Set it when a self-hosted Gitea, GitLab or GitHub Enterprise (or your OIDC issuer) uses a certificate from an internal CA. In the deploy stack, put the PEM in EXTRA_CA_DIR (default deploy/ca) and set this to /etc/repopulse/ca/<file>.pem. | Unset with an internal-CA forge: connecting fails with a TLS error (unable to verify the first certificate / unable to get local issuer certificate). A path that does not exist or is unreadable is only a warning from Node at startup, and the extra CA is silently not trusted. |

## API

| Variable | Required | Default | Purpose | If it is wrong |
| --- | --- | --- | --- | --- |
| `SESSION_SECRET` 🔒 | yes | — | Signs session cookies. | Changing it logs every user out. A short or shared value makes sessions forgeable. |
| `TOKEN_ENC_KEY` 🔒 | yes | — | AES-256-GCM key encrypting forge tokens at rest (Law 9). | Boot fails unless it is 32 bytes of hex. LOSING IT makes every stored forge credential undecryptable — they must be re-entered. |
| `API_BASE_URL` | yes | — | Where the API is reachable. Builds the OAuth callback URL. | OAuth fails after the forge redirects back, because the callback it was told about does not match this. |
| `PUBLIC_BASE_URL` | yes | — | Where users reach the web app. Builds the webhook URL and the post-login redirect. | Webhooks are registered against the wrong host and deliveries never arrive. |
| `GITHUB_APP_CLIENT_ID` | no | — | OAuth client id of YOUR GitHub App. OPTIONAL since D14 — set it only if you want "Sign in with GitHub" offered alongside local accounts and OIDC. | Forge sign-in is not offered at all when it is absent, which is a supported deployment. Set but wrong, login fails at GitHub with an unhelpful "application not found". |
| `GITHUB_APP_CLIENT_SECRET` 🔒 | no | — | OAuth client secret of your GitHub App. Required only alongside GITHUB_APP_CLIENT_ID. | Login fails at the token exchange, after the user has already approved. |
| `GITHUB_APP_ID` | no | — | Numeric App id, used for App-authenticated (installation) calls. | App-token flows are unavailable; PAT connections still work. |
| `FORGE_BASE_URL` | no | — | Fallback forge base URL for a connection saved without one. Each connection stores its own kind and base URL (Admin → Connections), so this is optional. Absent means github.com. | Only connections with no stored base URL are affected: they point at the wrong host and every sync fails with 404s. |
| `ADMIN_EMAIL` | no | — | Email of the first admin account, created on first boot (D14). Without it — and with no other local account — a fresh install has no way in. | A typo creates an admin nobody can sign in as. The bootstrap is idempotent on "any local account with a password exists", so correcting the value later does NOT create a second admin; use the admin user-creation route instead. |
| `ADMIN_PASSWORD` 🔒 | no | — | Password for that first admin. It must be changed at first sign-in before anything else is reachable. | Boot FAILS on a password below the minimum length rather than creating a weak admin. Leaving it set afterwards is inert — bootstrap never overwrites a password that has been changed — but remove it anyway; a live credential in a file is a live credential. |
| `OIDC_ISSUER` | no | — | Issuer URL of your identity provider, e.g. https://keycloak.example.com/realms/main. Setting the OIDC group at all makes single sign-on the offered option. | Boot fails if the group is half-configured — on purpose. A partially configured IdP fails at the callback instead, after the user has already authenticated, which is the worst moment to find out. |
| `OIDC_CLIENT_ID` | no | — | Client id your IdP issued for RepoPulse. | The IdP rejects the authorization request before the user can approve anything. |
| `OIDC_CLIENT_SECRET` 🔒 | no | — | Client secret for the token exchange. | Sign-in fails at the code exchange, after the user has already approved. |
| `OIDC_REDIRECT_URI` | no | — | Callback URL registered with the IdP — <PUBLIC_BASE_URL>/auth/oidc/callback. | The IdP refuses to redirect back; most report this as an unregistered redirect URI. |
| `OIDC_SCOPES` | no | `openid profile email` | Scopes requested at sign-in. | Dropping `openid` means no ID token comes back and sign-in cannot complete. |
| `OIDC_DISPLAY_NAME` | no | `Single sign-on` | Label on the sign-in button, so it can read "Log in with Acme SSO". | Only cosmetic — the button falls back to a generic label. |
| `FORGE_TOKEN` 🔒 | no | — | Read ONLY by the headless `pnpm connect:forge` bootstrap, never by the running server. Supply it on that one command line, not in a file. | The bootstrap refuses to run without it and prints where to generate one. A wrong token is reported by name (bad_token / bad_scope / no_repos) before anything is stored, so a bad credential never reaches the database. |
| `FORGE_ALLOW_INSECURE_LOOPBACK` | no | `unset` | Permits an http:// loopback forge URL. FOR LOCAL DEVELOPMENT ONLY. | Set in production, it allows an unencrypted forge connection. |
| `PORT` | no | `3300` | API listen port. | The reverse proxy cannot reach the API. |
| `DEMO_GITHUB_PORT` | no | `4010` | Port for the demo-mode fake GitHub. Development only. | Demo mode fails to start. Not read in a normal install. |
| `DEMO_FORGE_PORT` | no | `4011` | Port for the demo-mode fake forge. Development only. | Demo mode fails to start. Not read in a normal install. |

## Worker

| Variable | Required | Default | Purpose | If it is wrong |
| --- | --- | --- | --- | --- |
| `WORKER_HEALTH_PORT` | no | `3301` | Port for the worker /healthz endpoint. | Container health checks fail and the orchestrator restarts a healthy worker. |
| `REPORT_PRINT_BASE_URL` | no | — | Base URL the report printer loads /print/reports/:id from. The deploy stack sets it to the internal web service (http://web:8080). Unset, PUBLIC_BASE_URL is used. | Every report ends "failed" with a navigation error, because the headless browser cannot reach the page it prints. |
| `SNAPSHOT_ROOT` | no | `the system temp directory` | Scratch directory for C1a scan snapshots. Cleared by the sweeper. | Scans fail to extract; a non-ephemeral path retains customer source longer than intended. |
| `SCAN_RULES_DIR` | no | `/var/lib/repopulse/scan-rules` | Host directory holding the scan rulepacks and the grype vulnerability database, mounted read-only into the --network=none scan container. Filled by deploy/scan-db-sync.sh on the host, on your schedule. | Dependency scanning has no CVE data and fails rather than reporting a clean tree. MUST BE ABSOLUTE — a relative path is not resolved against the compose file and the worker will not start. Budget ~2 GB: the grype database alone is 1.9 GB, which is also why we fetch it here instead of shipping it. |
| `SCAN_IMAGE` | no | `localhost/repopulse/scan:dev` | Container image the sandboxed scanners run in. | Every tool-based scan fails to start; findings silently stop appearing. |
| `SCAN_RUNNER_URL` | no | `http://scan-runner:3310 in deploy/compose.yaml; unset means no runner` | Where the worker reaches the scan-runner sidecar (W17-27), the one container that holds the runtime socket and launches the --network=none scan containers on its behalf. http://host:port; SCAN_RUNNER_SOCKET is the unix-socket alternative. The packaged stack sets it to the scan-runner service on the internal scan network. | Every tool-based scan reports the sandbox as unavailable and no findings are persisted; the worker itself never touches the container runtime. |
| `SCAN_RUNNER_TOKEN` 🔒 | no | — | Shared secret between the worker and the scan-runner sidecar. Mandatory whenever the runner listens on TCP (the packaged stack); deploy/configure.mjs generates it and deploy/up.sh refuses to start without it. | The runner refuses to start (TCP listener with no token) or answers 401 to every scan request, so scans fail as sandbox-unavailable with no findings. |
| `AI_PASS_SCHEDULER` | no | `on` | Whether the worker looks for AI-pass schedules that an admin has opted a repository into (W19-12). Nothing is scheduled until an admin enables it per repository and acknowledges where source is sent; 'off' removes the check itself. | With 'off', schedules an admin enabled never run (each shows as not running). Left on, it does nothing for a repository that has no enabled schedule. |
| `AI_PASS_SCHEDULER_TICK_MS` | no | `900000` | How often, in milliseconds, the worker looks for due AI-pass schedules. | Too long and a schedule runs later than its time; too short only adds idle queries - the per-day and monthly caps still apply. |
| `RECONCILE_CRON` | no | `17 3 * * *` | Nightly reconcile sweep schedule. 'off' disables it. | Drift between the forge and the warehouse is never corrected. |
| `SECRETS_HISTORY_CRON` | no | `23 4 1 * *` | Monthly secrets history sweep. 'off' disables it. | Credentials committed and later deleted are never found. |
| `SECURITY_WEEKLY_CRON` | no | `41 2 * * 0` | Weekly full security and code-health pass. 'off' disables it. | Findings only ever come from pull requests, so unchanged code is never reviewed. |
| `SECURITY_CHAIN_CRON` | no | `41 3 * * 0` | Attack-chain recompute, deliberately an hour after the weekly pass. | Chains are built from findings the weekly scan is about to replace. |
| `REGISTERS_NIGHTLY_CRON` | no | `17 3 * * *` | Nightly W10 register pass (knowledge, supply chain, architecture, test gap). 'off' disables it. | Register findings never refresh; EOL dates in particular go stale silently. |
| `EOL_PRODUCTS` | no | `nodejs,python,go,ruby,php,java,dotnet,debian,ubuntu,alpine,postgresql,redis,nginx` | Comma-separated endoflife.date products the nightly sync tracks. | A runtime you use is not tracked, so no EOL finding is ever raised for it. |
| `LMSTUDIO_BASE_URLS` | no | — | DEPRECATED since W16-08 — configure models in Admin → Models instead, which needs no restart and supports hosted providers as well as LAN ones. Kept so an existing install does not lose its model on upgrade; a configured provider always wins over this. Comma-separated OpenAI-compatible endpoints for Tier-2 analysis (http://host:1234/v1). Absent means no Tier-2: the whole Tier-1 product still works. | Scheduled judgement passes skip with reason no_gateway. Pointing at an unreachable host is worse than leaving it unset — the passes then FAIL rather than skip, which is deliberate: a host you configured and cannot reach is a fault, not a choice. |
| `LMSTUDIO_MODEL` | no | — | DEPRECATED since W16-08 — see Admin → Models. The loaded model id to request. Use an INSTRUCT or CODER model, e.g. qwen3-coder-30b-a3b-instruct. Required whenever LMSTUDIO_BASE_URLS is set. | LM Studio answers 400 "Invalid model identifier" on every call. There is no default because a guessed model name is a guess about your machine; with it unset the gateway refuses to build and says which variable is missing. A REASONING model is the subtler mistake: measured here, qwen3.5-9b spent an entire 4000-token budget on reasoning and returned no answer at all, and at the tier's 45000 cap that is twenty minutes per chunk before the request is abandoned. The scanner now reports that by name rather than as a clean result, but the fix is the model: an instruct model answered the same prompt in 12 seconds. |
| `LMSTUDIO_CONCURRENCY` | no | `1` | Per-host concurrent Tier-2 request cap (FR-ANALYSIS-8). | Set too high, a local model thrashes and calls time out; the scheduler parks instead of queueing invisibly. |
| `CLAUDE_CLI_PATH` | no | `claude (looked up on PATH)` | Where the customer-supplied Claude Code CLI is installed (W19-08). Only used if an admin has accepted the responsibility statement and added a Claude Code CLI connection; RepoPulse does not ship or install the CLI. | Wrong, and a CLI connection fails closed with "was not found" naming this path; nothing is sent. Unset, the worker looks for `claude` on its PATH. |
| `LMSTUDIO_REQUEST_TIMEOUT_MS` | no | `1200000 (20 minutes)` | Wall-clock budget for ONE Tier-2 completion (W16-39). Raise it for a large reasoning model on a busy host. | Too low and a legitimately slow generation is killed mid-answer, which reads as a scanner that found nothing. Too high and a stalled stream leaves the scan sitting at "running" until someone notices. Before this existed the bound was undici's 300s header timeout, which killed every checklist against a 27B model at exactly 301s. |

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
