# Running RepoPulse

Three ways to run it, in order of how much you need first:

| | What you need | What you get |
|---|---|---|
| [Demo mode](#demo-mode) | nothing but Docker/Podman | the whole product, fake data, no GitHub account |
| [Dev stack](#dev-stack) | a GitHub OAuth app | your own org's real data, hot reload |
| [Containers](#containers) | a GitHub App | the customer-hostable stack |

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

Open <http://localhost:5173> and sign in. The sign-in is mocked: any login
lands you as the fixture user.

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
at the login screen instead of here.

---

## Dev stack

Same as above, plus a GitHub OAuth app so you can connect a real organisation.

1. Register an OAuth app at <https://github.com/settings/developers>:
   - **Homepage URL** `http://localhost:5173`
   - **Authorization callback URL** `http://localhost:3000/auth/callback`
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
| web | <http://localhost:5173> |
| api | <http://localhost:3000> |
| worker healthz | <http://localhost:3001/healthz> |

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
# WEBHOOK_SECRET and the GITHUB_APP_* values — none have defaults on purpose
podman compose -f deploy/compose.yaml up -d
```

Then open `http://localhost:8080` (`REPOPULSE_PORT`).

Generate each secret with `openssl rand -hex 32`. `deploy/.env` is gitignored
and must stay that way: `TOKEN_ENC_KEY` decrypts every stored forge credential,
so back it up separately and never rotate it casually — losing it means every
connection must be re-entered.

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

**`Port already in use: api (:3000)`** — something else is listening, commonly
the `deploy/compose.yaml` stack. `podman ps` to see, then either stop it or
`PORT=3010 pnpm dev`. In demo mode the OAuth callback follows whatever port you
choose.

**`missing required env var GITHUB_APP_CLIENT_ID`** — you have no OAuth app
configured. Either register one (above) or run `DEMO_MODE=1 pnpm dev`.

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
