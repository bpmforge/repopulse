import {
  SignJWT,
  UnsecuredJWT,
  calculateJwkThumbprint,
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  type JWK,
} from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import { OidcError } from './errors.js';
import {
  ALLOWED_ID_TOKEN_ALGS,
  claimsFromPayload,
  narrowAlgorithms,
  verifyIdToken,
  type KeyResolver,
} from './verify.js';

// Every rejection in W15-03 acceptance 2, each proven on its own, with NO
// network: the key set is local, so nothing here can pass because a fixture
// server happened to be reachable.

const ISSUER = 'https://id.example.test';
const AUDIENCE = 'repopulse-client-id';

// `CryptoKey` is a DOM global that this package's tsconfig lib does not
// include, so the key type is taken from jose's own signature instead.
type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];

let signingKey: PrivateKey;
let attackerKey: PrivateKey;
let kid: string;
let keys: KeyResolver;

beforeAll(async () => {
  const real = await generateKeyPair('RS256', { extractable: true });
  const attacker = await generateKeyPair('RS256', { extractable: true });
  signingKey = real.privateKey;
  attackerKey = attacker.privateKey;

  const jwk: JWK = await exportJWK(real.publicKey);
  kid = await calculateJwkThumbprint(jwk);
  jwk.kid = kid;
  jwk.alg = 'RS256';
  keys = createLocalJWKSet({ keys: [jwk] }) as KeyResolver;
});

interface TokenOverrides {
  issuer?: string;
  audience?: string;
  expiresIn?: string | number;
  key?: PrivateKey;
  claims?: Record<string, unknown>;
}

async function mintToken(overrides: TokenOverrides = {}): Promise<string> {
  return new SignJWT({ email: 'ada@example.test', ...(overrides.claims ?? {}) })
    .setProtectedHeader({ alg: 'RS256', kid })
    .setIssuer(overrides.issuer ?? ISSUER)
    .setAudience(overrides.audience ?? AUDIENCE)
    .setSubject('subject-1')
    .setIssuedAt()
    .setExpirationTime(overrides.expiresIn ?? '5m')
    .sign(overrides.key ?? signingKey);
}

async function expectRejected(token: string, expectedNonce?: string): Promise<OidcError> {
  const error = await verifyIdToken({
    idToken: token,
    issuer: ISSUER,
    audience: AUDIENCE,
    keys,
    ...(expectedNonce !== undefined ? { expectedNonce } : {}),
  }).then(
    () => null,
    (err: unknown) => err,
  );
  expect(error, 'verification was expected to fail but succeeded').toBeInstanceOf(OidcError);
  return error as OidcError;
}

