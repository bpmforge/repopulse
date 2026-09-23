# Independent verifier (challenger) — release/v1-selfhost

Date: 2026-09-23. Started at `425daa4`; HEAD moved to `2e4c7c2` mid-run (a Dockerfile web-build change pushed by the lead agent), and that commit is reviewed too.
Every result below comes from a command I ran myself. Nothing was committed or pushed, and no containers were touched.
Each temporary source break was reverted with `git checkout -- <file>`. The final `git status --short` shows only `?? docs/work/product-completion/evidence/v1-selfhost-20260923/`.

## 1. Lint / typecheck

| Command | Exit | Notes |
|---|---|---|
| `pnpm lint` | 0 | no findings |
| `pnpm typecheck` | 0 | root + every package |

## 2. Validators

| Command | Exit | Notes |
|---|---|---|
| `bash scripts/validate-arch.sh` | 0 | all rules PASS |
| `node scripts/validate-plan.mjs` | 0 | "OK: plan.json is valid", 18 advisory warnings (e.g. W16-39/41/48 acceptance count, W16-59 points 13). None are on W17-35/36/37 |
| `node scripts/validate-traceability.mjs` | 0 | no dangling refs; 2 coverage gaps (docs/design/CANVAS.md, docs/design/canvas never referenced) |
| `bash scripts/validate-compose.sh` | 0 | all rules PASS |

## 3. Full vitest (`pnpm test`)

- Exit **1**. Test Files: 1 failed, 318 passed, 2 skipped (321). Tests: **1 failed, 2461 passed, 9 skipped (2471)**. Duration 981 s.
- The single failure is `packages/analysis/src/t2/live.integration.test.ts`, test "completes a real prompt and returns usable JSON text". The host answered `400 ... Failed to load model "qwen/qwen3-coder-next". Error: Operation canceled.` That test's health check against the same host passed.
- **The environmental claim holds.** `git diff 8ba54ff..HEAD --stat -- packages/analysis` is empty, and packages/analysis was last touched in 957b95b. The test is gated on `LMSTUDIO_BASE_URLS`, and the error text comes from the LM Studio server, not from repo code.
- The count differs from the plan note: the note says 2459 passed, I got 2461. The +2 lines up with the two new tests in `apps/api/test/ops/deploy-up.test.ts` from 2e4c7c2, which landed while the run was in progress. The run therefore straddled two commits.

## 4. Refutation attempts (break → RED → restore → GREEN)

Baseline on the 4 named files: 17/17 GREEN.

| Claim | Break | Result |
|---|---|---|
| a. W17-35 | `assertListOk` returns `'ok'` first | **RED**: 8 of 11 failed (5/7 list-errors, 3/4 entity-errors). The tests that stayed green are the two 409-empty-repo cases and the "clears once fixed" case. Those also pass on the old code, so they only guard against regressions and are not RED-capable for this fix. |
| b. W17-36 (as specified) | `row = candidates[0]`, verification skipped | **RED**: 3 of 5 failed |
| b'. W17-36 (faithful old behaviour) | only the first candidate is tried, but it is still verified | **RED**: 1 of 5 failed ("accepts a captured Gitea delivery"). This is the test that actually pins the fix. |
| c. W17-37 | `server.listen(opts.port)` | **RED**: bound `"::"`, expected `"127.0.0.1"` |

After restore: 17/17 GREEN, and the working tree is clean.

**Verdict: all three fixes are real and each is pinned by a test that can fail.**

## 5. Diff review findings (`8ba54ff..HEAD`, plus 2e4c7c2)

Ordered by severity:

1. **MEDIUM — the GitLab subgroup claim does not hold end-to-end.** The W17-36 note says the receiver "matches the full path (GitLab subgroups)". The receiver compares `org || '/' || name` to `path_with_namespace`, but the connect path splits the forge full name as `const [org, name] = r.fullName.split('/')` at:
   - `packages/ingest/src/connect/connect.ts:58`
   - `apps/api/src/routes/connections/index.ts:277`
   - `apps/api/src/routes/connections/index.ts:323`

   A real GitLab project `platform/tools/widget` is therefore stored as org=`platform`, name=`tools`. Its deliveries would never match a candidate and would get a 401. The test hand-inserts org=`platform/tools`, a row that production never creates. The split itself predates this branch, but the claim is overstated and subgroup webhooks would not work.
2. **LOW — the W17-35 error clears only if something re-runs the entity, and nothing does.** A permanent refusal marks the entity `backfill_done=true`, and the repo goes `live`. The only automatic re-backfill, `requeueErrorRepos`, acts on repos in status `error` only, and it nulls the whole `repos.last_error` line. So "cleared when the entity next succeeds" needs a manual re-sync after the token is fixed; nothing re-fetches automatically.
3. **LOW — GitLab `listCommits` has no `emptyOn`.** GitHub and Gitea treat 409 as an empty repository. If GitLab answers an empty project with a 404, it would record a false "commits not ingested — HTTP 404". It is not a data-loss risk. I did not verify GitLab's actual behaviour.
4. **LOW — webhook candidate lookup is unordered and unindexed.** The lookup has no `ORDER BY`, and its concatenated-path predicate cannot use an `(org, name)` index, so each delivery scans `repos`. The RED case in 4b' also depends on Postgres returning the github row first (insertion/heap order).
5. **LOW — `HOST` is a generic variable name.** zsh sets `HOST` to the machine hostname, though not exported by default (checked: unset in node from zsh and bash here). If it ever gets exported, `listenHost()` would bind the LAN-resolvable hostname. The `api` `index.ts` wiring (`listenHost()` in `app.listen`) has no test; only the `listenHost` unit and the worker health server are tested.
6. **INFO — 2e4c7c2.** `FROM --platform=$BUILDPLATFORM` relies on buildah/BuildKit supplying `BUILDPLATFORM`; a legacy non-BuildKit docker builder would fail. There are no dangling `--from=source|deps` references. The two new tests in deploy-up are regex checks on the Dockerfile text, not builds.

Checked and supported by the code:
- 502 from available-repos and select
- row-locked splice with no duplicates
- `entities[x].error` in sync status
- the GitHub GraphQL PR list rejects on non-2xx
- receiver restricted to the route's providers
- GitLab token comparison is constant-time (`timingSafeEqual`)
- rate-limit 403/429 is still retried inside `BudgetedClient`, before `assertListOk`, so it is not recorded as permanent
- Dockerfile api/worker `ENV HOST=0.0.0.0`
- `HOST` in env-registry

## 6. E2E

`gate-e2e.txt` is a 5-line excerpt: `153 passed (5.2m)`, `1 skipped`, `EXIT=0`. It also contains a `✘` for `quality.spec.ts:538`. That test is intentionally marked as an expected failure (390px at 200% zoom, WCAG reflow), so the ✘ is consistent with passing.
**E2E was not re-run by me** because of port and resource contention. The 153/1 claim is unverified.
