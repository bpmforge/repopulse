import { describe, expect, it } from 'vitest';
import {
  MIN_PASSWORD_LENGTH,
  decoyPasswordHash,
  hashPassword,
  passwordPolicyError,
  verifyPassword,
} from './password.js';

describe('local password hashing (W15-02)', () => {
  it('round-trips a password and rejects a wrong one', async () => {
    const stored = await hashPassword('correct horse battery staple');
    await expect(verifyPassword(stored, 'correct horse battery staple')).resolves.toEqual({
      ok: true,
      needsRehash: false,
    });
    await expect(verifyPassword(stored, 'correct horse battery stapl')).resolves.toEqual({
      ok: false,
      needsRehash: false,
    });
  });

  it('salts every hash, so identical passwords do not share a stored value', async () => {
    const a = await hashPassword('the same password');
    const b = await hashPassword('the same password');
    expect(a).not.toEqual(b);
    await expect(verifyPassword(b, 'the same password')).resolves.toMatchObject({ ok: true });
  });

  it('stores the cost parameters alongside the hash', async () => {
    const stored = await hashPassword('some password here');
    const [scheme, meta, salt, hash] = stored.split('$');
    expect(scheme).toBe('scrypt');
    // The point of the format: a reader can tell what it cost without the code.
    expect(meta).toMatch(/^N=\d+,r=\d+,p=\d+,keylen=\d+$/);
    expect(Buffer.from(salt as string, 'base64').length).toBeGreaterThanOrEqual(16);
    expect(Buffer.from(hash as string, 'base64').length).toBe(32);
  });

  it('verifies a hash written with WEAKER parameters and asks to be rehashed', async () => {
    // A hash from a hypothetical earlier release. If this cannot be verified,
    // raising the cost would lock every existing user out — which is exactly
    // what putting the parameters in the string is meant to prevent.
    const { randomBytes, scryptSync } = await import('node:crypto');
    const salt = randomBytes(16);
    const weak = { N: 16384, r: 8, p: 1, keylen: 32 };
    const key = scryptSync('legacy password!', salt, weak.keylen, { ...weak, maxmem: 64 * 1024 * 1024 });
    const stored = `scrypt$N=${weak.N},r=${weak.r},p=${weak.p},keylen=${weak.keylen}$${salt.toString('base64')}$${key.toString('base64')}`;

    await expect(verifyPassword(stored, 'legacy password!')).resolves.toEqual({
      ok: true,
      needsRehash: true,
    });
    await expect(verifyPassword(stored, 'wrong')).resolves.toEqual({
      ok: false,
      needsRehash: false,
    });
  });

  it('fails closed on a corrupt or truncated stored value', async () => {
    for (const bad of [
      '',
      'notahash',
      'scrypt$N=32768,r=8,p=1,keylen=32$$',
      'bcrypt$N=1,r=1,p=1,keylen=32$AAAA$AAAA',
      'scrypt$N=99999999,r=8,p=1,keylen=32$AAAA$AAAA',
    ]) {
      await expect(verifyPassword(bad, 'anything')).resolves.toEqual({
        ok: false,
        needsRehash: false,
      });
    }
  });

  it('rejects a tampered hash body without throwing on a length mismatch', async () => {
    // timingSafeEqual throws when the buffers differ in length; a stored value
    // whose hash is the wrong size must fail, not crash the login route.
    const stored = await hashPassword('a good long password');
    const parts = stored.split('$');
    parts[3] = Buffer.from('short').toString('base64');
    await expect(verifyPassword(parts.join('$'), 'a good long password')).resolves.toEqual({
      ok: false,
      needsRehash: false,
    });
  });

  it('offers a decoy hash with the current parameters, so a missing account still costs a derivation', async () => {
    const decoy = await decoyPasswordHash();
    const current = await hashPassword('x'.repeat(MIN_PASSWORD_LENGTH));
    expect(decoy.split('$')[1]).toBe(current.split('$')[1]);
    // Same value on every call — recomputing it per request would cost a second
    // derivation and make the "no such user" path SLOWER than the real one.
    expect(await decoyPasswordHash()).toBe(decoy);
    await expect(verifyPassword(decoy, 'guess')).resolves.toMatchObject({ ok: false });
  });

  it('enforces a length policy and nothing else', () => {
    expect(passwordPolicyError('short')).toMatch(/at least/);
    expect(passwordPolicyError('a'.repeat(MIN_PASSWORD_LENGTH))).toBeNull();
    expect(passwordPolicyError('x'.repeat(257))).toMatch(/at most/);
    // No composition rule: a long passphrase of only lowercase letters is fine.
    expect(passwordPolicyError('correct horse battery staple')).toBeNull();
  });
});
