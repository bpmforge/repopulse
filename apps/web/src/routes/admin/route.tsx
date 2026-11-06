import { createFileRoute, Link, Outlet, useRouterState } from '@tanstack/react-router';
import { useActiveTabInView } from '../../components/shell/useActiveTabInView.js';
import { serializeGlobalSearch } from '@repopulse/shared/url-state';
import { PageHeader, WidgetFrame } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import type { MeContext } from '../../widgets/org/contracts.js';

// Admin (UX_SPEC §4.i). Tabs are routes, like the repo screen.
//
// The API enforces admin-only access on its own (requireSettings → 403); this
// check is presentation, not security. It exists so a member sees the
// ask-an-admin copy instead of a wall of failed requests — the 403 page copy
// FR-AUTH-4 calls for.
export const Route = createFileRoute('/admin')({
  component: AdminLayout,
});

interface AdminTab {
  to: string;
  label: string;
  exact?: boolean;
}

/**
 * W26-03 (UI review 2026-11-06, UI-07; Brad chose "group both"): thirteen
 * tabs in one row became a menu in four groups — a left column from lg up, a
 * single scrolling strip with group breaks below. Every page keeps its URL and
 * its `admin-tab-*` id, and every link is always rendered.
 */
export const ADMIN_GROUPS: { label: string; tabs: AdminTab[] }[] = [
  {
    label: 'Workspace',
    tabs: [
      { to: '/admin/members', label: 'Members' },
      { to: '/admin/identities', label: 'Identities' },
      { to: '/admin/agreements', label: 'Agreements' },
      { to: '/admin/settings', label: 'Scoring' },
    ],
  },
  {
    label: 'Sources',
    tabs: [
      { to: '/admin/', label: 'Connections', exact: true },
      { to: '/admin/sync', label: 'Sync' },
      { to: '/admin/ci-tokens', label: 'CI tokens' },
    ],
  },
  {
    label: 'Analysis',
    tabs: [
      { to: '/admin/rules', label: 'Rules' },
      { to: '/admin/analysis', label: 'Analysis' },
      { to: '/admin/models', label: 'Models' },
      { to: '/admin/patches', label: 'Verified fixes' },
    ],
  },
  {
    label: 'System',
    tabs: [
      { to: '/admin/setup', label: 'Setup' },
      { to: '/admin/audit', label: 'Audit log' },
    ],
  },
];

function AdminLayout() {
  const search = Route.useSearch();
  const preserved = serializeGlobalSearch(search);
  const { data: me, isSuccess, isError } = useApiQuery<MeContext>({ endpoint: '/me/context' });
  const pathname = useRouterState({ select: (st) => st.location.pathname });
  const menuStrip = useActiveTabInView<HTMLElement>(`${pathname}|${me?.role ?? ''}`);

  // W20-17 (UX_TODO ADM-21): nothing admin-only renders until the role is
  // KNOWN. The tabs and their widgets used to mount while /me/context loaded
  // (or after it failed), fire admin-only requests, and flash "Forbidden"
  // cards at a member.
  if (!isSuccess && !isError) {
    return (
      <div className="flex flex-col gap-4" data-testid="admin-loading" aria-busy="true">
        <div className="h-7 w-40 animate-pulse rounded-md bg-surface-2" />
        <div className="h-9 w-full animate-pulse rounded-md bg-surface-2" />
        <div className="h-48 w-full animate-pulse rounded-md bg-surface-2" />
      </div>
    );
  }

  // An error is treated as not-admin: the API would refuse the tabs anyway.
  if (isError || me?.role !== 'admin') {
    const admins = me?.admin_logins ?? [];
    // W20-04 (UX_TODO ADM-04): the rail no longer sends members here, but a
    // bookmark still can — so the wall points at the page that IS theirs.
    return (
      <div className="flex flex-col gap-2">
        <WidgetFrame
          title="Settings"
          state="empty"
          emptyMessage={
            admins.length > 0
              ? `You need an admin role in this workspace. Ask an admin (${admins.join(', ')}) to connect your organization or change your role.`
              : 'You need an admin role in this workspace. Ask an admin to connect your organization or change your role.'
          }
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
      {/* W17-31: below lg the menu is ONE strip that scrolls within itself,
          so no Settings screen scrolls sideways at 390px. From lg up it is a
          left column beside the page. */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:gap-6">
        <nav
          ref={menuStrip}
          className="flex shrink-0 gap-0.5 overflow-x-auto border-b border-border pb-px lg:sticky lg:top-12 lg:w-48 lg:flex-col lg:gap-4 lg:overflow-visible lg:border-b-0 lg:pb-0"
          aria-label="Admin sections"
          data-testid="admin-menu"
        >
          {ADMIN_GROUPS.map((group, gi) => (
            <div
              key={group.label}
              role="group"
              aria-label={group.label}
              className="flex shrink-0 items-center gap-0.5 lg:flex-col lg:items-stretch"
            >
              <span className="hidden px-3 pb-1 text-xs font-medium text-fg-faint lg:block">
                {group.label}
              </span>
              {group.tabs.map((tab) => (
                <Link
                  key={tab.label}
                  to={tab.to as never}
                  search={preserved as never}
                  activeOptions={{ exact: tab.exact ?? false, includeSearch: false }}
                  activeProps={{ 'data-active': 'true' }}
                  className="relative shrink-0 whitespace-nowrap rounded-md px-3 py-2 text-sm text-fg-muted hover:text-fg data-[active=true]:font-medium data-[active=true]:text-fg data-[active=true]:after:absolute data-[active=true]:after:inset-x-3 data-[active=true]:after:-bottom-px data-[active=true]:after:h-0.5 data-[active=true]:after:rounded-full data-[active=true]:after:bg-accent lg:py-1.5 lg:hover:bg-surface-2 lg:data-[active=true]:bg-surface-2 lg:data-[active=true]:after:hidden focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  data-testid={`admin-tab-${tab.label.toLowerCase()}`}
                >
                  {tab.label}
                </Link>
              ))}
              {gi < ADMIN_GROUPS.length - 1 && (
                <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-border lg:hidden" />
              )}
            </div>
          ))}
        </nav>
        <div className="min-w-0 flex-1">
          <Outlet />
        </div>
      </div>
    </div>
  );
}
