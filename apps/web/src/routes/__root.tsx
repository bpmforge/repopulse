import { useEffect, useState } from 'react';
import {
  createRootRouteWithContext,
  Outlet,
  useRouterState,
  type NavigateOptions,
} from '@tanstack/react-router';
import type { QueryClient } from '@tanstack/react-query';
import { Rail } from '../components/shell/Rail.js';
import { Topbar } from '../components/shell/Topbar.js';
import { DemoBanner } from '../components/shell/DemoBanner.js';
import { CommandPalette } from '../components/palette/CommandPalette.js';
import { Breadcrumb, type Crumb } from '../components/shell/Breadcrumb.js';
import { Toaster } from '../components/shell/Toaster.js';
import { useUiStore } from '../components/store/uiStore.js';
import { useSyncStream } from '../sse/useSyncStream.js';
import { useApiQuery, useSession } from '../api/useApiQuery.js';
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

const SEGMENT_LABELS: Record<string, string> = {
  repos: 'Repos',
  'pull-requests': 'Pull Requests',
  findings: 'Findings',
  plans: 'Plans',
  reports: 'Reports',
  views: 'Views',
  admin: 'Admin',
  me: 'My Focus',
};

/**
 * Sub-page labels (W16-05, F19). Path data only — the repo NAME is not in the
 * URL, so a repository still cannot appear in its own trail from here; that
 * crumb has to come from the screen that loaded it. This closes the half that
 * can be closed: `/repos/25152/security` said "Org › Repos", naming neither the
 * repository nor the tab, so the trail described a screen nobody was on.
 */
const SUBPAGE_LABELS: Record<string, string> = {
  hotspots: 'Hotspots',
  'pr-flow': 'PR Flow',
  ci: 'CI',
  findings: 'Findings',
  security: 'Security',
  'code-health': 'Code Health',
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
  settings: 'Settings',
  setup: 'Setup',
};

/** Minimal breadcrumb from the path; deeper drill-down crumbs come with screens. */
function deriveCrumbs(pathname: string): Crumb[] {
  const crumbs: Crumb[] = [{ label: 'Org', to: '/' }];
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length > 0) {
    const first = segments[0]!;
    crumbs.push({ label: SEGMENT_LABELS[first] ?? first, to: `/${first}` });
  }
  // The first segment that names something rather than identifying it. Numeric
  // ids are skipped deliberately: "Org › Repos › 25152" would be worse than
  // saying nothing, which is the same mistake F11 was about.
  const sub = segments.slice(1).find((seg) => SUBPAGE_LABELS[seg] !== undefined);
  if (sub) crumbs.push({ label: SUBPAGE_LABELS[sub]! });
  return crumbs;
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

/** Quiet placeholder for the one round-trip it takes to answer "who is this?". */
function SessionProbe() {
  return (
    <div
      className="flex h-screen w-screen items-center justify-center bg-bg text-fg-muted"
      data-testid="session-probe"
      aria-busy="true"
    >
      <p className="text-sm">Checking your session…</p>
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

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-bg text-fg">
      <Rail search={preservedSearch} badges={railBadges} />
      <div className="flex min-w-0 flex-1 flex-col">
        <DemoBanner />
        {/* Says why personalized views are empty for someone whose account is
            not connected to a committer — at the shell, because that is true on
            every personalized screen and not just one of them. */}
        <ForgeLinkBanner />
        {/* Global: ⌘K works from every screen (UX_SPEC §3.3). */}
        <CommandPalette />
        <Topbar value={search} onChange={onFilterChange} />
        <Breadcrumb crumbs={deriveCrumbs(pathname)} search={preservedSearch} />
        <main className="min-h-0 flex-1 overflow-auto p-4" data-testid="main">
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
