# Installing RepoPulse in your own environment

RepoPulse runs as six long-running containers on one host — web, API,
background worker, a scan-runner sidecar, PostgreSQL and Redis — plus a
one-shot migration job that runs before the API starts. It reads your
repositories through the forge's API and **never clones them**: nothing of your
source is stored beyond the metrics and findings you see in the dashboard.

**You do not need an account with GitHub, or with us, to install this.** You
run one script, sign in with the administrator account that script creates,
and connect a forge later from inside the product. Until you do, the product
runs; it just has nothing to measure yet.

Every command in this document was run on **linux/arm64 under rootless Podman
5.8** (`podman-compose` 1.6). Docker and amd64 hosts are untested — the
scripts carry Docker code paths, but nothing has run on one. Substitute
`docker` for `podman` at your own risk and tell us what happened.

## What you need

- A container runtime: Podman 5+ with `podman-compose`, or Docker 24+ with the
  compose plugin
- About 4 GB of disk for images, plus room for your warehouse (a few hundred MB
  for most organisations), plus 5 GB under the scan-data directory if you want
  dependency (CVE) scanning
- A hostname you will reach this install at, and a TLS terminator in front of
  it (nginx, Caddy, Traefik, a cloud load balancer — RepoPulse does not
  terminate TLS itself)

