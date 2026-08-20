import { createHash, randomBytes } from 'node:crypto';

// PKCE (RFC 7636), S256 only.
//
// `plain` is in the RFC and is not implemented here: it makes the challenge and
// the verifier the same string, so anything that could intercept the
// authorization response could also replay it, which is the entire attack PKCE
// exists to stop. An IdP that only supports `plain` is one we decline to talk to.

export interface PkcePair {
  verifier: string;
  challenge: string;
  method: 'S256';
}

/** base64url of raw bytes, no padding — RFC 7636 §4.1 forbids the `=`. */
function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

export function createPkcePair(): PkcePair {
  // 32 bytes → 43 base64url characters, the RFC's minimum verifier length and
  // comfortably inside its 128-character maximum.
  const verifier = base64url(randomBytes(32));
  return { verifier, challenge: deriveChallenge(verifier), method: 'S256' };
}

export function deriveChallenge(verifier: string): string {
  return base64url(createHash('sha256').update(verifier, 'ascii').digest());
}
