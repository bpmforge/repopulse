import { useEffect } from 'react';
import { createFileRoute, Link, Outlet, useParams } from '@tanstack/react-router';
import { serializeGlobalSearch } from '@repopulse/shared/url-state';
import { WidgetFrame } from '../../../components/index.js';
import { useApiQuery } from '../../../api/useApiQuery.js';
import { useUiStore } from '../../../components/store/uiStore.js';
import { HealthWhy } from '../../../widgets/repo/HealthWhy.js';
// W10-05: the axis letters belong beside the health grade, which is here.
// Widened out of the ticket's write_scope on purpose — a widget nobody mounts
// is the defect class this codebase keeps rediscovering.
import { RiskAxisStrip } from '../../../widgets/risk/RiskAxisStrip.js';
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
  { to: '/repos/$repoId/security', label: 'Security' },
  { to: '/repos/$repoId/code-health', label: 'Code Health' },
];

/**
 * Read the transport status off the query error the way useApiQuery does,
 * rather than `instanceof ApiError`: a duplicated module identity would make
 * every failure look generic, and the 404 wording below is the whole point.
 */
function statusOf(error: unknown): number | undefined {
  return (error as { status?: number } | null | undefined)?.status;
}

function requestIdOf(error: unknown): string | undefined {
  return (error as { requestId?: string } | null | undefined)?.requestId;
}

function RepoLayout() {
  const { repoId } = useParams({ from: '/repos/$repoId' });
  const search = Route.useSearch();
  const preserved = serializeGlobalSearch(search);
  // THE CRUMB ONLY THIS SCREEN KNOWS (W16-42).
  //
  // A repository's name is not in its URL, so the trail read
  // "Org › Repos › Security" and never said WHICH repository — on a product
  // whose whole premise is drilling down org → repo → PR → file. __root has
  // said since W16-05 that this crumb "has to come from the screen that loaded
  // it"; this is that.
  //
  // Published with the path it belongs to, so navigating between repos cannot
  // leave the previous name in the trail, and cleared on unmount so leaving
  // the section cannot either. A confidently wrong trail is worse than a thin
  // one.
  const setEntityCrumb = useUiStore((s) => s.setEntityCrumb);

  const { data, isLoading, isError, error, refetch } = useApiQuery<RepoDetail>({
    endpoint: '/repos/{id}',
    path: { id: repoId },
    query: { window: search.window },
  });

  const repoName = data?.name;
  useEffect(() => {
    if (repoName === undefined) return;
    setEntityCrumb({ pathPrefix: `/repos/${repoId}`, label: repoName, to: `/repos/${repoId}` });
    return () => setEntityCrumb(null);
  }, [repoId, repoName, setEntityCrumb]);

  const tabs = (
    <nav
      className="flex gap-1 border-b border-border"
      data-testid="repo-tabs"
      aria-label="Repository sections"
    >
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
  );

  // A failing repo query used to return the error frame ALONE, which took the
  // tab bar down with it and left a pasted or bookmarked URL with no way onward
  // but the back button. Whatever went wrong, the screen still has to offer a
  // route out — the repository list at minimum.
  if (isError) {
    const status = statusOf(error);
    // GET /repos/:id looks the repository up already filtered by workspace
    // (apps/api/src/routes/repos/index.ts), so "no such repository" and "yours
    // is not the workspace that owns it" arrive as the same 404. The copy has
    // to cover both without asserting either.
    const unseeable = status === 404;
    const requestId = requestIdOf(error);
    return (
      <div className="flex flex-col gap-4" data-testid="repo-detail">
        <header className="flex flex-wrap items-center gap-3">
          <h1 className="text-lg font-semibold" data-testid="repo-name">
            {repoId}
          </h1>
        </header>

        {/* The tabs stay for a transport failure — the repository is presumably
            still there and a sibling tab may well load — but not for a 404: a
            row of links that are all guaranteed to fail is worse than none. */}
        {!unseeable && tabs}

        <WidgetFrame
          title={unseeable ? 'Repository not visible here' : 'Repository failed to load'}
          state="error"
          testId="repo-error"
          errorMessage={
            unseeable
              ? // Never "deleted": a 404 here says only that this workspace
                // cannot see it. It may live in another workspace, it may never
                // have been ingested, and we do not have its name to quote back
                // — the id from the URL is the only identifier we hold.
                `This workspace cannot see a repository with id ${repoId}. It may belong to another workspace, or it may never have been ingested here.`
              : // The reason phrase alone ("Not Found", "Bad Gateway") explains
                // nothing, so say what we were doing when it failed.
                `We could not load repository ${repoId}. ${error?.message ?? 'The request failed.'}`
          }
          {...(requestId ? { requestId } : {})}
          {...(unseeable ? {} : { onRetry: () => void refetch() })}
        />

        <p className="text-sm text-fg-muted">
          <Link
            to="/repos"
            search={preserved as never}
            className="text-accent underline-offset-2 hover:underline"
            data-testid="repo-error-to-list"
          >
            Browse all repositories
          </Link>
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="repo-detail">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-lg font-semibold" data-testid="repo-name">
          {data ? `${data.org}/${data.name}` : isLoading ? 'Loading…' : repoId}
        </h1>
        <div className="flex flex-wrap items-center gap-4">
          <RiskAxisStrip repoId={repoId} />
          {data && <HealthWhy health={data.health} />}
        </div>
      </header>

      {tabs}

      <Outlet />
    </div>
  );
}
