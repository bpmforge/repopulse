# Installing RepoPulse in your own environment

RepoPulse runs as five containers on one host: a web front end, an API, a
background worker, PostgreSQL and Redis. It reads your repositories through the
GitHub API and **never clones them** — nothing of your source is stored beyond
the metrics and findings you see in the dashboard.

## What you need

- A container runtime: Podman 5+ or Docker 24+, with the `compose` subcommand
- ~4 GB of disk for images, plus room for your warehouse (a few hundred MB for
  most orgs)
- A GitHub account that can register an App in your organisation
- A hostname you will reach this install at, and a TLS terminator in front of it
  (nginx, Caddy, Traefik, a cloud load balancer — RepoPulse does not terminate
  TLS itself)

An LLM is **optional**. Tier-1 metrics — health scores, hotspots, PR cycle time,
review coverage, CI trends, DORA — need no model at all. Tiers 2 and 3 are
opt-in and point at your own LM Studio host or your own Anthropic API key.

## 1. Configure

```bash
cp deploy/.env.example deploy/.env
```

Fill in `deploy/.env`. Every secret is yours to generate — nothing ships with a
default:

```bash
openssl rand -hex 24   # POSTGRES_PASSWORD, REDIS_PASSWORD
openssl rand -hex 32   # SESSION_SECRET, TOKEN_ENC_KEY
```

Then paste the two database passwords into `DATABASE_URL` and `REDIS_URL`, and
set `PUBLIC_BASE_URL` / `API_BASE_URL` to the URL your users will open.

> **Back up `TOKEN_ENC_KEY` separately from your database dump.** It decrypts the
> forge credentials stored in Postgres. A dump without the key is unusable; the
> key without a dump is harmless. Losing it means every connected organisation
> must be re-authorised.

## 2. Register a GitHub App

RepoPulse authenticates as **your** GitHub App, in your organisation. Create one
at **Settings → Developer settings → GitHub Apps → New GitHub App**:

| Field | Value |
|---|---|
| Homepage URL | your `PUBLIC_BASE_URL` |
| Callback URL | `<PUBLIC_BASE_URL>/auth/callback` |
| Webhook URL | `<PUBLIC_BASE_URL>/api/v1/webhooks/github` |
| Webhook secret | the `WEBHOOK_SECRET` from your `.env` |

Repository permissions — **read-only, all of them**:
Contents, Metadata, Pull requests, Checks, Issues. RepoPulse never writes to
your repositories: it does not open branches, push commits, or comment on pull
requests.

Copy the App ID, Client ID, Client secret and a generated private key into
`deploy/.env`.

## 3. Start

```bash
podman compose -f deploy/compose.yaml up -d     # or: docker compose
```

The first run builds the images (several minutes) and applies database
migrations before the API starts. Re-running `up` later is safe — migrations are
recorded, so an already-migrated database is left alone.

Check it:

```bash
curl -f http://127.0.0.1:8080/healthz && echo OK
```

Then open `PUBLIC_BASE_URL` and sign in with GitHub.

Only the web container publishes a port, and it binds to `127.0.0.1` by default
so nothing is exposed before you have put TLS in front of it. Postgres and Redis
are reachable only on the internal network. To expose the web port on a LAN
interface, set `REPOPULSE_BIND=0.0.0.0` — **after** your terminator is in place.

## 4. Connect your organisation

Sign in, go to **Admin → Connections**, and connect the organisation your App is
installed on. Backfill starts immediately; the Org Overview shows per-repo
progress while it runs and fills in as history lands.

## Upgrading

```bash
git pull                                          # or pull new image tags
podman compose -f deploy/compose.yaml down
podman compose -f deploy/compose.yaml up -d --build
```

Migrations run as a one-shot job before the API restarts.

> **`up -d --build` alone is not enough.** Verified on Podman: it rebuilds the
> images and re-runs migrations, but leaves the already-running containers
> untouched — so the upgrade *appears* to succeed while every service keeps
> executing the old code. `down` first (or pass `--force-recreate`). Confirm
> afterwards with `podman ps`: the containers should show an uptime of seconds,
> not the age of your previous deployment.

## Backing up

```bash
podman exec repopulse_postgres_1 pg_dump -U repopulse repopulse > repopulse-$(date +%F).sql
```

Store `TOKEN_ENC_KEY` somewhere else. A dump plus that key is a complete restore.

## Troubleshooting

**Everything is stuck in `Created`.** Something with a health check is not
healthy yet — usually Postgres or Redis. `podman ps -a` shows which;
`podman logs <container>` says why.

**`redis ... exited (127)` with a `setpriv` error.** The Redis container needs to
run as the `redis` user; the shipped compose already sets this. If you have
edited it, do not drop `CAP_SETUID`/`CAP_SETGID` without also setting
`user: redis`.

**nginx exits with `host not found in upstream`.** The web container resolves the
API address at startup. It defaults to the `api` service; if you run the API
elsewhere, set `API_UPSTREAM` to its address.

**Login redirects then fails.** The Callback URL on your GitHub App must match
`<PUBLIC_BASE_URL>/auth/callback` exactly, including scheme and port.
