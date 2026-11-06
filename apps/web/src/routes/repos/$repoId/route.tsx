import { useEffect } from 'react';
import { createFileRoute, Link, Outlet, useParams, useRouterState } from '@tanstack/react-router';
import { serializeGlobalSearch } from '@repopulse/shared/url-state';
import { WidgetFrame } from '../../../components/index.js';
import { useApiQuery } from '../../../api/useApiQuery.js';
import { useUiStore } from '../../../components/store/uiStore.js';
import { HealthWhy } from '../../../widgets/repo/HealthWhy.js';
// W10-05: the axis letters belong beside the health grade, which is here.
// Widened out of the ticket's write_scope on purpose — a widget nobody mounts
// is the defect class this codebase keeps rediscovering.
import { RiskAxisStrip } from '../../../widgets/risk/RiskAxisStrip.js';
import { forgeLabel, type RepoDetail } from '../../../widgets/repo/contracts.js';
import { asOfLabel } from '../../../widgets/org/contracts.js';
import { orgWidgets } from '../../../widgets/org/OrgOverview.js';
import { SaveAsViewButton } from '../../../views/SaveAsViewButton.js';
import { useActiveTabInView } from '../../../components/shell/useActiveTabInView.js';

/**
 * The repository's sync state in words (W20-12, UX_TODO DSH-24, UX_SPEC
 * §4.b). The header never said when the forge was last read or that
 * monitoring was paused, so a stale page looked current.
 */
export function syncLabel(
  sync: string,
  lastSyncedAt: string | null | undefined,
): {
  text: string;
  tone: 'ok' | 'warn' | 'crit' | 'info';
} {
  const when = lastSyncedAt
    ? new Date(lastSyncedAt).toLocaleString(undefined, {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      })
    : null;
  switch (sync) {
    case 'live':
      return { text: when ? `Synced ${when}` : 'Synced', tone: 'ok' };
    case 'paused':
      return { text: 'Monitoring paused', tone: 'warn' };
    case 'paused_budget':
      return { text: 'Paused — forge API budget used up', tone: 'warn' };
    case 'error':
      return { text: when ? `Sync failed — last good ${when}` : 'Sync failed', tone: 'crit' };
    case 'backfilling':
      return { text: 'Backfilling history', tone: 'info' };
    case 'pending_backfill':
      return { text: 'Waiting to backfill', tone: 'info' };
    default:
      return { text: sync, tone: 'info' };
  }
}

const SYNC_DOT = { ok: 'bg-ok', warn: 'bg-warn', crit: 'bg-crit', info: 'bg-info' } as const;

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
interface RepoTab {
  /** Route path below /repos/$repoId (empty for Pulse). */
  seg: string;
  label: string;
  testId: string;
}

interface RepoTabGroup {
  key: string;
  label: string;
  tabs: RepoTab[];
}

/**
 * W26-03 (UI review 2026-11-06, UI-06; Brad chose "group both"): thirteen
 * tabs in one row did not fit a laptop and scrolled blind on a phone. They
 * are now six groups; a group with more than one page shows a second row.
 * Every page keeps its own route, URL and `repo-tab-*` test id, so saved links
 * and bookmarks land exactly where they did.
 */
export const TAB_GROUPS: RepoTabGroup[] = [
  { key: 'pulse', label: 'Pulse', tabs: [{ seg: '', label: 'Pulse', testId: 'pulse' }] },
  {
    key: 'delivery',
    label: 'Delivery',
    tabs: [
      { seg: 'activity', label: 'Activity', testId: 'activity' },
      { seg: 'prs', label: 'Pull requests', testId: 'pull-requests' },
      { seg: 'pr-flow', label: 'PR flow', testId: 'pr-flow' },
      { seg: 'ci', label: 'CI', testId: 'ci' },
      { seg: 'ai-reviewers', label: 'Review bots', testId: 'ai-reviewers' },
    ],
  },
  {
    key: 'findings',
    label: 'Findings',
    tabs: [{ seg: 'findings', label: 'Findings', testId: 'findings' }],
  },
  {
    key: 'security',
    label: 'Security',
    tabs: [{ seg: 'security', label: 'Security', testId: 'security' }],
  },
  {
    key: 'code-health',
    label: 'Code health',
    tabs: [
      { seg: 'code-health', label: 'Overview', testId: 'code-health' },
      { seg: 'hotspots', label: 'Hotspots', testId: 'hotspots' },
      { seg: 'performance', label: 'Performance', testId: 'performance' },
    ],
  },
  {
    key: 'ai-review',
    label: 'AI review',
    tabs: [{ seg: 'ai-review', label: 'AI review', testId: 'ai-review' }],
  },
];

/** The group and page a pathname under /repos/:id belongs to. */
export function activeTab(pathname: string): { group: RepoTabGroup; tab: RepoTab } {
  const seg = pathname.replace(/^\/repos\/[^/]+\/?/, '').split('/')[0] ?? '';
  for (const group of TAB_GROUPS) {
    const tab = group.tabs.find((t) => t.seg === seg);
    if (tab) return { group, tab };
  }
  // files/... and anything unknown: no tab claims it; Pulse's group is shown
  // without marking a page active.
  return { group: TAB_GROUPS[0]!, tab: { seg: '__none', label: '', testId: '' } };
}

