# CI integration: your pipeline pulls, RepoPulse never writes

Traces to: FOUNDING_BRIEF D16 ("Verified + CI pull"), D9a, N-3, N-9 · W18-18 ·
API_DESIGN.md "CI pull" · SECURITY_CONTROLS.md SC-31.

RepoPulse scans every pull request it ingests (section 2 lists exactly what runs on
each push). To get those results in front of
the developer at PR time, **your CI asks RepoPulse what is new on the PR**, and then
your pipeline decides what to do with the answer: fail the build, upload SARIF to
code scanning, or post a comment. Anything posted is posted by your pipeline, with
your forge token.

RepoPulse itself never writes to your repository. It posts no status check and no
comment, opens no branch, has no gate bot, and asks your forge for no write scope
(D9a, N-3). It produces no grades or scores (N-9). The only credential this adds is
a **read-only RepoPulse token**: it can read PR findings for the repositories it
names, and nothing else.

```
 your CI ──GET /api/v1/repos/{id}/pulls/{n}/findings (RepoPulse CI token)──▶ RepoPulse
    │                                                                        (read-only)
    ├─ repopulse check → exit code (your thresholds)
    ├─ SARIF  ──▶ your code-scanning upload (your forge token)
    └─ markdown ──▶ your PR comment (your forge token)
```

## 1. Mint a CI token (admin)

Tokens are minted by a workspace admin. Each one names the RepoPulse repository ids
it may read (the ids in RepoPulse URLs, `/repos/<id>`), lasts at most 365 days, and
is shown **once**:

```bash
# Signed in to RepoPulse as an admin, with your session cookie in $SID:
curl -sS -X POST "$REPOPULSE_SERVER/api/v1/admin/ci-tokens" \
  -H 'Content-Type: application/json' -H 'X-Requested-With: repopulse' \
  -b "repopulse_sid=$SID" \
  -d '{"name":"payments-api CI","repo_ids":[7],"expires_in_days":180}'
# → {"id":3,"token":"rpci_…","prefix":"rpci_AbCd1234","scope":"pr_findings:read",…}
```

Store `token` as a CI secret named `REPOPULSE_TOKEN`. RepoPulse keeps only a hash, so
a lost token cannot be shown again: revoke it and mint a new one.

```bash
curl -sS "$REPOPULSE_SERVER/api/v1/admin/ci-tokens" -b "repopulse_sid=$SID"   # list (prefix only)
curl -sS -X DELETE "$REPOPULSE_SERVER/api/v1/admin/ci-tokens/3" \
  -H 'X-Requested-With: repopulse' -b "repopulse_sid=$SID"                     # revoke
```

Minting and revoking are written to the audit log (`ci_token.created`,
`ci_token.revoked`). `last_used_at` shows whether a pipeline still uses a token.

What the token can do: `GET /api/v1/repos/{id}/pulls/{n}/findings` for its
repositories, and `GET /api/v1/cli/repopulse.mjs`. Any other endpoint answers 403,
any write answers 403, and another repository answers 404.

Your runner must be able to reach your RepoPulse server. For a server on a private
network, use a self-hosted runner on that network.

## 2. The `repopulse check` CLI

One JavaScript file with no dependencies, served by your RepoPulse server to the
token, so the CLI always matches the server version:

```bash
curl -fsS -H "Authorization: Bearer $REPOPULSE_TOKEN" \
  "$REPOPULSE_SERVER/api/v1/cli/repopulse.mjs" -o repopulse.mjs
node repopulse.mjs check --repo 7 --pr 42 --sha "$HEAD_SHA" --wait 600 \
  --fail-on high --sarif repopulse.sarif --markdown repopulse.md
```

It needs Node 20 or later. The source is `tools/repopulse-cli/repopulse.mjs` in the
RepoPulse distribution.