describe('ID token verification', () => {
  it('accepts a well-formed token and maps `sub` to the identity', async () => {
    const claims = await verifyIdToken({
      idToken: await mintToken(),
      issuer: ISSUER,
      audience: AUDIENCE,
      keys,
    });
    expect(claims.subject).toBe('subject-1');
    expect(claims.email).toBe('ada@example.test');
  });

  it('rejects a BAD SIGNATURE — a token signed by a key that is not in the JWKS', async () => {
    // Same `kid`, different private key: the key set resolves a key, so this
    // fails on the signature itself rather than on key lookup, which is the
    // check we mean to be testing.
    const error = await expectRejected(await mintToken({ key: attackerKey }));
    expect(error.code).toBe('oidc_id_token_invalid');
  });

  it('rejects the WRONG ISSUER', async () => {
    const error = await expectRejected(await mintToken({ issuer: 'https://evil.example.test' }));
    expect(error.code).toBe('oidc_id_token_invalid');
  });

  it('rejects the WRONG AUDIENCE — a valid token addressed to a different client', async () => {
    // This is the confused-deputy case: the IdP really did sign it, for some
    // other relying party. Signature alone is not authorization to enter here.
    const error = await expectRejected(await mintToken({ audience: 'someone-elses-client' }));
    expect(error.code).toBe('oidc_id_token_invalid');
  });

  it('rejects an EXPIRED token, beyond the clock tolerance', async () => {
    const error = await expectRejected(await mintToken({ expiresIn: '-10m' }));
    expect(error.code).toBe('oidc_id_token_invalid');
  });

  it('rejects alg=none — an UNSIGNED token that claims everything a real one does', async () => {
    // Deliberately NOT built with SignJWT, which refuses `alg: none` at sign
    // time; a test that passed because signing failed would prove nothing
    // about our verification. UnsecuredJWT produces the real attack payload.
    const unsigned = new UnsecuredJWT({ email: 'ada@example.test' })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject('subject-1')
      .setIssuedAt()
      .setExpirationTime('5m')
      .encode();
    expect(JSON.parse(Buffer.from(unsigned.split('.')[0] as string, 'base64url').toString()).alg).toBe(
      'none',
    );

    const error = await expectRejected(unsigned);
    expect(error.code).toBe('oidc_id_token_invalid');
  });

  it('rejects HS256 signed with the client secret — the classic algorithm-confusion downgrade', async () => {
    expect(ALLOWED_ID_TOKEN_ALGS).not.toContain('HS256');
    const secret = new TextEncoder().encode('a'.repeat(32));
    const forged = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', kid })
      .setIssuer(ISSUER)
      .setAudience(AUDIENCE)
      .setSubject('subject-1')
      .setExpirationTime('5m')
      .sign(secret);
    const error = await expectRejected(forged);
    expect(error.code).toBe('oidc_id_token_invalid');
  });

  it('rejects a token whose nonce is not the one this login sent', async () => {
    const token = await mintToken({ claims: { nonce: 'nonce-from-another-login' } });
    const error = await expectRejected(token, 'nonce-we-issued');
    expect(error.code).toBe('oidc_nonce_mismatch');
  });

  it('accepts the matching nonce', async () => {
    const token = await mintToken({ claims: { nonce: 'nonce-we-issued' } });
    const claims = await verifyIdToken({
      idToken: token,
      issuer: ISSUER,
      audience: AUDIENCE,
      keys,
      expectedNonce: 'nonce-we-issued',
    });
    expect(claims.subject).toBe('subject-1');
  });
});

describe('claim mapping', () => {
  it('identifies a person by `sub`, never by email', () => {
    // The whole point of acceptance 3: emails are reassigned when people leave,
    // so a new hire given a departed colleague's address must not inherit their
    // account. `sub` is what the IdP promises is stable.
    const claims = claimsFromPayload({
      sub: 'stable-opaque-id',
      email: 'reused@example.test',
      preferred_username: 'ada',
      name: 'Ada Lovelace',
      picture: 'https://example.test/ada.png',
    });
    expect(claims.subject).toBe('stable-opaque-id');
    expect(claims.email).toBe('reused@example.test');
    expect(claims.login).toBe('ada');
    expect(claims.name).toBe('Ada Lovelace');
    expect(claims.avatarUrl).toBe('https://example.test/ada.png');
  });

  it('falls back through preferred_username → email → sub for the display name', () => {
    expect(claimsFromPayload({ sub: 's', email: 'e@x.test' }).login).toBe('e@x.test');
    expect(claimsFromPayload({ sub: 's' }).login).toBe('s');
  });

  it('refuses a token with no `sub` rather than inventing an identity', () => {
    expect(() => claimsFromPayload({ email: 'e@x.test' })).toThrow(OidcError);
  });
});

describe('narrowing the accepted algorithms to what a provider advertises', () => {
  it('takes algorithms OFF the table when the provider says it does not use them', () => {
    expect(narrowAlgorithms(['RS256'])).toEqual(['RS256']);
  });

  it('never widens the allowlist to something a provider claims', () => {
    // The whole attack this guards is a discovery document that says "we sign
    // with HS256", where the verification key would be our own client secret.
    expect(narrowAlgorithms(['HS256', 'none', 'RS256'])).toEqual(['RS256']);
  });

  it('falls back to the full allowlist when the field is absent or nonsense', () => {
    expect(narrowAlgorithms([])).toBe(ALLOWED_ID_TOKEN_ALGS);
    expect(narrowAlgorithms(['HS256'])).toBe(ALLOWED_ID_TOKEN_ALGS);
  });
});
