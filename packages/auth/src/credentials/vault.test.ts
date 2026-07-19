import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  credentialFingerprint,
  decryptCredential,
  encryptCredential,
  fingerprintLast4,
  loadTokenKey,
  openSecret,
  sealSecret,
} from './vault.js';

const key = randomBytes(32);
const TOKEN = 'ghp_exampleSecretTokenValue1234567890ABCD';

describe('credential vault (FR-AUTH-5, NFR-6, SC-1)', () => {
  it('round-trips a token through AES-256-GCM', () => {
    const enc = encryptCredential(TOKEN, key);
    expect(decryptCredential(enc, key)).toBe(TOKEN);
  });

  it('never stores the plaintext token in the ciphertext or IV (DB-dump grep)', () => {
    const enc = encryptCredential(TOKEN, key);
    expect(enc.ciphertext.toString('utf8')).not.toContain(TOKEN);
    expect(enc.ciphertext.toString('latin1')).not.toContain(TOKEN);
    expect(enc.iv.toString('latin1')).not.toContain(TOKEN);
    // the display fingerprint carries only last-4 + a hash, never the token
    expect(enc.fingerprint).not.toContain(TOKEN);
    expect(enc.fingerprint).not.toContain(TOKEN.slice(0, -4));
  });

  it('uses a fresh random IV per encryption (same token → different ciphertext)', () => {
    const a = encryptCredential(TOKEN, key);
    const b = encryptCredential(TOKEN, key);
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it('rejects a tampered ciphertext (GCM auth tag)', () => {
    const enc = encryptCredential(TOKEN, key);
    const last = enc.ciphertext.length - 1;
    enc.ciphertext[last] = (enc.ciphertext[last] ?? 0) ^ 0xff; // flip a byte
    expect(() => decryptCredential(enc, key)).toThrow();
  });

  it('rejects the wrong key', () => {
    const enc = encryptCredential(TOKEN, key);
    expect(() => decryptCredential(enc, randomBytes(32))).toThrow();
  });

  it('fingerprint exposes last-4 + a short hash; last4 parses back out', () => {
    const fp = credentialFingerprint(TOKEN);
    expect(fp.startsWith('ABCD:')).toBe(true);
    expect(fingerprintLast4(fp)).toBe('ABCD');
  });

  it('sealSecret carries its own IV (iv‖tag‖ct) and openSecret round-trips it', () => {
    const secret = 'wh-per-connection-secret';
    const blob = sealSecret(secret, key);
    expect(openSecret(blob, key)).toBe(secret);
    // self-contained: two seals of the same secret differ (fresh IV each)
    expect(sealSecret(secret, key).equals(blob)).toBe(false);
    expect(blob.toString('latin1')).not.toContain(secret);
  });

  it('openSecret rejects a tampered sealed blob and the wrong key', () => {
    const blob = sealSecret('s', key);
    const bad = Buffer.from(blob);
    bad[bad.length - 1] = (bad[bad.length - 1] ?? 0) ^ 0xff;
    expect(() => openSecret(bad, key)).toThrow();
    expect(() => openSecret(blob, randomBytes(32))).toThrow();
  });

  it('loadTokenKey validates 32-byte hex', () => {
    expect(() => loadTokenKey({ TOKEN_ENC_KEY: 'abcd' } as NodeJS.ProcessEnv)).toThrow(/32 bytes/);
    expect(() => loadTokenKey({} as NodeJS.ProcessEnv)).toThrow(/required/);
    const good = randomBytes(32).toString('hex');
    expect(loadTokenKey({ TOKEN_ENC_KEY: good } as NodeJS.ProcessEnv).length).toBe(32);
  });
});
