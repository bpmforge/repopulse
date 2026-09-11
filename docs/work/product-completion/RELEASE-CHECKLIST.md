# RELEASE-CHECKLIST — RepoPulse 0.1.0-rc1 candidate, 2026-09-11 (W17-34 / RP-34)

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

## 7. What has to happen before GO

1. Fix E-1 (overview widget widths or the spec's contract) and E-2 (visible link affordance on exception-list links) in product code, on a new commit.
2. Re-run the full gate on that commit: G-1–G-10 plus `pnpm e2e` to 0 failures; rebuild the bundle (G-11) and repeat the clean-install smoke (G-12) from it. Every row in §1 must be re-dated to the new SHA — this checklist is only valid for `53374d6`.
3. Operator: rotate or delete the PAT in `.env.smoke`; decide on the `.gitleaks.toml` allowlist.
4. Publishing, merging to `main`, tagging and deploying remain separately authorised (D10, RP-34 step 5).
