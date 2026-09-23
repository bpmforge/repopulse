# RELEASE-CHECKLIST — RepoPulse v1 self-host candidate `0.1.0-rc2`, 2026-09-23 (branch `release/v1-selfhost`)

**Recommendation: HOLD — for founder-only items, not for defects.** Every
check that can run on this workstation passed on the candidate commit. What
is left needs hardware or a person this host does not have: a real amd64
machine with Docker (W11-01 / W11-05), a clean-VM human run of the docs
(W11-05), and a real Gitea instance ingested (W14-01). Nothing was merged,
tagged, published or deployed; the branch is pushed to both remotes.

| | |
|---|---|
| Candidate commit | **`814fb55`** (final code commit). Every gate, validator, bundle build and smoke below ran on it. This checklist and the evidence land in one docs-only commit on top |
| Base | `main` @ `8ba54ff` |
| Evidence directory | `docs/work/product-completion/evidence/v1-selfhost-20260923/` |
| Host | macOS / Apple M2 Max (arm64), Node 22, pnpm 9.15.9, podman client 6.1.0 → podman machine (applehv, server 5.8.2, qemu-user-static binfmt, Rosetta off), podman-compose 1.6, gitleaks 8.30.1. **No Docker** (no docker, colima, nerdctl or lima) |
| Bundles | `repopulse-0.1.0-rc2-linux-arm64.tar.gz` sha256 `109f86ec…a03860` and `repopulse-0.1.0-rc2-linux-amd64.tar.gz` sha256 `3c509e2b…635f31` (amd64 cross-built under emulation). Both built from `814fb55` with dirty=false. Both in `$HOME/tmp/`, not in git, not in any registry. v1 is bundle-only (founder decision); registry publish is deferred |

Status vocabulary as before: **PASS** ran on the candidate code, exit 0,
evidence attached. **FAIL** ran and did not pass. **BLOCKED** cannot run
here; reason given.

## 1. Gates, validators, bundles

