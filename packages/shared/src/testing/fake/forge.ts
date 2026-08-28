import { createServer, type Server } from 'node:http';
import { FIXTURE_SOURCES, archiveRoot, buildTarball } from './tarball.js';

// Fake forge API for e2e (W12-02).
//
// fake-github.ts fakes the OAuth *login* boundary. This fakes the DATA boundary
// — the endpoints the connect flow and ingestion call — so the real connect
// path can run end to end with no credential and no network. Until this
// existed, every test mocked below the ForgeProvider and the warehouse was
// populated by the seeder, which meant the single most important path in the
// product (connect → discover → backfill) had never executed at all.
//
// It serves GitHub's REST shapes because GitHubProvider is the adapter under
// test; a Gitea/GitLab fake is the same idea against their shapes (W7-02,
// W12-01).

export const FAKE_TOKEN = 'ghp_fake_forge_token_for_e2e_0123456789';
export const FAKE_REPOS = [
  { id: 9001, name: 'alpha-service', full_name: 'fixture-org/alpha-service' },
  { id: 9002, name: 'beta-web', full_name: 'fixture-org/beta-web' },
  // W4-22 owns this one. Specs that assert on ingestion must each own a repo no
  // other spec touches: globalSetup seeds once for the whole suite, so a shared
  // repo means a test can pass on ingestion it did not cause — and keep passing
  // after its own path breaks.
  { id: 9003, name: 'gamma-events', full_name: 'fixture-org/gamma-events' },
];

export const FAKE_COMMITS = [
  { sha: 'fake0000000000000000000000000000000000a1', message: 'init' },
  { sha: 'fake0000000000000000000000000000000000b2', message: 'add service' },
  { sha: 'fake0000000000000000000000000000000000c3', message: 'fix bug' },
];
export const FAKE_PRS = [
  { number: 11, title: 'Add the service' },
  { number: 12, title: 'Fix the bug' },
];

// Per-commit file churn, one entry per FAKE_COMMITS index. Enrichment writes
// these into commit_files, which is what the churn/hotspot metrics read — so
// these numbers are what makes M1/M2 nonzero rather than a fixture detail.
// Per-PR reviews and check runs — the enrichment lane's other half (W12-02
// acceptance 1, unblocked once enrichment was broadened to per-parent detail
// fetches). Keyed by index into FAKE_PRS.
export const FAKE_REVIEWS: { state: string; login: string }[][] = [
  [
    { state: 'APPROVED', login: 'fixture-reviewer' },
    { state: 'COMMENTED', login: 'fixture-dev' },
  ],
  [{ state: 'APPROVED', login: 'fixture-reviewer' }],
];

export const FAKE_CHECKS: { name: string; conclusion: string }[][] = [
  [
    { name: 'build', conclusion: 'success' },
    { name: 'test', conclusion: 'success' },
  ],
  [{ name: 'build', conclusion: 'failure' }],
];

/**
 * Per-commit file churn, WITH PATCHES (W16-33).
 *
 * The patches were missing until now, and everything that reads a DIFF rather
 * than a tree quietly had nothing to read: the OWASP checklists reported "no
 * changed files to review", and the secrets STREAM scanner — the one that is
 * supposed to find a credential within 60s of a webhook — had never been given
 * a line of source against this fake. Same family as the archive route W16-30
 * added: a fake that omits the field the real forge always sends does not
 * imitate it, it just fails somewhere else.
 *
 * The content is unified-diff shaped because that is what the real API returns
 * and what every consumer parses: `@@` hunk headers, `+`/`-`/context prefixes.
 * It is also deliberately not clean — a swallowed error, a string-built query
 * and a credential-SHAPED literal that is not a credential — so a scanner that
 * reads it can be told apart from one that did not run.
 */
