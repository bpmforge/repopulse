# RP-01 — Reproducible baseline

Captured 2026-09-08 on the product-completion branch. Everything below is a
**new observation from this session**, not a restatement of `docs/STATUS.md`.
Where a check could not run, the row says so; no row is marked pass on the
strength of an old log.

## 1. Environment

| Item | Value |
|---|---|
| Repository | `/Users/bmatthews/Code/repopulse` |
| Baseline commit | `23e8666` (Merge W16-60: the local demo container) |
| Branch | `codex/repopulse-product-completion` (cut from `main`) |
| Working tree at start | clean — no dirty or untracked files |
| Node | v22.23.1 (matches `.nvmrc`) |
| pnpm | 9.15.9 (matches `packageManager`) |
| Podman | 6.1.0 (`podman-machine-default`, applehv, 9 CPU / 8 GiB / 100 GiB) |
| podman-compose | present, used by `scripts/dev-up.sh` |
| Docker | **not installed** — `docker: command not found` |
| Playwright | 1.61.1 |
| Host | darwin 25.6.0, Apple silicon |

Ports listening after the dev stack came up: `3300` (api), `3309` (demo fake
forge), `5273` (web), `5432` (postgres), `6379` (redis). Nothing was already
bound before this session; `8090` (demo container) was free and unused.

**Docker absence is a release-scope fact, not an inconvenience.** The plan
requires Docker Compose and Podman Compose to be *tested separately* before
either is claimed as supported (§1). On this host only the Podman half can
ever be evidenced. RP-04 and RP-28 must record Docker as untested rather than
inferred.

## 2. Data tier — the guard that reads as a test failure

`pnpm test` is `node scripts/check-live-infra.mjs && vitest run`. With
`DATABASE_URL`/`REDIS_URL` set but nothing listening, the guard exits 1 and
**vitest never starts**. This is correct behaviour (it prevents a hundred
misleading ECONNREFUSED failures) but it is indistinguishable from a red suite
to any wrapper that only reads the exit code.

Observed cause on this host: the Podman VM was down (`last up 2 weeks ago`) —
a crashed/stopped VM, not a stopped container, exactly as the guard's own
message predicts. `./scripts/dev-up.sh` starts the VM and both services and
reports each healthy.

> Anything that runs `pnpm test` unattended must run `scripts/dev-up.sh` first,
> or it will report an environment outage as a code regression.

## 3. Full gate at baseline

Run on `23e8666` with the data tier up. These are the numbers every later task
is measured against.

| Gate | Command | Exit | Result |
|---|---|---|---|
| Lint | `pnpm lint` | 0 | clean, no output |
| Typecheck | `pnpm typecheck` | 0 | root + all 8 workspace projects `Done` |
| Unit/integration | `pnpm test` | 0 | **267 files passed, 2 skipped (269); 1919 tests passed, 8 skipped (1927)**; 148.69s |
| Bundle | `pnpm check:bundle` | — | NOT RUN this session (RP-32 owns it) |
| e2e | `pnpm e2e` | — | NOT RUN this session (RP-30 owns it) |

Single green run only. RP-03 requires three consecutive runs before this
counts as *stably* green — one pass does not disprove the intermittent
memory-pressure failures RP-03 targets.

Config already relevant to RP-03: `vitest.config.ts` sets
`fileParallelism: false` (documented as load-bearing, W16-17) and
`playwright.config.ts` sets `workers: 1`. Both are deliberate, both are
documented, and neither should be raised to "fix" a resource problem.

## 4. Validators at baseline

| Validator | Exit | Result |
|---|---|---|
| `scripts/validate-arch.sh` | 0 | all rules PASS (incl. rule 6 no-clone, rule 7 scan-spawn confinement) |
| `scripts/validate-traceability.mjs` | 0 | no dangling references; 2 informational coverage gaps (`docs/design/CANVAS.md`, `docs/design/canvas` unreferenced) |
| `scripts/validate-plan.mjs` | **1** | **59 errors, all `id must match W<0-15>-<nn>`** |

### The plan validator is red at baseline

`scripts/validate-plan.mjs:70` enforces `W<0-15>-<nn>`. The board contains a
complete W16 wave (59 tickets, all `done`). **Every one of them is rejected**,
so the validator has been failing for the whole of W16 and cannot currently
print a claimable set.

Board totals read directly from `plan.json`: **208 tickets — 198 done,
8 blocked, 2 todo**, waves W0–W16. Ticket schema keys: `id, title, phase,
module, stories, write_scope, depends_on, acceptance, points, status, notes`.

This is a pre-existing defect, not something the RP work introduced, and it
blocks RP-02 (which must import 34 tasks into this board) and RP-34 (which
must run the validators against the final commit). Repairing a regex that lags
the board it validates is not "editing validator rules to fit this document" —
the W16 tickets already exist and already shipped. RP-02 records the decision.

There is a stale local branch named `chore/board-schema-repair` with no commits
ahead of `main`; it is not a solution in progress.

## 5. Application walkthrough

