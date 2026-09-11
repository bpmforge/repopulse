# Independent verifier — W17-34 (RP-34 Final acceptance and release handoff)

- SHA verified: `53374d685f193a9f9e66cdd7e32908746d3fdc44` (branch `codex/repopulse-product-completion`)
- Start: 2026-09-11T06:22:23Z  ·  End: 2026-09-11T06:29:24Z (vitest finished; report written immediately after)
- This was a SEPARATE agent session from the primary W17-34 session. Every number below was re-derived by running the command in this session; nothing was copied from the primary's evidence files except where explicitly compared in "Evidence-file comparison".
- Machine load: a podman image build and a Playwright run were executing concurrently. Timings are not meaningful.
- Files modified by this session: this file only. No git state changed.

## Commands run

| # | Command | Exit | Key output |
|---|---------|------|------------|
| 1 | `git rev-parse HEAD` | 0 | `53374d685f193a9f9e66cdd7e32908746d3fdc44` |
| 1 | `git status --short` | 0 | ` M plan.json` and `?? docs/work/product-completion/evidence/w17-34-release-20260911/` — no other dirty paths |
| 2 | `pnpm lint` | 0 | Only output: `> repopulse@0.1.0 lint` / `> eslint .` (plus the pnpm onlyBuiltDependencies warning). No lint findings. |
| 3 | `bash scripts/validate-arch.sh` | 0 | `validate-arch: all rules PASS`; no FAIL lines |
| 3 | `node scripts/validate-plan.mjs` | 0 | `OK: plan.json is valid.`; no FAIL lines (ran against working-tree plan.json, which has W17-34 = in_progress) |
| 3 | `node scripts/validate-traceability.mjs` | 0 | `OK: traceability chain has no dangling references.` Also prints `Coverage gaps (2) — GAP-step input, not failures:`; no FAIL lines |
| 3 | `bash scripts/validate-compose.sh` | 0 | `validate-compose: all rules PASS`; no FAIL lines |
| 4 | `pnpm test` (one run, start 06:23:xxZ, end 06:29:24Z) | 0 | ` Test Files  314 passed \| 2 skipped (316)` / `      Tests  2435 passed \| 9 skipped (2444)` / `Duration  388.63s`. No failing files; no re-run needed. |
| 5 | `gitleaks git --no-banner -c .gitleaks.toml … .` | 1 (leaks found) | `407 commits scanned`, `leaks found: 17` |
| 5 | `gitleaks dir --no-banner -c .gitleaks.toml … .` | 1 (leaks found) | `leaks found: 25`; 8 of the 25 are in files not present in the git report (all three files untracked + gitignored, see triage) |
| 7a | `git show HEAD:plan.json` → find `W17-34` | 0 | At HEAD: `{"id":"W17-34","title":"Final acceptance and release handoff","status":"todo"}`. In the uncommitted working-tree plan.json: `status: "in_progress"`. |
| 7b | `git ls-files \| grep -E '(^\|/)(dist\|build\|coverage)/'` | grep 1 | No output — no tracked dist/build/coverage directories |
| 7c | grep `test.skip` / `it.skip` / `describe.skip` / `.skipIf` / `.runIf` over tracked `*.test.*` / `*.spec.*` | grep 0 | 101 matches. 100 are of the form `const describeIfX = <env condition> ? describe : describe.skip;` (or `(dockerAvailable ? describe : describe.skip)(…)`) keyed on `DATABASE_URL`/`REDIS_URL`/scan image/podman/docker/LM Studio availability. 1 is Playwright `test.skip(!PAT, 'set SMOKE_FORGE_PAT in .env.smoke …')` at `e2e/smoke-real-forge.spec.ts:41`. All environment-conditional; no unconditional skips. |
| 7c+ | grep `test.(fail\|fixme\|only)(` over tracked `e2e/` | grep 0 | One hit: `e2e/quality.spec.ts:547` `test.fail(width === 390 && zoom === 2, 'W17-31 residual: …')` — an expected-failure marker on the "no horizontal overflow at 390px, 200% zoom" test. |
| — | `pnpm e2e` | not run | Deliberately not run by this session: a Playwright run was already in progress on this machine and would collide on ports 3310 etc. |

## gitleaks triage — GIT report (17 findings, history scan)

Each line was opened at the flagged commit; "at HEAD" says whether the identical line still exists at that path/line in HEAD.

