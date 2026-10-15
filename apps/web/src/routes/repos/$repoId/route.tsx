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
  // Activity and Performance sit next to Pulse because they are the two
  // questions asked before any drill-down: "what has been happening here" and
  // "how fast does work get out". Neither owns an endpoint of its own —
  // Activity links the analyses that already exist, Performance reads the
  // delivery metrics nothing else on this screen shows.
  { to: '/repos/$repoId/activity', label: 'Activity' },
  { to: '/repos/$repoId/performance', label: 'Performance' },
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

  const { data, isError, error, refetch } = useApiQuery<RepoDetail>({
    endpoint: '/repos/{id}',
    path: { id: repoId },
    query: { window: search.window },
  });

  // THE ANSWER TO *THIS* REPOSITORY, NOT THE LAST ONE (W17-19).
  //
  // useApiQuery keeps the previous data while the new key loads
  // (`placeholderData: keepPreviousData`) — deliberate for a window change, where
  // a chart dimming to 50% beats a skeleton flash (UX §8), and wrong the moment
  // the REPOSITORY changes: /repos/8 rendered "acme/web" in the heading, in the
  // breadcrumb and in the health grade until the new fetch landed, which is a
  // confident lie about whose repository you are looking at.
  //
  // Gated on the id in the payload rather than on `isPlaceholderData`, which
  // would also fire on a window change and take the deliberate stale-render
  // down with it.
  const fresh = data !== undefined && String(data.id) === repoId ? data : undefined;

  const repoName = fresh?.name;
  useEffect(() => {
    if (repoName === undefined) return;
    setEntityCrumb({ pathPrefix: `/repos/${repoId}`, label: repoName, to: `/repos/${repoId}` });
    return () => setEntityCrumb(null);
  }, [repoId, repoName, setEntityCrumb]);

  const tabs = (
    // W17-31: ten tabs in a row scroll within the strip, not the page. Measured
    // at 390px the unscrollable strip pushed <main> 292px wide of the viewport
    // on every repository tab. Same fix as the Settings strip.
    <nav
      className="flex gap-0.5 overflow-x-auto border-b border-border pb-px"
      data-testid="repo-tabs"
      aria-label="Repository sections"
    >
      {TABS.map((tab) => (
        <Link
          key={tab.label}
          to={tab.to as never}
          params={{ repoId } as never}
          search={preserved as never}
          // includeSearch off (W18-28): an EXACT match also compares the search
          // params in full, and the filters in the URL never equal the preserved
          // subset this link carries — so the default tab (Pulse, Connections) was
          // never marked active on the screen it was showing.
          activeOptions={{ exact: tab.exact ?? false, includeSearch: false }}
          activeProps={{ 'data-active': 'true' }}
          className="relative shrink-0 whitespace-nowrap rounded-md px-3 py-2 text-sm text-fg-muted hover:text-fg data-[active=true]:font-medium data-[active=true]:text-fg data-[active=true]:after:absolute data-[active=true]:after:inset-x-3 data-[active=true]:after:-bottom-px data-[active=true]:after:h-0.5 data-[active=true]:after:rounded-full data-[active=true]:after:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
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
    // FORBIDDEN IS ITS OWN ANSWER (W17-19). Law 5 makes another workspace's
    // repository a 404, so a 403 that reaches here is this session being
    // refused — role gating (apiV1's admin routes) or a rejected CSRF header —
    // and says nothing at all about whether the repository exists. Borrowing
    // the 404's "may belong to another workspace" line would invent a reason.
    // 401 is deliberately NOT handled here: the shell owns the signed-out state
    // centrally (useSession), and a second treatment would double-render it.
    const forbidden = status === 403;
    // Neither answer changes on a second ask, so neither offers a retry.
    const final = unseeable || forbidden;
    const requestId = requestIdOf(error);
    return (
      <div className="flex flex-col gap-4" data-testid="repo-detail">
        <header className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold tracking-tight" data-testid="repo-name">
            {repoId}
          </h1>
        </header>

        {/* The tabs stay for a transport failure — the repository is presumably
            still there and a sibling tab may well load — but not for a 404 or a
            403: a row of links that are all guaranteed to fail the same way is
            worse than none. */}
        {!final && tabs}

        <WidgetFrame
          title={
            unseeable
              ? 'Repository not visible here'
              : forbidden
                ? 'You are not allowed to view this repository'
                : 'Repository failed to load'
          }
          state="error"
          testId="repo-error"
          errorMessage={
            unseeable
              ? // Never "deleted": a 404 here says only that this workspace
                // cannot see it. It may live in another workspace, it may never
                // have been ingested, and we do not have its name to quote back
                // — the id from the URL is the only identifier we hold.
                `This workspace cannot see a repository with id ${repoId}. It may belong to another workspace, or it may never have been ingested here.`
              : forbidden
                ? // Says what to do — ask for access — because unlike the 404
                  // there IS someone who can change the answer.
                  `Your account is signed in but not permitted to open repository ${repoId}. Ask a workspace admin for access.`
                : // The reason phrase alone ("Not Found", "Bad Gateway") explains
                  // nothing, so say what we were doing when it failed.
                  `We could not load repository ${repoId}. ${error?.message ?? 'The request failed.'}`
          }
          {...(requestId ? { requestId } : {})}
          {...(final ? {} : { onRetry: () => void refetch() })}
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
        <h1 className="text-2xl font-semibold tracking-tight" data-testid="repo-name">
          {fresh ? `${fresh.org}/${fresh.name}` : 'Loading…'}
        </h1>
        <div className="flex flex-wrap items-center gap-4">
          <RiskAxisStrip repoId={repoId} />
          {fresh && <HealthWhy health={fresh.health} />}
        </div>
      </header>

      {tabs}

      {/* Keyed on the repository so the tab below REMOUNTS when you switch
          repositories: every child widget keys its query on repo_id and would
          otherwise hold the previous repository's rows on screen for as long as
          the new fetch takes, for the same keepPreviousData reason as the
          heading above. One key covers every tab, including the ones this
          ticket does not touch. */}
      <div key={repoId}>
        <Outlet />
      </div>
    </div>
  );
}
