import { Link } from '@tanstack/react-router';
import { useApiQuery } from '../../api/useApiQuery.js';

// CI tokens about to expire (W20-15, UX_TODO X-19).
//
// A CI token lasts at most 365 days. On the day one expires, every pipeline
// using it starts failing with "Invalid, expired or revoked token", and nothing
// in RepoPulse said so beforehand. This names the tokens that expire within
// two weeks (or already have, and were never replaced) on System health and
// the Setup checklist, and the CI token list highlights the same rows.

export const EXPIRY_WARNING_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface ExpiringTokenInput {
  id: number;
  name: string;
  expires_at: string | null;
  revoked_at: string | null;
}

export type ExpiryState = 'expired' | 'expiring' | null;

/** Whether a token needs attention now: expired (unrevoked), or within the warning window. */
export function expiryState(token: ExpiringTokenInput, now: number = Date.now()): ExpiryState {
  if (token.revoked_at || !token.expires_at) return null;
  const at = Date.parse(token.expires_at);
  if (Number.isNaN(at)) return null;
  if (at <= now) return 'expired';
  return at - now <= EXPIRY_WARNING_DAYS * DAY_MS ? 'expiring' : null;
}

/** "in 3 days", "today", "expired 2 days ago". */
export function expiryWords(expiresAt: string, now: number = Date.now()): string {
  const days = Math.round((Date.parse(expiresAt) - now) / DAY_MS);
  if (days > 1) return `expires in ${days} days`;
  if (days === 1) return 'expires tomorrow';
  if (days === 0) return Date.parse(expiresAt) > now ? 'expires today' : 'expired today';
  return `expired ${-days} day${days === -1 ? '' : 's'} ago`;
}

export function expiringTokens<T extends ExpiringTokenInput>(
  items: readonly T[],
  now: number = Date.now(),
): T[] {
  return items
    .filter((t) => expiryState(t, now) !== null)
    .sort((a, b) => Date.parse(a.expires_at!) - Date.parse(b.expires_at!));
}

/**
 * The warning, for System health and the Setup checklist. Renders nothing when
 * no token needs attention or the caller may not list tokens (members).
 */
export function CiTokenExpiryNotice() {
  const { data } = useApiQuery<{ items: ExpiringTokenInput[] }>({
    endpoint: '/admin/ci-tokens',
  });
  const due = expiringTokens(data?.items ?? []);
  if (due.length === 0) return null;
  return (
    <div
      role="status"
      className="rounded-md border border-warn/40 bg-warn/10 p-3 text-sm text-fg"
      data-testid="ci-token-expiry"
    >
      <p className="font-medium">
        {due.length === 1 ? 'A CI token needs' : `${due.length} CI tokens need`} replacing
      </p>
      <p className="mt-0.5 text-xs text-fg-muted">
        Pipelines using an expired token fail with exit code 3. Create a replacement, put it in the
        pipeline&apos;s REPOPULSE_TOKEN, then revoke the old one.
      </p>
      <ul className="mt-1 text-xs">
        {due.map((t) => (
          <li key={t.id} data-testid={`ci-token-expiry-${t.id}`}>
            {t.name} — {expiryWords(t.expires_at!)}
          </li>
        ))}
      </ul>
      <Link to="/admin/ci-tokens" className="mt-1 inline-block text-xs text-accent underline">
        Open CI tokens
      </Link>
    </div>
  );
}
