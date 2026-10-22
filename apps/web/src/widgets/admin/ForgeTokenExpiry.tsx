import { Link } from '@tanstack/react-router';
import { useInbox } from '../me/Inbox.js';
import { expiryWords } from './CiTokenExpiry.js';
import { connectionLabel } from './Connections.js';

// Forge token owner and expiry (W20-25, UX_TODO ADM-50; W20_DECISIONS_2 row 4).
//
// A personal token that expires stops ingestion, and nothing said so before
// it happened. The API reads the owner and expiry from the forge at connect
// time; the Connections table shows them, and from 14 days before expiry
// admins see this banner on every screen and a notice in their inbox. Members
// get neither: the API lists expiring tokens to admins only.

/** The shell-wide warning for admins. Renders nothing for members or when no token is due. */
export function ForgeTokenBanner() {
  const { data } = useInbox();
  const due = data?.expiring_tokens ?? [];
  if (due.length === 0) return null;
  const first = due[0]!;
  const expired = Date.parse(first.expires_at) <= Date.now();
  return (
    <div
      role="status"
      className="flex items-start gap-2 border-b border-warn/40 bg-warn/10 px-4 py-1.5 text-xs text-fg"
      data-testid="forge-token-banner"
    >
      <span aria-hidden="true">●</span>
      <span>
        <strong>
          {due.length === 1
            ? `The ${connectionLabel(first.provider, first.base_url)} token${first.owner ? ` (${first.owner})` : ''} ${expiryWords(first.expires_at)}.`
            : `${due.length} forge tokens expire within 14 days or have expired.`}
        </strong>{' '}
        {expired || due.length > 1
          ? 'Syncing stops when a token expires. '
          : 'Syncing stops when it expires. '}
        Create a new token on the forge and use Replace token in{' '}
        <Link
          to={'/admin' as never}
          className="underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          data-testid="forge-token-banner-link"
        >
          Settings → Connections
        </Link>
        .
      </span>
    </div>
  );
}
