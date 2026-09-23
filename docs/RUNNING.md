# Running RepoPulse (developers)

This is the developer document. If you are installing RepoPulse to use it,
start with [INSTALL.md](INSTALL.md); this file is about running it from a
checkout.

Four ways to run it, in order of how much you need first:

| | What you need | What you get |
|---|---|---|
| [Demo container](#the-demo-container) | a container runtime | the customer stack, a fixture forge, an empty first run |
| [Demo mode](#demo-mode-from-a-checkout) | Node 22, pnpm, a container runtime | the whole product with seeded data, hot reload |
| [Dev stack](#dev-stack) | the above plus a forge token | your own organisation's real data, hot reload |
| [Container stack](#container-stack) | a container runtime | what a customer installs, built from this checkout |

**None of these needs a GitHub account to start.** You sign in with a local
account, so a forge credential buys you repository *data*, not entry.

Everything runs locally. RepoPulse never clones a repository and the web app
never calls a forge — it reads only our own Postgres.

---

## The demo container

No checkout tooling, no Node, no `.env`. One command, and everything after it
is done in the browser:

```bash
./deploy/demo.sh          # build + start, then print where to go
./deploy/demo.sh down     # stop
./deploy/demo.sh reset    # stop AND wipe the database, back to a first boot
```

Open <http://localhost:8090> and sign in as `demo@repopulse.local` with
`demo-password-change-me`. The product will immediately make you choose a new
password — that is the real first-boot behaviour of an account created from
`ADMIN_PASSWORD`, not a demo quirk.

**It starts EMPTY on purpose.** There is no seeded warehouse, because the point
is to walk the first run the way a customer does: connect a credential in
Admin → Connections (the script prints the fixture token to paste), choose
repositories, watch the backfill land in Admin → Sync, and see the repos go
live. Models, settings, agreements and scanners are all configured from the UI
too — nothing in this stack needs a file edited.

**What makes it a demo is only the forge.** `deploy/compose.demo.yaml` builds
the SAME api, worker, migrate, scan-runner and web images `deploy/compose.yaml`
does, and changes one thing: `FORGE_BASE_URL` points at a fixture server
instead of api.github.com. There is no demo mode, no seeded data and no
special-cased code path — which is what makes it evidence that the product
works rather than a mock of it. The release's recorded customer journey
(`deploy/journey.sh run`, below) is this stack plus one fixture-model service.

Every secret in that compose file is a fixed published throwaway, which is safe
for exactly one reason: it binds to loopback only. It is not an install recipe —
`deploy/compose.yaml` is, and it refuses to start without real ones.

`api` and `worker` share the `forge` container's network namespace. An
`http://` forge URL is allowed only for an exact loopback host, so reaching
the fixture as `http://forge:3309` would be refused by the same guard that
stops the product being pointed at an internal address. Sharing the namespace
satisfies that guard honestly instead of relaxing it for a fixture's
convenience.

## Demo mode (from a checkout)

The same idea without containers, for when you are already working in the repo.
Unlike the demo container above, this one SEEDS a warehouse, so there is data on
every screen immediately and no first run to walk.

```bash
pnpm install
pnpm bootstrap          # NOT `pnpm setup` — see below
DEMO_MODE=1 pnpm dev
```

Open <http://localhost:5273> and sign in with:

```
email     demo@repopulse.local
password  demo-password
```

The sign-in screen shows those credentials in its demo banner and fills the
form in for you, and the API prints them at boot. They are a REAL local
account, created at startup with a real password hash — demo mode does not
weaken the login route, so what you sign in through is the same path a real
install uses. *Sign in with GitHub* also works and needs no GitHub account:
that is the boundary demo mode mocks.

Everything you see is fake — a seeded warehouse of three invented repositories,
served through a local fake forge. The app says so in a banner across the top,
because the screens are identical to the real thing and a screenshot of demo
data is otherwise indistinguishable from a screenshot of your organisation.

Demo mode **refuses to start** under `NODE_ENV=production`. It mocks the login
boundary, which in production would be an authentication bypass rather than a
demo.

> **`pnpm bootstrap`, not `pnpm setup`.** `pnpm setup` is a built-in pnpm
> command that sets up pnpm itself; it would run and never touch this repo.

### What bootstrap does

Starts Postgres 16 + Redis in containers, writes `.env` from `.env.example`,
**generates** `SESSION_SECRET`, `WEBHOOK_SECRET` and `TOKEN_ENC_KEY`, applies
migrations, seeds the warehouse. It is safe to re-run: it never overwrites a
secret you already have.

It does **not** invent `GITHUB_APP_CLIENT_ID` / `GITHUB_APP_CLIENT_SECRET` —
those identify an OAuth app only you can register, and a fake value would fail
at the login screen instead of here. Their absence is not fatal: the API starts
without them and simply offers no GitHub button.

It also does not invent `ADMIN_EMAIL` / `ADMIN_PASSWORD`. Demo mode does not
need them (the login boundary is mocked), but a real sign-in does — add them to
`.env` yourself before starting the API:

```
ADMIN_EMAIL=you@example.com
ADMIN_PASSWORD=<at least 12 characters>
```

The API creates that account on its first boot and forces a password change at
first sign-in. Generating one here would mean writing a working password into
every developer's `.env` with a value we chose, which is the same mistake as a
default credential.

---

## Ports

RepoPulse deliberately does not use the framework defaults. `5173` (Vite),
`3000` and `3001`, Postgres's `5432` and Redis's `6379` are what every other
project on a machine also picks, and
sharing a machine with one of them is enough to lose a test run — Playwright
found `5173` held by an unrelated app and refused to start.

| What | Port | Override |
|---|---|---|
| API (dev) | 3300 | `PORT` |
| Worker healthz | 3301 | `WORKER_HEALTH_PORT` |
| Web dev server | 5273 | `WEB_PORT` |
| e2e API | 3310 | `E2E_API_PORT` |
| e2e worker healthz | 3311 | `E2E_WORKER_HEALTH_PORT` |
| e2e fake forge | 9099 | `E2E_FAKE_FORGE_PORT` |
| Demo container (web) | 8090 | `REPOPULSE_DEMO_PORT` |
| Container stack (web) | 8099 | `REPOPULSE_PORT` in `deploy/.env` |
| Postgres (dev data tier, host side) | 15432 | `POSTGRES_PORT` + `DATABASE_URL` |
| Redis (dev data tier, host side) | 16379 | `REDIS_PORT` + `REDIS_URL` |

The defaults live in **`ports.config.mjs`**, which the dev runner, the Vite
config and the Playwright config all import — one file, so they cannot drift
apart and leave a documented URL pointing at nothing. The e2e ports are
separate from the dev ports on purpose: a `pnpm dev` left running in another
terminal must not be mistaken for the API under test.

**Everything a host-run process opens binds loopback (127.0.0.1)** — the API
and the worker `/healthz` since W17-37 (`LISTEN_HOST`, default `127.0.0.1` — not `HOST`, which shells
set to the machine name; it used
to be every interface, which put the dev API and the worker's `/metrics` on
the LAN), the Vite dev server by Vite's own default, and the data tier by
`compose.dev.yaml`. Set `LISTEN_HOST=0.0.0.0` only when something outside this
machine genuinely has to reach the API, such as a Gitea in a container
delivering webhooks. The container images set `LISTEN_HOST=0.0.0.0` themselves: in
`deploy/compose.yaml` only the web proxy publishes a host port (on
`REPOPULSE_BIND`, default `127.0.0.1`), and the api and worker are reachable
only over the compose network.

The web dev server uses `strictPort`, so a collision fails loudly instead of
silently sliding to 5274 and making every documented URL wrong.

## Dev stack

Same as above against real data instead of the seeded warehouse.

Sign-in itself needs nothing new: set `ADMIN_EMAIL` / `ADMIN_PASSWORD` in `.env`
(above), run `pnpm dev`, and log in with them. Connecting an organisation to
pull its data is done from Admin → Connections once you are signed in, with a
read-only personal access token for GitHub, GitLab or Gitea (scopes in
[INSTALL.md](INSTALL.md#connect-your-forge)).

Register an OAuth app only if you want the **GitHub sign-in button** as well:

1. Register an OAuth app at <https://github.com/settings/developers>:
   - **Homepage URL** `http://localhost:5273`
   - **Authorization callback URL** `http://localhost:3300/auth/callback`
2. Put the client id and secret in `.env`:
   ```
   GITHUB_APP_CLIENT_ID=Iv1.xxxxxxxxxxxx
   GITHUB_APP_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
   ```
3. `pnpm dev`

`pnpm dev` runs three processes — the API, the **ingestion worker** and the web
dev server — with prefixed logs. All three matter: without the worker, queues
fill and nothing drains, which looks like ingestion being broken.

| | |
|---|---|
| web | <http://localhost:5273> |
| api | <http://localhost:3300> |
| worker healthz | <http://localhost:3301/healthz> |

Ctrl-C stops all three.

---

## Container stack

The customer-hostable stack — API, worker, scan-runner, web, Postgres, Redis,
and a one-shot migration job — built from this checkout. Postgres and Redis
are not published to the host; the web container is the only
externally-listening surface, and you put your own TLS terminator in front of
it.

```bash
ADMIN_PASSWORD='a long passphrase' deploy/configure.sh --url=http://localhost:8099 --admin-email=you@example.com
deploy/up.sh --build
curl -f http://127.0.0.1:8099/healthz && echo OK
```

`configure.sh` writes `deploy/.env` with every secret generated and never
rewrites it; `deploy/.env.example` is the reference for what each line means.
Use `deploy/up.sh`, not `compose up` directly. It does three things the raw
command does not, each of which cost a real install its ingestion or its
schema:

1. **It creates the scan-data mount source.** A bind mount whose source is
   missing fails at container-creation time, so the worker never starts and
   cannot report why. `up.sh` defaults `SCAN_RULES_DIR` to the shipped
   `deploy/scan-rules` and creates it.
2. **It verifies the stack afterwards.** `compose up` returned success while
   leaving the worker dead, and the web tier answers 200 either way. `up.sh`
   exits non-zero and names the services that are not running.
3. **It stops the application tier on a failed migration.** podman-compose
   does not honour `service_completed_successfully`, so without this the API
   and worker would start against an un-migrated schema.

An empty scan-data directory is fine: dependency scanning reports itself
unavailable (which the Security tab says plainly) until you run
`deploy/scan-db-sync.sh`, which needs 5 GB under that directory.

Then open `http://localhost:8099` (`REPOPULSE_PORT`) and sign in as
`ADMIN_EMAIL`. [INSTALL.md](INSTALL.md) is the same path written for someone
who did not write the code, and covers the bundle a customer receives instead
of this checkout.

`SCAN_RULES_DIR`, if you set it, **must be an absolute path** — podman-compose
resolves a relative bind source against your working directory, not the
compose file's.

### Building a bundle

```bash
deploy/bundle.sh --version=0.1.0-rc1 --out=$HOME/tmp/rp-bundle-out
```

Builds the images as `localhost/repopulse/<name>:<version>`, saves them to one
archive, stages `deploy/` with the `build:` stanzas stripped, and packs a
`.tar.gz` with a `.sha256` beside it. `dev` and `latest` are refused as
versions. Nothing is pushed anywhere; there is no registry. The bundle's own
`README.md` and `ARCHITECTURES.md` (under `deploy/bundle/`) travel with it.

---

## CI

**There is no CI running today, and there never has been.** Every gate this
project has ever passed was run locally. GitHub Actions is configured
(`.github/workflows/ci.yml`) but has never executed — the account has no
Actions billing — so no green check in this repository has ever meant anything.

`.gitea/workflows/gate.yaml` is the replacement, aimed at the maintainers'
self-hosted Gitea (an internal host, not reachable from outside). It mirrors
the GitHub gate step for step: lint, typecheck, `pnpm test` with
`REQUIRE_LIVE_INFRA=1` against Postgres + Redis services, the bundle budget,
and the four validators.

**It has never run either.** It needs a registered runner, which needs two
things only a Gitea admin can produce: a runner registration token (*Site
Administration → Actions → Runners*), and a decision to install a persistent
daemon on whichever machine hosts the runner. Once both exist:

```bash
# On the runner host (macOS example; Linux is the same binary plus a systemd unit)
brew install act_runner        # or download from gitea.com/gitea/act_runner/releases

act_runner register --no-interactive \
  --instance https://git.example.com \
  --token <REGISTRATION_TOKEN> \
  --name repopulse-local \
  --labels ubuntu-latest:docker://catthehacker/ubuntu:act-22.04,host:host
```

Then prove it goes **red** before trusting it green — push a commit with a
deliberate type error and confirm the gate fails. A CI system nobody has seen
fail is a CI system nobody has tested.

---

## Scan tools

The security and code-health scanners do not run on the host. They run inside
one sandboxed image (`Containerfile.scan`) that carries every tool they need —
opengrep, lizard, jscpd, dependency-cruiser, syft and grype — pinned by version
and checksum. One command builds it:

```bash
podman build -f Containerfile.scan -t localhost/repopulse/scan:dev .
```

Until it exists, every scanner that needs a tool fails with whatever podman
says, and the repository's Security tab shows that failure verbatim with this
command underneath it. `SCAN_IMAGE` overrides the tag if you build it
elsewhere. In the container stack the worker never touches the runtime
itself: the `scan-runner` sidecar holds the socket and launches the
`--network=none` scan containers on its behalf.

Two things this image deliberately does NOT contain:

- **grype's vulnerability database.** It is refreshed daily and baking a copy
  in would ship a stale one that looks current. `deploy/scan-db-sync.sh` pulls
  it into `$SCAN_RULES_DIR/vuln-db` (default `deploy/scan-rules`). A database
  grype will refuse — it rejects anything over five days old — is reported as
  a failed scan naming its age and the sync command, not as a clean bill of
  health.
- **Semgrep registry rules.** They are licence-barred for service use, so the
  semgrep scanner refuses a `p/…`, `r/…` or `auto` config outright rather than
  quietly ignoring it. The rules it runs are in-house and live in the repo.

A scanner that reads **"(not in this build)"** on the Security tab is a
different problem: there is no code for it here, and no tool you can install
will change that. Today that is `iac`. The `owasp_web` and `owasp_llm`
checklists are shipped but off by default and manual; the release journey
enabled one per repository through `PUT /scanners/:key`, because no screen
does yet.

---

## Tests

```bash
pnpm lint && pnpm typecheck && pnpm test
pnpm e2e                      # Playwright, against the seeded e2e stack
pnpm e2e:demo                 # Playwright, against the demo container
pnpm check:bundle             # production web build against its size budget
```

**`pnpm test` warns and skips when Postgres/Redis are absent.** Dozens of test
files need live infrastructure; without it they skip and the suite still
passes, over a subset. Set `REQUIRE_LIVE_INFRA=1` to make a missing data tier
a failure instead — that is what a real gate run looks like:

```bash
REQUIRE_LIVE_INFRA=1 pnpm test
```

`scripts/dev-up.sh` starts the Podman VM and both data-tier containers; run it
first on a machine that has been asleep, or the live-infra guard will report an
environment outage as a code regression.

The release evidence under `docs/work/product-completion/evidence/` was
produced by three longer runs, each writing its own record:

```bash
./deploy/journey.sh run                       # the complete customer journey in a browser, ~10 min
pnpm e2e e2e/quality.spec.ts                  # axe scans, keyboard flows, overflow, at three widths
scripts/drill-backup-restore.sh --source=rp-drill-a --target=rp-drill-b --version=<tag>
```

---

## Troubleshooting

**`Port already in use: api (:3300)`** — something else is listening, commonly
the `deploy/compose.yaml` stack. `podman ps` to see, then either stop it or
`PORT=3010 pnpm dev`. In demo mode the OAuth callback follows whatever port you
choose.

**The login screen shows no GitHub button** — you have no OAuth app configured,
which is a supported state rather than an error. Sign in with `ADMIN_EMAIL` /
`ADMIN_PASSWORD`, or register an app (above) if you want the button back.

**`Invalid email or password` with the credentials you just set** — the account
is created on the API's *first* boot after the variables appear, and only when
no local account with a password exists yet. The API logs the bootstrap outcome
on every start; check that line before re-typing the password.

**`TOKEN_ENC_KEY is required (32-byte hex)`** — run `pnpm bootstrap`, which
generates it. Copying `.env.example` by hand does not: the secrets ship blank
or as published placeholders on purpose, since a committed key is a published
key.

**`Postgres did not become ready`** — the container did not come up. Check
`podman logs repopulse-postgres`. On macOS the podman machine must be running
(`podman machine start`).

**The app loads but every screen is empty** — the warehouse has no data. Run
`pnpm seed`, or connect an organisation and wait for the first backfill.

**Nothing ingests** — check the worker is running. `pnpm dev` starts it;
running the API alone does not. In the container stack, Admin shows
"Background worker — Not working" when no heartbeat has arrived in the last
minute, and a scan start that no worker picks up says so after five minutes.