| # | Check | Status | Evidence | Notes |
|---|---|---|---|---|
| G-1 | `pnpm lint` | PASS | `gates.txt` | on `814fb55` |
| G-2 | `pnpm typecheck` | PASS | `gates.txt` | on `814fb55` |
| G-3 | `pnpm test` | PASS | `gates.txt` | `814fb55`: 319 files passed / 2 skipped, **2466 passed / 9 skipped**, exit 0 (baseline on `8ba54ff` was 2437/9). Earlier runs on this branch: `39439c8` 2464/9 green; `425daa4` 2459 passed + 1 failed; independent verifier 2461 passed + 1 failed. The one failure both times was `packages/analysis/src/t2/live.integration.test.ts` against the LAN LM Studio host ("Failed to load model qwen/qwen3-coder-next … Operation canceled"). The branch does not touch `packages/analysis`, and the same test passed on the final run. Two consecutive green runs on the last two code SHAs (`39439c8`, `814fb55`), not three on one |
| G-4 | `pnpm e2e` (full Playwright) | PASS | `gate-e2e.txt` | `814fb55`: **153 passed, 1 skipped** (the real-forge spec, which needs a PAT and runs in G-4b), exit 0. The ✘ at `quality.spec.ts:538` is the declared `test.fail` residual (R-06), which Playwright counts as passed. The 09-11 failures E-1 and E-2 no longer reproduce; `3662936` on main fixed them |
| G-4b | Real-forge smoke `SMOKE_REAL_FORGE=1 E2E_API_PORT=3011 pnpm e2e --grep "real forge"` | PASS | `real-forge-smoke.txt` | `814fb55` (and identically on `39439c8` and `425daa4`), founder-approved. Used the fine-grained PAT from the untracked `.env.smoke`; the token was never printed, and every log was grep-checked for it (0 hits). api.github.com → connect → discover → select → backfill → `bpmforge/quarry` **live**, 9 commits, 74 commit files, all five entity cursors done with no error. Warehouse rows were created by this run (connection at 19:37:50Z). Webhook registration got 403, as expected for a read-only token, and is recorded in `last_error` |
| G-5 | `validate-arch.sh` | PASS | `validators.txt` | on `814fb55` |
| G-6 | `validate-plan.mjs` | PASS | `validators.txt` | 18 pre-existing sizing warnings on done tickets |
| G-7 | `validate-traceability.mjs` | PASS | `validators.txt` | |
| G-8 | `validate-compose.sh` | PASS | `validators.txt` | |
| G-9 | `validate-egress-audit.sh` | PASS | `validators.txt` | |
| G-10 | `pnpm check:bundle` | PASS | `validators.txt` | Initial JS is 140.8 KB gzipped against a 200 KB budget |
| G-11 | arm64 bundle build (`deploy/bundle.sh --version=0.1.0-rc2`) | PASS | `bundles.txt` | Built from `814fb55`, dirty=false, in 217 s |
| G-12 | arm64 clean-install smoke, outside the repo, disposable project | PASS | `arm64-clean-install-smoke.log` | Steps: `shasum -c` OK → extract → `install.sh --port=8396` exit 0 in 28 s. Then `/healthz` 200, `/` 200, `/api/v1/me/context` 401. Admin login 200 (`must_change_password`), forced password change 200, `/setup/status` 200. A bad-signature POST to `/api/v1/webhooks/github` **through nginx** returns 401 (not 403). All images are arm64. Then `down` → `up.sh` 10 s, migrate "up to date" (no re-migrate), and login with the **changed** password 200 (data persisted). Then `down -v`: 0 containers, 0 volumes |
| G-13 | **amd64** bundle build | PASS (under emulation) | `bundles.txt` | Cross-built with `--arch=amd64` under qemu-user. The first two attempts, on `425daa4`, failed identically: `vite build` → esbuild's Go runtime `fatal error: lfstack.push` under qemu. Fixed in `2e4c7c2`, where the SPA builds on `$BUILDPLATFORM` (RED test in `deploy-up.test.ts`). Final build from `814fb55` took 157 s with cached layers; a cold build reached the web step in 288 s |
| G-14 | **amd64** install smoke | PASS **with a deviation**, emulated | `amd64-smoke-final.log` | `install.sh` (`REPOPULSE_ALLOW_EMULATED_ARCH=1` test hatch) exit 0 in 50 s. Then `/healthz` 200, `/` 200, `/api/v1/me/context` 401, admin login 200, forced password change 200, `/setup/status` 200, and the webhook bad-signature check 401. Then `down` → `up.sh` 43 s, no re-migrate, and login with the changed password 200 (data persisted), then `down -v` clean. api, worker, web, migrate and postgres ran **amd64** images. **Deviation:** upstream amd64 `redis:7-alpine` segfaults under qemu-user (`qemu: uncaught target signal 11`, first attempt: `amd64-smoke-attempt1-2e4c7c2.log`), so the native arm64 redis was substituted. Not covered: real amd64 CPUs, Docker, scans |
| G-15 | Docker engine | **BLOCKED** | — | No Docker on this host. The founder's "amd64 + Docker" acceptance (W11-01) needs a real amd64 machine with Docker |

## 2. Code fixes on this branch (RED first; evidence in `red-evidence.txt`)

