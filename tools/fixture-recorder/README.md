# fixture-recorder (W0-04)

Records real GitHub REST/GraphQL responses into
`packages/forge/fixtures/github/` as sanitized JSON, so W1-06's `ForgeProvider`
contract tests replay them with **zero live network** (CLAUDE.md Law: CI never
hits github.com). Run manually, never in CI.

## Run

```sh
# with a fine-grained read PAT
GITHUB_PAT=github_pat_xxx npx tsx tools/fixture-recorder/index.ts

# or reuse the gh CLI token (repo + read:org)
GITHUB_PAT=$(gh auth token) npx tsx tools/fixture-recorder/index.ts
```

(If `tsx` isn't on PATH, use `./apps/api/node_modules/.bin/tsx`.)

## What it records

| Fixture | Provenance | Demonstrates |
|---|---|---|
| `repo-get-200-etag` | recorded | 200 + etag + `x-ratelimit-*` headers |
| `repo-get-304-conditional` | recorded | conditional GET (`If-None-Match`) → 304 |
| `rate-limit` | recorded | `GET /rate_limit` budgeter seed |
| `pull-files-200` | recorded | PR files with unified `patch` present |
| `pull-files-truncated` | recorded | a file GitHub served with **no** `patch` → `patchTruncated` |
| `stats-contributors-202-warmup` | synthetic | 202 stats-warmup (can't force on a warm cache) |
| `secondary-rate-limit-403` | synthetic | abuse-detection 403 + `retry-after` (never forced live) |

Two fixtures are **synthetic** (authored from the documented shape): the 202
warmup only appears on a cold stats cache, and the secondary-403 can only be
produced by abusing the API. Both are marked `"provenance": "synthetic"`.

## Sanitization

`sanitize.ts` strips every response header except a safe allowlist (etag,
`x-ratelimit-*`, `link`, `retry-after`, content-type, request-id) and
deep-scrubs token-shaped substrings (`gh[opusr]_…`, `github_pat_…`) from bodies.
The request `Authorization` header is never captured. A test in
`packages/forge/fixtures/replay.test.ts` re-asserts no secret material survives.

## Replay

`packages/forge/fixtures/replay.ts` loads the fixtures and returns a
`RequestExecutor`-shaped function (matches BudgetedClient's executor seam). A
request that matches no fixture throws `ReplayMissError` — the guard proving
nothing escapes to github.com.

## Introspection

`introspect.ts` resolves the `github-api.md` §6 UNVERIFIED item: whether the
GraphQL `PullRequestChangedFile` type has a `patch` field (it does not).
Re-run if the GraphQL schema is ever suspected to have changed.
