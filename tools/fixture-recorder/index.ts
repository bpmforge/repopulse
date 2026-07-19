import { GITHUB_API, githubFetch, recordRest, writeFixture } from './record.js';
import { writeSyntheticFixtures } from './synthetic.js';
import { introspectPullRequestChangedFile } from './introspect.js';

// Entry point (run live, never in CI): records the GitHub fixture set W1-06's
// contract tests replay. Usage:
//   GITHUB_PAT=<read token> npx tsx tools/fixture-recorder/index.ts
// or, using the gh CLI token:
//   GITHUB_PAT=$(gh auth token) npx tsx tools/fixture-recorder/index.ts

const FIXTURE_REPO = 'bpmforge/repopulse-fixture';
const REAL_REPO = 'bpmforge/repopulse';


interface PrFile {
  filename: string;
  status: string;
  changes: number;
  patch?: string;
}

// Scan the real repo's PRs for a file GitHub served WITHOUT a `patch` (its
// truncation signal — ForgeDiffFile.patchTruncated). Records the first such
// file-set as the truncated-diff fixture; returns false if none is found.
async function recordTruncatedDiff(): Promise<boolean> {
  const prs = (await githubFetch(
    'GET',
    `${GITHUB_API}/repos/${REAL_REPO}/pulls?state=all&per_page=30&sort=created&direction=desc`,
  ).then((r) => r.body)) as { number: number }[];

  for (const pr of prs) {
    const url = `${GITHUB_API}/repos/${REAL_REPO}/pulls/${pr.number}/files?per_page=100`;
    const raw = await githubFetch('GET', url);
    const files = (Array.isArray(raw.body) ? raw.body : []) as PrFile[];
    const truncated = files.find((f) => f.patch === undefined && f.changes > 0);
    if (truncated) {
      writeFixture({
        scenario: 'pull-files-truncated',
        provenance: 'recorded',
        note: `PR #${pr.number} of ${REAL_REPO}: file "${truncated.filename}" (${truncated.changes} changes) served with no patch → ForgeDiffFile.patchTruncated=true.`,
        request: { method: 'GET', url },
        response: raw,
      });
      console.log(`  truncated-diff found in ${REAL_REPO} PR #${pr.number}: ${truncated.filename}`);
      return true;
    }
  }
  return false;
}

async function main(): Promise<void> {
  console.log('Recording GitHub fixtures → packages/forge/fixtures/github\n');

  // 1. 200 with etag + rate-limit headers (the rate-limit-header case too).
  const repoUrl = `${GITHUB_API}/repos/${FIXTURE_REPO}`;
  const repo200 = await recordRest('repo-get-200-etag', repoUrl, {
    note: 'Baseline 200 for a repo, carrying etag + x-ratelimit-* headers.',
  });
  const etag = repo200.headers['etag'];

  // 2. 304 conditional — same URL with If-None-Match: <etag>.
  if (etag) {
    await recordRest('repo-get-304-conditional', repoUrl, {
      etagMatch: etag,
      extraHeaders: { 'if-none-match': etag },
      note: 'Conditional GET with the etag from repo-get-200-etag → 304, zero primary charge.',
    });
  } else {
    console.warn('  no etag on the 200 response — skipped the 304 fixture');
  }

  // 3. Explicit rate-limit state.
  await recordRest('rate-limit', `${GITHUB_API}/rate_limit`, {
    note: 'GET /rate_limit — the budgeter seeds its buckets from these (never guessed).',
  });

  // 4. Normal PR files (patch present) from the seeded fixture repo.
  await recordRest(
    'pull-files-200',
    `${GITHUB_API}/repos/${FIXTURE_REPO}/pulls/1/files?per_page=100`,
    { note: 'PR files with unified patch hunks present (the non-truncated case).' },
  );

  // 5. Truncated diff (patchTruncated) from the real repo; else synthesize.
  const foundTruncated = await recordTruncatedDiff();
  if (!foundTruncated) {
    console.warn('  no natural truncated diff found — writing a synthetic one');
    writeFixture({
      scenario: 'pull-files-truncated',
      provenance: 'synthetic',
      note: 'No naturally-truncated file found in the scanned PRs; authored from the documented shape — a large file GitHub serves with no `patch`.',
      request: {
        method: 'GET',
        url: `${GITHUB_API}/repos/${REAL_REPO}/pulls/1/files?per_page=100`,
      },
      response: {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
        body: [
          {
            filename: 'pnpm-lock.yaml',
            status: 'modified',
            additions: 15000,
            deletions: 200,
            changes: 15200,
            // no `patch` → patchTruncated
          },
        ],
      },
    });
  }

  // 6. Synthetic deterministic error shapes (202 warmup, secondary-403).
  writeSyntheticFixtures('bpmforge', 'repopulse-fixture');

  // 7. GraphQL introspection — resolve the github-api.md §6 UNVERIFIED item.
  console.log('\nIntrospecting GraphQL PullRequestChangedFile…');
  const { fields, hasPatch } = await introspectPullRequestChangedFile();
  console.log(`  fields: ${fields.join(', ')}`);
  console.log(
    hasPatch
      ? '  VERDICT: has `patch` — ingest plan can simplify (record in github-api.md §6)'
      : '  VERDICT: NO `patch` field — confirms github-api.md §6; diffs stay REST-only',
  );
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
