# Gitea v1 API — verified behaviour (W7-02)

**Verified 2026-08-14** against a live Gitea instance (`https://gitea.com/api/v1`,
repo `gitea/tea`) and against Gitea's own source, not from the swagger and not
from memory. Every claim below has the check that produced it.

The swagger describes the *shape* of these endpoints but not the three things
that actually changed our design, so they are recorded here.

## Webhook signature — `X-Gitea-Signature`

**Bare lowercase hex HMAC-SHA256 over the raw request body. No `sha256=` prefix.**

Source: `services/webhook/deliver.go` (go-gitea/gitea, main):

```go
sig256 := hmac.New(sha256.New, secret)
io.MultiWriter(sig1, sig256).Write(payloadContent)
signatureSHA256 = hex.EncodeToString(sig256.Sum(nil))
...
req.Header.Add("X-Gitea-Signature", signatureSHA256)
```

This is the difference the design doc flagged as UNVERIFIED. It matters because
GitHub sends `X-Hub-Signature-256: sha256=<hex>`: a verifier written for GitHub
rejects every genuine Gitea delivery, and one that leniently strips an optional
prefix would accept a GitHub-shaped signature on a Gitea hook. We implement each
strictly (`packages/forge/src/gitea/webhook.ts`) and contract-test both the
accept and the reject.

Gitea also sends `X-Hub-Signature: sha1=<hex>` for Gogs compatibility. We ignore
it — SHA-1, and superseded by the header above.

## Pagination — `page`/`limit` + `x-total-count`

`ForgeCursor` encodes the **page number**. Confirmed present on a real listing:

```
GET /repos/gitea/tea/pulls?state=all&limit=2  →  x-total-count: 699
```

The total is what makes INGESTION §7's percent-complete exact rather than an
estimate. It is also why the cursor is derived from the total rather than from
"was this page full": a full FINAL page is indistinguishable from a full middle
page, and guessing costs a wasted request per entity — or worse, sets
`backfill_done` on a repo that still had rows. `GITEA_MAX_PER_PAGE = 50`
(`MAX_RESPONSE_ITEMS`); larger `limit` values are silently clamped.

## Three shape differences from GitHub

### 1. No `pushed_at` on repositories

Gitea repos expose `updated_at`; there is no `pushed_at`. The backfill planner
orders repos by it (recently-active first), so `updated_at` is mapped to
`pushedAt`. It also moves on metadata edits, making the ordering slightly
noisier than GitHub's — ordering only, never correctness.

### 2. Commits carry NO per-file churn — the one with product consequences

A commit's `files[]` contains only `filename` and `status`, on **both** the list
and the single-commit endpoint:

```
GET /repos/gitea/tea/git/commits/{sha}
  files[0] = {"filename": ".gitea/workflows/release-nightly.yml", "status": "modified"}
  stats    = {"total": 17, "additions": 13, "deletions": 4}
```

Commit-level `stats` is accurate; per-file attribution simply does not exist at
the source. So `getCommitFiles` returns each file with `additions: 0,
deletions: 0` plus the true commit totals.

**Consequence:** hotspot/ownership metrics that rank files by per-commit churn
cannot be computed from Gitea commits the way they can from GitHub. We record
zero rather than splitting the commit total across files, which would look
plausible and be fiction. PR files are unaffected — see below.

Upside: because `files` is embedded, `getCommitFiles` is **one** request on
Gitea where GitHub needs a separate fetch.

### 3. PR list omits churn; PR detail and PR files carry it

Same split as GitHub, verified:

```
GET /repos/gitea/tea/pulls?state=all   → additions: null, changed_files: null
GET /repos/gitea/tea/pulls/1090        → additions: 233, deletions: 6, changed_files: 4
GET /repos/gitea/tea/pulls/1090/files  → {"filename":"cmd/api.go","status":"changed",
                                          "additions":22,"deletions":1}
```

The list omitting churn must normalize to **absent**, not zero, or a genuinely
0-line PR becomes indistinguishable from an unfetched one.

## Vocabulary differences

| Concept | GitHub | Gitea |
|---|---|---|
| File modified | `modified` | `changed` |
| File deleted | `removed` | `deleted` |
| Review: changes requested | `CHANGES_REQUESTED` | `REQUEST_CHANGES` |
| Review: comment | `COMMENTED` | `COMMENT` |
| Merged PR | `state: closed` + `merged_at` | `state: closed` + `merged: true` |

## No check-runs API

Gitea has no check-runs equivalent; the nearest is commit statuses:

```
GET /repos/gitea/tea/commits/{sha}/statuses
  → {"id": 6, "status": "success", "context": "goreleaser / release-image (push)",
     "created_at": "...", "updated_at": "..."}
```

`supportsCheckRuns: false`, and callers branch on the capability. A status is a
point-in-time result with **no start time**, so CI *duration* metrics cannot be
derived from it — `startedAt` is null rather than reusing `created_at`, which
would fabricate a zero-second run.

## Not yet verified

- **A real webhook delivery from Brad's Gitea 1.x instance.** The signature
  format is confirmed from source and contract-tested both ways, but no live
  delivery has been received and verified end to end. That needs a token and a
  reachable URL.
- **Actions API** availability, which is version-dependent. Not used.