| Ticket | Fix | RED on the old code |
|---|---|---|
| W17-35 | Backfill entity fetch errors were absorbed silently: adapters read any non-2xx list response as an empty page. Now `ForgeHttpError` is raised; a permanent refusal is recorded on `sync_cursors.last_error` (migration 0029) and in `repos.last_error`, and the entity still finishes; 5xx errors fail the job so it retries or dead-letters; discovery returns 502 | 5 contract tests resolved `{items: []}`. 4 integration tests: `last_error` null, and a 502 that checkpointed `done` |
| W17-36 | Webhook receiver per forge. Gitea delivery was verified **live** (1.24.7 sends GitHub-compatible headers and `X-Hub-Signature-256`), and a captured delivery is replayed in tests. The receiver now verifies against each candidate connection. New `/webhooks/gitlab` route (`X-Gitlab-Token`), chosen through `ForgeCapabilities.webhookScheme`. GitLab subgroup paths are kept intact | Gitea delivery on a path shared with GitHub: 401. `/webhooks/gitlab`: 404. Subgroup stored as `platform`/`tools` |
| W17-37 | The api and the worker health server bound every interface. They now use `LISTEN_HOST` (default `127.0.0.1`); the images set `0.0.0.0`, and only web publishes a port, on `REPOPULSE_BIND` | Health server bound `::`; a generic `HOST=build-box.lan` was honoured |
| W17-36 (assembled app) | Pre-existing since W1-08: the CSRF plugin exempted `/webhooks`, but the receiver lives at `/api/v1/webhooks/*`. In the real app **every** delivery, GitHub's included, got 403 before its signature was checked, which is why Setup only ever showed "no delivery yet". Found by an app-level test (`app.test.ts`); fixed in `814fb55` | `app.test.ts`: both routes returned 403. After the fix they return 401 "Invalid webhook signature", and do so through nginx in G-12/G-14 |
| W11-01 (partial) | `bundle.sh --arch=`, the `install.sh` emulation test hatch, and the web build on `$BUILDPLATFORM` | `deploy-up.test.ts` BUILDPLATFORM assertion |

## 3. Independent verifier (V-1)

A separate agent session (run on `425daa4`/`2e4c7c2`), given commands rather than conclusions, re-ran
lint, typecheck, the validators and the full vitest suite. It broke each fix
and confirmed the named test went RED, then restored it. Report:
`independent-verifier.md`. It could not refute W17-35, W17-36 or W17-37.
Accepted findings:
- **GitLab subgroup webhooks would 401.** Fixed in `39439c8`.
- **`HOST` is a generic variable name.** Renamed to `LISTEN_HOST` in `39439c8`.
- Three low-severity notes are recorded on W17-35/36 as follow-ups:
  - A refusal clears on the next successful fetch of that entity.
  - GitLab's empty-project behaviour is unverified.
  - The webhook candidate query has no ORDER BY.

It did not run e2e (resource contention); G-4 above did.

## 4. Hygiene

| # | Check | Status | Notes |
|---|---|---|---|
| S-1 | No secrets entered git | PASS for this branch | gitleaks on `8ba54ff..HEAD`: **0 findings** (`secrets-gitleaks.txt`). Full-history gitleaks still exits 1 with 33 findings, all pre-dating this branch (the 09-11 triage classes; no allowlist yet, R-14). `.env.smoke` still holds the live PAT on this workstation — used for G-4b, never printed or committed. **Rotate it after the release decision** |
| S-2 | No build output or archives in git | PASS | Bundles live in `$HOME/tmp` only |
| S-3 | No disabled tests | PASS | No `.only`/`.skip` added; the new tests are live |
| S-4 | No accidental remote/production changes | PASS | Pushed `release/v1-selfhost` to origin and github only. No merge, tag, publish or deploy. Every throwaway container, network, volume and image created for this run was removed, and base-image tags that emulated builds re-pointed to amd64 were restored to native. The dev data tier stayed up throughout |

## 5. Board changes (plan.json)

- **Filed and closed:** W17-35, W17-36 and W17-37.
- **Deferred off the v1 path** (still blocked, title marked DEFERRED, each with a
  note): W7-05, W7-06, W7-07, W12-10, W14-03 and W16-09. All of these are
  bpmforge dogfood/SaaS hosting or bpmforge infrastructure, not the product.
- **W16-34:** closed as superseded by W17-03, by founder decision. The note says
  it was never diagnosed.
- **W11-01:** re-scoped to "bundle on amd64 + Docker; registry publish
  deferred". The original acceptance is preserved in a note. It stays blocked
  on a real amd64 Docker host.
- **W11-05 and W14-01:** updated with today's evidence; both stay blocked.
- **VISION.md:** the MVP lines were updated to cover D14 local accounts + PAT
  and the built Gitea adapter.
- **Setup copy:** no longer says "Register your own GitHub App".
- **`.env.example`:** the stale deployment-wide `FORGE_BASE_URL` comment is
  corrected.

## 6. Remaining items that need the founder

1. **Real amd64 host with Docker.** Run this checklist's G-12 on it: bundle →
   `install.sh` → `/healthz` → admin login → `/setup/status` → restart. This is
   W11-01's remaining acceptance.