export const FAKE_COMMIT_FILES: {
  path: string;
  additions: number;
  deletions: number;
  status: string;
  patch: string;
}[][] = [
  [
    {
      path: 'src/index.ts',
      additions: 40,
      deletions: 0,
      status: 'added',
      patch: [
        '@@ -0,0 +1,8 @@',
        "+import { createServer } from 'node:http';",
        '+',
        '+export function start(port: number) {',
        '+  return createServer((req, res) => {',
        '+    res.end(JSON.stringify({ ok: true }));',
        '+  }).listen(port);',
        '+}',
      ].join('\n'),
    },
  ],
  [
    {
      path: 'src/service.ts',
      additions: 25,
      deletions: 3,
      status: 'modified',
      patch: [
        '@@ -12,7 +12,11 @@ export class ChargeService {',
        '   async settle(id: string) {',
        '-    await this.db.settle(id);',
        '+    try {',
        '+      await this.db.query(`select * from charges where id = ${id}`);',
        '+    } catch {',
        '+      // swallowed',
        '+    }',
        '   }',
      ].join('\n'),
    },
    {
      path: 'src/index.ts',
      additions: 5,
      deletions: 1,
      status: 'modified',
      patch: [
        '@@ -1,3 +1,5 @@',
        "+const STRIPE_KEY = 'sk_test_00000000000000000000000000';",
        '+',
        " import { createServer } from 'node:http';",
      ].join('\n'),
    },
  ],
  [
    {
      path: 'src/service.ts',
      additions: 8,
      deletions: 12,
      status: 'modified',
      patch: [
        '@@ -30,6 +30,4 @@ export class ChargeService {',
        '-  private retry(fn: () => Promise<void>) {',
        '-    return fn().catch(() => fn());',
        '-  }',
        '+  private retry = withBackoff;',
      ].join('\n'),
    },
  ],
];

export interface FakeForge {
  baseUrl: string;
  /** Every path the connect flow touched — asserted so the fake cannot silently go unused. */
  calls: string[];
  close: () => Promise<void>;
}

/**
 * A stable index for a sha this fake does not know (W16-38).
 *
 * PREFERS THE ORDINAL IN THE SHA. The seeder names commits `payments-c0` …
 * `payments-c7`, so the trailing number is the commit's position in that
 * repo's history — which makes the mapping deterministic, varied, and tied to
 * something meaningful rather than to a hash's luck.
 *
 * That matters more than it sounds. A scanner that reviews the NEWEST commit
 * gets whichever fixture the newest sha lands on, and the first version of
 * this hashed `payments-c7` onto the one benign patch in the set — so the
 * OWASP checklist reviewed a clean `createServer` snippet, found nothing, and
 * looked broken while working perfectly.
 *
 * djb2 remains the fallback for a sha with no ordinal (a real hex one), because
 * the requirement there is only "same sha, same answer, spread across the set"
 * — not collision resistance. A cryptographic hash would claim something about
 * security that this function does not mean.
 */
function hashIndex(sha: string, buckets: number): number {
  const ordinal = /(\d+)$/.exec(sha)?.[1];
  if (ordinal !== undefined) return Number(ordinal) % buckets;
  let h = 5381;
  for (let i = 0; i < sha.length; i++) h = ((h << 5) + h + sha.charCodeAt(i)) >>> 0;
  return h % buckets;
}

