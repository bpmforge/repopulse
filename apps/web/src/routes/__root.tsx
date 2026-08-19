import { useEffect } from 'react';
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
import { useApiQuery } from '../api/useApiQuery.js';
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

function RootShell() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const theme = useUiStore((s) => s.theme);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Apply the persisted theme to <html data-theme> — flips tokens + charts.
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
  }, [theme]);

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

  // Print routes render bare (W5-04). Every file route is a child of this
  // shell, so without this the rail, topbar, breadcrumb and toaster would be
  // printed into the PDF — and the SSE mount above would keep the page busy
  // forever, which is worse: the print pipeline waits for the page to settle.
  if (pathname.startsWith('/print/')) return <Outlet />;

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