2. **W11-05, clean-VM human run.** A person follows only `docs/INSTALL.md` on
   a machine with no checkout (can be the same VM as item 1), connects a real
   forge with a PAT, watches the backfill, reads a report, and records every
   doc gap.
3. **W14-01.** Add a Gitea token for `git.bpmforge.com`, or re-scope the ticket
   to "a real customer Gitea" if the dogfood deployment stays deferred.
4. Rotate or delete the PAT in `.env.smoke`, and decide on the
   `.gitleaks.toml` allowlist (R-14). The dev database on this workstation
   now holds the smoke's GitHub connections, with that PAT encrypted, so a
   `pnpm dev` worker would reconcile `bpmforge/quarry` with it. Rotating the
   token, or purging those rows, ends that.
5. Merge `release/v1-selfhost` → `main`, tag, and publish or hand out the bundle.
   Each of these is a separate founder authorisation.

## 6b. Residual register (updated 2026-09-23)

| ID | Residual | Status now |
|---|---|---|
| R-01 | Docker engine untested | **open**: no Docker on the host (G-15) |
| R-02 | amd64 untested | **narrowed**: built, and install-smoked under qemu-user emulation (G-13/G-14); real amd64 hardware still untested |
| R-04 | Real-forge half of the journey blocked (no PAT) | **closed**: G-4b passed against api.github.com |
| R-10 | `GITHUB_APP_PRIVATE_KEY` / `WEBHOOK_SECRET` written but unread | unchanged; `INSTALL.md` says to ignore them |
| R-11 | Gitea/GitLab webhook delivery untested | **narrowed**: Gitea delivery verified live and replayed in tests; GitLab has a route and tests against documented headers, but no live GitLab |
| R-12 | Packaged scan / restore drill not re-run | unchanged: prior-SHA evidence only (scans not exercised on rc2) |
| R-14 | gitleaks full-history exits 1; live PAT in `.env.smoke` | unchanged |
| R-06, R-07, R-08, R-09, R-13 | as in the 09-11 register below | unchanged |
| R-16 (new) | A forge list for a feature that is DISABLED (issues off, and so on) used to read as empty; if the forge answers it with a 4xx, it now shows as a permanent "issues not ingested — HTTP …". GitHub documents only 200/301/404/422 for listing issues, so the real answer is unverified | disclosed on W17-35; add it to `emptyOn` once observed live |
| R-15 (new) | The enrichment lists (PR files, check runs, reviews) still read an HTTP error as empty | follow-up on W17-35; making them throw would strand a repo in `backfilling` |

---

# Previous candidate — superseded

The 2026-09-11 checklist for `0.1.0-rc1` (`53374d6`) follows unchanged, for
the record. Its HOLD reasons E-1/E-2 were fixed on main (`3662936`) and do
not reproduce in G-4 above.

## RELEASE-CHECKLIST — RepoPulse 0.1.0-rc1 candidate, 2026-09-11 (W17-34 / RP-34)

**Recommendation: HOLD.** Two required e2e checks fail on the final commit
(rows E-1 and E-2). Everything else required by RP-34 passed against the
same SHA. Nothing was pushed, merged, tagged, published or deployed.

