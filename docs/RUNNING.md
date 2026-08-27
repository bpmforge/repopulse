# Running RepoPulse

Three ways to run it, in order of how much you need first:

| | What you need | What you get |
|---|---|---|
| [Demo mode](#demo-mode) | nothing but Docker/Podman | the whole product, fake data, no forge account |
| [Dev stack](#dev-stack) | a forge token or App, for real data | your own org's real data, hot reload |
| [Containers](#containers) | nothing but Docker/Podman | the customer-hostable stack |

**None of these needs a GitHub account to start.** Since D14 you sign in with a
local account, so a forge credential buys you repository *data*, not entry.

Everything runs locally. RepoPulse never clones a repository (CONSTRAINTS.md
C1) and the web app never calls a forge — it reads only our own Postgres.

---

## Demo mode

The fastest way to see whether this is useful to you. No GitHub account, no
OAuth app, no credentials of any kind.

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

Both are safe only because demo mode refuses to start under
`NODE_ENV=production` (below).

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
at the login screen instead of here. Since D14 their absence is no longer fatal:
the API starts without them and simply offers no GitHub button.

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
`3000` and `3001` are what every other project on a machine also picks, and
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
| Container stack (web) | 8099 | `REPOPULSE_PORT` in `deploy/.env` |

The defaults live in **`ports.config.mjs`**, which the dev runner, the Vite
config and the Playwright config all import — one file, so they cannot drift
apart and leave a documented URL pointing at nothing. The e2e ports are
separate from the dev ports on purpose: a `pnpm dev` left running in another
terminal must not be mistaken for the API under test.

The web dev server uses `strictPort`, so a collision fails loudly instead of
silently sliding to 5274 and making every documented URL wrong.

## Dev stack

Same as above against real data instead of the seeded warehouse.

Sign-in itself needs nothing new: set `ADMIN_EMAIL` / `ADMIN_PASSWORD` in `.env`
(above), run `pnpm dev`, and log in with them. Register an OAuth app only if you
want the **GitHub sign-in button** as well — connecting an organisation to pull
its data is done from Admin → Connections once you are signed in, and on a
self-hosted forge takes a Gitea token rather than any of this.

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

## Containers

The customer-hostable stack — API, worker, web, Postgres, Redis, and a
migration job — built from this repo. Postgres and Redis are not published to
the host; the web container is the only externally-listening surface, and you
put your own TLS terminator in front of it.

```bash
cp deploy/.env.example deploy/.env
# fill in POSTGRES_PASSWORD, REDIS_PASSWORD, SESSION_SECRET, TOKEN_ENC_KEY,
# WEBHOOK_SECRET — none have defaults on purpose — and add ADMIN_EMAIL /
# ADMIN_PASSWORD, which are how you get in the first time. The GITHUB_APP_*
# values are optional and can stay blank.
podman compose -f deploy/compose.yaml up -d
```

Then open `http://localhost:8099` (`REPOPULSE_PORT`) and sign in as
`ADMIN_EMAIL`. [INSTALL.md](INSTALL.md) is the same path written for someone
who did not write the code.

Generate each secret with `openssl rand -hex 32`. `deploy/.env` is gitignored
and must stay that way: `TOKEN_ENC_KEY` decrypts every stored forge credential,
so back it up separately and never rotate it casually — losing it means every
connection must be re-entered.

`SCAN_RULES_DIR` **must be an absolute path** and the directory must exist
before `up`. `deploy/scan-rules` ships empty for that reason; it is filled by
`deploy/scan-db-sync.sh`, host-side, because the scan container has no network.

### Verified clean run (W13-06, 2026-08-19)

This exact path was run from a **fresh `.env` and empty volumes** on macOS 15 /
Podman 5 (arm64), under its own compose project so it touched no existing
install:

```bash
cp deploy/.env.example deploy/.env      # fill every blank; none has a default
podman compose -p repopulse-clean -f deploy/compose.yaml up -d --build
curl -f http://127.0.0.1:${REPOPULSE_PORT}/healthz
```

**Result: 37 seconds** from `up` to `/healthz` answering 200, with a warm image
cache. All six containers healthy, 22 migrations applied to the empty database,
`/` served the SPA, a pasted deep link (`/repos/1/ci`) returned 200 through the
history fallback, and `/api/v1/me/context` correctly returned 401 unauthenticated.

Two things this run found and fixed, both of which a customer would have hit:

- **The migrate job could not tell you whether it had done anything.** It
  printed `[migrate] up to date` identically whether it had just built the
  entire schema from nothing or done nothing at all. It now prints
  `[migrate] applied 22 migration(s); 22 total` on a first run and
  `up to date (22 migration(s) already applied)` afterwards.
- **The migration output looked like a crash.** Postgres NOTICEs were printed
  as multi-line objects — `severity: 'NOTICE', message: 'relation
  "__drizzle_migrations" already exists, skipping'` — in a shape
  indistinguishable from an error, in the output the install guide tells you to
  read. Notices are now suppressed by default.

`scripts/validate-compose.sh` now also asserts that every variable the compose
file reads appears in `.env.example`, and that no secret ships with a value.
Both rules were checked by breaking them deliberately.

---

## CI

**There is no CI running today, and there never has been.** Every gate this
project has ever passed was run locally. GitHub Actions is configured
(`.github/workflows/ci.yml`) but has never executed — the account has no
Actions billing — so no green check in this repository has ever meant anything.

`.gitea/workflows/gate.yaml` is the replacement, aimed at the self-hosted Gitea
at `git.bpmforge.com`. It mirrors the GitHub gate step for step: lint,
typecheck, `pnpm test` with `REQUIRE_LIVE_INFRA=1` against Postgres + Redis
services, the bundle budget, and the four validators.

**It has never run either.** It needs a registered runner, which needs two
things I cannot produce:

1. **A runner registration token**, minted by a Gitea admin at
   *Site Administration → Actions → Runners → Create new Runner*, or per-repo
   at *Settings → Actions → Runners*.
2. **A decision to install a persistent daemon** on whichever machine hosts the
   runner, since acceptance requires it to survive a reboot.

Once both exist:

```bash
# On the runner host (macOS example; Linux is the same binary plus a systemd unit)
brew install act_runner        # or download from gitea.com/gitea/act_runner/releases

act_runner register --no-interactive \
  --instance https://git.bpmforge.com \
  --token <REGISTRATION_TOKEN> \
  --name repopulse-local \
  --labels ubuntu-latest:docker://catthehacker/ubuntu:act-22.04,host:host

# Survive a reboot (macOS): a launchd agent running `act_runner daemon`
# in the directory holding .runner. On Linux, the packaged systemd unit.
```

Then prove it goes **red** before trusting it green — push a commit with a
deliberate type error and confirm the gate fails. A CI system nobody has seen
fail is a CI system nobody has tested.

Until that is done the GitHub workflow stays in place. Deleting it would leave
the repository with no CI definition at all, which is worse than having one
that has never been billed.

---

## Tests

```bash
pnpm lint && pnpm typecheck && pnpm test
pnpm e2e                      # Playwright, against the seeded stack
```

**`pnpm test` warns and skips when Postgres/Redis are absent.** 37 test files
need live infrastructure; without it they skip and the suite still passes, over
a subset. Set `REQUIRE_LIVE_INFRA=1` to make a missing data tier a failure
instead — that is what a real gate run looks like:

```bash
REQUIRE_LIVE_INFRA=1 pnpm test
```

---

## Troubleshooting

**`Port already in use: api (:3300)`** — something else is listening, commonly
the `deploy/compose.yaml` stack. `podman ps` to see, then either stop it or
`PORT=3010 pnpm dev`. In demo mode the OAuth callback follows whatever port you
choose.

**The login screen shows no GitHub button** — you have no OAuth app configured,
which since D14 is a supported state rather than an error. Sign in with
`ADMIN_EMAIL` / `ADMIN_PASSWORD`, or register an app (above) if you want the
button back. It is no longer a startup failure: the API used to refuse to boot
without `GITHUB_APP_CLIENT_ID`, and that is exactly what made the product
un-installable for anyone who did not already have one.

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
running the API alone does not.
