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
      res.writeHead(status, { 'content-type': 'application/json' });
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
