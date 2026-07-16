import { randomBytes } from 'node:crypto';

export function generateState(): string {
  return randomBytes(32).toString('hex');
}
