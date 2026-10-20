import { useApiQuery } from '../../api/useApiQuery.js';
import type { MeContext } from '../org/contracts.js';
import { useAuthProviders, useIdentityLink } from './contracts.js';

// "Your account is not connected to a committer" (W15-04, D14, FR-AUTH-6).
//
// Since D14 a person can sign in with a local account or their company IdP, and
// neither says anything about which forge account writes their code. Every
// personalized surface — My PRs, my review load, hotspots in code I own —
// resolves through the identity link, so for such a user they are all empty.
//
// An empty list is an ANSWER: it says "you have no open pull requests". For an
// unlinked account that answer is false, and the product would be stating
// something about someone's work that it has no basis for. This banner is what
// makes the difference visible, and it is deliberately in the shell rather than
// inside one widget: the claim is wrong on every personalized screen, not just
// the one that happens to carry the notice.
//
// `no_activity` is DELIBERATELY SILENT here even though the endpoint reports it.
// "Your account is connected and nothing of yours has been ingested" is a true
// statement about someone's work, so an empty list is already an honest answer
// — and this banner is shell-wide and undismissable, which for an exec or a
// lead who never commits would mean a permanent warning stripe on every screen
// about a state they will never leave. The distinction stays in the API so a
// per-widget empty state can use it where it is actually relevant.

export function ForgeLinkBanner() {
  const { link } = useIdentityLink();
  const { providers } = useAuthProviders();
  const { data: me } = useApiQuery<MeContext>({ endpoint: '/me/context' });

  // Tested against the one state that SPEAKS rather than against 'linked', so
  // an unregistered endpoint, an older API that omits the field, or a state
  // added later all render nothing rather than a banner whose text nobody
  // chose.
  if (link?.state !== 'unlinked') return null;
  // W20-17 (UX_TODO INS-36): before the first sync there are no committers to
  // link to, so the warning is premature, and it told the brand-new bootstrap
  // admin to ask an administrator (themselves).
  if (me?.repo_count === 0) return null;
  const isAdmin = me?.role === 'admin';

  return (
    <div
      className="flex items-start gap-2 border-b border-warn/40 bg-warn/10 px-4 py-1.5 text-xs text-fg"
      data-testid="forge-link-banner"
      data-link-state={link.state}
      role="status"
    >
      <span aria-hidden="true">●</span>
      <span>
        <strong>Not connected to a forge account.</strong> Your personal views are empty because
        RepoPulse does not know which committer is you — not because you have no work.
        {isAdmin ? (
          <>
            {' '}
            Link your account to your committer in{' '}
            <a
              href="/admin/identities"
              className="underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              data-testid="forge-link-banner-identities"
            >
              Settings → Identities
            </a>
            .
          </>
        ) : providers.github ? (
          ' Signing in with GitHub connects it automatically; otherwise ask an administrator to link your forge identity.'
        ) : (
          ' Ask an administrator to link your forge identity.'
        )}
      </span>
    </div>
  );
}
