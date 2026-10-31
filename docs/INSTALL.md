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

What has actually been run, all on **linux/arm64**:

- **Install from a checkout**, followed literally from a fresh VM
  (2026-10-31), on **Ubuntu 26.04 LTS with its own rootless Podman 5.7**
  (`podman-compose` 1.5) and on **Ubuntu 24.04 LTS with its own Docker 29**
  (`docker.io`, `docker-compose-v2`, `docker-buildx`): sign-in, a report PDF
  and the scan-data sync all worked on both.
- The bundle and everything else in this document, under **rootless Podman
  5.8** (`podman-compose` 1.6) in the Linux VM that `podman machine` runs on a
  Mac (see [Install on a Mac](#install-on-a-mac)).

An **amd64** bundle has been built and installed only under emulation on an
arm64 host (2026-09-23; see `ARCHITECTURES.md` in the bundle for exactly what
ran), never on real amd64 hardware. The bundle path has not been run under
Docker.

## What you need

- A container runtime, one of:
  - **Podman 5 or newer with `podman-compose` 1.5 or newer.** These are hard
    floors, and `deploy/up.sh` refuses anything older with a sentence. On
    Podman 4 the services that wait for the database migration never start.
    Older `podman-compose` lets blank lines in `deploy/.env` override the
    paths `up.sh` sets, and prints every password it passes to a container
    in its output. **Ubuntu 24.04's own packages (Podman 4.9.3,
    podman-compose 1.0.6) do not qualify**; Ubuntu 26.04 LTS's (5.7 / 1.5) do.
    Rootless Podman also needs its API socket, which a fresh Linux host does
    not enable. The scan-runner uses it to start scans:

    ```bash
    systemctl --user enable --now podman.socket
    ```

  - **Docker 24 or newer with the compose plugin and buildx** (the images use
    BuildKit; Ubuntu's `docker.io` comes without it):

    ```bash
    sudo apt-get install docker.io docker-compose-v2 docker-buildx   # Ubuntu/Debian
    sudo usermod -aG docker "$(id -un)"   # then log out and back in: the group
                                          # only applies to new login sessions
    ```

    With both runtimes installed, set `RUNTIME=docker` (or `podman`) for every
    `deploy/` script; otherwise they pick Podman.
- About 4 GB of disk for images, plus room for your warehouse (a few hundred MB
  for most organizations), plus **8 GB** under the scan-data directory if you
  want dependency (CVE) scanning (see [Scan data](#scan-data))
- Memory for six containers: plan on 4 GB free for the stack, more while
  scans run (a starting figure, not a measured minimum)
- A hostname you will reach this install at, and a TLS terminator in front of
  it (nginx, Caddy, Traefik, a cloud load balancer — RepoPulse does not
  terminate TLS itself)

Later, when you want repository data, you will also need an account on your
forge that can register a GitHub App or mint a Gitea or GitLab token — see
[Connect your forge](#connect-your-forge). Nothing before that step requires it.

An LLM is **optional**. Tier-1 metrics — health scores, hotspots, PR cycle
time, review coverage, CI trends, delivery cadence — need no model at all.
Tiers 2 and 3 are configured later from **Settings → Models** and point at your
own OpenAI-compatible endpoint (LM Studio, for example) or your own hosted API
key.

## Install from the bundle

This is the customer path. The bundle is a directory of images and scripts
that needs **a container runtime and nothing else**: no source checkout, no
Node, no registry access, no network at install time. There is one bundle per
CPU architecture, and `install.sh` refuses to load one onto another.

Bundles are **not published anywhere yet**, and v1 ships as a bundle only:
publishing images to a registry is deliberately deferred past v1. There is no
download URL and no registry; a bundle is built with `deploy/bundle.sh` from a checkout and handed
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
rather than creating a weak administrator. `configure.sh` deletes the
`deploy/admin-password` file once `.env` holds the password, so the plaintext
copy does not stay beside the bundle.

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
SMOKE_PASSWORD=… deploy/smoke-report-pdf.sh    # generate one report and download its PDF (see Check that reports work)
deploy/uninstall.sh                            # remove RepoPulse (webhooks first) — see Uninstall
```

### Start on boot

Compose marks every service `restart: unless-stopped`, but rootless Podman has
no daemon to do the restarting: after a reboot the stack stays down until
someone runs `deploy/up.sh`. Once, as the user who ran `install.sh`:

```bash
sudo loginctl enable-linger "$(id -un)"          # keep your user services running without a login
systemctl --user enable podman-restart.service   # start unless-stopped containers at boot
```

`deploy/up.sh` warns while lingering is off. On a Mac, the `podman machine` VM
has to be running first: `podman machine start` (or add it as a login item),
then `deploy/up.sh`.

Data lives in three named volumes: `repopulse_pgdata`, `repopulse_redisdata`,
and `repopulse_reportdata` (generated report PDFs and their data, written by the
worker and served by the api). `down` keeps them; only `down -v` deletes them.
`backup.sh` dumps the database only. A report whose files are gone still shows
in Reports with its parameters, and can be generated again. Upgrading, rolling back and
restoring are in [RUNBOOK.md](RUNBOOK.md).

## Install on a Mac

On macOS the containers run inside the Linux VM that `podman machine`
manages. Three things differ from a Linux host:

1. **Create and start the VM first**, with room for the stack and the scan
   data. The sizes are a starting point, not a measured minimum:

   ```sh
   podman machine init --cpus 4 --memory 8192 --disk-size 60
   podman machine start
   ```

2. **Keep everything under your home folder.** `podman machine` shares only
   `/Users` with the VM by default, so a bind mount from anywhere else (the
   `/opt/repopulse` examples in this document, say) fails and the worker
   never starts. Extract the bundle somewhere like `~/repopulse`, and if you
   set `SCAN_RULES_DIR` or `EXTRA_CA_DIR` in `deploy/.env`, point them under
   `/Users/<you>/` too (absolute paths, as everywhere).

3. **The socket warning from `up.sh` is expected.** The container socket lives
   inside the VM, so `up.sh` cannot see it from macOS and says so; `podman
   info` reports the VM's path and the scan-runner mounts that. It is only a
   problem if scans then fail to start.

Everything else (install, sign-in, connecting a forge, the cron line for
`deploy/scan-db-sync.sh`, with your own home path) is as below.

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
host: when Node is absent it runs inside the migration image with no network,
building that one image from the checkout first (under a minute). `up.sh
--build` then builds the rest, including the scanners' sandbox image
(`Containerfile.scan`, a few minutes the first time), which no compose service
builds on its own. The first `up.sh --build` took about four minutes in
total on a 4-CPU VM.
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

Four things are worth knowing on day one:

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
- **A sign-in ends after 15 minutes without activity, and after 12 hours in
  any case.** `SESSION_IDLE_MINUTES` and `SESSION_MAX_HOURS` change that; run
  `./deploy/up.sh` afterwards.

## Sign in

Open the URL you gave `install.sh`. The sign-in screen offers exactly the
doors this deployment configured: with nothing but the admin account you get an
email and password form, and nothing else.

Sign in as `ADMIN_EMAIL`. You are asked to set a new password before anything
else is reachable, because the one you typed has been sitting in a file on disk
since then. You are now an administrator of a working install with no data in
it. **Settings → Setup** lists what is outstanding: which sign-in methods are live,
configuration problems, whether a forge is connected, whether any repositories
are selected, and whether any webhook delivery has arrived. It reports whether
each variable is *set*, never its value.

Add further people from **Settings → Members**. Choose their role there
(member or admin); the result shows a one-time password once, and a ready-to-send
invite with the sign-in address (`PUBLIC_BASE_URL`) and their email. The invite
deliberately leaves the password out: send that separately, so a chat or mail
log never holds both. The bootstrap is idempotent on "a local account with a
password exists", so editing `ADMIN_EMAIL` afterwards creates nothing.

**`ADMIN_EMAIL` is required even if everyone will use single sign-on.** A first
OIDC or GitHub sign-in is never made administrator — an identity provider's
email is not proof of who owns this install — so without the password admin
nobody can connect a forge. `configure.sh` refuses to run without
`--admin-email`, and `up.sh` warns when SSO is set and `ADMIN_EMAIL` is not.
Sign in with the admin account, then promote people in Settings → Members.

A member who forgets their password is reset from Settings → Members; a
locked-out sole admin is reset from the host — RUNBOOK → *Routine care*.

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
  **github.com only.** The sign-in always talks to github.com, even when your
  data connection is a GitHub Enterprise Server (`FORGE_BASE_URL` does not
  move it). A GitHub Enterprise company signs people in with OIDC instead and
  links them to their forge identity as below.

**One account per sign-in method.** RepoPulse never joins accounts by email.
Someone who signs in with a password and later with OIDC or GitHub gets a
second, separate account (a federated account is keyed on the provider's
subject, not on an email the provider may not have verified). Pick one method
per person; if a duplicate appears, remove the one they do not use in
Settings → Members and link the remaining account to their forge identity in
Settings → Identities.

**Who can join through single sign-on.** By default, anyone your identity
provider accepts — and, with GitHub sign-in, anyone with any GitHub account —
becomes a member at their first sign-in. Restrict it in `deploy/.env` (W20-10):

- `SSO_ALLOWED_GITHUB_ORGS=acme,acme-labs` — GitHub sign-in admits only members
  of one of these organisations;
- `SSO_ALLOWED_OIDC_GROUPS=repopulse-users` — OIDC admits only someone whose
  ID token `groups` claim contains one of these (configure your IdP to send
  the claim);
- `SSO_ALLOWED_EMAIL_DOMAINS=example.com` — OIDC also admits a verified email
  in one of these domains.

The check runs at **every** sign-in, so taking someone out of the org or group
ends their access. That is also how to keep a removed member out: **Remove**
in Settings → Members deletes the account, and without an allowlist a
federated user simply signs in again. Refused sign-ins are written to the audit
log with the reason. Local accounts are not affected.

People who sign in with a password or OIDC have no forge account of their own,
so their personalised screens are empty until an admin links them:
**Settings → Identities → Link to member** on the committer that is them.

## Connect your forge

RepoPulse authenticates as **your** App or token against **your**
organisation. There is no shared RepoPulse App and nothing hosted by us: your
source, your tokens and your findings never leave your install.

You do this from **Settings → Connections**, signed in as the administrator you
just created. The form takes three things: the forge kind (GitHub, GitLab or
Gitea), a base URL for a self-hosted instance (blank for github.com), and an
**access token**. For GitHub Enterprise Server, type the server's address as
you open it in a browser (`https://ghe.example.com`): RepoPulse adds the
`/api/v3` API path itself, as it adds `/api/v1` for Gitea and `/api/v4` for
GitLab. An address that already ends in `/api/v3` is used as typed. Each connection has its own base URL, so one install can
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
**blocked** on the evidence host for want of a token at the time. A
throwaway Gitea 1.24.7 was connected on 2026-09-23 (discover → select →
backfill → live, commit counts matching Gitea's own); no GitLab instance has
been connected. Beyond that, what follows is what the code does; it has not
been proven against your forge by us.

**RepoPulse never writes to your code.** It opens no branches, pushes no
commits, comments on no pull requests, and **never clones** — analysis reads
an API tarball into an ephemeral scratch directory that is deleted after the
scan. The one thing it creates on the forge is a **push webhook** per selected
repository, for live updates, and on some forges that needs a write-level
scope: on Gitea it does (see the note under the table). Without it the
repository still backfills and goes live; it just gets no live updates.

| Forge | Token | Scopes |
|---|---|---|
| GitHub | a classic personal access token, or a fine-grained token with read access to the repositories | `repo` (read), `read:org` |
| GitLab | a personal access token | `read_api` |
| Gitea | **Settings → Applications → Generate New Token** | `read:repository`, `read:organization`, `read:user` |

> **Gitea, measured 2026-09-23 against Gitea 1.24.7:** with only the three read
> scopes above, repositories are discovered and backfilled, but registering the
> push webhook is refused (403) — the repository goes live with *"live updates
> unavailable — webhook registration failed"* — and the issues fetch is refused
> too. Creating a webhook is a write in Gitea: add `write:repository` (and
> `read:issue` for issues) if you want live updates. Any entity the forge
> refuses is named in **Settings → Sync** (for example *"issues not ingested —
> HTTP 403: token does not have at least one of required scope(s):
> [read:issue]"*) instead of looking like a repository with no issues; fix the
> token and the next sync clears it.

> **Optional on GitHub — code-scanning alerts.** To import the alerts GitHub
> code scanning already holds for a repository, the credential RepoPulse uses
> needs read access to them: a classic token's `repo` scope already includes it;
> a fine-grained token needs **Code scanning alerts: Read-only**; a GitHub App
> you registered yourself needs the same repository permission
> (`security_events: read`). It is read-only — never grant write. Without it
> nothing breaks: SARIF upload still works, and the nightly code-scanning pull
> is skipped with the reason shown in the scan result ("the token or GitHub App
> may not read code-scanning alerts") instead of importing zero alerts quietly.
> Grant it later and the next nightly pull picks it up.

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

### Behind an outbound proxy

If the server reaches the internet only through a corporate proxy, set it in
`deploy/.env` and restart (W20-10):

```sh
HTTPS_PROXY=http://proxy.corp.example:3128
# NO_PROXY blank keeps the compose default:
#   localhost,127.0.0.1,api,web,postgres,redis,scan-runner
# If you set it, keep those and add LAN hosts the proxy cannot reach:
NO_PROXY=localhost,127.0.0.1,api,web,postgres,redis,scan-runner,gitea.lan
```

The api and worker send every outbound call through it — the forge, tarball
downloads for scans, hosted models and your OIDC issuer. Node's `fetch`
ignores `HTTPS_PROXY` unless `NODE_USE_ENV_PROXY=1`, which the shipped compose
file sets for both services; a process started some other way logs a warning
at startup when a proxy is set without it. A proxy that re-signs TLS also
needs its CA added as in the section above. Without the proxy setting,
connecting a forge from such a server fails with a timeout ("cannot reach"),
not a bad-token error. `deploy/scan-db-sync.sh` passes `HTTPS_PROXY` and
`NO_PROXY` from `.env` to the containers that download the vulnerability
database, and, when `NODE_EXTRA_CA_CERTS` is set, mounts `EXTRA_CA_DIR` into
them and trusts that certificate as well, so a proxy that re-signs TLS works
for the scan data too. When a download fails it prints the container's own
error; with no way out at all, import the database from a file with
`SCAN_VULN_DB_ARCHIVE` (see [Scan data](#scan-data)).

### The GitHub App variables are for sign-in, not for data

`GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET` in `deploy/.env` add a
**Sign in with GitHub** button; they do not connect anything. Register an App
(or an OAuth App) under **Settings → Developer settings** with
Callback URL `<API_BASE_URL>/auth/callback`, copy the client id and secret in,
and restart the stack. Leave them blank and nothing is lost but the button.
Register it on **github.com**: GitHub Enterprise Server sign-in is not
supported (use OIDC for that).
`GITHUB_APP_ID` is accepted and stored; installation-token flows are not part
of this release, and a private key variable is read by nothing, so do not put
one in the file.

### Connecting without the web UI

For an install that is scripted rather than clicked, from a **checkout** (the
CLI is not in the bundle):

```bash
# --dry-run first: checks the token, lists every repository it can see, saves nothing
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

In **Settings → Connections**, connect the organisation, then choose which
repositories to track — nothing is ingested until you do. Backfill starts
immediately; **Settings → Sync** shows per-repository progress while it runs, and
the screens fill in as history lands. In the recorded journey three
repositories went from selected to `live` and every screen showed that run's
data.

**Track all and auto-add new** tracks every repository the token can see and
turns on *Auto-add* for that connection: repositories created on the forge
later are tracked by the nightly sync (archived ones are left for you to pick).
Turn it off with the connection row's **Auto-add** switch; that never
untracks anything. To stop tracking one repository, use **Pause** on it in
**Settings → Sync**: it makes no forge calls and keeps its history. Removing a
connection deletes the webhooks it registered on the forge first.

**Or track a public repository by name** (`owner/name`, under the list) tracks
a repository the token can read but does not list as its own, such as an
open-source project you know, to try RepoPulse on before your own code. It
backfills and scans like any other. The forge sends no webhook for a
repository you do not administer, so it updates on the nightly sync.

### Webhooks

Webhook deliveries are how RepoPulse notices a push without polling. Until
your first push after connecting, "no delivery yet" is expected — it is not
evidence the webhook is wrong, and not evidence it is right. After a push,
**Settings → Setup** shows the timestamp of the most recent delivery. If nothing
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
that connection and stores encrypted. There is no global `WEBHOOK_SECRET`
to set; an older `deploy/.env` that still has that line can keep it, nothing
reads it. Where the hook points depends on the forge:

| Forge | Receiver | How a delivery is authenticated |
|---|---|---|
| GitHub | `<PUBLIC_BASE_URL>/api/v1/webhooks/github` | `X-Hub-Signature-256` HMAC over the body |
| Gitea | `<PUBLIC_BASE_URL>/api/v1/webhooks/github` | the same header — Gitea sends GitHub-compatible headers alongside its own |
| GitLab | `<PUBLIC_BASE_URL>/api/v1/webhooks/gitlab` | `X-Gitlab-Token` (GitLab sends the secret itself, not a signature) |

Evidence, 2026-09-23 (W17-36): a live Gitea 1.24.7 hook created exactly the
way RepoPulse creates it delivered push, issues, pull_request and release
events with `X-GitHub-Event`, `X-GitHub-Delivery` and a valid
`X-Hub-Signature-256`; a captured delivery is replayed through the receiver
in the test suite. GitLab deliveries are tested against GitLab's documented
headers but have **not** been received from a live GitLab. On any forge the
nightly reconcile still repairs whatever a missed delivery left behind.

**Scheduled sync only.** If the forge cannot reach this install (a private
server behind a firewall, an internal `PUBLIC_BASE_URL`), tick **Scheduled
sync only (no webhooks)** when you connect, or switch it on later per
connection in Settings → Connections. RepoPulse then registers no hooks on
that connection's repositories, so the forge's admins do not see a growing
list of failed deliveries; switching it on removes the hooks it already
registered. The nightly reconcile keeps those repositories current, so
changes appear the next morning rather than within a minute. Switching it off
registers the hooks again.

**Removing a repository.** Settings → Sync offers **Pause** (stop syncing,
keep its history; the usual choice) and, for admins, **Remove and delete
history…**, which asks you to type the repository's `org/name`, removes its
webhook, and deletes everything stored about it. It cannot be undone. A
repository whose code was ever sent to an off-network model keeps its history:
that record is append-only.

## Connect a model (optional)

Open **Settings → Models → Set up a model**. It asks four things and says, at each
step, what leaves your network:

1. **Where does your model run?** On this machine or your network (nothing
   leaves your network); through a gateway you run (the gateway, and wherever it
   forwards, receives your diffs, pull-request descriptions and file paths); or
   a vendor's API with your own key (the vendor receives them, and every request
   is recorded in the egress audit).
2. **Connect and test it.** *Test connection* makes a real request and also
   probes the model: its context window, whether it streams, supports JSON mode
   and tool use. A model that cannot stream, or whose context window is under
   8192 tokens, is refused with a sentence rather than failing later inside a
   scheduled pass.
3. **Which kinds of analysis should use it?** It becomes the first choice for the
   roles you tick; what was already set up stays behind it as a fallback.
4. **What leaves your network, role by role.** A table per role: stays home, or
   leaves (and to which host). Tier-3 (the Claude API) is a separate per-repository
   opt-in and is always audited; the **Local only** switch in the Routing section
   blocks anything that would leave.

The full forms below the wizard stay available for editing, reordering a
role's fallbacks and removing connections. The *Quality per model* table shows
how each model did on labelled test cases, and says *not yet run* for any model
nobody has measured.

### Worked example 1: LM Studio on the same network

**Verified end to end** on 2026-10-18 by driving the wizard in a real browser
against a real LM Studio (qwen/qwen3.8-27b): the test, the probe, the save, the
role assignment and the review all passed (`e2e/models-lm-studio.spec.ts`, which
you can run yourself with `E2E_LM_STUDIO=1 E2E_LM_STUDIO_MODEL=<id>`).

1. In LM Studio, load a model and start the local server (in LM Studio's Developer
   tab, or `lms server start`, which is what was used for the check above). Note the model's exact id: `lms ls`, or
   `curl http://<machine>:1234/v1/models`. Prefer an **instruct or coder** model;
   a reasoning model works but each call takes tens of seconds to minutes.
2. In RepoPulse choose **On this machine or my network**, then the **LM Studio**
   preset (`http://localhost:1234/v1`).
3. **Use the machine's IP address, not `localhost`, if RepoPulse runs in a
   container** - inside a container `localhost` is the container itself. Write
   `http://192.168.1.50:1234/v1` with your machine's address. Host names are not
   accepted for a model on your network; only IP addresses are.
4. Type the model id exactly as LM Studio names it and press **Test connection**.
   Expect *Reached it.* and a capabilities line (context window, streaming,
   JSON mode, tool use). LM Studio rejects the plain `json_object` format and
   accepts `json_schema`; the probe knows and reports JSON mode as working.
5. **Save and continue**, tick the roles, **Save and review**. Each ticked role
   reads *Stays home.* Nothing was sent anywhere but your LM Studio.

### Worked example 2: a hosted API key (Gemini)

**Not verified with a real key.** No Gemini key was available when this was
written. What *was* checked: the request path is exercised by tests against a
faked endpoint, a Gemini connection with no base URL saves (a bug in exactly
this was found and fixed while writing this section), and the wizard refuses
to save a hosted connection until you confirm what will be sent. The first real
request will tell you the rest, and it will tell you plainly: *Test connection*
shows the vendor's own error text.

1. Create an API key in Google AI Studio.
2. In RepoPulse choose **A vendor's API, with my key**, then **Google Gemini
   (API key)**. There is no address to enter. Type a model id such as
   `gemini-2.5-flash` and paste the key (encrypted at rest, never shown again).
3. Tick *I understand diffs, pull-request descriptions and file paths will be
   sent to this vendor* - the **Save** button stays disabled until you do. This
   is a data-egress decision, so it is recorded with your name.
4. **Test connection**, then save and choose roles. The review table will say
   *Leaves* for those roles and name `generativelanguage.googleapis.com`; every
   request is recorded in **Settings → Analysis** (the egress audit). Hosted calls
   cost money on your account.

Other vendors (Anthropic, an OpenAI-compatible service, Vertex with a
service-account key, Bedrock) follow the same shape; Vertex takes its whole JSON
key file in the key field. Subscription logins (a Claude or ChatGPT plan) are
not an API key and are not part of this path.

### Use your own Claude Code CLI (customer-supplied, optional)

If you have a Claude plan and would rather use its Claude Code CLI than an API
key, RepoPulse can run **your** CLI as a model. This is a customer-supplied
option, not a RepoPulse feature: you install the CLI and sign in to it yourself,
**RepoPulse neither stores nor transmits the login**, and **API keys remain the
supported route**. The makers of RepoPulse have not verified that your plan's
terms allow this use; that responsibility is yours, which is why it is **off
until an admin reads and accepts a statement**, recorded with their name, the
time and the exact version of the statement.

1. In **Settings → Models**, choose *Claude Code CLI you installed
   (customer-supplied)*. The full statement is shown. Tick that you have read
   it and **Accept and turn on**. Anyone with admin rights can **Switch off**
   again; connections that use it then stop and say why.
2. Install the CLI where the worker can run it, and sign in. The optional
   `deploy/compose.claude-cli.yaml` (shipped in the bundle too) gives the worker
   **and the api** one persistent volume for the CLI and its login and sets
   `CLAUDE_CLI_PATH` (default: `claude` on the `PATH`). Start the stack with it
   **once** as `deploy/up.sh --with-claude-cli`: that records
   `COMPOSE_EXTRA_FILES=compose.claude-cli.yaml` in `deploy/.env`, so every
   later `deploy/up.sh` (a restart or an upgrade) keeps the overlay. Started
   without it, the containers are recreated without the volume and every CLI
   connection fails; **System health** then says the worker cannot find the
   CLI. Then, once, inside the worker container, install the CLI into that
   volume and run `claude` to complete the login yourself.
3. Add the connection (a model name such as `sonnet`; there is no key or address
   to enter). **Test connection** runs your CLI once. If the CLI is missing, or
   its login has expired, it says so in those words and nothing is sent.

How it is run: with **no tools** (it cannot run commands or read files), nothing
saved to disk, the code on standard input (never on the command line), in an empty
temporary directory, and with an environment that holds none of RepoPulse's
secrets. It counts as leaving your network: every call is in the egress audit,
the review table says so, and the **Local only** switch refuses it.

**What was and was not checked.** Checked: the runner against a real `claude`
binary (version, `auth status`, and a real call, which came back *"Failed to
authenticate: OAuth session expired and could not be refreshed"* because the
login on the machine used had expired - that exact message is the signed-out case
in the tests), and every other path against a faked CLI. **Not checked:** a
successful answer from a live CLI (the available login had expired and signing
in is yours to do, not ours), installing the CLI inside the worker image, and
the compose override. Note that `claude auth status` can report *logged in* while
the session has expired, so **Test connection** is the only proof. Settings →
Models shows two lines: what the **worker** found (it runs every pass, and checks
every ten minutes) and what the **api** found (it runs Test connection). The
overlay mounts the same volume into both, so they agree; if they do not, the
stack was started without the overlay.

**Removing it.** **Switch off** only withdraws the acceptance: RepoPulse stops
using the CLI, but it stays installed and signed in inside the worker's
`claude-cli` volume. To remove it as well:

1. Sign the CLI out, with its own sign-out command, run inside the worker
   (`docker compose exec worker /var/lib/claude-cli/npm/bin/claude …`). This
   ends the session at Anthropic's end too; deleting the volume alone only
   forgets it locally.
2. Remove `compose.claude-cli.yaml` from `COMPOSE_EXTRA_FILES` in `deploy/.env`
   (or the `-f deploy/compose.claude-cli.yaml` you start with by hand), then start
   RepoPulse again with `deploy/up.sh`.
3. Delete the volume, which holds the CLI and its login: `docker volume rm
   <project>_claude-cli` (`docker volume ls` shows the exact name).

### If it does not connect

- *not a private-range LAN address* - you gave a host name. Use the IP address.
- *Invalid model identifier* / HTTP 400 - the model id is not exactly what the
  server names. List it with `lms ls` or `/v1/models`.
- *Could not connect* with `ECONNREFUSED` - nothing is listening there: the
  server is not started, or `localhost` is the container (see step 3).
- *This server does not stream responses* - pick a model or server that
  supports `stream: true`; every analysis call is streamed.

## Scan data

Security and code scanning run in a container with **no network at all**. That
is the control, not an inconvenience: a binary pointed at your source cannot
phone anywhere. The consequence is that everything those tools need — our
rulepacks and a vulnerability database — has to be put in front of them from
outside, which is what `deploy/scan-db-sync.sh` does.

Run it once now, then nightly:

```bash
deploy/scan-db-sync.sh
# then, in the crontab of the user who ran install.sh — NOT root's
# (adjust the path to your bundle directory):
0 3 * * * /opt/repopulse/deploy/scan-db-sync.sh >> $HOME/repopulse-scan-sync.log 2>&1
```

Rootless Podman (the default, and the tested setup) gives every user their own
images and containers. A root cron job cannot see the scan image you loaded,
leaves root-owned files in the scan-data directory, and fails every night, so
the script refuses to run as root when `deploy/.env` belongs to another user
(`REPOPULSE_ALLOW_ROOT=1` overrides that for a deliberately rootful install).
The job also needs that user to linger — see *Start on boot*.

> **Provision 8 GB of disk under the scan-data directory** (`deploy/scan-rules`
> beside the compose file unless you set `SCAN_RULES_DIR`). The vulnerability
> database was **about 3.2 GiB** on 2026-10-31 (it was 1.9 GiB a month earlier,
> and it grows), and a refresh stages the new copy beside the live one before
> swapping them by rename, so a sync briefly holds two — which a 5 GB volume
> cannot do. The first sync took under two minutes on a fast connection. The script checks free space first and refuses to
> start if there is not enough, rather than filling the disk your database is
> on at three in the morning.

The same script also builds an index of **known-malicious packages** from the
OpenSSF malicious-packages feed (republished as `MAL-*` advisories by osv.dev),
so a package that *is* the attack — which has no CVE, and so is invisible to the
vulnerability database — is reported at severity 5. That step needs outbound
HTTPS to `osv-vulnerabilities.storage.googleapis.com` and about 100 MB of disk;
`SCAN_SYNC_MALICIOUS=0` turns it off. If the index is missing the dependency
scan says so on its run instead of reporting none found.

It also builds a **package-name index** (`package-index/`), which the slopsquat
check uses to flag dependencies that do not exist in their registry: the
signature of a package name an AI assistant invented, which anyone can register
afterwards. Scans never call a registry. They read the names synced here.

| Ecosystem | Source | Default |
|---|---|---|
| npm | `registry.npmjs.org` (the `all-the-package-names` daily snapshot, sha512-checked) | on |
| PyPI | `https://pypi.org/simple/` (PEP 691 JSON) | on |
| RubyGems | `https://rubygems.org/names` | on |
| crates.io | `https://static.crates.io/db-dump.tar.gz` (several hundred MB; adds age and download counts) | opt-in |
| Go | `https://index.golang.org/index`, incremental (existence is checked only once the backfill completes, which takes many nightly runs) | opt-in |
| Maven | no public name list exists; supply your own | via `SCAN_PACKAGE_INDEX_MAVEN_FILE` |

The default set takes about 110 MB, and a refresh stages a second copy, so
allow about 250 MB. The worker holds the lists in memory while a scan runs:
about 350 MB with the default set.

Settings, in `deploy/.env` or the shell:

- `SCAN_PACKAGE_INDEX_ECOSYSTEMS="npm pypi rubygems cargo go"` chooses the
  ecosystems.
- `SCAN_PACKAGE_INDEX_MAVEN_FILE=/path/names.txt` adds a Maven list, one
  `groupId:artifactId` per line.
- `SCAN_SYNC_PACKAGE_INDEX=0` turns the step off.

Without the index, the slopsquat check still flags names that look like
misspellings of popular packages. Its run shows that existence was **not
checked**, and it does not close earlier "not in registry" findings. Its
findings start in shadow mode, like every new rule. An admin promotes them in
Settings → Rules.

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

### Container image scanning (optional, off by default)

RepoPulse can scan the container images your Dockerfiles, compose files and
Kubernetes manifests name, for known CVEs in their OS packages and base
layers. It is **off** until you turn on the *Container image CVEs* scanner for
a repository (Security tab → scanners), because it is the one scanner that
reaches out to registries.

How it works: a host-side job copies each image into a scratch directory with
[`skopeo`](https://github.com/containers/skopeo), the scan image's `grype`
reads it with no network, and the scratch copy is deleted. Nothing but findings
is kept. Install `skopeo` on the host that runs the RepoPulse worker; if it is
missing the run says so and no findings are closed.

**Private registries are yours to configure.** RepoPulse stores no registry
credentials. Log in once with `skopeo login --authfile /etc/repopulse/registry-auth.json <registry>`
and set `IMAGE_SCAN_AUTH_FILE` to that path in the worker's environment. Public
images need nothing. Images pinned by digest are scanned as written; for images
pinned by tag, a finding also says when a newer tag of the same variant would
clear it. References that cannot be pulled as written (build arguments, stage
names, `scratch`) are counted as skipped, not scanned.

## Check that reports work

Run this once after the first install and after each upgrade:

```bash
SMOKE_EMAIL=you@example.com SMOKE_PASSWORD='…' deploy/smoke-report-pdf.sh
```

With no `SMOKE_*` variables it signs in as `ADMIN_EMAIL` / `ADMIN_PASSWORD`
from `deploy/.env`. The account must already have done its first-sign-in
password change, because the script does not change anyone's password, and
that change means the `ADMIN_PASSWORD` in `deploy/.env` is no longer the
password. So right after an install: sign in once in the browser, set the new
password, then pass it as `SMOKE_PASSWORD` as above. The script says which of
the two it ran into. It
generates one Repo Health report, waits for the worker, downloads the PDF
through the api, and checks the PDF header and page count:

```
PASS: report #2 downloaded as a PDF, 61234 bytes, 2 page(s)
```

The report stays in the history. The chain it tests crosses three containers:

- the **worker** prints with Playwright's headless Chromium, which is why the
  worker image is Debian-based when the others are Alpine;
- the printer loads `/print/reports/:id` from the **web** service on the
  internal network (`REPORT_PRINT_BASE_URL`, default `http://web:8080`), not
  from your public URL, which a container usually cannot reach;
- the worker writes the files to the `reportdata` volume at `/app/.data`, and
  the **api** reads them from the same volume at the same path to serve the
  download.

If a step fails, the script names it. `failed in the worker: …` carries the
worker's error. `has_pdf=false` means the api cannot see the worker's files, so
check that both services mount `reportdata`.

## Put TLS in front

RepoPulse publishes one plain-HTTP port. Your terminator should:

- forward `/` to that port, including `/api/` and the server-sent events stream
  at `/api/v1/events` (buffering off, long read timeout);
- expose `POST /api/v1/webhooks/github` (GitHub and Gitea) and
  `POST /api/v1/webhooks/gitlab` (GitLab) on the public vhost if your forge is on
  the internet, and everything else only where your users are — the webhook
  handler authenticates every delivery by signature and does nothing but verify
  and enqueue, so the worst case for an attacker is a rejected 401;
- set `REPOPULSE_BIND=0.0.0.0` in `deploy/.env` only once that is in place, and
  `NODE_ENV=production` (the default the scripts write) so session cookies carry
  the Secure flag;
- pass the client address in `X-Forwarded-For`. The API trusts one proxy hop
  from a private address (the bundled `web` container) by default; with your
  terminator in front of that, set `TRUST_PROXY=2` in `deploy/.env` so sign-in
  rate limits and audit lines are per person rather than shared by everyone.

[DEPLOYMENT.md](DEPLOYMENT.md) has the topology, ports and monitoring detail.

## Uninstall

`down -v` deletes the data but is not an uninstall. Tracking a repository
registers a push webhook on it; left behind, every one of them keeps sending
deliveries that fail to a server that no longer exists. Run, **while the stack
is still up** (step 1 reads the database):

```bash
deploy/uninstall.sh                     # asks before each step; --yes to skip the questions
```

In order, it:

1. removes every webhook RepoPulse registered, on every tracked repository of
   every active connection (the hooks pointing at `PUBLIC_BASE_URL`; a hook
   another service registered is never touched). It runs
   `pnpm remove:webhooks` inside the api image, through the budgeted forge
   client. Any repository it could not clean up is named — remove that hook in
   the forge's repository *Settings → Webhooks*. Already lost the forge or the
   database? `--keep-webhooks` skips this step;
2. offers a final `deploy/backup.sh`. Keep `TOKEN_ENC_KEY` with it, or it can
   never be restored;
3. runs `down -v`, which deletes `repopulse_pgdata`, `repopulse_redisdata` and
   `repopulse_reportdata`, and removes the fixed-name `repopulse-scan-scratch`
   volume and the Claude CLI volume, if you added one;
4. deletes `SCAN_RULES_DIR` and `EXTRA_CA_DIR` (it asks for each);
5. prints what only you can do: delete the nightly `backup.sh` and
   `scan-db-sync.sh` cron lines, revoke the forge tokens (or uninstall the
   GitHub App) on the forge, and remove the `REPOPULSE_TOKEN` secrets from
   your pipelines.

Backups you took are not touched. Delete `deploy/.env` last, once no backup
needs its `TOKEN_ENC_KEY`.

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

**Sign-in accepts the password, then shows the sign-in screen again.** You are
on plain `http://` at an address other than `localhost`. The session cookie is
`Secure`, so the browser drops it; the sign-in screen says so in a yellow box.
Put TLS in front (above) or use an SSH tunnel to `localhost`. There is
deliberately no switch to make the cookie insecure.

**"Rate limit exceeded" for everyone at once.** The API sees every browser as
the same proxy address. If you added your own reverse proxy in front of the
bundled one, set `TRUST_PROXY=2` (see *Put TLS in front*).

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
