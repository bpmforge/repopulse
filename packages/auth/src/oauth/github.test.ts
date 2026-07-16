import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  buildAuthorizeUrl,
  exchangeCodeForToken,
  fetchGithubIdentity,
  GithubOAuthError,
  type GithubOAuthEndpoints,
} from './github.js';
import type { GithubOAuthConfig } from './config.js';

const config: GithubOAuthConfig = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  redirectUri: 'http://localhost:3000/auth/callback',
};

describe('buildAuthorizeUrl', () => {
  it('includes client_id, redirect_uri, scope and state', () => {
    const url = new URL(buildAuthorizeUrl(config, 'the-state'));
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('test-client-id');
    expect(url.searchParams.get('redirect_uri')).toBe(config.redirectUri);
    expect(url.searchParams.get('scope')).toBe('read:user read:org');
    expect(url.searchParams.get('state')).toBe('the-state');
  });

  it('honors an endpoint override', () => {
    const url = buildAuthorizeUrl(config, 's', { authorizeUrl: 'http://mock/authorize' });
    expect(url.startsWith('http://mock/authorize?')).toBe(true);
  });
});

describe('exchangeCodeForToken / fetchGithubIdentity against a mocked GitHub', () => {
  let server: Server;
  let endpoints: GithubOAuthEndpoints;
  let lastTokenBody: unknown;
  let lastUserAuthHeader: string | undefined;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        if (req.url === '/login/oauth/access_token') {
          lastTokenBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ access_token: 'mock-access-token' }));
          return;
        }
        if (req.url === '/user') {
          lastUserAuthHeader = req.headers.authorization;
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({
              id: 42,
              login: 'octocat',
              name: 'The Octocat',
              avatar_url: 'https://example.com/a.png',
            }),
          );
          return;
        }
        if (req.url === '/user-bad') {
          res.writeHead(401, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ message: 'Bad credentials' }));
          return;
        }
        res.writeHead(404);
        res.end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server did not bind');
    const base = `http://127.0.0.1:${address.port}`;
    endpoints = { tokenUrl: `${base}/login/oauth/access_token`, userUrl: `${base}/user` };
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  });

  it('exchanges a code for an access token', async () => {
    const token = await exchangeCodeForToken(config, 'the-code', endpoints);
    expect(token).toBe('mock-access-token');
    expect(lastTokenBody).toMatchObject({
      client_id: 'test-client-id',
      client_secret: 'test-client-secret',
      code: 'the-code',
      redirect_uri: config.redirectUri,
    });
  });

  it('fetches the identity with a bearer token', async () => {
    const identity = await fetchGithubIdentity('mock-access-token', endpoints);
    expect(identity).toEqual({
      forgeUserId: '42',
      login: 'octocat',
      name: 'The Octocat',
      avatarUrl: 'https://example.com/a.png',
    });
    expect(lastUserAuthHeader).toBe('Bearer mock-access-token');
  });

  it('throws GithubOAuthError on a non-2xx identity response', async () => {
    const address = server.address();
    if (address === null || typeof address === 'string') throw new Error('server did not bind');
    const badEndpoints: GithubOAuthEndpoints = {
      userUrl: `http://127.0.0.1:${address.port}/user-bad`,
    };
    await expect(fetchGithubIdentity('bad-token', badEndpoints)).rejects.toThrow(GithubOAuthError);
  });
});
