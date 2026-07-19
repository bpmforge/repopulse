import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

// Forge-credential vault (FR-AUTH-5, NFR-6, SC-1): AES-256-GCM via node:crypto,
// a fresh random 12-byte IV per row, auth tag stored, 32-byte key from env,
// key_version for rotation. Plaintext never touches the DB or logs; decryption
// happens only in forge-module memory when a call actually needs the token.

const ALGO = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Current key version — bump + backfill via a decrypt-old/encrypt-new sweep. */
export const CURRENT_KEY_VERSION = 1;

export interface EncryptedCredential {
  /** authTag(16 bytes) ‖ ciphertext — the forge_connections schema has no
   * separate tag column, so the GCM tag is prepended to the stored blob. */
  ciphertext: Buffer;
  iv: Buffer;
  keyVersion: number;
  /** Safe-to-display `last4:sha256[0:12]` — never the token itself. */
  fingerprint: string;
}

/** Load + validate the 32-byte AES key from env (TOKEN_ENC_KEY, hex). */
export function loadTokenKey(env: NodeJS.ProcessEnv = process.env): Buffer {
  const hex = env.TOKEN_ENC_KEY;
  if (!hex) throw new Error('TOKEN_ENC_KEY is required (32-byte hex)');
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) throw new Error('TOKEN_ENC_KEY must be 32 bytes (64 hex chars)');
  return key;
}

/** Non-reversible display fingerprint: last 4 chars + a short sha256 prefix. */
export function credentialFingerprint(token: string): string {
  const last4 = token.slice(-4);
  const sha = createHash('sha256').update(token).digest('hex').slice(0, 12);
  return `${last4}:${sha}`;
}

/** The last-4 the UI shows (parsed out of the stored fingerprint). */
export function fingerprintLast4(fingerprint: string): string {
  return fingerprint.split(':')[0] ?? '';
}

export function encryptCredential(plaintext: string, key: Buffer): EncryptedCredential {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([tag, enc]),
    iv,
    keyVersion: CURRENT_KEY_VERSION,
    fingerprint: credentialFingerprint(plaintext),
  };
}

export interface StoredCredential {
  ciphertext: Buffer;
  iv: Buffer;
  keyVersion: number;
}

// Decryption is intentionally exported for forge-module use only (arch: forge
// may import auth). A tampered blob or wrong key throws (GCM auth-tag failure)
// rather than returning garbage.
export function decryptCredential(rec: StoredCredential, key: Buffer): string {
  if (rec.ciphertext.length < TAG_BYTES) throw new Error('ciphertext too short');
  const tag = rec.ciphertext.subarray(0, TAG_BYTES);
  const enc = rec.ciphertext.subarray(TAG_BYTES);
  const decipher = createDecipheriv(ALGO, key, rec.iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString('utf8');
}
