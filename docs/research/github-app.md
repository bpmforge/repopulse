# GitHub App + Dev OAuth Registration — W0-05

Human-in-the-loop prerequisite (CONSTRAINTS.md C5, SECURITY_CONTROLS.md SC-25): a
GitHub App and a separate localhost OAuth app must be registered through GitHub's UI —
an agent cannot do this part. This doc is the instruction set for the human step, and
becomes the permanent record of what was registered (ids/permissions/webhook config —
**never secrets**, those live only in `.env`, gitignored per CLAUDE.md Law 9).

Scoped to **this deployment** (`repopulse.bpmforge.com`) only — see "Scope: what this
registration is and isn't" at the end before assuming it generalizes to another install.

## Part A — GitHub App (production-shaped: OAuth login + installation-token ingest)

1. GitHub → **Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Fill in:
   - **GitHub App name**: `RepoPulse` (globally unique — add a suffix if taken).
   - **Homepage URL**: `https://repopulse.bpmforge.com`
   - **Callback URL**: `https://repopulse.bpmforge.com/auth/callback`
   - **Webhook**: Active, URL `https://repopulse.bpmforge.com/webhooks/github`, generate
     and save a **webhook secret** (goes in `.env` as `WEBHOOK_SECRET`, never committed).
3. **Permissions** — repository, read-only only (C5 / SC-25 minimum scope):
   - Contents: Read-only
   - Metadata: Read-only (mandatory, auto-selected)
   - Pull requests: Read-only
   - Checks: Read-only
   - Deployments: Read-only
   - Issues: Read-only
4. **Subscribe to webhook events**: Pull request, Push, Check run/suite, Issues, Deployment.
5. **Where can this GitHub App be installed?**: Only on this account is fine for dev;
   Any account if it needs installing elsewhere later.
6. Create the app, then note/generate:
   - **App ID** (shown on the app's page)
   - **Client ID** + **Client secret** (OAuth section of the app settings)
   - **Private key** (.pem download — signs installation token requests)
7. **Install the app** onto the scratch fixture repo (Part C). Note the
   **Installation ID** from the URL after installing (`.../settings/installations/<ID>`).

## Part B — Localhost dev OAuth app (local login only, separate registration)

1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. **Homepage URL**: `http://localhost:5173`
3. **Authorization callback URL**: `http://localhost:3000/auth/callback` (matches
   `API_BASE_URL` in `.env.example`).
4. Register, generate a **Client secret**. Note the **Client ID** and **Client secret**.

## Part C — Scratch fixture repo

1. Create a small GitHub repo (public or private) for the GitHub App to install onto —
   e.g. `bpmforge/repopulse-fixture`.
2. Seed real activity so ingest/metrics have something to compute against: a handful of
   PRs (some merged, some open, at least one with review comments), a few regular
   commits, and at least one PR with a CI check run (a trivial GitHub Actions workflow
   that just echoes something is enough to produce `check_runs`).
3. Install the GitHub App from Part A onto this repo if not already done in A.7.

## What to hand back

Non-secret (recorded below in this file):
- GitHub App ID, Client ID, Installation ID
- Dev OAuth app Client ID
- Scratch repo `owner/name`

Secret (goes directly into local `.env`, never into this file or git):
- GitHub App Client secret, private key (.pem), webhook secret
- Dev OAuth app Client secret

## Registered app record

_Filled in once the human steps above are complete — currently pending (W0-05 `todo`)._

| Field | Value |
|---|---|
| GitHub App name | _pending_ |
| GitHub App ID | _pending_ |
| GitHub App Client ID | _pending_ |
| Installation ID | _pending_ |
| Permissions granted | contents:read, metadata:read, pull_requests:read, checks:read, deployments:read, issues:read (per C5/SC-25 — verify actual grant matches this list, not a superset) |
| Webhook URL | `https://repopulse.bpmforge.com/webhooks/github` |
| Webhook events | pull_request, push, check_run, check_suite, issues, deployment |
| Dev OAuth app Client ID | _pending_ |
| Dev OAuth app callback | `http://localhost:3000/auth/callback` |
| Scratch fixture repo | _pending_ |

## `.env.example` reconciliation

`.env.example`'s `GITHUB_APP_*` / `GITHUB_PAT` var names already match
`docs/DEPLOYMENT.md` §3's env/secret matrix — no rename needed. Once the human step
above completes, the *local* `.env` (gitignored) gets the real values; `.env.example`
itself only ever holds names/placeholders, never real secrets.

## Scope: what this registration is and isn't

This is **one GitHub App + one OAuth app for this specific deployment**
(`repopulse.bpmforge.com`), not a reusable credential or a published integration.
Concretely:

- **Another person self-hosting RepoPulse** (their own container/instance, their own
  domain) needs their **own** GitHub App and OAuth app registration, with callback and
  webhook URLs pointing at *their* domain, not bpmforge's. GitHub Apps are tied to their
  registered callback/webhook URLs — ours will not work for someone else's install.
  `.env.example` documents the variable *names* a self-hoster needs to fill in; it
  carries no values that would let anyone else authenticate as this app.
- **GitHub Enterprise Server (self-hosted/on-prem GitHub, "GHE")** is **not supported
  in v1**. `packages/forge`'s GitHub client hardcodes `api.github.com` as the only
  allowlisted host (verified: `packages/forge/src/client/budgeted-client.ts`'s
  allowlist, enforced by `scripts/validate-arch.sh` rule 4 — no `api.github.com`
  reference outside `packages/forge`). A GHE instance uses a different API base URL
  (`https://<ghe-host>/api/v3` for REST) and its own App registration flow; wiring that
  up is unscoped work, not a config flip of this registration. FOUNDING_BRIEF D3 scopes
  v1 to "GitHub v1 behind a `ForgeProvider` interface; Gitea adapter is a v1.x ticket" —
  GHE isn't listed even as a v1.x follow-on today.
- **RepoPulse itself is single-tenant in v1** (FOUNDING_BRIEF D1): one Postgres
  `workspace_id = 'default'` for everyone who logs into this instance, backed by this
  one GitHub App. The schema is SaaS-ready (`workspace_id` on every tenant table, RLS
  policies droppable in later per ARCHITECTURE.md §7) but the *multi-tenant onboarding
  flow* — letting an unrelated org register their own workspace against this same
  running instance with their own GitHub App/installation — is explicitly out of scope
  until the "SaaS flip" (ARCHITECTURE.md §7: workspace creation/invite flows, RLS
  enable, per-workspace budgets/LLM config). Today, everyone who authenticates via this
  App's OAuth callback lands in the same single workspace.
- **Enterprise-in-the-sense-of-Cloud** (GitHub Enterprise Cloud, i.e. an org on
  github.com with an Enterprise plan) *is* supported today — it's still github.com's
  `api.github.com`, just with higher rate-limit ceilings (see
  `docs/research/github-api.md` §1, "GHEC" column). No extra registration steps beyond
  this doc; the org just needs to approve/install the GitHub App like any other GitHub
  org.
