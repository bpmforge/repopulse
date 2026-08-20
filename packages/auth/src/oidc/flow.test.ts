import { createLocalJWKSet } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildAuthorizationUrl, exchangeCodeForTokens, tokenAuthMethod } from './client.js';
import type { OidcConfig } from './config.js';
import { discover, discoveryUrl, parseMetadata, type CacheEntry } from './discovery.js';
import { OidcError } from './errors.js';
import { startFixtureIdp, type FixtureIdp } from './fixture-idp.js';
import { generateNonce } from './nonce.js';
import { createPkcePair, deriveChallenge } from './pkce.js';
import { generateState } from '../oauth/state.js';
import { verifyIdToken, type KeyResolver } from './verify.js';

// The whole authorization-code + PKCE flow against a fixture OpenID Provider
// running in this process (W15-03 acceptance 4). Nothing here touches the
// internet: the only socket is a loopback port bound by the fixture.

const CLIENT_ID = 'repopulse-test-client';
const CLIENT_SECRET = 'repopulse-test-secret';
const REDIRECT_URI = 'http://localhost:3300/auth/oidc/callback';

let idp: FixtureIdp;
let config: OidcConfig;

beforeAll(async () => {
  idp = await startFixtureIdp({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    claims: { sub: 'idp-subject-9', email: 'ada@example.test', preferred_username: 'ada' },
  });
  config = {
    issuer: idp.issuer,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    redirectUri: REDIRECT_URI,
    scopes: 'openid profile email',
    displayName: 'Test SSO',
  };
});

afterAll(async () => {
  await idp.close();
});

describe('the authorization-code + PKCE flow end to end', () => {
  it('discovers, redirects, exchanges, verifies, and lands on a stable subject', async () => {
    const cache = new Map<string, CacheEntry>();
    const metadata = await discover(config.issuer, { cache });
    expect(metadata.tokenEndpoint).toBe(`${idp.issuer}/token`);

    const state = generateState();
    const nonce = generateNonce();
    const pkce = createPkcePair();

    const authorizeUrl = buildAuthorizationUrl(config, metadata, {
      state,
      nonce,
      codeChallenge: pkce.challenge,
    });
    const url = new URL(authorizeUrl);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    // The CHALLENGE travels; the verifier must not, or PKCE is decorative.
    expect(url.searchParams.get('code_challenge')).not.toBe(pkce.verifier);
    expect(url.toString()).not.toContain(pkce.verifier);

    const code = idp.authorize(authorizeUrl);
    const tokens = await exchangeCodeForTokens(config, metadata, code, pkce.verifier);

    const keys = createLocalJWKSet(idp.publicJwks) as KeyResolver;
    const claims = await verifyIdToken({
      idToken: tokens.idToken,
      issuer: config.issuer,
      audience: config.clientId,
      expectedNonce: nonce,
      keys,
    });
    expect(claims.subject).toBe('idp-subject-9');
    expect(claims.login).toBe('ada');
    expect(claims.email).toBe('ada@example.test');
  });

  it('is refused by the provider when the code_verifier does not match the challenge', async () => {
    // The verifier round trip, proven where it actually lives: the fixture
    // recomputes S256(code_verifier) and compares. A wrong verifier is a
    // stolen authorization code being redeemed by someone who never started
    // the flow, and it must not produce a token.
    const metadata = await discover(config.issuer);
    const pkce = createPkcePair();
    const code = idp.authorize(
      buildAuthorizationUrl(config, metadata, {
        state: generateState(),
        nonce: generateNonce(),
        codeChallenge: pkce.challenge,
      }),
    );
    const wrong = createPkcePair().verifier;
    await expect(
      exchangeCodeForTokens(config, metadata, code, wrong),
    ).rejects.toMatchObject({ code: 'oidc_exchange_failed' });
  });

  it('cannot redeem the same authorization code twice', async () => {
    const metadata = await discover(config.issuer);
    const pkce = createPkcePair();
    const code = idp.authorize(
      buildAuthorizationUrl(config, metadata, {
        state: generateState(),
        nonce: generateNonce(),
        codeChallenge: pkce.challenge,
      }),
    );
    await exchangeCodeForTokens(config, metadata, code, pkce.verifier);
    await expect(exchangeCodeForTokens(config, metadata, code, pkce.verifier)).rejects.toBeInstanceOf(
      OidcError,
    );
  });

  it('derives the challenge as unpadded base64url of SHA-256 over the verifier', () => {
    const pair = createPkcePair();
    expect(pair.challenge).toBe(deriveChallenge(pair.verifier));
    expect(pair.challenge).not.toMatch(/[+/=]/);
    expect(pair.verifier.length).toBeGreaterThanOrEqual(43);
  });

  it('prefers client_secret_basic when the provider advertises it', async () => {
    const metadata = await discover(config.issuer);
    expect(tokenAuthMethod(metadata)).toBe('basic');
    // ...and the secret is therefore never in the form body.
    const bodies = idp.tokenRequests();
    expect(bodies.every((b) => b['client_secret'] === undefined)).toBe(true);
    expect(bodies.every((b) => typeof b['code_verifier'] === 'string')).toBe(true);
  });
});