| Option | Meaning |
|---|---|
| `--server URL` | RepoPulse base URL (or `REPOPULSE_SERVER`) |
| `--repo ID` / `--pr N` | RepoPulse repository id; PR number (GitLab: the MR **iid**) |
| `--fail-on LEVEL` | fail when a new finding is at or above `critical`, `high` (default), `medium`, `low`, `info`; `none` disables |
| `--max-new N` | fail when more than N new findings remain |
| `--include-experimental` | also count findings from rules still in shadow mode (excluded by default) |
| `--sha SHA` | the PR head commit this pipeline tests; RepoPulse must have scanned exactly this commit |
| `--wait SECONDS` | poll (every 15 s at most) until every PR scanner has finished on that commit — and, on a PR's first pipeline, until RepoPulse has ingested the PR at all |
| `--allow-unscanned` | do not fail when the head has not been scanned yet |
| `--sarif PATH` / `--markdown PATH` / `--json PATH` | write SARIF 2.1.0, a markdown summary, the raw findings |

The token is read only from `REPOPULSE_TOKEN`. It is never accepted on the command
line, because arguments end up in process lists and CI logs.

| Exit code | Meaning |
|---|---|
| 0 | passed |
| 1 | a threshold was breached (`--fail-on` / `--max-new`) |
| 2 | usage error |
| 3 | RepoPulse refused or could not be reached (bad token, a token that does not name the repository) |
| 4 | not ready: RepoPulse has not ingested the PR yet, has not finished scanning its head, or holds a different head than `--sha` |

### What runs on each PR push (W21-02)

When the forge's webhook tells RepoPulse a PR was opened or pushed, these run on the
new head, each one only if it is switched on for the repository (Repository →
Security → Scanners; the defaults are in the table):

| Scanner | Runs on a PR push | Reads | Default |
|---|---|---|---|
| `secrets` | always | the PR's patches | on |
| `sensitive_change` | always (rides the secrets scan) | the PR's patches | on |
| `semgrep` | always | the files the PR changed (Opengrep, the shipped packs) | on |
| `anti_slop` | always | the head's tree; reports only on files the PR changed. Rule layer only: no model is called on a push | on |
| `logging_hygiene` | always | the files the PR changed (the logging pack) | on |
| `performance` | always | the files the PR changed (the performance pack) | on |
| `dependency_cve` | only when the PR changes a manifest or lockfile | the whole head (syft + grype), because a lockfile is read whole | on |
| `container_image` | only when switched on, and the PR changes a Dockerfile, compose file or manifest that names an image | the images those changed files name | **off** |

Not on a PR push: code health (complexity, duplication), the registers, the attack
chainer, the OWASP checklists and every model-backed (AI) pass. Those are weekly,
nightly or started by hand. A PR run never closes a finding: only a scan of the
default branch can say a finding is gone.

**Forge cost per push.** For each new head: the PR's file list (one call per 100
changed files) and **one** source archive, shared by every scanner above; the
secrets scan reads the file list once more for the patches. A head that has
already been scanned is not fetched again, so a replayed webhook, a label or a
review on the same head costs nothing. At most three PR heads are queued per
webhook delivery (newest first); the rest are picked up by the next one. All of it
goes through the budgeted forge client on the scan lane. If that budget is spent,
the head's scanners finish as `budget_exceeded` (listed in `head.failed`) and are
retried on the next PR event. An operator can switch the pattern scanners off for
PR pushes with `PR_SCANS=off` on both the worker and the API; PR pushes then run the
secrets scan and the radar only.

The head counts as scanned only once **every** scanner that runs on a PR push for
that repository has finished a run on it, succeeded or failed (W20-15). For
`dependency_cve` and `container_image` that means: when the change gave them
something to read. A PR that changes no manifest does not wait for a dependency
scan that will not run. The answer
names the ones still running (`head.pending`) and the ones that failed there
(`head.failed`), and the markdown summary repeats both. A PR the forge's webhook
has not reached RepoPulse with yet answers 404 with the problem type
`urn:repopulse:problem:pr-not-synced`; `--wait` keeps polling through it.

