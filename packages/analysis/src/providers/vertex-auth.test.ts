import { generateKeyPairSync, createVerify } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearTokenCache,
  mintAccessToken,
  parseServiceAccount,
  signAssertion,
  ServiceAccountError,
} from './vertex-auth.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
});
const sa = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    type: 'service_account',
    client_email: 'rp@proj.iam.gserviceaccount.com',
    private_key: privateKey,
    token_uri: 'https://oauth2.googleapis.com/token',
    ...extra,
  });

beforeEach(() => clearTokenCache());

describe('parseServiceAccount', () => {
  it('rejects non-JSON with a sentence', () => {
    expect(() => parseServiceAccount('ya29.token')).toThrow(/not JSON/);
  });
  it('rejects a key of another type', () => {
    expect(() => parseServiceAccount(sa({ type: 'authorized_user' }))).toThrow(/service_account/);
  });
  it('rejects a missing private key', () => {
    expect(() => parseServiceAccount(sa({ private_key: '' }))).toThrow(/private_key/);
  });
  it('refuses a token endpoint that is not Google', () => {
    expect(() => parseServiceAccount(sa({ token_uri: 'https://evil.example/token' }))).toThrow(
      /not Google/,
    );
  });
});

describe('signAssertion', () => {
  it('produces an RS256 JWT that verifies with the public key and carries the claims', () => {
    const jwt = signAssertion(parseServiceAccount(sa()), 1000);
    const [h, c, s] = jwt.split('.') as [string, string, string];
    const v = createVerify('RSA-SHA256');
    v.update(`${h}.${c}`);
    expect(v.verify(publicKey, Buffer.from(s, 'base64url'))).toBe(true);
    const claims = JSON.parse(Buffer.from(c, 'base64url').toString());
    expect(claims).toMatchObject({
      iss: 'rp@proj.iam.gserviceaccount.com',
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1000,
      exp: 4600,
    });
  });
  it('reports an unreadable private key as a sentence', () => {
    expect(() => signAssertion(parseServiceAccount(sa({ private_key: 'not a key' })), 1)).toThrow(
      ServiceAccountError,
    );
  });
});

describe('mintAccessToken', () => {
  const ok = () =>
    vi.fn(async () => new Response(JSON.stringify({ access_token: 'tok1', expires_in: 3600 })));

  it('posts a jwt-bearer grant and caches the token until near expiry', async () => {
    const fetchImpl = ok();
    let t = 0;
    const deps = { fetchImpl: fetchImpl as unknown as typeof fetch, now: () => t };
    expect(await mintAccessToken(sa(), deps)).toBe('tok1');
    expect(await mintAccessToken(sa(), deps)).toBe('tok1');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = String(
      (fetchImpl.mock.calls[0] as unknown[])[1] &&
        ((fetchImpl.mock.calls[0] as unknown[])[1] as RequestInit).body,
    );
    expect(body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer');
    t = 3600_000;
    await mintAccessToken(sa(), deps);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("surfaces Google's own reason when the exchange is refused", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: 'invalid_grant', error_description: 'Invalid JWT' }), {
          status: 400,
        }),
    );
    await expect(
      mintAccessToken(sa(), { fetchImpl: fetchImpl as unknown as typeof fetch }),
    ).rejects.toThrow(/invalid_grant: Invalid JWT/);
  });
});
