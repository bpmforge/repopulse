import { useEffect, useRef, useState } from 'react';
import {
  createRootRouteWithContext,
  Outlet,
  useRouterState,
  type NavigateOptions,
} from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { Rail } from '../components/shell/Rail.js';
import { NavDrawer } from '../components/shell/NavDrawer.js';
import { RepoPulseWordmark } from '../components/brand/RepoPulseMark.js';
import { Topbar } from '../components/shell/Topbar.js';
import { DemoBanner } from '../components/shell/DemoBanner.js';
import { CommandPalette } from '../components/palette/CommandPalette.js';
import { Breadcrumb, type Crumb } from '../components/shell/Breadcrumb.js';

export type EntityCrumb = { pathPrefix: string; label: string; to: string };
import { Toaster } from '../components/shell/Toaster.js';
// Side-effect import: registers every widget type before any screen renders
// (W16-55). Saved views live outside the org overview and cannot rely on it
// having been visited first.
import '../widgets/registerAll.js';
import { useUiStore } from '../components/store/uiStore.js';
import { useSyncStream } from '../sse/useSyncStream.js';
import { useApiQuery, useSession } from '../api/useApiQuery.js';
import { filterScopeFor } from '../api/filterScope.js';
import { PersonaPicker } from '../widgets/onboarding/PersonaPicker.js';
import { SignedOut } from '../widgets/auth/SignedOut.js';
import { ForgeLinkBanner } from '../widgets/auth/ForgeLinkBanner.js';
import { mergeGlobalSearch, validateGlobalSearch, type GlobalSearch } from '../api/urlState.js';
import { serializeGlobalSearch } from '@repopulse/shared/url-state';

// The app shell (UX §3, DASHBOARD §1): left rail, topbar with the three global
// filters (serialized to the URL), sticky breadcrumb, theme application, and the
// single SSE mount. Every route renders inside <Outlet/> and inherits the
// validated GlobalSearch, so pasting a URL restores the identical screen state
// (FR-WEB-2). The root route validates ?window=&repos=&person= for the whole tree.

export interface RouterContext {
  queryClient: QueryClient;
}

export const Route = createRootRouteWithContext<RouterContext>()({
  validateSearch: validateGlobalSearch,
  component: RootShell,
});

// The rail's own words (W18-28). The trail used to say "Findings", "Plans",
// "Views" and "Admin" under a rail that says "Reviews", "Improvement plans",
// "Saved Views" and "Settings", so the two halves of the wayfinding named the
// same screen differently and neither matched the page heading.
const SEGMENT_LABELS: Record<string, string> = {
  repos: 'Repositories',
  'pull-requests': 'Pull Requests',
  findings: 'Reviews',
  plans: 'Improvement plans',
  reports: 'Reports',
  views: 'Saved Views',
  admin: 'Settings',
  me: 'My Focus',
  setup: 'Setup',
  // W18-29. Not rail entries: reached from the Overview tile and from Reviews.
  governance: 'AI-code governance',
  'sensitive-changes': 'Sensitive changes',
};

/**
 * Sub-page labels (W16-05, F19). Path data only — the repo NAME is not in the
 * URL, so a repository still cannot appear in its own trail from here; that
 * crumb has to come from the screen that loaded it. This closes the half that
 * can be closed: `/repos/25152/security` said "Org › Repos", naming neither the
 * repository nor the tab, so the trail described a screen nobody was on.
 */
const SUBPAGE_LABELS: Record<string, string> = {
  activity: 'Activity',
  performance: 'Performance',
  hotspots: 'Hotspots',
  'pr-flow': 'PR Flow',
  'ai-reviewers': 'AI Reviewers',
  ci: 'CI',
  findings: 'Findings',
  security: 'Security',
  'code-health': 'Code Health',
  'ai-review': 'AI Review',
  prs: 'Pull Requests',
  files: 'Files',
  connections: 'Connections',
  sync: 'Sync',
  members: 'Members',
  identities: 'Identities',
  agreements: 'Agreements',
  rules: 'Rules',
  analysis: 'Analysis',
  models: 'Models',
  patches: 'Verified fixes',
  settings: 'Settings',
  setup: 'Setup',
};

/** Minimal breadcrumb from the path; deeper drill-down crumbs come with screens. */
export function deriveCrumbs(pathname: string, entity?: EntityCrumb | null): Crumb[] {
  const crumbs: Crumb[] = [{ label: 'Org', to: '/' }];
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length > 0) {
    const first = segments[0]!;
    crumbs.push({ label: SEGMENT_LABELS[first] ?? first, to: `/${first}` });
  }
  // The named entity, from the screen that loaded it (W16-42) — but ONLY when
  // it belongs to the path being rendered. A crumb that outlives its screen
  // names the wrong repository, which is worse than naming none.
  if (entity && pathname.startsWith(entity.pathPrefix)) {
    crumbs.push({ label: entity.label, to: entity.to });
  }
  // The first segment that names something rather than identifying it. Numeric
  // ids are skipped deliberately: "Org › Repos › 25152" would be worse than
  // saying nothing, which is the same mistake F11 was about.
  const sub = segments.slice(1).find((seg) => SUBPAGE_LABELS[seg] !== undefined);
  if (sub) crumbs.push({ label: SUBPAGE_LABELS[sub]! });
  return crumbs;
}