| File:line @commit | Line content (trimmed) | At HEAD | Classification |
|---|---|---|---|
| `deploy/compose.demo.yaml:97` @4b082f59 | `TOKEN_ENC_KEY: '00112233…eeff'` (32-byte 0x00..0xff pattern, repeated) | no (moved/changed) | TEST PLACEHOLDER — sequential-hex demo key for the demo compose stack, not a generated secret |
| `apps/web/src/widgets/auth/CreateUser.test.tsx:19` @56e733e5 | `temporary_password: 'RXhhbXBsZS1PbmNlLU9ubHk'` (base64 of "Example-Once-Only") | yes | TEST PLACEHOLDER |
| `packages/reports/src/assembler/risk.integration.test.ts:140` | `dedupKey: 'w9-12-unpriced'` | yes | IDENTIFIER-NOT-A-SECRET (ticket-named dedup key) |
| `packages/insights/src/score/health.ts:217` @a73bdbb8 | `{ key: 'complexityP90', raw: … }` | no (line moved) | IDENTIFIER-NOT-A-SECRET (metric key name) |
| `packages/reports/src/assembler/code-health.integration.test.ts:157` | `dedupKey: 'w9-06-complexity'` | yes | IDENTIFIER-NOT-A-SECRET |
| `packages/reports/src/assembler/code-health.integration.test.ts:185` | `metricKey: 'ch_complexity_p90'` | yes | IDENTIFIER-NOT-A-SECRET |
| `packages/security/src/scanners/code-health/run.ts:122` @e7dc748e | `{ key: 'ch_complexity_p90', value: … }` | no (line moved) | IDENTIFIER-NOT-A-SECRET |
| `packages/security/src/scanners/anti-slop/run.integration.test.ts:267` | `dedupKey: 'w9-03-slopsquat'` | yes | IDENTIFIER-NOT-A-SECRET |
| `packages/security/src/scanners/chainer/run.integration.test.ts:145/153/161` | `dedupKey: 'w8-09-compound-1/2/3'` | yes | IDENTIFIER-NOT-A-SECRET (3 findings) |
| `e2e/admin.spec.ts:32` | `const secret = 'ghp_e2e_never_echo_me_0123456789ABCDEF';` | yes | TEST PLACEHOLDER (self-describing fake PAT used to assert the UI never echoes it) |
| `packages/insights/src/score/health.ts:158` @ef5c718f | `{ key: 'e2eCycleP50Hours', … }` | no (line moved) | IDENTIFIER-NOT-A-SECRET |
| `packages/auth/src/credentials/vault.test.ts:12` @e9976aca | `const TOKEN = 'ghp_exampleSecretTokenValue1234567890ABCD';` | no (line changed) | TEST PLACEHOLDER ("example" in the value; ghp_ prefix with non-random tail) |
| `packages/ingest/src/connect/connect.integration.test.ts:67` @e9976aca | `const TOKEN = 'ghp_connectFlowSecretTokenABCDEFGH1234567890';` | no (line changed) | TEST PLACEHOLDER |
| `apps/api/src/routes/connections/index.test.ts:20` | `const TOKEN = 'ghp_routeTestSecretTokenABCDEFGH1234567890XY';` | yes | TEST PLACEHOLDER |
| `packages/forge/fixtures/github/repo-get-200-etag.json:132` @07d15b1d | `"temp_clone_token": "AA2SVNE2Y6DPX3WSSYOUHV3KLQSGG",` | yes | RECORDED-FIXTURE-VALUE — see note below |

**Note on `temp_clone_token` (fixture line 132).** This is a recorded GitHub `GET /repos/{owner}/{repo}` response (the surrounding keys `permissions`, `allow_squash_merge`, `squash_merge_commit_message`, etc. are the real API shape). GitHub returns `temp_clone_token` only when the request is authenticated; it is a short-lived (minutes-scale) token that grants temporary clone access to that one repository and is issued fresh per response. The value here was captured when the fixture was recorded and has long since expired; it cannot be used now. So: not a live secret and not a placeholder either — it is a real-but-expired value captured from a live API response. My assessment: RECORDED-FIXTURE-VALUE, no current exposure; the only residual concern is hygiene (a recorded fixture retained a token-shaped field rather than scrubbing it to a placeholder). A `.gitleaksignore`/allowlist entry or scrubbing the field would make the scan clean; neither has been done at HEAD.

Summary: 0 REAL SECRET, 6 TEST PLACEHOLDER, 10 IDENTIFIER-NOT-A-SECRET, 1 RECORDED-FIXTURE-VALUE.

## gitleaks triage — DIR report (25 findings; 8 in files NOT in the git report)

The other 17 dir findings are the same file/line pairs as the git report at HEAD and are not repeated here.

