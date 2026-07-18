# GitHub Auth: Dev Fixture Recording (W0-05) + Production App (W7-07)

Two distinct concerns, deliberately split (was one ticket, W0-05, until 2026-07-18):

- **W0-05 (now, dev)** — the read token + scratch repo needed to *record fixtures*.
  Needs authenticated **read** access only. No GitHub App, no webhook, no public
  domain. This is what unblocks the ingest/metrics code (W0-04 → W1-06 → W2-02/03).
- **W7-07 (later, prod)** — the production GitHub App + webhook + prod OAuth app,
  whose callback/webhook URLs need `repopulse.bpmforge.com` **live** (TLS-terminated),
  so it's gated on the W7-05 deploy. Only live end-to-end operation needs it.

The reason the split is safe: the entire forge/ingest chain is tested against
**recorded fixtures with zero live network in CI** (W0-04, W1-06, W2-03 acceptance).
Live GitHub access is needed exactly once — to record — and REST/GraphQL **response
bodies are identical across auth modes**. `FORGE_PROVIDER.md §5` names PAT as the
dev fallback; W0-04 scrubs every token out of the fixtures regardless of which one
recorded them. Nothing secret in git (CLAUDE.md Law 9).

---

## Part 1 — W0-05: dev fixture-recording prerequisite (actionable now)

### 1a. Read token

Either works — both produce identical response bodies for recording:

- **gh CLI token** (fastest): `gh auth token` if the CLI is already authenticated with
  `repo` + `read:org` scopes. Zero new registration. For one-time recording only — not
  the committed dev-auth pattern.
- **Fine-grained PAT**: GitHub → Settings → Developer settings → Personal access tokens
  → Fine-grained tokens → Generate. Repository read-only: Contents, Metadata, Pull
  requests, Checks, Deployments, Issues. Put it in the local `.env` as `GITHUB_PAT`
  (gitignored; `.env.example` documents the name only).

### 1b. Fixture source repos (record against both — W2-03 wants reproducible counts)

- **Scratch repo** — a small, controlled repo seeded with a known set of PRs (some
  merged, some open, ≥1 with review comments), a few commits, and ≥1 PR with a CI check
  run (a trivial GitHub Actions workflow that echoes something produces `check_runs`).
  Gives W2-03 exact ground-truth row counts to assert against.
- **Larger existing repo** — any real repo with rich history, for the fixtures that are
  awkward to seed by hand: 202 stats-warmup, truncated diffs (`patchTruncated`),
  rate-limit-header / secondary-403 cases.

### 1c. Record

Done in W0-04 (`tools/fixture-recorder`), using the 1a token against the 1b repos.
No further registration required to reach a green W1-06 / W2-02 / W2-03.

### Recorded values (fill in as 1a/1b are settled)

| Field | Value |
|---|---|
| Dev token type | _pending_ (gh CLI token · or fine-grained PAT named `___`) |
| Scratch fixture repo | _pending_ (`owner/name`) |
| Larger fixture repo | _pending_ (`owner/name`) |

---

## Part 2 — W7-07: production GitHub App + webhook + prod OAuth (deferred, needs deploy)

Do NOT attempt until W7-05 is done — the callback/webhook URLs below are unreachable
until `repopulse.bpmforge.com` is deployed and TLS-terminated. Registering the App now
would just mean GitHub failing every webhook delivery against a dead host.

### 2a. GitHub App

1. GitHub → **Settings → Developer settings → GitHub Apps → New GitHub App**.
2. Fill in:
   - **Name**: `RepoPulse` (globally unique — add a suffix if taken).
   - **Homepage URL**: `https://repopulse.bpmforge.com`
   - **Callback URL**: `https://repopulse.bpmforge.com/auth/callback`
   - **Webhook**: Active, URL `https://repopulse.bpmforge.com/webhooks/github`, generate
     and save a **webhook secret** (→ `.env` `WEBHOOK_SECRET`, never committed).
3. **Permissions** — repository, read-only only (C5 / SC-25):
   Contents · Metadata (mandatory) · Pull requests · Checks · Deployments · Issues.
4. **Subscribe to webhook events**: Pull request, Push, Check run/suite, Issues, Deployment.
5. Create, then note/generate: **App ID**, **Client ID** + **Client secret**,
   **private key** (.pem).
6. **Install** onto the real org/repos. Note the **Installation ID** from the URL
   (`.../settings/installations/<ID>`).

### 2b. Localhost dev OAuth app (local login; registerable independently, no prod domain)

1. GitHub → **Settings → Developer settings → OAuth Apps → New OAuth App**.
2. **Homepage URL**: `http://localhost:5173`
3. **Authorization callback URL**: `http://localhost:3000/auth/callback` (matches
   `API_BASE_URL` in `.env.example`).
4. Register, generate a **Client secret**. Note the **Client ID** + **Client secret**.

### Registered app record (W7-07 fills this in)

| Field | Value |
|---|---|
| GitHub App name | _pending (W7-07)_ |
| GitHub App ID | _pending_ |
| GitHub App Client ID | _pending_ |
| Installation ID | _pending_ |
| Permissions granted | contents:read, metadata:read, pull_requests:read, checks:read, deployments:read, issues:read (verify the actual grant matches — not a superset) |
| Webhook URL | `https://repopulse.bpmforge.com/webhooks/github` |
| Webhook events | pull_request, push, check_run, check_suite, issues, deployment |
| Dev OAuth app Client ID | _pending_ |
| Dev OAuth app callback | `http://localhost:3000/auth/callback` |

Non-secret values (ids) go in the table above. Secrets (Client secrets, private key,
webhook secret) go only into the gitignored `.env`, never here.

---

## `.env.example` reconciliation

`.env.example`'s `GITHUB_APP_*` / `GITHUB_PAT` var names already match
`docs/DEPLOYMENT.md` §3. Dev (W0-05) uses `GITHUB_PAT`; prod (W7-07) populates the
`GITHUB_APP_*` set. `.env.example` only ever holds names/placeholders — never real
secrets.

## Scope: what this registration is and isn't

One deployment (`repopulse.bpmforge.com`), not a reusable credential or a published
integration:

- **Another person self-hosting RepoPulse** needs their **own** App + OAuth
  registrations, callback/webhook pointing at *their* domain. GitHub Apps are tied to
  their registered URLs — ours won't work for someone else's install. `.env.example`
  documents the variable *names*; it carries no values that authenticate as this app.
- **GitHub Enterprise Server (self-hosted GitHub, "GHE")** is **not supported in v1**.
  `packages/forge` hardcodes `api.github.com` as the only allowlisted host (verified:
  `budgeted-client.ts` allowlist, enforced by `validate-arch.sh` rule 4). GHE uses a
  different API base (`https://<host>/api/v3`) and its own App flow — unscoped work,
  not a config flip. FOUNDING_BRIEF D3 scopes v1 to GitHub-behind-`ForgeProvider`
  (Gitea adapter is the only named v1.x forge follow-on).
- **RepoPulse is single-tenant in v1** (D1): one `workspace_id = 'default'` for everyone
  who logs into this instance. Schema is SaaS-ready (`workspace_id` everywhere, RLS
  droppable in later, ARCHITECTURE.md §7) but the multi-tenant onboarding flow — an
  unrelated org registering their own workspace + App against this running instance —
  is out of scope until the "SaaS flip."
- **GitHub Enterprise *Cloud*** (an Enterprise-plan org on github.com) *is* supported:
  still `api.github.com`, just higher rate-limit ceilings (`github-api.md` §1, GHEC
  column). The org just installs the App like any other.
