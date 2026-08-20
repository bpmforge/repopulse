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

Every variable is documented in [CONFIG.md](CONFIG.md) — purpose, default, and
what breaks if it is wrong. Wrong or missing configuration fails at startup with
a message naming each variable; the API will not half-boot.

## 2. Connect your forge

RepoPulse authenticates as **your** App against **your** organisation. There is
no shared RepoPulse App and no RepoPulse-hosted anything: your source, your
tokens and your findings never leave your install.

### GitHub

Create an App at **Settings → Developer settings → GitHub Apps → New GitHub
App** (an *organisation* App if the repositories belong to an org):

| Field | Value |
|---|---|
| GitHub App name | anything; it is shown to your users when they authorise |
| Homepage URL | your `PUBLIC_BASE_URL` |
| Callback URL | `<API_BASE_URL>/auth/callback` |
| Request user authorization (OAuth) during installation | ticked |
| Webhook URL | `<PUBLIC_BASE_URL>/api/v1/webhooks/github` |
| Webhook secret | the `WEBHOOK_SECRET` from your `.env` |

**Repository permissions — read-only, every one of them** (C5 / SC-25):

| Permission | Access | Why RepoPulse needs it |
|---|---|---|
| Contents | Read-only | Commit history and the ephemeral tarball the scanners read |
| Metadata | Read-only | Repository list, default branch, archived flag (mandatory on every App) |
| Pull requests | Read-only | PR flow, review coverage, cycle time |
| Checks | Read-only | CI pass rate and flakiness |

Subscribe to these events: **Push**, **Pull request**, **Pull request review**,
**Check suite**, **Check run**.

RepoPulse never writes to your repositories. It opens no branches, pushes no
commits, comments on no pull requests, and **never clones** — analysis reads an
API tarball into an ephemeral scratch directory that is deleted after the scan.
If you are ever asked to grant write access, something is wrong.

**The private key.** Generate one at the bottom of the App page; the browser
downloads a `.pem` once and GitHub never shows it again. Put the file somewhere
the containers can read it and point `GITHUB_APP_PRIVATE_KEY_PATH` at it, or
paste its contents into `GITHUB_APP_PRIVATE_KEY`. Treat it like a password: it
authenticates as the App to every repository the App is installed on. If it
leaks, delete it on the App page and generate a new one — old keys keep working
until you do.

Copy the **App ID**, **Client ID** and **Client secret** into `deploy/.env`,
then **Install App** on the organisation and choose the repositories.

### Gitea

Gitea has no App concept, so a token stands in for one.

1. As a user with read access to the repositories you want tracked, go to
   **Settings → Applications → Generate New Token**.
2. Scopes: **`read:repository`**, **`read:organization`**, **`read:user`** —
   read-only, same rule as GitHub.
3. Set `FORGE_BASE_URL` to your Gitea base URL (`https://gitea.example.com`)
   and paste the token when you add the connection in **Admin → Connections**.
   The token is encrypted at rest with `TOKEN_ENC_KEY` before it is stored.
4. Webhooks: **Repository settings → Webhooks → Add webhook → Gitea**, target
   `<PUBLIC_BASE_URL>/api/v1/webhooks/gitea`, secret = your `WEBHOOK_SECRET`,
   events **Push**, **Pull request**, **Pull request review**.

A self-hosted Gitea over plain `http://` is rejected unless it is a loopback
address and `FORGE_ALLOW_INSECURE_LOOPBACK` is set — a development escape hatch,
not a deployment option.

## 3. Start

```bash
podman compose -f deploy/compose.yaml up -d     # or: docker compose
```

The first run builds the images (several minutes) and applies database
migrations before the API starts. Re-running `up` later is safe — migrations are
recorded, so an already-migrated database is left alone.

Check it:

```bash
curl -f http://127.0.0.1:8099/healthz && echo OK
```

Then open `PUBLIC_BASE_URL` and sign in with GitHub.

Only the web container publishes a port, and it binds to `127.0.0.1` by default
so nothing is exposed before you have put TLS in front of it. Postgres and Redis
are reachable only on the internal network. To expose the web port on a LAN
interface, set `REPOPULSE_BIND=0.0.0.0` — **after** your terminator is in place.

## 4. Select repositories

Sign in, go to **Admin → Connections**, and connect the organisation your App is
installed on. Then choose which repositories to track — nothing is ingested
until you do. Backfill starts immediately; the Org Overview shows per-repo
progress while it runs and fills in as history lands.

**Admin → Setup** lists what is still outstanding: configuration problems, a
missing connection, no repositories selected, and whether any webhook delivery
has arrived yet. It reports whether each variable is *set*, never its value.

### Webhooks

Webhook deliveries are how RepoPulse notices a push without polling. Until your
first push after connecting, "no delivery yet" is expected — it is not evidence
the webhook is wrong, and not evidence it is right. After a push, the setup
screen shows the timestamp of the most recent delivery. If nothing arrives:

- your forge must be able to reach `PUBLIC_BASE_URL` (a private install behind
  a firewall cannot receive them; ingestion still works on the reconcile cron),
- the webhook secret must match `WEBHOOK_SECRET` exactly,
- deliveries with a bad signature are rejected and logged, not silently dropped.

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
