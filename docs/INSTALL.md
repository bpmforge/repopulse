# Installing RepoPulse in your own environment

RepoPulse runs as five containers on one host: a web front end, an API, a
background worker, PostgreSQL and Redis. It reads your repositories through the
forge's API and **never clones them** — nothing of your source is stored beyond
the metrics and findings you see in the dashboard.

**You do not need an account with GitHub, or with us, to install this.** You
fill in a file, start the stack, and sign in with an administrator account this
install creates for you. Connecting a forge is a later step, done from inside
the product by someone who is already signed in — and until you do it, the
product runs, it just has nothing to measure yet.

## What you need

- A container runtime: Podman 5+ or Docker 24+, with the `compose` subcommand
- ~4 GB of disk for images, plus room for your warehouse (a few hundred MB for
  most orgs)
- A hostname you will reach this install at, and a TLS terminator in front of it
  (nginx, Caddy, Traefik, a cloud load balancer — RepoPulse does not terminate
  TLS itself)

Later, when you want repository data, you will also need an account on your
forge that can register a GitHub App or mint a Gitea token — see
[Connect your forge](#connect-your-forge). Nothing before that step requires it.

An LLM is **optional**. Tier-1 metrics — health scores, hotspots, PR cycle time,
review coverage, CI trends, DORA — need no model at all. Tiers 2 and 3 are
opt-in and point at your own LM Studio host or your own Anthropic API key.

## Configure

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

Add the first administrator. These two lines are what let you in the first
time; without them — and with no other account — a fresh install has no door:

```bash
ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD=<at least 12 characters>
```

The API creates that account on its first boot and marks it **must change
password**, so the value above is a one-use credential, not a standing one. A
password shorter than the minimum fails the boot rather than creating a weak
administrator. The bootstrap is idempotent on "a local account with a password
exists", so editing `ADMIN_EMAIL` afterwards creates nothing — add further
people from **Admin → Members** instead.

> **Back up `TOKEN_ENC_KEY` separately from your database dump.** It decrypts the
> forge credentials stored in Postgres. A dump without the key is unusable; the
> key without a dump is harmless. Losing it means every connected organisation
> must be re-authorised.

Every variable is documented in [CONFIG.md](CONFIG.md) — purpose, default, and
what breaks if it is wrong. Wrong or missing configuration fails at startup with
a message naming each variable; the API will not half-boot.

`GITHUB_APP_*` and the `OIDC_*` group are **not** required and can stay blank.
Each one you fill in adds a way to sign in; leaving them all blank leaves
password accounts, which is a complete configuration, not a degraded one.

## Start

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

Only the web container publishes a port, and it binds to `127.0.0.1` by default
so nothing is exposed before you have put TLS in front of it. Postgres and Redis
are reachable only on the internal network. To expose the web port on a LAN
interface, set `REPOPULSE_BIND=0.0.0.0` — **after** your terminator is in place.

## Sign in

Open `PUBLIC_BASE_URL`. The sign-in screen offers exactly the doors this
deployment configured — that is why it is worth looking at rather than
guessing: with nothing but the two `ADMIN_*` lines you get an email and
password form, and nothing else.

Sign in as `ADMIN_EMAIL`. You are asked to set a new password before anything
else is reachable, because the one in `deploy/.env` has been sitting in a file
on disk since you typed it. Once that is done, remove `ADMIN_PASSWORD` from
`deploy/.env`: it is inert — the bootstrap never overwrites a password that has
been changed — but a live credential in a file is a live credential.

You are now an administrator of a working install with no data in it. **Admin →
Setup** lists what is outstanding; the forge rows on it are what stands between
you and real numbers, not between you and a usable product.

The other two doors, if you want them:

- **Single sign-on (OIDC).** Set the `OIDC_*` group in `deploy/.env` and
  restart. RepoPulse offers your IdP as a button; a half-configured group fails
  the boot on purpose, because the alternative is discovering it at the
  callback, after someone has already authenticated.
- **GitHub sign-in.** Comes with registering a GitHub App, below. It lets people
  sign in with their forge account instead of a password — and, because the
  account then carries a forge identity, personalized screens ("my open PRs")
  can find their work without anyone linking it by hand.

## Connect your forge

RepoPulse authenticates as **your** App against **your** organisation. There is
no shared RepoPulse App and no RepoPulse-hosted anything: your source, your
tokens and your findings never leave your install.

You do this from **Admin → Connections**, signed in as the administrator you
just created.

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
then **Install App** on the organisation and choose the repositories. Filling in
`GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` also turns on GitHub
sign-in, which is why the button appears after this restart and not before.

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

### Connecting without the web UI

**Admin → Connections** is reachable with the administrator account above, so
this is no longer the only way to connect a forge on a fresh install. It stays
because two things still want it: scripting an install that is built rather than
clicked, and a bootstrap host that cannot receive webhook deliveries at all, for
which the browser flow's webhook registration would only fail.

```bash
# --dry-run first: connects, lists what the token can see, selects nothing
FORGE_TOKEN=<your token> pnpm connect:forge \
  --provider gitea --base-url https://git.example.com --dry-run

# then select everything it found, or name repositories explicitly
FORGE_TOKEN=<your token> pnpm connect:forge \
  --provider gitea --base-url https://git.example.com --all
```

**The token is read from the environment, never from an argument** — an
argument is visible in your shell history and in `ps` output for every user on
the machine. It is encrypted with `TOKEN_ENC_KEY` through the same code path the
API uses, and the command prints its fingerprint, never the token.

A rejected credential is reported by name — `bad_token`, `bad_scope` or
`no_repos` — rather than as a stack trace, so you can tell "wrong token" from
"right token, wrong scopes" from "this account can see nothing".

Backfill is enqueued for each selected repository; the worker drains it.
Webhook registration is skipped in this path and the nightly reconcile covers
the gap.

## Select repositories

In **Admin → Connections**, connect the organisation your App is installed on.
Then choose which repositories to track — nothing is ingested until you do.
Backfill starts immediately; the Org Overview shows per-repo progress while it
runs and fills in as history lands.

**Admin → Setup** lists what is still outstanding: which sign-in methods are
live, configuration problems, whether a forge is connected, whether any
repositories are selected, and whether any webhook delivery has arrived yet. It
reports whether each variable is *set*, never its value.

### Webhooks

Webhook deliveries are how RepoPulse notices a push without polling. Until your
first push after connecting, "no delivery yet" is expected — it is not evidence
the webhook is wrong, and not evidence it is right. After a push, the setup
screen shows the timestamp of the most recent delivery. If nothing arrives:

- your forge must be able to reach `PUBLIC_BASE_URL` (a private install behind
  a firewall cannot receive them; ingestion still works on the reconcile cron),
- the webhook secret must match `WEBHOOK_SECRET` exactly,
- deliveries with a bad signature are rejected and logged, not silently dropped.

## Scan data

Security and code scanning run in a container with **no network at all**. That
is the control, not an inconvenience: a binary pointed at your source cannot
phone anywhere. The consequence is that everything those tools need — our
rulepacks and a vulnerability database — has to be put in front of them from
outside, which is what `deploy/scan-db-sync.sh` does.

Run it once now, then nightly:

```bash
deploy/scan-db-sync.sh
# then, in root's crontab:
0 3 * * * /opt/repopulse/deploy/scan-db-sync.sh >> /var/log/repopulse-scan-sync.log 2>&1
```

> **Provision 5 GB of disk under `SCAN_RULES_DIR`.** The vulnerability database
> is **~1.9 GiB**, and a refresh stages the new copy beside the live one before
> swapping them by rename, so a sync briefly holds two — which a 4 GB volume
> cannot do. The first run downloads all of it and takes a minute or two on a
> fast connection. The script checks free space first and refuses to start if
> there is not enough, rather than filling the disk your database is on at three
> in the morning.

The database is downloaded from Anchore by *your* install rather than shipped
inside our image, because it aggregates 26 upstream feeds (NVD, GitHub
Advisories, CISA KEV, EPSS, and the distributions) that are each licensed on
their own terms and are not ours to redistribute. You get CISA KEV and EPSS
scores as part of it — no extra feed, no API key, no account.

The host doing the sync needs outbound HTTPS to `grype.anchore.io`. It does
**not** need any scanner installed: the fetch runs inside the RepoPulse scan
image using the same pinned binary that will later read the database, so the
two can never disagree about its format. If your egress is filtered, that one
hostname is the only thing to allow — and it is allowed for the *host*, never
for the scan container.

**If you skip this step**, dependency scanning does not fail — it reports
nothing. A repository with no findings then looks exactly like a repository
that is clean, which is the one failure mode worth going out of your way to
avoid. `SCAN_SYNC_VULN_DB=0` turns the download off deliberately; the script
says so on every run when it is set.

Check what the scanners can currently see:

```bash
ls "$SCAN_RULES_DIR"                 # expect: rulepacks  rulepacks.sha256  vuln-db
podman run --rm --network=none -v "$SCAN_RULES_DIR/vuln-db:/vuln-db:ro" \
  localhost/repopulse/scan:dev grype db status
```

`Status: valid` with a `Built:` timestamp from your last sync means the offline
database is readable exactly as the scanner will read it. A build date that
stops moving means your cron entry is not running — and stale vulnerability
data is quietly wrong rather than loudly broken, so it is worth an alert.

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

**The sign-in screen offers no password form.** It should always offer one, so
this means the browser could not read the API's list of providers — check that
the web container is reaching the API (`API_UPSTREAM`) before looking at
anything to do with authentication.

**"Invalid email or password" for `ADMIN_EMAIL`.** The account is created on the
API's first boot, so it does not exist if that boot failed or if a local account
with a password already existed when you added the variables. `podman logs` on
the api container prints the bootstrap outcome on every start. Setting
`ADMIN_EMAIL` to a second address later does *not* create a second admin.

**GitHub sign-in redirects then fails.** The Callback URL on your GitHub App
must match `<API_BASE_URL>/auth/callback` exactly, including scheme and port.
Password and OIDC sign-in are unaffected, so this is not a reason to be locked
out — sign in with your administrator account and fix the App.