/**
 * The browser-tab title for a trail (W18-28): most specific first, so the part
 * that differs between tabs is the part a narrow tab still shows.
 * "Security · payments · RepoPulse"; the bare root is "Overview · RepoPulse".
 */
export function documentTitle(crumbs: Crumb[]): string {
  const named = crumbs.slice(1).map((c) => c.label);
  const parts = named.length === 0 ? ['Overview'] : named.slice(-2).reverse();
  return [...parts, 'RepoPulse'].join(' · ');
}

// The shell is for people who are signed in. RootShell decides which of the
// three things a visitor can legitimately be shown — the sign-in screen, a
// quiet session probe, or the app — and only the last one mounts AppShell.
// Everything expensive and session-bound (the SSE stream, the rail badge query,
// every widget under <Outlet/>) lives inside AppShell, so signed out it never
// runs. Before this split, an anonymous visitor got the full authenticated
// chrome with a red "No active session" error and a Retry button on every card:
// eight failure states describing something that is not a failure.
function RootShell() {
  const theme = useUiStore((s) => s.theme);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Apply the persisted theme to <html data-theme> — flips tokens + charts.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

  // Print routes render bare (W5-04) and are fetched by the print pipeline with
  // its own session, so they neither need nor want the probe: an extra in-flight
  // request keeps the page from settling, and the pipeline waits for settle.
  const isPrint = pathname.startsWith('/print/');
  const { status } = useSession({ enabled: !isPrint });

  // Remembering that we once had a session is what lets the sign-in screen tell
  // "your session ended" from "you were never signed in". Same destination,
  // different sentence — neither of which should read as a broken product.
  const [hadSession, setHadSession] = useState(false);
  useEffect(() => {
    if (status === 'authenticated') setHadSession(true);
  }, [status]);

  if (isPrint) return <Outlet />;
  if (status === 'loading') return <SessionProbe />;
  // 'anonymous' covers TWO states the session probe cannot separate: nobody is
  // signed in, and someone holds a session that must change its password before
  // it may do anything (it carries no `userId`, so /me/context 401s for it too).
  // SignedOut asks /auth/local/session which one it is. The forced change is
  // decided HERE rather than at a /signin URL on purpose — a route can be
  // navigated away from, and "cannot reach anything else until it is done" has
  // to be a property of the shell.
  if (status === 'anonymous') return <SignedOut expired={hadSession} />;
  // 'unknown' — the probe itself failed with something that is NOT a 401 (the
  // API is down, the proxy returned 502). That is not evidence anyone is signed
  // out, so the app renders and each widget reports its own error honestly,
  // with a request id, rather than the shell inventing a sign-in wall.
  return <AppShell />;
}

/**
 * Quiet placeholder for the one round-trip it takes to answer "who is this?".
 *
 * WITH AN ESCAPE HATCH (W16-15). This screen is the outermost thing the app
 * renders, so when it does not resolve there is nothing else on the page — no
 * error, no retry, no sign-out. A user walk hit exactly that: a session naming
 * a deleted user 500'd, and the browser sat here for ever, unrecoverable
 * without clearing cookies.
 *
 * The 500 itself is fixed at the source, but the STRAND is the class of bug and
 * it survives any future cause. After a few seconds this stops claiming to be
 * busy and offers the two things a stuck person needs: a reload and a way to
 * abandon the session. Cheap, and it makes the dead end impossible rather than
 * fixed-for-one-reason.
 */
const PROBE_PATIENCE_MS = 6000;