The reports are written for codes 0, 1 and 4, so a comment step can run after a
failed check.

**What "new" means.** A finding counts as new when RepoPulse first saw it on this PR
and it is still on the PR head. Findings on the base branch are excluded, and so are
findings fixed by a later push and findings someone dismissed or resolved. "New" is
relative to what RepoPulse has scanned. If a scanner has never scanned your base
branch, a pre-existing problem in a file the PR touches can look new. The response's
`head.scanners` lists which scanners actually ran on the head commit. For the full
rule, see API_DESIGN.md "CI pull".

## 3. GitHub Actions

Repository variables: `REPOPULSE_SERVER`, `REPOPULSE_REPO_ID`. Secret:
`REPOPULSE_TOKEN`. The comment and the SARIF upload use the workflow's own
`GITHUB_TOKEN`. On pull requests from forks, that token is read-only and the comment
step is skipped.

```yaml
# .github/workflows/repopulse.yml
name: RepoPulse
on:
  pull_request:

permissions:
  contents: read
  pull-requests: write # only for the comment step: posted by THIS workflow, not RepoPulse
  security-events: write # only for the SARIF upload

jobs:
  repopulse:
    runs-on: ubuntu-latest # or a self-hosted runner that can reach RepoPulse
    env:
      REPOPULSE_SERVER: ${{ vars.REPOPULSE_SERVER }}
      REPOPULSE_TOKEN: ${{ secrets.REPOPULSE_TOKEN }}
    steps:
      - name: Fetch the RepoPulse CLI
        run: |
          curl -fsS -H "Authorization: Bearer $REPOPULSE_TOKEN" \
            "$REPOPULSE_SERVER/api/v1/cli/repopulse.mjs" -o repopulse.mjs

      - name: RepoPulse check
        run: |
          node repopulse.mjs check \
            --repo "${{ vars.REPOPULSE_REPO_ID }}" \
            --pr "${{ github.event.pull_request.number }}" \
            --sha "${{ github.event.pull_request.head.sha }}" \
            --wait 600 --fail-on high \
            --sarif repopulse.sarif --markdown repopulse.md

      - name: Upload SARIF to code scanning
        if: ${{ !cancelled() && hashFiles('repopulse.sarif') != '' }}
        uses: github/codeql-action/upload-sarif@v3
        with:
          sarif_file: repopulse.sarif
          category: repopulse

      - name: Comment on the PR (with this workflow's token)
        if: ${{ !cancelled() && hashFiles('repopulse.md') != '' && github.event.pull_request.head.repo.full_name == github.repository }}
        env:
          GH_TOKEN: ${{ github.token }}
        run: |
          gh pr comment "${{ github.event.pull_request.number }}" --repo "${{ github.repository }}" \
            --body-file repopulse.md --edit-last \
          || gh pr comment "${{ github.event.pull_request.number }}" --repo "${{ github.repository }}" \
            --body-file repopulse.md
```

## 4. GitLab CI

CI/CD variables: `REPOPULSE_SERVER`, `REPOPULSE_REPO_ID`, `REPOPULSE_TOKEN` (masked).
To post a note, add `GITLAB_NOTE_TOKEN`: a project access token with the `api` scope,
masked. It belongs to your project, not to RepoPulse. GitLab does not ingest SARIF
into its security dashboard, so the SARIF file is kept as a job artifact.

