import { createServer, type Server } from 'node:http';
import { FIXTURE_LOGIN } from '@repopulse/shared';

// Fake GitHub OAuth boundary for e2e (W4-00, docs/TESTING.md §6).
//
// Mocks github.com at the *boundary only* — the three endpoints
// `packages/auth/src/oauth/github.ts` actually calls. Everything inside the
// boundary is the real production path: real `/auth/login` state cookie, real
// signed-cookie verification, real token exchange over HTTP, real
// `findOrCreateUser`, real Redis session. Nothing about the session or cookie
// layer is stubbed, which is the whole point of criterion 1 — a test that
// fabricated a session would not exercise what ships.
//
// The identity it returns is the seeder's fixture user. `fetchGithubIdentity`
// maps `String(body.id)` onto `forgeUserId`, and seed.ts writes the fixture
// user with `forgeUserId: FIXTURE_LOGIN` — so `id` must be that same string,
// not a number, or login creates a second orphan user instead of resolving to
// the seeded one (and every /me assertion then reads an empty warehouse).

export const FAKE_CODE = 'fake-oauth-code';

export interface FakeGithub {
  baseUrl: string;
  close: () => Promise<void>;
}

/**
 * Starts the fake on `port` (0 = ephemeral). The authorize endpoint redirects
 * straight back to `redirect_uri` with the state it was handed, standing in for
 * the consent screen a human would click through.
 */
export function startFakeGithub(port = 0): Promise<FakeGithub> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (url.pathname === '/login/oauth/authorize') {
      const redirectUri = url.searchParams.get('redirect_uri');
      const state = url.searchParams.get('state');
      if (!redirectUri || !state) {
        res.writeHead(400).end('authorize called without redirect_uri/state');
        return;
      }
      const back = new URL(redirectUri);
      back.searchParams.set('code', FAKE_CODE);
      back.searchParams.set('state', state);
      res.writeHead(302, { location: back.toString() }).end();
      return;
    }

    if (url.pathname === '/login/oauth/access_token') {
      // Drain the body so the client's write completes before we reply.
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ access_token: 'fake-access-token' }));
      });
      return;
    }

    if (url.pathname === '/user') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          id: FIXTURE_LOGIN,
          login: FIXTURE_LOGIN,
          name: 'Fixture Dev',
          avatar_url: null,
        }),
      );
      return;
    }

    res.writeHead(404).end();
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('fake github did not bind'));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${address.port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}
