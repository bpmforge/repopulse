import { randomBytes } from 'node:crypto';

// SC-17: 128-bit crypto-random share slug. 16 bytes hex-encoded = 32 chars.
export function generateShareSlug(): string {
  return randomBytes(16).toString('hex');
}
