# W17-34 — gitleaks triage, SHA 53374d685f193a9f9e66cdd7e32908746d3fdc44, 2026-09-11

`secrets-gitleaks.txt` records gitleaks 8.30.1 exiting 1 on both scans:
17 findings across all 407 commits of history, 25 findings in the working
tree. This file classifies every one. Nothing was rewritten, scrubbed or
deleted; history is untouched. The JSON reports were regenerated for this
triage with the same config (`.gitleaks.toml`, default ruleset plus an
allowlist for `.env.example`).

Verdict on the acceptance item "no secrets entered git": **PASS with two
notes** — nothing in git history is a live credential. Two things need an
operator's eyes and are listed under "Action for the operator"; neither is
in git.

## History scan (17) — all tracked, all classified

| # | Rule | File:line | Value (truncated) | Class | Why |
|---|---|---|---|---|---|
| 1 | generic-api-key | deploy/compose.demo.yaml:105 | `0011223344…eeff` | DEMO PLACEHOLDER | `TOKEN_ENC_KEY` for the demo stack; a counting-hex pattern, comment on the line above says it only ever seals the fixture's own fake token. Not usable anywhere else. |
| 2 | generic-api-key | apps/web/src/widgets/auth/CreateUser.test.tsx:19 | `RXhhbXBsZS1PbmNlLU9ubHk` | TEST PLACEHOLDER | base64 of "Example-Once-Only"; a unit-test fixture for the one-time password display. |
| 3 | generic-api-key | packages/reports/src/assembler/risk.integration.test.ts:140 | `w9-12-unpriced` | IDENTIFIER | A finding key string in a test; not a credential. |
| 4 | generic-api-key | packages/insights/src/score/health.ts:232 | `complexityP90` | IDENTIFIER | A metric key name in source. |
| 5 | generic-api-key | packages/reports/src/assembler/code-health.integration.test.ts:157 | `w9-06-complexity` | IDENTIFIER | Test fixture key. |
| 6 | generic-api-key | packages/reports/src/assembler/code-health.integration.test.ts:185 | `ch_complexity_p90` | IDENTIFIER | Metric key. |
| 7 | generic-api-key | packages/security/src/scanners/anti-slop/run.integration.test.ts:267 | `w9-03-slopsquat` | IDENTIFIER | Test fixture key. |
| 8 | generic-api-key | packages/security/src/scanners/code-health/run.ts:171 | `ch_complexity_p90` | IDENTIFIER | Metric key in source. |
| 9–11 | generic-api-key | packages/security/src/scanners/chainer/run.integration.test.ts:145,153,161 | `w8-09-compound-{1,2,3}` | IDENTIFIER | Test fixture keys. |
| 12 | generic-api-key | e2e/admin.spec.ts:32 | `ghp_e2e_never_echo_me_0123456789ABCDEF` | TEST PLACEHOLDER | Deliberately fake PAT the e2e types into the connection form to prove it is never echoed back. Fails GitHub's format (underscores). |
| 13 | generic-api-key | packages/insights/src/score/health.ts:260 | `e2eCycleP50Hours` | IDENTIFIER | Metric key. |
| 14 | github-pat | packages/auth/src/credentials/vault.test.ts:14 | `ghp_exampleSecretTokenValue1234567890ABC` | TEST PLACEHOLDER | Vault seal/unseal unit-test constant. |
| 15 | github-pat | packages/ingest/src/connect/connect.integration.test.ts:75 | `ghp_connectFlowSecretTokenABCDEFGH123456` | TEST PLACEHOLDER | Connect-flow test constant. |
| 16 | github-pat | apps/api/src/routes/connections/index.test.ts:20 | `ghp_routeTestSecretTokenABCDEFGH12345678` | TEST PLACEHOLDER | Route test constant. |
| 17 | generic-api-key | packages/forge/fixtures/github/repo-get-200-etag.json:132 | `AA2SVNE2Y6DPX3WSSYOUHV3KLQSGG` | RECORDED FIXTURE VALUE, EXPIRED | The `temp_clone_token` field of a real `GET /repos/{owner}/{repo}` response recorded 2026-07-18 (W0-04). GitHub issues this token for a few minutes for authenticated `git clone` of a private repo; it expired the same day. The W0-04 sanitizer scrubs headers and `ghp_`/`gho_`-shaped strings and did not know this field. Not a live secret; it IS a sanitizer gap (see below). |

Line numbers are the working-tree lines; the history hits are the same
strings at their original lines (the JSON report carries the commit SHAs).

## Working-tree scan (25) — 8 more than history

The 17 above recur (same strings). The 8 extra are all in files that are
**untracked and gitignored** — verified with `git ls-files --error-unmatch`
(not tracked) and `git check-ignore` (ignored), and `git log --all` shows
none of the three paths ever existed in any commit:

| File | Findings | Class |
|---|---|---|
| `.env` | 3 hex values (lines 22, 24, 29) | Local dev secrets (`SESSION_SECRET`/`TOKEN_ENC_KEY`-style); never in git. |
| `deploy/.env` | 4 hex values (lines 3, 4, 9, 10) | Written by `configure.mjs` during the local W17-28/29 drills; never in git. |
| `.env.smoke` | 1 `github_pat_11AA2SVN…` (line 1) | **A real GitHub fine-grained PAT**, the `SMOKE_FORGE_PAT` that `e2e/smoke-real-forge.spec.ts` reads (file dated 2026-08-13, mode 0600). Never in git. |

## Action for the operator (outside this ticket's write scope)

1. `.env.smoke` holds a live fine-grained PAT on this workstation. It is
   gitignored and was never committed, so it is not a release blocker, but
   revoke or rotate it if the real-forge smoke is no longer needed. Nothing
   in this ticket touches it.
2. Sanitizer gap: `tools/fixture-recorder` should scrub `temp_clone_token`
   (and any `*_token` JSON field) before writing fixtures. The one recorded
   value is long expired, so no rotation is needed; the fix is a product-code
   change and is recorded here as a follow-up, not made.
3. If the SC-18 gate is to exit 0 in CI, the test placeholders above need
   either a `gitleaks:allow` comment or a path allowlist in `.gitleaks.toml`
   for `**/*.test.ts`, `e2e/**`, `deploy/compose.demo.yaml` and the forge
   fixture directory. That is a security-control edit and was not made
   unilaterally.

## Commands

```
gitleaks git --no-banner -c .gitleaks.toml --report-format json --report-path /tmp/gl-git.json .   # EXIT=1, 17
gitleaks dir --no-banner -c .gitleaks.toml --report-format json --report-path /tmp/gl-dir.json .   # EXIT=1, 25
for f in .env .env.smoke deploy/.env; do git ls-files --error-unmatch $f; git check-ignore $f; done
git log --all --oneline -- .env .env.smoke deploy/.env    # (no output)
```