const tabPath = (seg: string) => (seg === '' ? '/repos/$repoId/' : `/repos/$repoId/${seg}`);

const TAB_CLASS =
  'relative shrink-0 whitespace-nowrap rounded-md px-3 py-2 text-sm text-fg-muted hover:text-fg data-[active=true]:font-medium data-[active=true]:text-fg data-[active=true]:after:absolute data-[active=true]:after:inset-x-3 data-[active=true]:after:-bottom-px data-[active=true]:after:h-0.5 data-[active=true]:after:rounded-full data-[active=true]:after:bg-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';

const SUBTAB_CLASS =
  'shrink-0 whitespace-nowrap rounded-full px-3 py-1 text-[13px] text-fg-muted hover:bg-surface-2 hover:text-fg data-[active=true]:bg-surface-2 data-[active=true]:font-medium data-[active=true]:text-fg data-[active=true]:shadow-[inset_0_0_0_1px_var(--color-border)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';

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

  const pathname = useRouterState({ select: (st) => st.location.pathname });
  const current = activeTab(pathname);
  const groupStrip = useActiveTabInView<HTMLElement>(pathname);
  const subStrip = useActiveTabInView<HTMLElement>(pathname);
  const tabs = (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <nav
          ref={groupStrip}
          className="flex gap-0.5 overflow-x-auto border-b border-border pb-px"
          data-testid="repo-tabs"
          aria-label="Repository sections"
        >
          {TAB_GROUPS.map((group) => {
            const active = group.key === current.group.key && current.tab.seg !== '__none';
            const single = group.tabs.length === 1;
            const first = group.tabs[0]!;
            return (
              <Link
                key={group.key}
                to={tabPath(first.seg) as never}
                params={{ repoId } as never}
                search={preserved as never}
                data-active={active ? 'true' : undefined}
                aria-current={active && single ? 'page' : undefined}
                className={TAB_CLASS}
                // A one-page group IS that page, so it keeps the page's id.
                data-testid={single ? `repo-tab-${first.testId}` : `repo-group-${group.key}`}
              >
                {group.label}
              </Link>
            );
          })}
        </nav>
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-bg to-transparent sm:hidden"
        />
      </div>
      {current.group.tabs.length > 1 && (
        <nav
          ref={subStrip}
          className="flex gap-1 overflow-x-auto"
          data-testid="repo-subtabs"
          aria-label={`${current.group.label} pages`}
        >
          {current.group.tabs.map((tab) => {
            const active = tab.seg === current.tab.seg;
            return (
              <Link
                key={tab.seg}
                to={tabPath(tab.seg) as never}
                params={{ repoId } as never}
                search={preserved as never}
                data-active={active ? 'true' : undefined}
                aria-current={active ? 'page' : undefined}
                className={SUBTAB_CLASS}
                data-testid={`repo-tab-${tab.testId}`}
              >
                {tab.label}
              </Link>
            );
          })}
        </nav>
      )}
    </div>
  );

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
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight" data-testid="repo-name">
            {fresh ? `${fresh.org}/${fresh.name}` : 'Loading…'}
            {/* Which forge and host (W20-15, UX_TODO X-16). */}
            {fresh?.forge && (
              <span
                className="ml-2 align-middle text-sm font-normal text-fg-muted"
                data-testid="repo-forge"
              >
                {forgeLabel(fresh.forge)}
              </span>
            )}
          </h1>
          {fresh && (
            // W20-12 (UX_TODO DSH-24/48): sync state and data freshness.
            <p className="flex flex-wrap items-center gap-3 text-xs text-fg-muted">
              {((label) => (
                <span
                  className="inline-flex items-center gap-1.5"
                  data-testid="repo-sync-state"
                  data-sync={fresh.sync}
                >
                  <span
                    aria-hidden="true"
                    className={`h-2 w-2 rounded-full ${SYNC_DOT[label.tone]}`}
                  />
                  {label.text}
                </span>
              ))(syncLabel(fresh.sync, fresh.last_synced_at))}
              {fresh.as_of !== undefined && (
                <span data-testid="repo-as-of">{asOfLabel(fresh.as_of)}</span>
              )}
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <RiskAxisStrip repoId={repoId} window={search.window} />
          {fresh && <HealthWhy health={fresh.health} repoId={repoId} search={preserved} />}
          {/* W20-16 (UX_TODO DSH-07): "Save as view…" on the repository pages.
              They are not widget grids, so the view this saves is the
              Overview's dashboard scoped to THIS repository (every tile
              follows a view's repositories since W20-09), without the
              one-tile health grid the header above already answers. */}
          {fresh && (
            <SaveAsViewButton
              widgets={orgWidgets(search.window, preserved).filter((w) => w.type !== 'health-grid')}
              window={search.window}
              repos={String(fresh.id)}
              defaultName={`${fresh.org}/${fresh.name}`}
            />
          )}
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
