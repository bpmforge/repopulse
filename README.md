# RepoPulse

A self-hosted code security and quality platform for teams shipping
AI-written code, with delivery metrics as context ([VISION](docs/VISION.md)).
It checks code with rules first and your own model second, proves each
finding and fix, ranks them by real risk and tracks them until they are gone —
without your code leaving your network. RepoPulse reads your forge (GitHub,
Gitea or GitLab) through its API, **never clones**, keeps only metrics and
findings in its own database, and shows them as a drill-down dashboard
(organisation → repository → pull request → file → finding) with saved views
and a report center. At PR time, your own CI pulls the results with
`repopulse check` ([CI_INTEGRATION](docs/CI_INTEGRATION.md)); RepoPulse never
writes to your repositories.

It is customer-hosted. There is no hosted service, no account with us, and no
image registry: you receive one install bundle per CPU architecture and run it
with Podman or Docker.

## Install from a bundle

The bundle is a `.tar.gz` plus a `.sha256` beside it, built by
`deploy/bundle.sh` from this repository. **Bundles are not published anywhere
yet**: none of the commands below downloads anything, and there is no URL to
fetch one from. Someone builds it and hands it to you.

What you need on the host:

- Podman 5+ with `podman-compose`, or Docker 24+ with the compose plugin
- the CPU architecture named in the bundle file name (`install.sh` refuses a mismatch)
- about 4 GB of disk for images, plus room for your data
- a hostname your users will open, and your own TLS terminator in front
  (RepoPulse binds to `127.0.0.1` by default and does not terminate TLS)

On the host, with the two files in the current directory:

```bash
shasum -a 256 -c repopulse-0.2.0-linux-arm64.tar.gz.sha256   # or: sha256sum -c
tar -xzf repopulse-0.2.0-linux-arm64.tar.gz
cd repopulse-0.2.0-linux-arm64
ADMIN_PASSWORD='a long passphrase' ./install.sh --url=http://localhost:8099 --admin-email=you@example.com
```

`install.sh` verifies every file against `SHA256SUMS`, checks the
architecture, loads the images, writes `deploy/.env` with every secret
generated, then starts the stack and **verifies each service is running**
before it reports success. It ends with the URL to open. Check it yourself:

```bash
curl -f http://127.0.0.1:8099/healthz && echo OK
```

Open the URL and sign in as the admin email with the password you set. You are
asked to change it before anything else is reachable. The install is now
working and empty: connecting a forge is done from **Settings → Connections**
inside the product, with an access token for GitHub, Gitea or GitLab.
[docs/INSTALL.md](docs/INSTALL.md) walks through that, the reverse proxy, and
the scan-data sync that dependency scanning needs.

Replace `http://localhost:8099` with the public URL your users will open once
TLS is in front; `--port=` changes the published port. The password comes from
the environment or a `deploy/admin-password` file, never from an argument, so
it does not land in shell history.

Data lives in two named volumes and survives `compose down`; only `down -v`
deletes it. Backups, restore, upgrade and rollback are in
[docs/RUNBOOK.md](docs/RUNBOOK.md); every procedure there was executed, not
just written.

## Try it without installing anything

From a checkout, with a container runtime:

```bash
./deploy/demo.sh          # build + start; prints where to go
./deploy/demo.sh down     # stop
```

Open <http://localhost:8090> and sign in as `demo@repopulse.local` with
`demo-password-change-me`. It is the same stack as the bundle with one change:
the forge it talks to is a local fixture server, so you can connect, choose
repositories and watch a backfill land without a real credential. The rest of
the developer paths (seeded demo mode, dev stack, tests) are in
[docs/RUNNING.md](docs/RUNNING.md).

## What is in this release, and what is not

Every row states what you must configure, what kind of evidence stands behind
it, and its status. "Tested" means a recorded run in
`docs/work/product-completion/evidence/`; "supported" means the code ships and
is unit-tested but the release evidence did not exercise it end to end;
"absent" means there is no code for it and no configuration will make it
appear. All evidence is from **linux/arm64 on rootless Podman**; Docker and
amd64 are untested, not unsupported.

