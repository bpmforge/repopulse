import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { SignJWT, calculateJwkThumbprint, exportJWK, generateKeyPair, type JWK } from 'jose';

// A real, if very small, OpenID Provider — in this process, on a loopback port,
// with keys generated per test run.
//
// This exists because the alternative ways to test an OIDC client are both
// worthless. Reaching a real IdP over the internet makes the suite a network
// monitor rather than a test, and stubbing our own token-exchange function
// tests the stub. In particular the PKCE requirement CANNOT be proven from the
// client side: in PKCE the PROVIDER hashes the verifier and compares it to the
// challenge, so a fixture that ignores `code_verifier` produces a green suite
// with the requirement entirely unmet. This one checks it and returns 400.
//
// Not exported from ./index.ts on purpose: it is test scaffolding, and shipping
// a thing that mints ID tokens from the same barrel as the thing that verifies
// them is asking for the wrong import in production code.

export interface FixtureIdpOptions {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Claims merged into every ID token this provider issues. */
  claims?: Record<string, unknown>;
}

interface PendingAuthorization {
  codeChallenge: string;
  nonce: string;
  redirectUri: string;
}

export interface FixtureIdp {
  issuer: string;
  jwksUri: string;
  publicJwks: { keys: JWK[] };
  /** Simulates the user consenting at /authorize; returns the authorization code. */
  authorize(authorizeUrl: string): string;
  /** Number of times the discovery document has been fetched — the cache assertion. */
  discoveryFetchCount(): number;
  tokenRequests(): Array<Record<string, string>>;
  close(): Promise<void>;
}

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export async function startFixtureIdp(options: FixtureIdpOptions): Promise<FixtureIdp> {
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const kid = await calculateJwkThumbprint(publicJwk);
  publicJwk.kid = kid;
  publicJwk.alg = 'RS256';
  publicJwk.use = 'sig';

  const pending = new Map<string, PendingAuthorization>();
  const tokenRequests: Array<Record<string, string>> = [];
  let discoveryFetches = 0;
  let issuer = '';

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://placeholder');
    const json = (status: number, body: unknown): void => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
      discoveryFetches += 1;
      json(200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        response_types_supported: ['code'],
        subject_types_supported: ['public'],
        id_token_signing_alg_values_supported: ['RS256'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/jwks') {
      json(200, { keys: [publicJwk] });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/token') {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        void (async () => {
          const form = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
          const fields = Object.fromEntries(form.entries());
          tokenRequests.push(fields);

          // Client authentication, either way round.
          const header = req.headers.authorization;
          let clientId = form.get('client_id');
          let clientSecret = form.get('client_secret');
          if (header?.startsWith('Basic ')) {
            const [id, secret] = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':');
            clientId = decodeURIComponent(id ?? '');
            clientSecret = decodeURIComponent(secret ?? '');
          }
          if (clientId !== options.clientId || clientSecret !== options.clientSecret) {
            json(401, { error: 'invalid_client' });
            return;
          }
          if (form.get('grant_type') !== 'authorization_code') {
            json(400, { error: 'unsupported_grant_type' });
            return;
          }

          const code = form.get('code') ?? '';
          const authorization = pending.get(code);
          if (!authorization) {
            json(400, { error: 'invalid_grant' });
            return;
          }
          // Authorization codes are single use; a replay must not mint a
          // second token even when everything else about it is correct.
          pending.delete(code);

          if (form.get('redirect_uri') !== authorization.redirectUri) {
            json(400, { error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
            return;
          }

          // THE PKCE CHECK. Absent verifier is as fatal as a wrong one —
          // otherwise a client could downgrade itself by simply omitting it.
          const verifier = form.get('code_verifier');
          if (verifier === null) {
            json(400, { error: 'invalid_request', error_description: 'code_verifier required' });
            return;
          }
          const derived = base64url(createHash('sha256').update(verifier, 'ascii').digest());
          const expected = Buffer.from(authorization.codeChallenge);
          const actual = Buffer.from(derived);
          if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
            json(400, { error: 'invalid_grant', error_description: 'PKCE verification failed' });
            return;
          }

          const idToken = await new SignJWT({
            nonce: authorization.nonce,
            ...(options.claims ?? {}),
          })
            .setProtectedHeader({ alg: 'RS256', kid })
            .setIssuer(issuer)
            .setAudience(options.clientId)
            .setSubject(String(options.claims?.['sub'] ?? 'fixture-subject'))
            .setIssuedAt()
            .setExpirationTime('5m')
            .sign(privateKey);

          json(200, { access_token: 'fixture-access-token', token_type: 'Bearer', id_token: idToken });
        })();
      });
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fixture IdP did not bind');
  issuer = `http://127.0.0.1:${address.port}`;

  return {
    issuer,
    jwksUri: `${issuer}/jwks`,
    publicJwks: { keys: [publicJwk] },
    authorize(authorizeUrl: string): string {
      const url = new URL(authorizeUrl);
      if (url.searchParams.get('response_type') !== 'code') throw new Error('response_type');
      if (url.searchParams.get('client_id') !== options.clientId) throw new Error('client_id');
      if (url.searchParams.get('code_challenge_method') !== 'S256') throw new Error('method');
      const redirectUri = url.searchParams.get('redirect_uri');
      if (redirectUri !== options.redirectUri) throw new Error('redirect_uri');
      const code = randomBytes(16).toString('hex');
      pending.set(code, {
        codeChallenge: url.searchParams.get('code_challenge') ?? '',
        nonce: url.searchParams.get('nonce') ?? '',
        redirectUri,
      });
      return code;
    },
    discoveryFetchCount: () => discoveryFetches,
    tokenRequests: () => tokenRequests,
    close: () =>
      new Promise<void>((resolve, reject) =>
        (server as Server).close((err) => (err ? reject(err) : resolve())),
      ),
  };
}
