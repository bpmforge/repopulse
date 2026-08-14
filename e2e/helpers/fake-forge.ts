import { createServer, type Server } from 'node:http';

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
export const FAKE_COMMIT_FILES: {
  path: string;
  additions: number;
  deletions: number;
  status: string;
}[][] = [
  [{ path: 'src/index.ts', additions: 40, deletions: 0, status: 'added' }],
  [
    { path: 'src/service.ts', additions: 25, deletions: 3, status: 'modified' },
    { path: 'src/index.ts', additions: 5, deletions: 1, status: 'modified' },
  ],
  [{ path: 'src/service.ts', additions: 8, deletions: 12, status: 'modified' }],
];

export interface FakeForge {
  baseUrl: string;
  /** Every path the connect flow touched — asserted so the fake cannot silently go unused. */
  calls: string[];
  close: () => Promise<void>;
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

    // Per-commit file churn — the enrichment phase (W12-05). getCommitFiles
    // fetches the SINGLE-commit endpoint (/repos/o/r/commits/{sha}), which is
    // a different path from the commit LIST above and returns files + stats.
    // Without it enrichment has nothing to fetch, and M1/M2 stay at zero
    // because churn metrics read commit_files.
    const commitDetail = /^\/repos\/[^/]+\/[^/]+\/commits\/([0-9a-z]+)$/.exec(url.pathname);
    if (commitDetail && req.method === 'GET') {
      const sha = commitDetail[1]!;
      // Deterministic per-SHA so the churn totals are stable across runs and an
      // assertion can name a number rather than "greater than zero".
      const idx = FAKE_COMMITS.findIndex((c) => c.sha === sha);
      const files = FAKE_COMMIT_FILES[idx] ?? FAKE_COMMIT_FILES[0]!;
      json(200, {
        sha,
        files: files.map((f) => ({
          filename: f.path,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.additions + f.deletions,
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