| Capability | Required configuration | Evidence type | Status | Known limits |
|---|---|---|---|---|
| Install from bundle; data survives restart | container runtime only | recorded smoke (W17-28); repeated for this document (W17-33) | **Tested** on linux/arm64, rootless Podman | amd64, Docker, rootful Podman, Windows/WSL2 untested; no registry, no download URL |
| First admin sign-in, forced password change | `ADMIN_EMAIL`, `ADMIN_PASSWORD` | recorded smoke + browser journey (W17-28, W17-30) | **Tested** | one bootstrap admin only; further people from Settings → Members |
| Single sign-on (OIDC) | the `OIDC_*` group | unit tests of the callback and half-configuration refusal | Supported | no real identity provider was connected in release evidence |
| Sign in with GitHub | `GITHUB_APP_CLIENT_ID` / `_SECRET` | e2e with a mocked OAuth boundary | Supported | real GitHub OAuth not run in release evidence |
| Connect a forge and choose repositories | Settings → Connections; an access token for GitHub, Gitea or GitLab | browser journey against a fixture forge (W17-30) | **Tested** against the fixture forge | the real `api.github.com` run is **blocked** (no credential on the evidence host); no real Gitea or GitLab instance connected in release evidence |
| Backfill and ingestion to `live` | a connected forge | browser journey (W17-30) | **Tested** against the fixture forge | as above |
| Webhook deliveries | forge can reach `PUBLIC_BASE_URL` | unit tests of signature and token verification; Gitea deliveries verified against Gitea 1.24.7 | Supported for GitHub, Gitea and GitLab | two receivers: `/api/v1/webhooks/github` (GitHub and Gitea, HMAC signature) and `/api/v1/webhooks/gitlab` (GitLab token); expose both through your proxy. A forge that cannot reach the install falls back to the nightly reconcile |
| Tier-1 metrics: health, hotspots, PR flow, reviews, CI, DORA-style delivery | none | populated screens (W17-30); bounds measured at 100 repos / 10,000 findings (W17-32) | **Tested** | repository lists are not paged (about 311 bytes per repository per request) |
| Tier-2 model review (OpenAI-compatible endpoint such as LM Studio) | Settings → Models | browser journey with a fixture model: connection test, checklist finding, timeout, recovery (W17-30) | **Tested** against the fixture model | a real local model was exercised in development, not in release evidence; use an instruct model, not a reasoning model |
| Tier-3 hosted model (API key) | Settings → Models, plus per-repository opt-in; writes an egress audit row | unit tests | Supported | not exercised in release evidence; API-key auth only (Vertex, Bedrock, Copilot absent) |
| Sandboxed scanners: in-house Semgrep rules, secrets, code-health tools, dependency CVEs | `deploy/scan-db-sync.sh` for CVE data | packaged-stack proof (W17-27) and journey (W17-30) | **Tested** on Podman | CVE scanning reports itself unavailable until the sync has run; Docker path unit-tested only |
| OWASP web and LLM checklist reviews (model-driven) | a Tier-2 model; enabled per repository, off by default | journey step: one checklist finding through the validator (W17-30) | **Tested** for the web checklist against the fixture model | no screen enables a per-repository scanner yet; the journey used the API route |
| CI pull: `repopulse check` fails a PR on new findings, writes SARIF and a markdown summary | a CI token (Settings → CI tokens) in `REPOPULSE_TOKEN`; see [CI_INTEGRATION.md](docs/CI_INTEGRATION.md) | API integration tests and CLI unit tests (W18-18, W20-15) | Supported | not run against a real forge pipeline in release evidence; on a PR push only the secrets stream and the sensitive-change radar scan the head — the other scanners' findings come from their scheduled runs |
| Reports and PDF export | none | unit tests (W17-26) | Supported | not part of the recorded journey |
| Backup, restore, upgrade, rollback | `deploy/backup.sh`, `deploy/restore.sh`, `deploy/up.sh` | recorded drill, 44 checks (W17-29) | **Tested** | same-version upgrade only; migrations are forward-only; a restarted `api` alone is invisible to `web` (restart the stack) |
| Health and metrics endpoints | none | unit tests | Supported | `/metrics` is unauthenticated; keep it off the public vhost |
| Accessibility (WCAG 2.2 AA via axe) | none | 78 automated scans, 9 keyboard flows (W17-31) | **Tested** | at 390 px width and 200 % zoom some paths scroll sideways inside the main area |
| Runtime APM, measured latency, CPU or memory | — | — | **Absent** | "Performance" is a review of code findings; nothing is timed |
| Test-coverage ingestion | — | — | **Absent** | the test-gap register uses commit co-change only; the screen says not supported |
| Infrastructure-as-code scanning | none (runs inside the code-health tools scan) | adapter tests over recorded real tool output (W18-26) | **Shadow candidate, not yet surfaced** | checkov (Terraform, CloudFormation, Kubernetes manifests, Dockerfiles; an allowlist of exposure, privilege, credential and encryption checks), hadolint, actionlint and shellcheck run and store findings as experimental — excluded from scores, banners, plans and reports until an admin promotes them. Helm charts are not scanned. The Security tab's `iac` scanner row still reads "not in this build"; that flips when the checks are promoted |
| Bitbucket; Kubernetes/Helm packaging; email or chat digests; PR comments or any write to your repositories | — | — | **Absent** | by decision; RepoPulse never writes to a repository |