```yaml
# .gitlab-ci.yml
repopulse:
  stage: test
  image: node:22-alpine
  rules:
    - if: $CI_PIPELINE_SOURCE == "merge_request_event"
  script:
    - wget -q --header "Authorization: Bearer $REPOPULSE_TOKEN"
      -O repopulse.mjs "$REPOPULSE_SERVER/api/v1/cli/repopulse.mjs"
    - node repopulse.mjs check
      --repo "$REPOPULSE_REPO_ID"
      --pr "$CI_MERGE_REQUEST_IID"
      --sha "${CI_MERGE_REQUEST_SOURCE_BRANCH_SHA:-$CI_COMMIT_SHA}"
      --wait 600 --fail-on high
      --sarif repopulse.sarif --markdown repopulse.md
  after_script:
    # Posted by YOUR pipeline with YOUR token. Skipped when no token is configured.
    - |
      if [ -n "$GITLAB_NOTE_TOKEN" ] && [ -f repopulse.md ]; then
        node -e 'process.stdout.write(JSON.stringify({body: require("fs").readFileSync("repopulse.md","utf8")}))' > note.json
        wget -q -O /dev/null --header "PRIVATE-TOKEN: $GITLAB_NOTE_TOKEN" \
          --header "Content-Type: application/json" --post-file note.json \
          "$CI_API_V4_URL/projects/$CI_PROJECT_ID/merge_requests/$CI_MERGE_REQUEST_IID/notes"
      fi
  artifacts:
    when: always
    paths: [repopulse.sarif, repopulse.md]
```

## 5. Gitea Actions

Gitea Actions uses GitHub-compatible workflow syntax. Repository variables:
`REPOPULSE_SERVER`, `REPOPULSE_REPO_ID`. Secrets: `REPOPULSE_TOKEN`, and
`GITEA_COMMENT_TOKEN`, a Gitea access token with `write:issue` that belongs to your
bot account, not to RepoPulse. Gitea has no SARIF ingestion, so upload the file as an
artifact if you want to keep it.

```yaml
# .gitea/workflows/repopulse.yml
name: RepoPulse
on:
  pull_request:

jobs:
  repopulse:
    runs-on: ubuntu-latest
    env:
      REPOPULSE_SERVER: ${{ vars.REPOPULSE_SERVER }}
      REPOPULSE_TOKEN: ${{ secrets.REPOPULSE_TOKEN }}
    steps:
      - name: RepoPulse check
        run: |
          curl -fsS -H "Authorization: Bearer $REPOPULSE_TOKEN" \
            "$REPOPULSE_SERVER/api/v1/cli/repopulse.mjs" -o repopulse.mjs
          node repopulse.mjs check \
            --repo "${{ vars.REPOPULSE_REPO_ID }}" \
            --pr "${{ github.event.pull_request.number }}" \
            --sha "${{ github.event.pull_request.head.sha }}" \
            --wait 600 --fail-on high \
            --sarif repopulse.sarif --markdown repopulse.md

      - name: Comment on the PR (with your token)
        if: ${{ !cancelled() }}
        env:
          GITEA_TOKEN: ${{ secrets.GITEA_COMMENT_TOKEN }}
        run: |
          [ -f repopulse.md ] || exit 0
          node -e 'process.stdout.write(JSON.stringify({body: require("fs").readFileSync("repopulse.md","utf8")}))' > comment.json
          curl -fsS -X POST \
            -H "Authorization: token $GITEA_TOKEN" -H "Content-Type: application/json" \
            --data @comment.json \
            "${{ github.server_url }}/api/v1/repos/${{ github.repository }}/issues/${{ github.event.pull_request.number }}/comments"
```

## 6. Calling the API directly

```bash
curl -fsS -H "Authorization: Bearer $REPOPULSE_TOKEN" \
  "$REPOPULSE_SERVER/api/v1/repos/7/pulls/42/findings?new=true&limit=100"
```

The response is `{pull, head, items, next_cursor}`. Each item carries `severity`
(1–5) and `severity_label`, `confidence`, `dimension`, `rule_id`, `file`,
`line_start`/`line_end`, `title`, `evidence`, `suggested_fix`, `experimental`,
`introduced_by_pr` and `seen_at_head`. Follow `next_cursor` until it is `null`. Add
`include_experimental=true` to include shadow-mode rules. With `new=false`, the
response also includes pre-existing findings in files the PR touches. The full
contract is in API_DESIGN.md "CI pull", and the live schema is served at
`/api/v1/openapi.json`.
