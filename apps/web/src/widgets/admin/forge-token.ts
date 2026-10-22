import { expiryWords } from './CiTokenExpiry.js';

// The Connections table's token cells in words (W20-25, UX_TODO ADM-50). Kept
// apart from the banner so Connections.tsx can import them without a cycle.

export interface TokenFields {
  status: string;
  auth_kind?: string;
  token_owner?: string | null;
  token_expires_at?: string | null;
  token_checked_at?: string | null;
  token_expiry?: 'expired' | 'expiring' | 'ok' | 'unknown';
}

/** The token cell in words: whose it is and when it stops working. */
export function tokenOwnerText(row: TokenFields): string {
  if (row.status !== 'active') return '—';
  if (row.auth_kind === 'app') return 'App installation';
  if (!row.token_checked_at) return 'Not read yet (read at the next nightly sync)';
  return row.token_owner ?? 'owner not reported';
}

export function tokenExpiryText(row: TokenFields, now: number = Date.now()): string {
  if (row.status !== 'active' || row.auth_kind === 'app' || !row.token_checked_at) return '—';
  if (!row.token_expires_at) return 'No expiry reported';
  return expiryWords(row.token_expires_at, now);
}