## Coming from Slop Scorecard

[Slop Scorecard](https://github.com/bpmforge/slop-scorecard) grades one
checkout, once, on your own machine. RepoPulse runs the same kinds of check
on every tracked repository, on a schedule, keeps their history, and puts them
beside delivery, review and CI numbers. What each scorecard check becomes here:

| Scorecard check | In RepoPulse |
|---|---|
| Secrets | the secrets scanner (every scan, and the head of each PR push) |
| Phantom imports | `slop.phantom_module` / `slop.phantom_symbol` (anti-slop scanner) |
| Hallucinated dependencies | **not in this build**: the `slopsquat` rule is designed (SECURITY_SUITE.md) but no scanner writes it yet |
| Duplication | `duplication.clone` (code-health tools) |
| Dead exports | `slop.unused_export` (anti-slop scanner) |
| Dependency risk (OSV CVEs) | the dependency scanner, from the grype database (`deploy/scan-db-sync.sh`), with KEV and EPSS |

The scorecard's grade and slop index have no counterpart: RepoPulse shows
signals per repository, not a letter. The scorecard writes JSON, not SARIF, so
its results cannot be imported directly; a tool that does write SARIF can be
uploaded with `POST /api/v1/repos/{id}/external-findings/sarif` (admin). The
optional ast-grep / Opengrep rules in the scorecard's `rules/` are not loaded;
RepoPulse runs its own rule packs, which do not share their rule ids.

## Documentation

| Document | For whom | What |
|---|---|---|
| [docs/INSTALL.md](docs/INSTALL.md) | the person installing it | bundle or checkout install, first sign-in, connecting a forge, scan data, reverse proxy |
| [docs/CONFIG.md](docs/CONFIG.md) | the same person, later | every environment variable, its default, and what breaks when it is wrong |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | whoever owns the host | topology, network exposure, TLS, webhook ingress, monitoring, the scan sandbox |
| [docs/RUNBOOK.md](docs/RUNBOOK.md) | the on-call admin | backup, restore, upgrade, rollback, and the things that bit us |
| [docs/CI_INTEGRATION.md](docs/CI_INTEGRATION.md) | whoever owns your pipelines | CI tokens, `repopulse check`, exit codes, SARIF and PR-comment recipes for GitHub, GitLab and Gitea |
| [docs/RUNNING.md](docs/RUNNING.md) | developers | demo container, seeded demo mode, dev stack, tests |
| `docs/ARCHITECTURE.md`, `docs/SRS.md`, `docs/STATUS.md` | contributors | design, requirements, progress ledger |

## Stack

TypeScript on Node 22 · pnpm monorepo · Fastify · PostgreSQL 16 with Drizzle ·
Redis with BullMQ · React 18, Vite, TanStack Router and Query · Tailwind 4 with
shadcn/ui · ECharts · vitest and Playwright. Ships as container images for
Podman or Docker Compose.

## Licence

Repo Pulse is licensed under the [Apache License 2.0](LICENSE). See
[NOTICE](NOTICE) for attributions and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)
for the third-party rule packs, fixtures and tools the repository and its
container images contain, and the licence each one is under.