function SessionProbe() {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setSlow(true), PROBE_PATIENCE_MS);
    return () => clearTimeout(t);
  }, []);

  return (
    <div
      className="flex h-screen w-screen flex-col items-center justify-center gap-3 bg-bg text-fg-muted"
      data-testid="session-probe"
      aria-busy={!slow}
    >
      <p className="text-sm">Checking your session…</p>

      {slow && (
        <div className="flex flex-col items-center gap-2 text-xs" data-testid="session-probe-stuck">
          <p>
            This is taking longer than it should. The server may be unreachable, or this session
            may no longer be valid.
          </p>
          <div className="flex items-center gap-3">
            <button
              type="button"
              data-testid="session-probe-retry"
              onClick={() => window.location.reload()}
              className="rounded-sm border border-border px-2 py-1 text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              Try again
            </button>
            {/* A direct fetch, deliberately NOT through the query layer: what
                is stuck is TanStack's session query, and this has to work
                regardless of it. /auth/logout is POST-only and CSRF-guarded, so
                a plain link or a native form submit would 403 — the header has
                to be set, then the page reloaded to land on sign-in. */}
            <button
              type="button"
              data-testid="session-probe-signout"
              onClick={() => {
                void fetch('/auth/logout', {
                  method: 'POST',
                  credentials: 'include',
                  headers: { 'x-requested-with': 'repopulse' },
                }).finally(() => window.location.reload());
              }}
              className="rounded-sm border border-border px-2 py-1 text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              Sign out
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// The sign-in and forced-password-change screens live in widgets/auth (W15-04).
// The version that used to be inline here offered one hardcoded GitHub link,
// which since D14 is a button most deployments should not show at all.

function AppShell() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // The single app-wide sync stream (SSE) — cache-bust + chip + toasts.
  useSyncStream();

  // Rail badge counts (UX_SPEC §3.1, R-A4). The review queue reuses the exact
  // query My Focus makes, so react-query serves both from one request rather
  // than adding a count endpoint that could disagree with the list.
  //
  // The Findings badge is deliberately ABSENT rather than 0: there are no
  // findings rows and no lastSeenAt until W6, and a badge stuck at 0 is
  // indistinguishable from a working one. Tracked in W4-21.
  const { data: reviewQueue } = useApiQuery<{ items: unknown[] }>({
    endpoint: '/me/review-queue',
  });
  const railBadges =
    reviewQueue === undefined ? {} : { '/pull-requests': reviewQueue.items.length };

  // WHICH FILTERS THIS SCREEN APPLIES, and the options for the one that needs
  // them (W16-50). FilterBar has accepted `repoOptions` since it was written
  // and Topbar has forwarded them; nothing ever supplied any, so the repository
  // picker contained only "All repos" and could never be set. Fetched only
  // where the picker is actually shown — react-query serves the /repos screen
  // from the same cache entry.
  const scope = filterScopeFor(pathname);
  const { data: repoList } = useApiQuery<{ items: { id: number; org: string; name: string }[] }>(
    { endpoint: '/repos', query: { window: search.window } },
    { enabled: scope.repos },
  );
  const repoOptions = (repoList?.items ?? []).map((r) => ({
    id: String(r.id),
    label: `${r.org}/${r.name}`,
  }));

  const onFilterChange = (patch: {
    window?: string;
    repos?: string | null;
    person?: string | null;
  }) => {
    void navigate({
      search: (prev: GlobalSearch) => mergeGlobalSearch(prev, patch),
    } as NavigateOptions);
  };

  const preservedSearch = serializeGlobalSearch(search);
  // Published by the screen that loaded the entity — the repo layout sets its
  // name here, because the URL only carries an id (W16-42).
  const entityCrumb = useUiStore((s) => s.entityCrumb);
  const crumbs = deriveCrumbs(pathname, entityCrumb);
  const title = documentTitle(crumbs);

  // Every screen was titled "RepoPulse" (W18-28), so browser tabs, history and
  // a screen reader's page announcement could not tell Overview from a
  // repository's Security tab (WCAG 2.4.2). The trail already names the screen.
  useEffect(() => {
    document.title = title;
  }, [title]);

  // W17-14 drawer state. Lives in the shell rather than the drawer so the
  // trigger and the panel share it, and so focus can return to the trigger.
  const [drawerOpen, setDrawerOpen] = useState(false);
  const drawerTriggerRef = useRef<HTMLButtonElement>(null);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg text-fg">
      {/* W17-14: the rail is DESKTOP only now. Below 768px it used to collapse
          to a column of unlabelled icons that ate 56px of a 390px screen
          permanently; narrow screens get the labelled drawer instead. */}
      <div className="hidden md:flex">
        <Rail search={preservedSearch} badges={railBadges} />
      </div>
      <NavDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        badges={railBadges}
        search={preservedSearch}
        returnFocusTo={drawerTriggerRef}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        {/* The drawer's trigger. Labelled in words, not a bare hamburger, and
            it reports its own state — a control that opens something must say
            so (aria-expanded / aria-controls). */}
        <div className="flex items-center gap-2 border-b border-border px-3 py-2 md:hidden">
          <button
            type="button"
            ref={drawerTriggerRef}
            onClick={() => setDrawerOpen(true)}
            aria-expanded={drawerOpen}
            aria-controls="nav-drawer"
            className="inline-flex items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            data-testid="nav-drawer-trigger"
          >
            <span aria-hidden="true">☰</span>
            Menu
          </button>
          <RepoPulseWordmark />
        </div>
        <DemoBanner />
        {/* Says why personalized views are empty for someone whose account is
            not connected to a committer — at the shell, because that is true on
            every personalized screen and not just one of them. */}
        <ForgeLinkBanner />
        {/* Global: ⌘K works from every screen (UX_SPEC §3.3). */}
        <CommandPalette />
        <Topbar value={search} onChange={onFilterChange} scope={scope} repoOptions={repoOptions} />
        <Breadcrumb crumbs={crumbs} search={preservedSearch} />
        <main className="min-h-0 flex-1 overflow-auto p-5" data-testid="main">
          <Outlet />
        </main>
      </div>
      <Toaster />
      {/* First-login persona question (UX_SPEC §6). Rendered at the shell so it
          appears wherever the user lands, and renders nothing once answered. */}
      <PersonaPicker />
    </div>
  );
}
