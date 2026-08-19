import { createFileRoute, Link, Outlet } from '@tanstack/react-router';
import { serializeGlobalSearch } from '@repopulse/shared/url-state';
import { WidgetFrame } from '../../components/index.js';
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
  { to: '/admin/settings', label: 'Settings' },
];

function AdminLayout() {
  const search = Route.useSearch();
  const preserved = serializeGlobalSearch(search);
  const { data: me, isSuccess } = useApiQuery<MeContext>({ endpoint: '/me/context' });

  if (isSuccess && me?.role !== 'admin') {
    return (
      <WidgetFrame
        title="Admin"
        state="empty"
        emptyMessage="You need an admin role in this workspace. Ask an admin to connect your organisation or change your role."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="admin">
      <h1 className="text-lg font-semibold">Admin</h1>
      <nav className="flex gap-1 border-b border-border" aria-label="Admin sections">
        {TABS.map((tab) => (
          <Link
            key={tab.label}
            to={tab.to as never}
            search={preserved as never}
            activeOptions={{ exact: tab.exact ?? false }}
            activeProps={{ 'data-active': 'true' }}
            className="rounded-t-md px-3 py-2 text-sm text-fg-muted hover:text-fg data-[active=true]:border-b-2 data-[active=true]:border-accent data-[active=true]:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
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