| | |
|---|---|
| Final commit under test | `53374d685f193a9f9e66cdd7e32908746d3fdc44` (branch `codex/repopulse-product-completion`, tip at the time every check below ran) |
| Working tree at run time | clean except `plan.json` and `docs/work/product-completion/**` (this ticket's own write scope; no product source, `deploy/` or test file differs from the SHA) |
| Evidence directory | `docs/work/product-completion/evidence/w17-34-release-20260911/` — every pointer below is relative to it |
| Host | macOS 26 / Apple M2 Max (arm64), Node v22.23.2, pnpm 9.15.9, podman client 6.1.0 → rootless podman machine (server 5.8.2), podman-compose 1.6, gitleaks 8.30.1, Playwright 1.61.1 / headless Chromium |
| Tested bundle | `repopulse-0.1.0-rc1-linux-arm64.tar.gz`, sha256 `a3e6a1699725f0d455748b048df4b7fd31e05ca42e02fdf4db44e7c3f49e7dba`, 694 MB, built 2026-09-11T06:21:50Z from `53374d6` (`GIT_DIRTY=true` because of the docs/plan files above); images `localhost/repopulse/{migrate,api,worker,scan-runner,web,scan}:0.1.0-rc1` plus `docker.io/library/postgres:16` and `redis:7-alpine`; **linux/arm64 only** |
| Location of the bundle | `$HOME/tmp/rp-bundle-w1734/` on this workstation. Not in git, not in any registry |

Status vocabulary: **PASS** = ran on `53374d6`, exit 0, evidence attached.
**FAIL** = ran, did not pass. **BLOCKED** = could not be run here; reason
given. No row is marked PASS from a log produced on an earlier SHA.

## 1. RP-34 step 1 — gates, validators, bundle, clean install on the same commit

| # | Check | Status | Evidence | Notes |
|---|---|---|---|---|
| G-1 | `pnpm lint` | PASS | `gate-lint-typecheck.txt` (`EXIT lint=0`) | eslint, whole workspace |
| G-2 | `pnpm typecheck` | PASS | `gate-typecheck-exit.txt` (`EXIT=0`) | The first capture in `gate-lint-typecheck.txt` lost its exit line; re-run on the same SHA to record it |
| G-3 | `pnpm test` (vitest, unit + integration against local Postgres/Redis) | PASS | `gate-test-run1.txt`, `gate-test-run2.txt`, `gate-test-run3.txt` | 3 consecutive runs, each `314 files passed / 2 skipped`, `2435 tests passed / 9 skipped`, `EXIT=0`. Skips are environment-conditional (row S-3), not disabled tests |
| G-4 | `pnpm e2e` (Playwright, full suite against the seeded dev stack) | **FAIL** | `gate-e2e.txt` | `150 passed, 3 failed, 1 skipped, EXIT=1`. The three ✘ are analysed in §2: two are real failures (E-1, E-2); the third (E-3) is a declared expected failure and does not count. First attempt aborted on a port held by an orphaned process from the W17-32 session; killed and re-run, recorded in the file |
| G-5 | `bash scripts/validate-arch.sh` | PASS | `validators.txt` | 7/7 rules PASS |
| G-6 | `node scripts/validate-plan.mjs` | PASS | `validators.txt` | OK; 18 pre-existing sizing warnings on done tickets, unchanged |
| G-7 | `node scripts/validate-traceability.mjs` | PASS | `validators.txt` | OK; 2 pre-existing GAP-step inputs (CANVAS.md unreferenced), unchanged |
| G-8 | `bash scripts/validate-compose.sh` | PASS | `validators.txt` | 12/12 rules PASS |
| G-9 | `bash scripts/validate-egress-audit.sh` | PASS | `validators.txt` | INSERT allowed, UPDATE/DELETE denied for `repopulse_app` |
| G-10 | `pnpm check:bundle` (web production build + size budget) | PASS | `bundle-check.txt` | Initial JS 140.5 KB gzipped, budget 200 KB, `EXIT=0`. Vite's >500 kB chunk warning is for lazy `echarts`, not initial JS |
| G-11 | Bundle build from the final commit (`deploy/bundle.sh --version=0.1.0-rc1`) | PASS | `bundle-build.log` | Manifest `git_sha` = `53374d6…`, checksum above; nothing published |
| G-12 | Clean-install smoke of that bundle, README steps, outside the repo, disposable project | PASS | `clean-install-smoke.txt` | `shasum -c` OK → extract → `install.sh --port=8399` exit 0 (checksums verified, 6 images loaded, `deploy/.env` generated, 7 containers up) → `/healthz` 200, `/` 200, `/api/v1/me/context` 401 unauthenticated, bootstrap admin login 200 `must_change_password` → `down -v`, 0 containers / 0 volumes left. Deviations from the literal README line, as in W17-33: `REPOPULSE_PROJECT` and `--port` set so the run cannot collide with the dogfood stack on this host |

## 2. The e2e failures, individually

| # | Test | Status | Evidence | What is wrong |
|---|---|---|---|---|
| E-1 | `e2e/org-overview.spec.ts:110` "the org overview composes through WidgetGrid with 2x2 heroes (W4-21, R-D2)" | **FAIL** | `gate-e2e.txt`, `gate-e2e-isolation.txt` | Assertion `every panel is the same width — that is a spreadsheet`: every panel on `/` now spans the same grid width. Deterministic — fails alone too (1 failed / 6 passed). Attribution: W17-17 (2026-09-10) put the `top-actions` widget first in `orgWidgets` and recorded that this spec was outside its write scope and "NOT verified in a live browser"; no full e2e run is recorded between W17-17 and this one. Either the layout regressed to equal widths or the spec's bento contract was invalidated without being updated. Product-code fix or spec decision required; not made here |
| E-2 | `e2e/quality.spec.ts:157` and `:166` "axe: every listed screen, dark / light theme, 1440px" | **FAIL** | `gate-e2e.txt`, `gate-e2e-isolation-run2.txt`, `gate-e2e-axe-repro.txt` | `serious: link-in-text-block` on `/admin/agreements` (6 nodes, `.text-accent[href$="prs/5"]` links inside `.text-xs` exception-list text: colour is the only thing distinguishing the link). Passes in isolation because the seed has no exception rows; fails deterministically once `admin.spec.ts` W5-08 configures agreements with exception lists (reproduced: admin + a11y + quality, single worker → 2 failed / 3 passed). W17-31's 0-violation result on `dac3339` was on the empty state. Real WCAG 1.4.1 defect on a state customers reach; CSS fix required; not made here |
| E-3 | `e2e/quality.spec.ts:538` "no horizontal overflow at 390px, 200% zoom" | not a failure | `gate-e2e-isolation-run3.txt`, W17-31 §3 | Marked `test.fail()` in the spec: a declared, measured residual (195 CSS-px viewport, below WCAG 1.4.10's 320 px floor; 14/28 paths overflow 16–129 px). Playwright prints ✘ and counts it as passed (`1 passed, EXIT=0`). Listed so the ✘ in `gate-e2e.txt` is not misread; the file's `3 failed` count is E-1 + E-2 (two theme variants) |

## 3. RP-34 step 2 — independent verifier

| # | Check | Status | Evidence | Notes |
|---|---|---|---|---|
| V-1 | Fresh verifier session re-derives lint, validators, unit tests, gitleaks and the spot-checks by running them, then compares against this session's files | PASS (re-derived; agrees) | `independent-verifier.md` | Separate agent session (06:22–06:29Z), given commands not conclusions. Its own runs: lint 0; four validators 0; `pnpm test` `314 passed / 2 skipped` files, `2435 passed / 9 skipped` tests, identical to G-3; gitleaks 17/25 with its own triage reaching the same classes as `secrets-triage.md` (0 real secrets in git; `temp_clone_token` = expired recorded value; `.env.smoke` = live PAT, untracked and ignored). It did not run e2e (port collision with the run in progress). Discrepancies it raised, all accepted: (1) W17-34 was `todo` at HEAD and `in_progress` only in the working tree — the claim was never committed separately; this closing commit carries both; (2) the e2e gate is red at HEAD and `org-overview` was never shown green on this SHA — agreed, that is E-1 and the reason for HOLD; (3) `disabled-tests.txt` did not list the `test.fail` marker at `quality.spec.ts:547` — appended to that file; (4) gitleaks has no allowlist and stays non-clean — recorded in §6 |

## 4. RP-34 step 3 — hygiene

| # | Check | Status | Evidence | Notes |
|---|---|---|---|---|
| S-1 | No secrets entered git | PASS, with notes | `secrets-gitleaks.txt`, `secrets-triage.md` | gitleaks exits 1 (17 history / 25 tree hits) and every hit is classified: 13 identifiers or test placeholders, 1 demo-stack placeholder key, 1 recorded-fixture `temp_clone_token` that expired the day it was recorded in 2026-07 (a sanitizer gap, listed as follow-up), and 8 in gitignored, never-committed `.env` files. One of those, `.env.smoke`, holds a **live fine-grained PAT on this workstation** — not in git, not a release blocker, flagged for the operator to rotate or delete |
| S-2 | No generated source snapshots or build output in git | PASS | `generated-in-git.txt` | No tracked `dist/ build/ coverage/ *.tsbuildinfo` or archives; only tracked `.env*` files are the two `.env.example` templates; one tracked file >1 MB is the design canvas HTML (a design doc, pre-existing) |
| S-3 | No disabled tests | PASS | `disabled-tests.txt` | No `.only`, `.todo`, `xit`, or unconditional `.skip` in tracked test files. The vitest "9 skipped" are `describe.skip` chosen at runtime only when a scan image, vulnerability DB, docker, or podman live image is absent; the one Playwright `test.skip` is the real-forge smoke without a PAT. None hides a failing test |
| S-4 | No dead navigation | PASS (by prior same-branch evidence, not re-run here) | W17-30 `w17-30-journey-20260911.md`, W17-14 STATUS entry, `gate-e2e.txt` | Deep-link and secondary-navigation e2e specs (RP-14/RP-19) are inside the 150 passing tests of G-4 on this SHA; the W17-30 journey walked every rail entry. No navigation test is among the 3 failures |
| S-5 | No unsupported capability presented as working | PASS (by prior same-branch evidence) | W17-33 `w17-33-readme-install-20260911.md`, README capability matrix | README lists runtime APM, coverage ingestion, IaC, Bitbucket, Helm, digests and repository writes as ABSENT and separates "supported" from "tested"; the `iac` scanner reads "not in this build" in the UI. README is unchanged between W17-33 and this SHA (W17-33 is the tip) |
| S-6 | No accidental production or remote changes | PASS | `no-publish.txt` | No push, tag, merge or deploy from this ticket. Branch is 39 commits ahead of both `main` remotes. The branch itself was already on `origin` (Gitea) at this SHA before this ticket began; GitHub has no copy of the branch. The bpmforge dogfood install was not touched |

## 5. Plan §6 final acceptance matrix, mapped to evidence on this branch

Rows whose proof is a prior ticket's evidence are marked with that ticket; those runs were on earlier SHAs of this same branch and are not re-executed here except where G-3/G-4/G-12 already cover them on `53374d6`.

| Requirement | Proof required | Status | Evidence |
|---|---|---|---|
| Customer can install independently | RP-28 bundle smoke, RP-33 README walkthrough | PASS on final SHA | G-11, G-12 (this ticket) plus `w17-28-bundle-smoke-20260910.md`, `w17-33-readme-install-20260911.md` |
| Broken worker cannot look fully healthy | RP-06 heartbeat, RP-08 UI failure/recovery | PASS | unit/integration tests in G-3; W17-30 journey step 12 (dead-worker drill) |
| No AI required for basic value | RP-09 metadata-only journey | PASS | `e2e/first-run.spec.ts` in G-4's passing set; W17-09 STATUS entry |
| Supported AI actually produces reviews | RP-11 worker/gateway integration, RP-30 journey | PASS | G-3 (gateway/worker integration tests); `w17-30-journey-20260911.md` |
| Outbound review policy/auditing works | RP-11 network-attempt and audit-failure tests | PASS | G-3, G-9; W17-11 STATUS entry |
| Supported scanners actually execute | RP-27 packaged sandbox run | PASS (prior SHA `d3b85bc`-era images) / not re-run on `53374d6` | `w17-27-packaged-scan-proof-20260910.md`. The scan image was rebuilt in G-11 but a packaged scan was not re-executed here |
| Code/security/performance evidence is honest | RP-10 state matrix, RP-20/21 negative cases | PASS | G-3 (negative-case tests present and green); W17-10/20/21 STATUS entries |
| Findings lead to useful actions | RP-22–RP-25 journey and verification fixtures | PASS | G-3, G-4 passing set; `w17-30-journey-20260911.md` |
| Existing features remain reachable | RP-14/RP-19 deep-link and secondary navigation tests | PASS | G-4 passing set (S-4) |
| Product looks polished and is usable | RP-31 screenshots, axe, keyboard, zoom | **FAIL** | E-2 (axe serious violation on a populated agreements page); rest of W17-31 evidence stands |
| Reports and user data survive operations | RP-26 persistence, RP-29 restore/upgrade drill | PASS (prior SHA) | `w17-29-backup-restore-drill-20260910.md` + `.log`; not re-run on `53374d6` |
| No feature is declared complete from stale logs | RP-34 final-commit evidence | this document | every §1 row ran on `53374d6`; §5 rows that lean on earlier SHAs say so |

## 6. Known limitations carried into the candidate

- Tested on linux/arm64 under rootless podman only. docker and amd64 are untested (README says so).
- 390 px at 200 % zoom overflows on 14 of 28 paths (E-3, declared).
- `GITHUB_APP_PRIVATE_KEY` and `WEBHOOK_SECRET` are written by `configure.mjs` but read by nothing (W17-33 finding; template fix pending).
- `iac` scanner absent; runtime APM, coverage ingestion, Bitbucket, Helm, digests and repository writes absent (README capability matrix).
- `.gitleaks.toml` has no allowlist for the test placeholders, so the SC-18 gate exits 1 until one is added (a security-control edit, not made here).
- Fixture recorder does not scrub `temp_clone_token` (secrets-triage.md, follow-up).

## 6b. Residual register (carried from W17 tickets)

Accepted residuals and known gaps. None of these alone flip HOLD (E-1/E-2 do); they must travel with any GO decision.

| ID | Residual | Source | Status |
|---|---|---|---|
| R-01 | Docker engine untested (podman-only evidence) | W17-27/28/30/33/34 | accepted |
| R-02 | amd64 / non-arm64 images and bundle untested | W17-28/33/34 | accepted |
| R-03 | Docker-on-docker / privileged docker socket on worker unproven | W17-27 | accepted (do not reopen unless Bradford asks) |
| R-04 | Real-forge half of customer journey **BLOCKED** — no `SMOKE_FORGE_PAT` on host; W11-05 stays blocked | W17-30 | BLOCKED |
| R-05 | nginx DNS sticky (compose overlay / demo networking) | W17-30 | accepted for now |
| R-06 | 390px @ 200% zoom horizontal overflow on 14/28 paths (`test.fail`, below WCAG reflow floor) | W17-31 / E-3 | declared residual |
| R-07 | Findings vs Reviews breadcrumb / rail label mismatch | W17-31 | accepted residual |
| R-08 | Security scanner `all_rejected` label conflates dedupe-noop with true rejections | W17-30 | small follow-up |
| R-09 | Repo / health-tiles / attention list payloads unpaged (grow with N) | W17-32 | accepted residual |
| R-10 | `GITHUB_APP_PRIVATE_KEY` / `WEBHOOK_SECRET` written by `configure.mjs` but unread | W17-33 | template fix pending |
| R-11 | Gitea/GitLab webhook delivery untested (receiver reads GitHub headers; rely on nightly reconcile) | W17-33 | hypothesis / untested |
| R-12 | Packaged scan (W17-27) and backup/restore drill (W17-29) not re-executed on tip `53374d6` | W17-34 §5 | prior-SHA evidence only |
| R-13 | Stale / attachable vuln-db residual from packaged proof path | W17-27 | accepted residual |
| R-14 | gitleaks exits 1 without allowlist for test placeholders; live PAT may exist in untracked `.env.smoke` | W17-34 S-1 | operator follow-up |

## 7. What has to happen before GO

1. Fix E-1 (overview widget widths or the spec's contract) and E-2 (visible link affordance on exception-list links) in product code, on a new commit.
2. Re-run the full gate on that commit: G-1–G-10 plus `pnpm e2e` to 0 failures; rebuild the bundle (G-11) and repeat the clean-install smoke (G-12) from it. Every row in §1 must be re-dated to the new SHA — this checklist is only valid for `53374d6`.
3. Operator: rotate or delete the PAT in `.env.smoke`; decide on the `.gitleaks.toml` allowlist.
4. Publishing, merging to `main`, tagging and deploying remain separately authorised (D10, RP-34 step 5).