Stack: `DEMO_MODE=1 pnpm dev` — the documented from-a-checkout demo, which
seeds a warehouse so the screens are populated. Screenshots at 1440×900 and
390×844 are under `baseline/desktop-1440x900/` and `baseline/mobile-390x844/`.
All 11 screens captured at both widths (22 images). Fake forge, seeded fixture
data, no real organisation, no production data touched.

**Harness note for every later task:** `waitUntil: 'networkidle'` never
resolves on this app — the sync SSE stream keeps the network permanently busy,
so every navigation times out at 30s. Use `domcontentloaded`. This is a
property of the app, not a bug.

| Screen | Route | Browser outcome | Known gap (owning task) |
|---|---|---|---|
| Sign-in | `/` | Renders; demo banner names the credentials and prefills them | — |
| Overview | `/` | Populated: setup checklist, Weekly pulse, Delivery KPIs, Repo health, Needs attention | Order is wrong vs §4; at 1440×900 the fold lands on the *headings* of Repo health / Needs attention — **no actionable item is visible without scrolling** (RP-17). No top-three-actions section exists (RP-16) |
| Repositories | `/repos` | Renders | RP-18 |
| Repository detail | `/repos/38179?window=30d` | Renders, window preserved in URL | Performance and Activity tabs do not exist (RP-19, RP-21) |
| Findings | `/findings` | Renders | Presented as "Findings", not "Reviews" (RP-22) |
| Finding detail | desktop `/findings?window=30d` · mobile `/findings?window=30d&finding=65659` | **Divergent** — the mobile row click wrote `finding=65659` into the URL; the same click on desktop did not | Selected finding is not consistently URL state (RP-22 step 1 explicitly requires it) |
| Plans | `/plans` | Renders | RP-24, RP-25 |
| Reports | `/reports` | Renders | RP-26 |
| Settings | `/admin` | Renders | Landing page shows no setup progress or system health (RP-08) |
| My Focus | `/me` | Renders | Must survive the RP-14 nav regrouping |

### Navigation, as observed

The rail shows a **text wordmark only, no brand mark** (RP-13) and **nine flat
primary destinations**: Org Overview, Repos, Pull Requests, My Focus, Findings,
Plans, Reports, Views, Admin. §4 requires six primary plus a secondary
Workspace group (RP-14).

At 390×844 the rail collapses to a **bare column of nine unlabelled icons** —
no drawer, no labels, no trigger — consuming ~56px of a 390px viewport. This is
precisely the control RP-14 step 2 replaces with an accessible menu drawer.

## 6. RP-27 probe — run early because it cascades

RP-27 gates RP-28/29/30/31/32/33/34. Answered read-only, at RP-01 cost, so the
scope decision can be made now rather than at the end.

**The packaged worker cannot execute a scan sandbox.** Three independent
confirmations:

1. `Dockerfile:100` — the `worker` stage is `FROM base` (`node:22.23.1-alpine`)
   and installs only `tsx`. **No `podman`, no `docker` binary** is present in
   the final image.
2. It runs `USER app` (unprivileged), and `deploy/compose.yaml` sets
   `security_opt: [no-new-privileges:true]` on all five services with **no
   socket mount, no `privileged`, no `cap_add`, no `devices:`**.
3. `packages/security/sandbox/run.ts:73` defaults to `runtime: 'podman'` and
   the comment claims "docker works with the same argv" — but
   `packages/security/sandbox/profile.ts:88` unconditionally pushes
   `--timeout=<seconds>`, which is **Podman-only**. `docker run` rejects it.
   So even with a Docker binary injected, the argv is wrong — exactly the
   defect the plan's §2 predicts.

Consequence: scanners cannot run in the shipped container today, and this
cannot be fixed by installing a binary alone. RP-27 step 2 forbids the easy
escapes (privileged mode, disabling isolation, mounting the host socket), and
step 3 says to stop with a bounded runner proposal rather than improvise. That
proposal is RP-27's deliverable; it is **not** decided here.

The sandbox architecture itself is sound and enforced — `validate-arch.sh`
rule 7 passes, meaning scan tools are spawned from exactly one place.

## 7. Source observation vs observed behaviour

Rows above marked "Renders" are **observed** — a real browser loaded the route
against a real API and a seeded database, and a screenshot exists. Rows in §6
are **source observations**: read from the Dockerfile, compose file, and
sandbox source. No scan was executed. The distinction is the point of this
document; do not promote a §6 row to evidence without running it.

## 8. What this baseline does not establish

- No `pnpm e2e` run (RP-30) and no `pnpm check:bundle` run (RP-32).
- No container-stack install: `deploy/up.sh` / `deploy/demo.sh` were not
  exercised. The walkthrough used the from-checkout dev stack (RP-04, RP-28).
- No backup, restore, or upgrade drill (RP-29).
- No accessibility or contrast measurement (RP-31).
- Screenshots are demo-seeded. They show layout and hierarchy honestly; they
  prove nothing about real forge ingestion (RP-09, RP-30).
- Test suite verified green **once**, not three times (RP-03).
