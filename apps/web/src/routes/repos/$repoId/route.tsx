import { createFileRoute, Link, Outlet, useParams } from '@tanstack/react-router';
import { serializeGlobalSearch } from '@repopulse/shared/url-state';
import { WidgetFrame } from '../../../components/index.js';
import { useApiQuery } from '../../../api/useApiQuery.js';
import { HealthWhy } from '../../../widgets/repo/HealthWhy.js';
import type { RepoDetail } from '../../../widgets/repo/contracts.js';

// Repo Detail layout (UX_SPEC §4.b). Each tab is its OWN route, not local state
// (DASHBOARD §1): a tab has to be linkable, back-button-able and paste-able, and
// FR-WEB-2 requires a pasted URL to restore the identical screen.
export const Route = createFileRoute('/repos/$repoId')({
  component: RepoLayout,
});

// Absolute route paths, not relative ones: a relative `to` resolves against the
// CURRENT route, so once you are on /hotspots the Hotspots link becomes
// /hotspots/hotspots. Caught by the deep-link e2e, which is exactly the case a
// click-through walk would have kept passing.
const TABS: { to: string; label: string; exact?: boolean }[] = [
  { to: '/repos/$repoId/', label: 'Pulse', exact: true },
  { to: '/repos/$repoId/hotspots', label: 'Hotspots' },
  { to: '/repos/$repoId/pr-flow', label: 'PR Flow' },
  { to: '/repos/$repoId/ci', label: 'CI' },
  { to: '/repos/$repoId/findings', label: 'Findings' },
];

function RepoLayout() {
  const { repoId } = useParams({ from: '/repos/$repoId' });
  const search = Route.useSearch();
  const preserved = serializeGlobalSearch(search);
  const { data, isLoading, isError, error } = useApiQuery<RepoDetail>({
    endpoint: '/repos/{id}',
    path: { id: repoId },
    query: { window: search.window },
  });

  if (isError) {
    return (
      <WidgetFrame
        title="Repository"
        state="error"
        {...(error ? { errorMessage: error.message } : {})}
      />
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="repo-detail">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold" data-testid="repo-name">
          {data ? `${data.org}/${data.name}` : (isLoading ? 'Loading…' : repoId)}
        </h1>
        {data && <HealthWhy health={data.health} />}
      </header>

      <nav className="flex gap-1 border-b border-border" data-testid="repo-tabs" aria-label="Repository sections">
        {TABS.map((tab) => (
          <Link
            key={tab.label}
            to={tab.to as never}
            params={{ repoId } as never}
            search={preserved as never}
            activeOptions={{ exact: tab.exact ?? false }}
            activeProps={{ 'data-active': 'true' }}
            className="rounded-t-md px-3 py-2 text-sm text-fg-muted hover:text-fg data-[active=true]:border-b-2 data-[active=true]:border-accent data-[active=true]:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            data-testid={`repo-tab-${tab.label.toLowerCase().replace(/\s/g, '-')}`}
          >
            {tab.label}
          </Link>
        ))}
      </nav>

      <Outlet />
    </div>
  );
}