Later, when you want repository data, you will also need an account on your
forge that can register a GitHub App or mint a Gitea or GitLab token — see
[Connect your forge](#connect-your-forge). Nothing before that step requires it.

An LLM is **optional**. Tier-1 metrics — health scores, hotspots, PR cycle
time, review coverage, CI trends, delivery cadence — need no model at all.
Tiers 2 and 3 are configured later from **Admin → Models** and point at your
own OpenAI-compatible endpoint (LM Studio, for example) or your own hosted API
key.

## Install from the bundle

This is the customer path. The bundle is a directory of images and scripts
that needs **a container runtime and nothing else**: no source checkout, no
Node, no registry access, no network at install time. There is one bundle per
CPU architecture, and `install.sh` refuses to load one onto another.

Bundles are **not published anywhere yet**. There is no download URL and no
registry; a bundle is built with `deploy/bundle.sh` from a checkout and handed
to you as a `.tar.gz` with a `.sha256` beside it.

```bash
shasum -a 256 -c repopulse-<version>-linux-<arch>.tar.gz.sha256   # or: sha256sum -c
tar -xzf repopulse-<version>-linux-<arch>.tar.gz
cd repopulse-<version>-linux-<arch>
ADMIN_PASSWORD='a long passphrase' ./install.sh --url=https://repopulse.example.com --admin-email=you@example.com
```

`install.sh` does five things and stops with a sentence when any of them fails:

1. verifies every file against `SHA256SUMS` — a truncated or altered copy is
   refused before anything is loaded (`CHECKSUM MISMATCH`);
2. checks the CPU architecture against `VERSION` (`ARCHITECTURE MISMATCH`);
3. loads the images as `localhost/repopulse/<name>:<version>` and confirms
   each one is present — `localhost/` is the runtime's name for "loaded
   here", not a registry;
4. writes `deploy/.env` **once**, with every secret generated, the URL you gave,
   and the version pinned. A rerun never rewrites it;
5. starts the stack with `deploy/up.sh`, which waits for each service and
   **exits non-zero naming any that did not come up**. A loading page is not
   proof: the web tier answers while the worker is dead, which is why the
   script checks.

The administrator password comes from `ADMIN_PASSWORD` in the environment or a
`deploy/admin-password` file, never from an argument, so it does not land in
shell history. It must be at least 12 characters; a shorter one fails the boot
rather than creating a weak administrator.

`--url=` is the address your users will open, and it must match the callback
you later register on your GitHub App. `--port=` (default `8099`) is the one
port the stack publishes, bound to `127.0.0.1` until you set
`REPOPULSE_BIND=0.0.0.0` in `deploy/.env` **after** your TLS terminator is in
place. Nothing else — not Postgres, not Redis — is reachable from outside the
compose network.

Check it:

```bash
curl -f http://127.0.0.1:8099/healthz && echo OK
```

Then open the URL. The rest of this document applies from here on, whichever
way you installed.

Day to day, from the bundle directory:

```bash
deploy/up.sh                                   # start (or restart) and verify; safe to rerun
podman compose -f deploy/compose.yaml down     # stop; data stays in the volumes
deploy/backup.sh                               # dump the database beside a manifest
deploy/scan-db-sync.sh                         # refresh scan rules + fetch the CVE database
```

Data lives in two named volumes, `repopulse_pgdata` and `repopulse_redisdata`.
`down` keeps them; only `down -v` deletes them. Upgrading, rolling back and
restoring are in [RUNBOOK.md](RUNBOOK.md).

## Install from a checkout

The same stack, built on the host. Use this when you are evaluating from the
source repository rather than a bundle. It needs the runtime, `git`, and about
ten minutes for the first image build.

```bash
git clone <this repository> repopulse && cd repopulse
ADMIN_PASSWORD='a long passphrase' deploy/configure.sh --url=https://repopulse.example.com --admin-email=you@example.com
deploy/up.sh --build
curl -f http://127.0.0.1:8099/healthz && echo OK
```

`configure.sh` writes `deploy/.env` exactly as `install.sh` does — every secret
generated, mode `0600`, never rewritten on a rerun — and needs no Node on the
host: when Node is absent it runs inside the migration image with no network.
`deploy/.env.example` documents every line it writes and is the file to read
before editing anything by hand.

Use `deploy/up.sh`, not `compose up` directly. A bare `compose up` returned
success while leaving the worker dead (its bind-mount source did not exist),
and the web tier answered 200 either way. `up.sh` creates the scan-data
directory, verifies the stack afterwards, and on a failed migration stops the
application containers itself rather than letting them run against a schema
they do not understand.

## Configuration you may want to change

Everything is in `deploy/.env`, and every variable is documented in
[CONFIG.md](CONFIG.md) — purpose, default, and what breaks if it is wrong.
Wrong or missing configuration fails at startup with a message naming each
variable; the API will not half-boot.

Three things are worth knowing on day one:

- **Back up `TOKEN_ENC_KEY` separately from your database dump.** It decrypts
  the forge credentials stored in Postgres. A dump without the key is unusable;
  the key without a dump is harmless. Losing it means every connected
  organisation must be re-authorised.
- **`GITHUB_APP_*` and the `OIDC_*` group can stay blank.** Each one you fill
  in adds a way to sign in; leaving them blank leaves password accounts, which
  is a complete configuration, not a degraded one.
- **Remove `ADMIN_PASSWORD` after your first sign-in.** The bootstrap never
  overwrites a password that has been changed, so the line is inert, but a
  live credential in a file is a live credential.

## Sign in

Open the URL you gave `install.sh`. The sign-in screen offers exactly the
doors this deployment configured: with nothing but the admin account you get an
email and password form, and nothing else.

Sign in as `ADMIN_EMAIL`. You are asked to set a new password before anything
else is reachable, because the one you typed has been sitting in a file on disk
since then. You are now an administrator of a working install with no data in
it. **Admin → Setup** lists what is outstanding: which sign-in methods are live,
configuration problems, whether a forge is connected, whether any repositories
are selected, and whether any webhook delivery has arrived. It reports whether
each variable is *set*, never its value.

Add further people from **Admin → Members**. The bootstrap is idempotent on "a
local account with a password exists", so editing `ADMIN_EMAIL` afterwards
creates nothing.

The other two doors, if you want them:

- **Single sign-on (OIDC).** Set the `OIDC_*` group in `deploy/.env` and
  restart the stack. RepoPulse offers your identity provider as a button; a
  half-configured group fails the boot on purpose, because the alternative is
  discovering it at the callback, after someone has already authenticated. No
  real identity provider was connected in this release's evidence; the callback
  and the refusal are unit-tested.
- **GitHub sign-in.** Comes with registering a GitHub App, below. It lets
  people sign in with their forge account instead of a password, and because
  the account then carries a forge identity, personalised screens ("my open
  PRs") can find their work without anyone linking it by hand.

## Connect your forge

RepoPulse authenticates as **your** App or token against **your**
organisation. There is no shared RepoPulse App and nothing hosted by us: your
source, your tokens and your findings never leave your install.

You do this from **Admin → Connections**, signed in as the administrator you
just created. The form takes three things: the forge kind (GitHub, GitLab or
Gitea), a base URL for a self-hosted instance (blank for github.com), and an
**access token**. Each connection has its own base URL, so one install can
watch more than one forge. The token is encrypted at rest with
`TOKEN_ENC_KEY` before it is stored, and the screen shows only its fingerprint
afterwards.

A rejected credential is reported by name — `bad_token`, `bad_scope` or
`no_repos` — so you can tell "wrong token" from "right token, wrong scopes"
from "this account can see nothing". The recorded journey exercised the
rejected case before the accepted one.

In this release's evidence the whole connect-and-backfill path was run in a
browser against a **fixture forge** that answers the real client code. The
run against `api.github.com` is a separate credentialed test that was
**blocked** on the evidence host for want of a token, and no real Gitea or
GitLab instance was connected. What follows is what the code does; it has not
been proven against your forge by us.

**Read-only, every scope.** RepoPulse never writes to your repositories. It
opens no branches, pushes no commits, comments on no pull requests, and
**never clones** — analysis reads an API tarball into an ephemeral scratch
directory that is deleted after the scan. If a scope with write access seems
to be needed, something is wrong.

| Forge | Token | Scopes |
|---|---|---|
| GitHub | a classic personal access token, or a fine-grained token with read access to the repositories | `repo` (read), `read:org` |
| GitLab | a personal access token | `read_api` |
| Gitea | **Settings → Applications → Generate New Token** | `read:repository`, `read:organization`, `read:user` |

A self-hosted forge over plain `http://` is rejected unless it is a loopback
address and `FORGE_ALLOW_INSECURE_LOOPBACK` is set — a development escape
hatch, not a deployment option.

### A forge with an internal-CA certificate

If your Gitea, GitLab or GitHub Enterprise serves a certificate signed by your
own CA, the connection fails with a TLS error such as `unable to verify the first
certificate` or `unable to get local issuer certificate`. Do not turn verification off; add your CA instead. The
`api` and `worker` containers mount `deploy/ca` (or `EXTRA_CA_DIR`, which must
be absolute) read-only at `/etc/repopulse/ca`, and Node adds any PEM named by
`NODE_EXTRA_CA_CERTS` to its built-in roots:

```sh
cp internal-ca.pem deploy/ca/ && chmod 644 deploy/ca/internal-ca.pem
echo 'NODE_EXTRA_CA_CERTS=/etc/repopulse/ca/internal-ca.pem' >> deploy/.env
./deploy/up.sh    # api and worker read the file only at startup
```

A bundle with several CAs is fine — concatenate them into one PEM. Left unset,
nothing changes. A path that does not exist inside the container is only a
startup warning from Node, so if the TLS error persists, check the api log for
`Warning: Ignoring extra certs`. Outside containers (the dev harness), set
`NODE_EXTRA_CA_CERTS` to the host path.

### The GitHub App variables are for sign-in, not for data

`GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET` in `deploy/.env` add a
**Sign in with GitHub** button; they do not connect anything. Register an App
(or an OAuth App) under **Settings → Developer settings** with
Callback URL `<API_BASE_URL>/auth/callback`, copy the client id and secret in,
and restart the stack. Leave them blank and nothing is lost but the button.
`GITHUB_APP_ID` is accepted and stored; installation-token flows are not part
of this release, and a private key variable is read by nothing, so do not put
one in the file.

### Connecting without the web UI

For an install that is scripted rather than clicked, from a **checkout** (the
CLI is not in the bundle):

```bash
# --dry-run first: connects, lists what the token can see, selects nothing
FORGE_TOKEN=<your token> pnpm connect:forge \
  --provider gitea --base-url https://git.example.com --dry-run

# then select everything it found, or name repositories with --repos
FORGE_TOKEN=<your token> pnpm connect:forge \
  --provider gitea --base-url https://git.example.com --all
```

**The token is read from the environment, never from an argument** — an
argument is visible in your shell history and in `ps` output for every user on
the machine. It is encrypted with `TOKEN_ENC_KEY` through the same code path the
API uses, and the command prints its fingerprint, never the token. A rejected
credential is reported by name — `bad_token`, `bad_scope` or `no_repos` —
rather than as a stack trace. Backfill is enqueued for each selected
repository; the worker drains it. Webhook registration is skipped in this path
and the nightly reconcile covers the gap.

## Select repositories

In **Admin → Connections**, connect the organisation, then choose which
repositories to track — nothing is ingested until you do. Backfill starts
immediately; **Admin → Sync** shows per-repository progress while it runs, and
the screens fill in as history lands. In the recorded journey three
repositories went from selected to `live` and every screen showed that run's
data.

### Webhooks

Webhook deliveries are how RepoPulse notices a push without polling. Until
your first push after connecting, "no delivery yet" is expected — it is not
evidence the webhook is wrong, and not evidence it is right. After a push,
**Admin → Setup** shows the timestamp of the most recent delivery. If nothing
arrives:

- your forge must be able to reach `PUBLIC_BASE_URL` (a private install behind
  a firewall cannot receive them; ingestion still works on the nightly
  reconcile),
- the token must be allowed to manage hooks on the repository, or the
  registration is skipped and recorded,
- deliveries with a bad signature are rejected with 401 and logged, not
  silently dropped.

You do not configure the webhook by hand. When you connect, RepoPulse
registers a hook on each selected repository with a secret it generates for
that connection and stores encrypted; the receiver is
`<PUBLIC_BASE_URL>/api/v1/webhooks/github`, and it verifies GitHub's signature
format. The `WEBHOOK_SECRET` line that `install.sh` writes into `deploy/.env`
is not read by this release and can be ignored. RepoPulse asks Gitea and
GitLab to register a hook too, but their deliveries were not exercised in this
release's evidence; treat the nightly reconcile as the freshness mechanism for
those forges.

## Scan data

Security and code scanning run in a container with **no network at all**. That
is the control, not an inconvenience: a binary pointed at your source cannot
phone anywhere. The consequence is that everything those tools need — our
rulepacks and a vulnerability database — has to be put in front of them from
outside, which is what `deploy/scan-db-sync.sh` does.

Run it once now, then nightly:

```bash
deploy/scan-db-sync.sh
# then, in root's crontab (adjust the path to your bundle directory):
0 3 * * * /opt/repopulse/deploy/scan-db-sync.sh >> /var/log/repopulse-scan-sync.log 2>&1
```

> **Provision 5 GB of disk under the scan-data directory** (`deploy/scan-rules`
> beside the compose file unless you set `SCAN_RULES_DIR`). The vulnerability
> database is **about 1.9 GiB**, and a refresh stages the new copy beside the
> live one before swapping them by rename, so a sync briefly holds two — which
> a 4 GB volume cannot do. The script checks free space first and refuses to
> start if there is not enough, rather than filling the disk your database is
> on at three in the morning.

The database is downloaded from Anchore by *your* install rather than shipped
inside our image, because it aggregates 26 upstream feeds (NVD, GitHub
Advisories, CISA KEV, EPSS, and the distributions) that are each licensed on
their own terms and are not ours to redistribute. The host doing the sync needs
outbound HTTPS to `grype.anchore.io` and nothing else; it does **not** need any
scanner installed, because the fetch runs inside the RepoPulse scan image using
the same pinned binary that will later read the database.

**If you skip this step**, dependency scanning does not fail — it reports
itself unavailable on the repository's Security tab, naming this script. That
is deliberate: a repository with no findings must not look like a repository
that is clean. `SCAN_SYNC_VULN_DB=0` turns the download off knowingly; the
script says so on every run when it is set.

Check what the scanners can currently see:

```bash
ls deploy/scan-rules                 # expect: rulepacks  rulepacks.sha256  vuln-db
```

In the recorded journey the CVE scanner first reported `no vulnerability
database ... run deploy/scan-db-sync.sh`, and after the database was attached
it ran and reported its tool versions. A build date that stops moving means
your cron entry is not running — and stale vulnerability data is quietly wrong
rather than loudly broken, so it is worth an alert.

## Put TLS in front

RepoPulse publishes one plain-HTTP port. Your terminator should:

- forward `/` to that port, including `/api/` and the server-sent events stream
  at `/api/v1/events` (buffering off, long read timeout);
- expose `POST /api/v1/webhooks/github` on the public vhost if your forge is on
  the internet, and everything else only where your users are — the webhook
  handler authenticates every delivery by signature and does nothing but verify
  and enqueue, so the worst case for an attacker is a rejected 401;
- set `REPOPULSE_BIND=0.0.0.0` in `deploy/.env` only once that is in place, and
  `NODE_ENV=production` (the default the scripts write) so session cookies carry
  the Secure flag.

[DEPLOYMENT.md](DEPLOYMENT.md) has the topology, ports and monitoring detail.

## Troubleshooting

**`CHECKSUM MISMATCH`** — the tarball was truncated or altered in transit.
Re-copy it and check `.tar.gz.sha256` before extracting. Nothing was loaded.

**`IMAGES NOT LOADED`** from `up.sh` — `deploy/.env` pins a version whose
images are not present. Run `./install.sh` again; it reloads them
idempotently. Nothing was started.

**`STACK IS NOT HEALTHY`** — `up.sh` names the services that did not come up
and prints the `logs` command. `scan-runner` not running on Linux almost
always means the Podman API socket is not enabled:
`systemctl --user enable --now podman.socket`.

**`DATABASE MIGRATION FAILED`** — the schema was not applied and the
application containers were stopped on purpose. The log command it prints has
the reason. The common one on a reused host is a `repopulse_pgdata` volume left
by an earlier install under a different password: `up.sh` says so, and the two
ways out are restoring the matching `deploy/.env` or removing the volume
knowingly.

**Everything is stuck in `Created`.** Something with a health check is not
healthy yet — usually Postgres or Redis. `podman ps -a` shows which;
`podman logs <container>` says why.

**The sign-in screen offers no password form.** It should always offer one, so
this means the browser could not read the API's list of providers — check that
the web container is reaching the API before looking at anything to do with
authentication. If you restarted only the `api` container, restart the whole
stack: `web` resolves the API address once at startup.

**"Invalid email or password" for `ADMIN_EMAIL`.** The account is created on
the API's first boot, so it does not exist if that boot failed or if a local
account with a password already existed when you added the variables. The API
log prints the bootstrap outcome on every start. Setting `ADMIN_EMAIL` to a
second address later does *not* create a second admin.

**GitHub sign-in redirects then fails.** The Callback URL on your GitHub App
must match `<API_BASE_URL>/auth/callback` exactly, including scheme and port.
Password and OIDC sign-in are unaffected, so this is not a reason to be locked
out — sign in with your administrator account and fix the App.

**Scans report "unavailable".** The `scan-runner` service cannot reach the
runtime socket, or the scan image is missing; `podman logs` on it says which.
A scanner that reads **"(not in this build)"** is a different thing: there is
no code for it in this release, and no tool you can install will change that.
