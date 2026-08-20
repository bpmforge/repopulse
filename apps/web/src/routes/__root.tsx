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

/** Minimal breadcrumb from the path; deeper drill-down crumbs come with screens. */
function deriveCrumbs(pathname: string): Crumb[] {
  const crumbs: Crumb[] = [{ label: 'Org', to: '/' }];
  const segments = pathname.split('/').filter(Boolean);
  if (segments.length > 0) {
    const first = segments[0]!;
    crumbs.push({ label: SEGMENT_LABELS[first] ?? first });
  }
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
  if (status === 'anonymous') return <SignIn expired={hadSession} />;
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

/**
 * The whole app for a visitor without a session. GitHub OAuth is the only way
 * in (apps/api/src/routes/auth), so this is a link and not a form; it must be a
 * full-page navigation to /auth/login, which is why it is an <a> rather than a
 * router Link, and why it does not go through the typed /api/v1 client.
 */
function SignIn({ expired }: { expired: boolean }) {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-bg p-6 text-fg">
      <main
        className="w-full max-w-sm rounded-md border border-border bg-surface p-6"
        data-testid="signin"
      >
        <h1 className="text-base font-medium">RepoPulse</h1>
        <p className="mt-2 text-sm text-fg-muted">
          {expired
            ? 'Your session ended. Sign in again to pick up where you left off — nothing was lost.'
            : 'Sign in to see your organisation’s delivery, code health, and risk.'}
        </p>
        <a
          href="/auth/login"
          className="mt-5 inline-flex w-full items-center justify-center rounded-sm border border-border bg-surface-2 px-3 py-2 text-sm text-fg hover:text-fg"
          data-testid="signin-github"
        >
          Sign in with GitHub
        </a>
        <p className="mt-4 text-xs text-fg-faint">
          RepoPulse only reads what your GitHub account can already see.
        </p>
      </main>
    </div>
  );
}

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