| File:line | Rule | Value (redacted by me) | `git ls-files --error-unmatch` | `git check-ignore` | Assessment |
|---|---|---|---|---|---|
| `.env.smoke:1` | github-fine-grained-pat | `github_pat_11AA2SVNA0…` (full-length fine-grained PAT) | NOT tracked | ignored | Looks like a REAL personal access token (fine-grained PAT format, non-placeholder body) used for the real-forge smoke test. It is untracked and gitignored, so it is not in the repo; it lives only on this machine. Not printed in full anywhere in this report. |
| `.env:22`, `.env:24`, `.env:29` | generic-api-key | three 64-hex values | NOT tracked | ignored | Local dev secrets (encryption key / session secret shaped). Real for this machine; not in git. |
| `deploy/.env:3`, `:4` | generic-api-key | two 48-hex values | NOT tracked | ignored | Local deploy-stack secrets. Not in git. |
| `deploy/.env:9`, `:10` | generic-api-key | two 64-hex values | NOT tracked | ignored | Local deploy-stack secrets. Not in git. |

All three extra files are untracked and gitignored; none of the 8 values appear in the git history scan.

## Evidence-file comparison (primary session's files, read only)

- `gate-test-run1.txt`: header `SHA 53374d685f193a9f9e66cdd7e32908746d3fdc44  start 2026-09-11T05:52:20Z`; summary `Test Files  314 passed | 2 skipped (316)` / `Tests  2435 passed | 9 skipped (2444)`; `EXIT=0`. **SHA matches HEAD; counts match my run exactly.** `gate-test-run2.txt` and `gate-test-run3.txt` carry the same SHA and identical counts, EXIT=0.
- `gate-e2e.txt`: header SHA `53374d685f19…` — **matches HEAD**. Result: `3 failed`, `1 skipped`, `150 passed (4.2m)`, `EXIT=1`. The three failures: `org-overview.spec.ts:110` ("every panel is the same width — that is a spreadsheet"), `quality.spec.ts:157` and `:166` (serious/critical axe violations on `settings-agreements` @1440 dark/light), and `quality.spec.ts:538` (390px/200% overflow). Not re-run by me (see above).
- `gate-e2e-isolation.txt` / `-run2.txt` / `-run3.txt` (same SHA): org-overview re-fails in isolation (`1 failed / 6 passed`, EXIT=1) — a **consistent failure at HEAD**, not load-related. The two axe tests **pass** in isolation (EXIT=0). The 390px/200% test prints `✘` then counts as passed with EXIT=0 in both reruns; this is because it carries `test.fail(...)` (`e2e/quality.spec.ts:547`), i.e. it is an expected failure, so the `✘` is the expected outcome and Playwright reports it as passed.
- `secrets-gitleaks.txt`: git `leaks found: 17`, dir `leaks found: 25`, both EXIT=1 — matches my counts exactly.
- `disabled-tests.txt`: lists `test.skip` at `e2e/smoke-real-forge.spec.ts:41` and the four scan-image/podman/docker `describe.skip` conditionals; its Playwright grep pattern was `test.skip / fixme / test.only` and therefore does not list the `test.fail(` marker at `e2e/quality.spec.ts:547`.

## Discrepancies

1. **W17-34 status at HEAD is `todo`, not `in_progress`.** The claim "ticket exists with status in_progress at HEAD" is false for the committed tree; `in_progress` exists only in the uncommitted working-tree `plan.json` (the ` M plan.json` in `git status`). The claim-to-commit step (`Claim = set in_progress + commit`, CLAUDE.md Law 1) has not been committed.
2. **The full e2e gate is red at HEAD.** `gate-e2e.txt` is EXIT=1 with 3 failures, and `e2e/org-overview.spec.ts:110` fails again in isolation with the same assertion (`every panel is the same width — that is a spreadsheet`). Only the two axe failures were shown to pass on rerun; org-overview was never shown green at this SHA in any evidence file. Any "gate green" statement for W17-34 would not be supported by the evidence directory as it stands. (Unit tests, lint, and all four validators are green in my run.)
3. **`disabled-tests.txt` omits the `test.fail` marker** at `e2e/quality.spec.ts:547`. It is an expected-failure marker, not a skip, but it is a disabled-assertion marker in the same family and the primary's inventory does not mention it.
4. **gitleaks is not clean and has no allowlist**: 17 history findings persist (all non-secret on inspection, one being an expired recorded `temp_clone_token`). Primary's counts match mine; this is recorded as a fact, not a mismatch.
5. **`.env.smoke` on this machine contains what appears to be a live fine-grained GitHub PAT.** It is untracked and gitignored (verified), so it is not a repository leak, but it is present in the working directory that the dir scan covers.

No discrepancies found in: HEAD SHA, dirty-path set, lint exit, validator exits, vitest counts (all three primary runs and mine agree: 314/2 files, 2435/9 tests), gitleaks counts (17/25), tracked build-artifact check, environment-conditional skip inventory.