describe('discovery', () => {
  it('caches the document instead of refetching it on every login', async () => {
    const before = idp.discoveryFetchCount();
    const cache = new Map<string, CacheEntry>();
    await discover(config.issuer, { cache });
    await discover(config.issuer, { cache });
    await discover(config.issuer, { cache });
    expect(idp.discoveryFetchCount() - before).toBe(1);
  });

  it('refetches once the entry has expired, so a key or endpoint change is picked up', async () => {
    const before = idp.discoveryFetchCount();
    const cache = new Map<string, CacheEntry>();
    let clock = 1_000;
    const now = (): number => clock;
    await discover(config.issuer, { cache, now, ttlMs: 60_000 });
    clock += 61_000;
    await discover(config.issuer, { cache, now, ttlMs: 60_000 });
    expect(idp.discoveryFetchCount() - before).toBe(2);
  });

  it('tolerates a trailing slash on the configured issuer', () => {
    expect(discoveryUrl('https://id.example.test/')).toBe(
      'https://id.example.test/.well-known/openid-configuration',
    );
  });

  it('refuses a document whose issuer is not the one we configured', () => {
    // Without this, whoever answers for the discovery URL chooses the jwks_uri,
    // and every later signature check passes against their keys.
    expect(() =>
      parseMetadata('https://id.example.test', {
        issuer: 'https://evil.example.test',
        authorization_endpoint: 'https://evil.example.test/a',
        token_endpoint: 'https://evil.example.test/t',
        jwks_uri: 'https://evil.example.test/jwks',
      }),
    ).toThrow(/issuer mismatch/);
  });

  it('names the missing endpoint at parse time rather than failing mid-login', () => {
    expect(() =>
      parseMetadata('https://id.example.test', {
        issuer: 'https://id.example.test',
        authorization_endpoint: 'https://id.example.test/a',
        jwks_uri: 'https://id.example.test/jwks',
      }),
    ).toThrow(/token_endpoint/);
  });

  it('does NOT require userinfo_endpoint, because every claim we use is in the ID token', () => {
    const metadata = parseMetadata('https://id.example.test', {
      issuer: 'https://id.example.test',
      authorization_endpoint: 'https://id.example.test/a',
      token_endpoint: 'https://id.example.test/t',
      jwks_uri: 'https://id.example.test/jwks',
    });
    expect(metadata.jwksUri).toBe('https://id.example.test/jwks');
  });

  it('reports a provider that is unreachable rather than throwing something unrecognisable', async () => {
    const failing: typeof fetch = () => Promise.reject(new Error('ECONNREFUSED'));
    await expect(
      discover('https://nowhere.example.test', { fetchImpl: failing, cache: new Map() }),
    ).rejects.toMatchObject({ code: 'oidc_discovery_failed' });
  });
});
