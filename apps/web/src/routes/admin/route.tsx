import { createFileRoute, Link, Outlet } from '@tanstack/react-router';
import { serializeGlobalSearch } from '@repopulse/shared/url-state';
import { PageHeader, WidgetFrame } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import type { MeContext } from '../../widgets/org/contracts.js';

// Admin (UX_SPEC §4.i). Tabs are routes, like the repo screen.
//
// The API enforces admin-only access on its own (requireAdmin → 403); this
// check is presentation, not security. It exists so a member sees the
// ask-an-admin copy instead of a wall of failed requests — the 403 page copy
// FR-AUTH-4 calls for.
export const Route = createFileRoute('/admin')({
  component: AdminLayout,
});

const TABS: { to: string; label: string; exact?: boolean }[] = [
  { to: '/admin/', label: 'Connections', exact: true },
  { to: '/admin/sync', label: 'Sync' },
  { to: '/admin/members', label: 'Members' },
  { to: '/admin/identities', label: 'Identities' },
  { to: '/admin/agreements', label: 'Agreements' },
  { to: '/admin/rules', label: 'Rules' },
  { to: '/admin/analysis', label: 'Analysis' },
  // W16-07: where the model this product runs on is configured. Next to
  // Analysis because the two answer the same question from opposite ends —
  // Analysis says which repos may be analysed, Models says what analyses them.
  { to: '/admin/models', label: 'Models' },
  // W18-29: the verified-fix attempts, beside the model that drafts them.
  { to: '/admin/patches', label: 'Verified fixes' },
  { to: '/admin/settings', label: 'Settings' },
  // W20-08 (UX_TODO FND-17): minting a CI token needed curl and a copied cookie.
  { to: '/admin/ci-tokens', label: 'CI tokens' },
  // W20-10 (UX_TODO X-04): who changed what, from the persisted audit trail.
  { to: '/admin/audit', label: 'Audit log' },
  // W11-02. Its own top-level route rather than an /admin child — the setup
  // checklist is what an operator opens when something is not working yet, and
  // burying it under a tab group they are already lost in helps nobody. The
  // link lives here because this is where they look first.
  { to: '/setup', label: 'Setup' },
];

function AdminLayout() {
  const search = Route.useSearch();
  const preserved = serializeGlobalSearch(search);
  const { data: me, isSuccess } = useApiQuery<MeContext>({ endpoint: '/me/context' });

  if (isSuccess && me?.role !== 'admin') {
    // W20-04 (UX_TODO ADM-04): the rail no longer sends members here, but a
    // bookmark still can — so the wall points at the page that IS theirs.
    return (
      <div className="flex flex-col gap-2">
        <WidgetFrame
          title="Admin"
          state="empty"
          emptyMessage="You need an admin role in this workspace. Ask an admin to connect your organisation or change your role."
        />
        <p className="text-sm text-fg-muted">
          Your own theme, home screen and password are in{' '}
          <Link to="/account" className="text-accent underline" data-testid="admin-wall-account">
            Account
          </Link>
          .
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="admin">
      {/* W17-12: was `text-lg font-semibold`, i.e. the same 18px a SECTION
          title uses elsewhere — so the page and section levels were
          indistinguishable and a reader could not tell where they were. */}
      <PageHeader
        title="Settings"
        description="Connections, models, analysis policy, members, and the health of this install."
        testId="admin-header"
      />
      {/* W17-31: the strip scrolls WITHIN ITSELF on narrow screens. Nine tabs
          that could not wrap or scroll pushed <main> 440px past a 390px
          viewport, so every Settings screen scrolled sideways — the page-level
          overflow the ticket forbids. `shrink-0` + nowrap keeps each tab
          readable; `overflow-x-auto` keeps the overflow inside the strip. */}
      <nav
        className="flex gap-0.5 overflow-x-auto border-b border-border pb-px"
        aria-label="Admin sections"
      >
        {TABS.map((tab) => (
          <Link
            key={tab.label}
            to={tab.to as never}
            search={preserved as never}
            // includeSearch off (W18-28): an EXACT match also compares the search
            // params in full, and the filters in the URL never equal the preserved
            // subset this link carries — so the default tab (Pulse, Connections) was
            // never marked active on the screen it was showing.
            activeOptions={{ exact: tab.exact ?? false, includeSearch: false }}
            activeProps={{ 'data-active': 'true' }}
            className="relative shrink-0 whitespace-nowrap rounded-md px-3 py-2 text-sm text-fg-muted hover:text-fg data-[active=true]:font-medium data-[active=true]:text-fg data-[active=true]:after:absolute data-[active=true]:after:inset-x-3 data-[active=true]:after:-bottom-px data-[active=true]:after:h-0.5 data-[active=true]:after:rounded-full data-[active=true]:after:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            data-testid={`admin-tab-${tab.label.toLowerCase()}`}
          >
            {tab.label}
          </Link>
        ))}
      </nav>
      <Outlet />
    </div>
  );
}