export function startFakeForge(port = 0): Promise<FakeForge> {
  const calls: string[] = [];

  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    calls.push(`${req.method} ${url.pathname}`);

    // Auth is checked, not ignored: a connect flow that "succeeds" against a
    // fake accepting anything would prove nothing about credential handling.
    const auth = req.headers.authorization ?? '';
    if (!auth.includes(FAKE_TOKEN)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: 'Bad credentials' }));
      return;
    }

    const json = (status: number, body: unknown) => {
      res.writeHead(status, {
        'content-type': 'application/json',
        // GitHub sends these on every response and the BudgetedClient reads
        // them (Law 7). Omitting them made the budgeter treat remaining as
        // unknown and defer every entity job to the rate-limit reset — the
        // jobs completed or sat delayed and nothing was ever ingested, with no
        // error anywhere. A fake that omits headers the real forge always sends
        // does not imitate it.
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4999',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
        'x-ratelimit-used': '1',
        'x-ratelimit-resource': 'core',
      });
      res.end(JSON.stringify(body));
    };

    // Repo discovery — what the connect flow's smoke call and repo picker use.
    if (url.pathname === '/user/repos') {
      json(
        200,
        FAKE_REPOS.map((r) => ({
          id: r.id,
          node_id: `node-${r.id}`,
          name: r.name,
          full_name: r.full_name,
          private: true,
          archived: false,
          default_branch: 'main',
          pushed_at: new Date().toISOString(),
          owner: { login: 'fixture-org' },
        })),
      );
      return;
    }

    // Entity pages. Shapes match GitHub's REST responses because
    // packages/forge/src/github/normalize.ts is what parses them — emitting a
    // convenient shape instead would test the fake, not the adapter.
    const entity = /^\/repos\/[^/]+\/[^/]+\/(commits|pulls|issues|releases|deployments)$/.exec(
      url.pathname,
    );
    if (entity && req.method === 'GET') {
      const kind = entity[1];
      const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
      if (kind === 'commits') {
        json(
          200,
          FAKE_COMMITS.map((c, i) => ({
            sha: c.sha,
            commit: {
              author: { name: 'Fixture Dev', email: 'dev@fixture.test', date: day(i + 1) },
              committer: { date: day(i + 1) },
              message: c.message,
            },
            author: { login: 'fixture-dev', id: 4242 },
            parents: i === 0 ? [] : [{ sha: FAKE_COMMITS[i - 1]!.sha }],
            stats: { additions: 10 + i, deletions: i },
          })),
        );
        return;
      }
      if (kind === 'pulls') {
        json(
          200,
          FAKE_PRS.map((pr, i) => ({
            number: pr.number,
            title: pr.title,
            state: 'closed',
            draft: false,
            user: { login: 'fixture-dev', id: 4242 },
            created_at: day(i + 3),
            updated_at: day(i + 1),
            merged_at: day(i + 1),
            closed_at: day(i + 1),
            additions: 20,
            deletions: 4,
            head: { sha: `head-${pr.number}` },
            base: { ref: 'main' },
          })),
        );
        return;
      }
      // Releases/issues/deployments exist so the planner's other lanes resolve
      // rather than 404 — empty is a legitimate answer for a young repo.
      json(200, []);
      return;
    }

    // Per-PR reviews (enrichment). Fetched per PR number, not paginated at
    // repo scope — which is exactly why reviews belong to enrichment rather
    // than the history entity walk.
    const reviewsPath = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/reviews$/.exec(url.pathname);
    if (reviewsPath && req.method === 'GET') {
      const prNumber = Number(reviewsPath[1]);
      const idx = FAKE_PRS.findIndex((p) => p.number === prNumber);
      const reviews = FAKE_REVIEWS[idx] ?? [];
      json(
        200,
        reviews.map((r, i) => ({
          id: prNumber * 100 + i,
          state: r.state,
          user: { login: r.login, id: 4242 },
          submitted_at: new Date(Date.now() - (i + 1) * 3_600_000).toISOString(),
          body: '',
        })),
      );
      return;
    }

    // Check runs, keyed on the HEAD COMMIT rather than the PR — the reason
    // `checks` could never go through the paginated repo-scope walk that
    // INGESTION §3's entity order implied.
    const checksPath = /^\/repos\/[^/]+\/[^/]+\/commits\/([^/]+)\/check-runs$/.exec(url.pathname);
    if (checksPath && req.method === 'GET') {
      const ref = checksPath[1]!;
      const idx = FAKE_PRS.findIndex((p) => `head-${p.number}` === ref);
      const checks = idx >= 0 ? (FAKE_CHECKS[idx] ?? []) : [];
      json(200, {
        total_count: checks.length,
        check_runs: checks.map((c, i) => ({
          // Globally unique, NOT per-PR: check_runs upserts on
          // (repo, kind, forge_run_id, run_attempt), so ids restarting at 1 for
          // each PR made PR 12's "build" overwrite PR 11's — the fixture
          // silently lost a row and the count came back 2 instead of 3.
          id: (idx + 1) * 100 + i,
          name: c.name,
          status: 'completed',
          conclusion: c.conclusion,
          head_sha: ref,
          started_at: new Date(Date.now() - 7_200_000).toISOString(),
          completed_at: new Date(Date.now() - 7_000_000).toISOString(),
        })),
      });
      return;
    }

    // Per-commit file churn — the enrichment phase (W12-05). getCommitFiles
    // fetches the SINGLE-commit endpoint (/repos/o/r/commits/{sha}), which is
    // a different path from the commit LIST above and returns files + stats.
    // Without it enrichment has nothing to fetch, and M1/M2 stay at zero
    // because churn metrics read commit_files.
    // `[0-9a-z]+` was too narrow (W16-33): the seeder's commit shas look like
    // `payments-c1`, and a hyphen made this route 404 for every commit in the
    // demo. So getCommitFiles came back empty and everything that reads a DIFF
    // — the OWASP checklists, and the secrets STREAM scanner that is supposed
    // to catch a credential within 60s of a webhook — reported "no changed
    // files" against a warehouse full of them.
    //
    // A real forge accepts any ref here, not just a hex sha, so the wider
    // pattern is also the more faithful one.
    const commitDetail = /^\/repos\/[^/]+\/[^/]+\/commits\/([0-9a-zA-Z._-]+)$/.exec(
      url.pathname,
    );
    if (commitDetail && req.method === 'GET') {
      const sha = commitDetail[1]!;
      // Deterministic per-SHA so the churn totals are stable across runs and an
      // assertion can name a number rather than "greater than zero".
      // DETERMINISTIC PER SHA, AND NOT ALWAYS THE FIRST ONE (W16-38).
      //
      // `findIndex` only matches this fake's OWN commit shas. The seeder's look
      // like `payments-c7`, so every commit in the demo fell through to
      // FAKE_COMMIT_FILES[0] — the one benign patch in the set. The OWASP
      // checklist therefore reviewed a clean `createServer` snippet on every
      // run, reported zero findings, and looked exactly like a checklist that
      // does not work. It was working; it was being shown nothing to find.
      //
      // Falls back to a hash of the sha rather than to index 0, so an unknown
      // sha still gets a STABLE and varied file set — the churn totals stay
      // reproducible, which is what index 0 was protecting, without every
      // commit in a seeded repo being the same clean diff.
      const known = FAKE_COMMITS.findIndex((c) => c.sha === sha);
      const idx = known >= 0 ? known : hashIndex(sha, FAKE_COMMIT_FILES.length);
      const files = FAKE_COMMIT_FILES[idx] ?? FAKE_COMMIT_FILES[0]!;
      json(200, {
        sha,
        files: files.map((f) => ({
          filename: f.path,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.additions + f.deletions,
          // The field the real API always sends and this fake omitted, so
          // every diff-reading scanner saw a file it had to skip (W16-33).
          patch: f.patch,
          status: f.status,
        })),
        stats: {
          additions: files.reduce((s, f) => s + f.additions, 0),
          deletions: files.reduce((s, f) => s + f.deletions, 0),
        },
      });
      return;
    }

    // PR backfill goes over GraphQL, not REST: listPullRequests needs the
    // additions/deletions/changedFiles the REST list omits (graphql.ts). The
    // REST /pulls handler above is therefore NOT the path ingestion takes —
    // without this, POST /graphql fell through to the 404 below, `payload.data`
    // came back undefined and the job died on an unreadable
    // "Cannot read properties of undefined (reading 'repository')".
    if (url.pathname === '/graphql' && req.method === 'POST') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        const day = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString();
        json(200, {
          data: {
            repository: {
              pullRequests: {
                // One page: FAKE_PRS is smaller than the query's first:50, so
                // hasNextPage is false and the cursor loop terminates.
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: FAKE_PRS.map((pr, i) => ({
                  number: pr.number,
                  id: `gql-pr-${pr.number}`,
                  title: pr.title,
                  body: null,
                  isDraft: false,
                  state: 'MERGED',
                  createdAt: day(i + 3),
                  updatedAt: day(i + 1),
                  mergedAt: day(i + 1),
                  closedAt: day(i + 1),
                  author: { login: 'fixture-dev', __typename: 'User' },
                  mergedBy: { login: 'fixture-dev' },
                  baseRefName: 'main',
                  headRefOid: `head-${pr.number}`,
                  additions: 20,
                  deletions: 4,
                  changedFiles: 2,
                })),
              },
            },
          },
        });
      });
      return;
    }

    // THE SOURCE ARCHIVE (W16-30, C1a).
    //
    // Absent until now, so every snapshot scanner — anti_slop, semgrep,
    // code_health_tools, the architecture register — got a 404 from the one
    // endpoint it depends on and had never run once against this fake, in the
    // demo or in e2e. `json()` is not used: the response is BYTES, and a
    // JSON-encoded archive fails inside snapshot/tar.ts a long way from here.
    //
    // 200 with the bytes rather than a 302 to a codeload host, because that is
    // what the caller actually sees: Octokit follows the redirect itself, so
    // resolveTarball's 200 branch is the production path.
    const tarballPath = /^\/repos\/([^/]+)\/([^/]+)\/tarball\/(.*)$/.exec(url.pathname);
    if (tarballPath && req.method === 'GET') {
      const repo = `${tarballPath[1]}/${tarballPath[2]}`;
      const sha = decodeURIComponent(tarballPath[3] ?? '');
      const bytes = buildTarball(archiveRoot(repo, sha), FIXTURE_SOURCES);
      res.writeHead(200, {
        'content-type': 'application/gzip',
        'content-length': String(bytes.byteLength),
        'content-disposition': `attachment; filename=${archiveRoot(repo, sha)}.tar.gz`,
        'x-ratelimit-limit': '5000',
        'x-ratelimit-remaining': '4999',
        'x-ratelimit-reset': String(Math.floor(Date.now() / 1000) + 3600),
        'x-ratelimit-used': '1',
        'x-ratelimit-resource': 'core',
      });
      res.end(bytes);
      return;
    }

    // Webhook registration during connect.
    if (url.pathname.endsWith('/hooks') && req.method === 'POST') {
      req.resume();
      req.on('end', () => json(201, { id: 4242, active: true }));
      return;
    }

    json(404, { message: 'not found' });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('fake forge did not bind'));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        calls,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
