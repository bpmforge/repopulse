import { useEffect, useRef, useState } from 'react';
import {
  createRootRouteWithContext,
  Outlet,
  useRouterState,
  type NavigateOptions,
} from '@tanstack/react-router';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
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
import { resolveTheme, useUiStore } from '../components/store/uiStore.js';
import { useSyncStream } from '../sse/useSyncStream.js';
import { SESSION_ENDPOINT, queryKeyFor, useApiQuery, useSession } from '../api/useApiQuery.js';
import { apiFetch, errorDetailOf } from '../api/client.js';
import type { MeContext } from '../widgets/org/contracts.js';
import { filterScopeFor } from '../api/filterScope.js';
import { PersonaPicker } from '../widgets/onboarding/PersonaPicker.js';
import { SignedOut } from '../widgets/auth/SignedOut.js';
import { ForgeLinkBanner } from '../widgets/auth/ForgeLinkBanner.js';
import { Inbox, useInbox } from '../widgets/me/Inbox.js';
import { FirstRunPanel } from '../widgets/onboarding/FirstRunPanel.js';
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
  account: 'Account',
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
  // W20-12 (UX_TODO DSH-25): the tab's new name.
  performance: 'Performance findings',
  hotspots: 'Hotspots',
  'pr-flow': 'PR Flow',
  'ai-reviewers': 'AI Reviewers',
  ci: 'CI',
  // W20-22 (UX_TODO ADM-34): the repo tab's name, the rail's word.
  findings: 'Reviews',
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
  patches: 'Verified fixes',
  settings: 'Settings',
  setup: 'Setup',
  audit: 'Audit log',
};

/** Minimal breadcrumb from the path; deeper drill-down crumbs come with screens. */
export function deriveCrumbs(pathname: string, entity?: EntityCrumb | null): Crumb[] {
  // W20-12 (UX_TODO DSH-34): "Overview", the rail's and the heading's word —
  // the trail alone said "Org".
  const crumbs: Crumb[] = [{ label: 'Overview', to: '/' }];
  const segments = pathname.split('/').filter(Boolean);
  const first = segments[0];
  if (first !== undefined) {
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
  const subIndex = segments.findIndex((seg, i) => i > 0 && SUBPAGE_LABELS[seg] !== undefined);
  const sub = subIndex >= 0 ? segments[subIndex]! : undefined;
  // W20-12 (UX_TODO DSH-34): the drill-down LEAF, named from the path. The file
  // page read "… › Files", a crumb that went nowhere and never said which file;
  // PR detail ended at "Pull Requests" without the number.
  if (first === 'repos' && sub === 'files' && segments.length > subIndex + 1) {
    const path = segments
      .slice(subIndex + 1)
      .map((seg) => {
        try {
          return decodeURIComponent(seg);
        } catch {
          return seg;
        }
      })
      .join('/');
    crumbs.push({ label: path });
    return crumbs;
  }
  if (first === 'repos' && sub === 'prs' && /^\d+$/.test(segments[subIndex + 1] ?? '')) {
    crumbs.push({
      label: SUBPAGE_LABELS.prs!,
      to: `/${segments.slice(0, subIndex + 1).join('/')}`,
    });
    crumbs.push({ label: `#${segments[subIndex + 1]}` });
    return crumbs;
  }
  if (sub) crumbs.push({ label: SUBPAGE_LABELS[sub]! });
  return crumbs;
}

/**
 * The top-bar repository options (W20-15, UX_TODO X-16). With more than one
 * forge host connected, `org/name` alone cannot tell a GitHub repository from
 * its Gitea mirror, so each label names its host; with one host it stays short.
 */
export function topbarRepoOptions(
  items: { id: number; org: string; name: string; forge?: { host: string | null } | null }[],
): { id: string; label: string }[] {
  const hosts = new Set(items.map((r) => r.forge?.host ?? null).filter((h) => h !== null));
  return items.map((r) => ({
    id: String(r.id),
    label:
      hosts.size > 1 && r.forge?.host
        ? `${r.org}/${r.name} · ${r.forge.host}`
        : `${r.org}/${r.name}`,
  }));
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
  // 'system' (W20-17, UX_TODO ADM-38) follows the OS and keeps following it.
  // Print routes are always light (ADM-24): paper is white, and Ctrl+P of the
  // viewer printed light text on a dark page.
  const isPrintRoute = pathname.startsWith('/print/');
  useEffect(() => {
    const apply = () =>
      document.documentElement.setAttribute(
        'data-theme',
        isPrintRoute ? 'light' : resolveTheme(theme),
      );
    apply();
    if (theme !== 'system' || isPrintRoute || typeof window.matchMedia !== 'function') return;
    const media = window.matchMedia('(prefers-color-scheme: light)');
    media.addEventListener?.('change', apply);
    return () => media.removeEventListener?.('change', apply);
  }, [theme, isPrintRoute]);

  // Print routes render bare (W5-04). The PDF pipeline injects the report
  // (window.__REPORT_DATA) and has no session, so it neither needs nor wants
  // the probe: an extra in-flight request keeps the page from settling, and the
  // pipeline waits for settle.
  //
  // A PERSON opening the same viewer does need it (W20-15, UX_TODO X-24): a
  // shared or bookmarked report link, or a session that expired with the tab
  // open, used to sit on "Loading…" with no way to sign in. Only the injected
  // pipeline skips the gate now; a person gets the sign-in screen in place and
  // the report opens after signing in.
  const isPrint = pathname.startsWith('/print/');
  const isPdfPipeline =
    isPrint && (window as unknown as { __REPORT_DATA?: unknown }).__REPORT_DATA !== undefined;
  const { status } = useSession({ enabled: !isPdfPipeline });

  // Remembering that we once had a session is what lets the sign-in screen tell
  // "your session ended" from "you were never signed in". Same destination,
  // different sentence — neither of which should read as a broken product.
  const [hadSession, setHadSession] = useState(false);
  useEffect(() => {
    if (status === 'authenticated') setHadSession(true);
  }, [status]);

  // Back from a mid-use expiry (W20-04, UX_TODO X-02): everything that failed
  // with 401 while the session was gone is asked again, so the screen the
  // person kept is current rather than a column of "No active session" cards.
  const queryClient = useQueryClient();
  const recovering = useRef(false);
  useEffect(() => {
    if (status === 'anonymous' && hadSession) recovering.current = true;
    if (status === 'authenticated' && recovering.current) {
      recovering.current = false;
      void queryClient.invalidateQueries({ predicate: (q) => q.state.status === 'error' });
    }
  }, [status, hadSession, queryClient]);

  if (isPdfPipeline) return <Outlet />;
  if (status === 'loading') return <SessionProbe />;
  if (isPrint) {
    // Bare, as before, but behind the same sign-in screen as the app.
    if (status === 'anonymous') return <SignedOut expired={hadSession} />;
    return <Outlet />;
  }
  // 'anonymous' covers TWO states the session probe cannot separate: nobody is
  // signed in, and someone holds a session that must change its password before
  // it may do anything (it carries no `userId`, so /me/context 401s for it too).
  // SignedOut asks /auth/local/session which one it is. The forced change is
  // decided HERE rather than at a /signin URL on purpose — a route can be
  // navigated away from, and "cannot reach anything else until it is done" has
  // to be a property of the shell.
  if (status === 'anonymous' && !hadSession) return <SignedOut expired={false} />;
  // 'unknown' — the probe itself failed with something that is NOT a 401. That
  // is not evidence anyone is signed out. If /healthz says the database or
  // Redis is down, one outage screen says so (W20-04, UX_TODO ADM-43);
  // otherwise the app renders and each widget reports its own error honestly.
  if (status === 'unknown') return <OutageGate />;

  // SIGNED OUT MID-USE (W20-04, UX_TODO X-02). The sign-in screen used to
  // REPLACE the app, unmounting everything in progress — a half-typed triage
  // note, a bulk selection, unsaved settings — while promising "nothing was
  // lost". It now opens OVER the app, which stays mounted (inert) underneath,
  // so all of that is still there after signing in again. The write that hit
  // the 401 was refused and is not replayed; the sign-in copy says so. Same
  // element positions in both states, so React keeps AppShell's state.
  const expired = status === 'anonymous';
  return (
    <>
      <AppShell inert={expired} />
      {expired ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Sign in again"
          className="fixed inset-0 z-[60] overflow-auto"
          data-testid="reauth-overlay"
        >
          <SignedOut expired />
        </div>
      ) : null}
    </>
  );
}

/** What /healthz says is down, from its `postgres=down redis=ok` detail. */
export function downFromHealthDetail(detail: string | undefined): string[] {
  if (!detail) return [];
  return [...detail.matchAll(/(\w+)=down/g)].map((m) => m[1]!);
}

const HEALTH_KEY = ['healthz'] as const;
const OUTAGE_POLL_MS = 10_000;

/**
 * Asks /healthz why the session probe failed (W20-04, UX_TODO ADM-43).
 *
 * With Postgres or Redis down, the probe 500s, the shell rendered the full app
 * anyway, and every card showed its own "Internal Server Error". Nothing said
 * the server had lost its database — and the admin's System health panel
 * could not either, because the api-v1 guard needs the database before any
 * route answers. /healthz needs no session and already names what is down.
 *
 * Anything it cannot establish — /healthz unreachable, a proxy 502 — keeps
 * the old behaviour: the app renders and the widgets report honestly. Only a
 * dependency the server itself says is down earns the outage screen.
 */
function OutageGate() {
  const queryClient = useQueryClient();
  const {
    data: health,
    isPending,
    refetch,
    isFetching,
  } = useQuery<{ down: string[]; unreachable: boolean }>({
    queryKey: HEALTH_KEY,
    queryFn: () =>
      apiFetch<unknown>('/healthz').then(
        () => ({ down: [], unreachable: false }),
        (err: unknown) => {
          const down = downFromHealthDetail(errorDetailOf(err));
          // W20-17 (UX_TODO INS-56): /healthz itself did not answer (still
          // migrating after up.sh, a proxy 502, the api container down). With
          // no session behind it, the full shell with an error on every card
          // explained nothing.
          return { down, unreachable: down.length === 0 && isServerSideFailure(err) };
        },
      ),
    retry: false,
    // Keep asking while it is down, so the screen clears itself on recovery.
    refetchInterval: (q) =>
      (q.state.data?.down.length ?? 0) > 0 || q.state.data?.unreachable ? OUTAGE_POLL_MS : false,
  });

  const down = health?.down;
  const healthy =
    health !== undefined && down !== undefined && down.length === 0 && !health.unreachable;
  useEffect(() => {
    // Recovered (or never down): re-ask who this is, so the shell can tell a
    // signed-out visitor from a signed-in one again.
    if (healthy)
      void queryClient.invalidateQueries({ queryKey: queryKeyFor({ endpoint: SESSION_ENDPOINT }) });
  }, [healthy, queryClient]);

  // The probe never throws (a failure IS the answer), so no data means pending.
  if (isPending || down === undefined) return <SessionProbe />;
  if (healthy) return <AppShell />;
  if (health?.unreachable) {
    return (
      <div
        className="flex h-dvh w-full flex-col items-center justify-center gap-3 bg-bg p-6 text-fg"
        data-testid="server-unreachable"
      >
        <div className="panel max-w-lg p-6" role="alert">
          <h1 className="text-base font-medium">RepoPulse can’t reach its server</h1>
          <p className="mt-2 text-sm text-fg-muted">
            It may still be starting up (the first start after an install or upgrade applies
            database migrations), or a proxy in front of it is not forwarding. This page checks
            again every {OUTAGE_POLL_MS / 1000} seconds and opens the app by itself.
          </p>
          <p className="mt-2 text-xs text-fg-muted">
            Your admin can check <code className="font-mono">/healthz</code> and the logs of the api
            container (<code className="font-mono">deploy/up.sh</code> prints how).
          </p>
          <button
            type="button"
            onClick={() => void refetch()}
            disabled={isFetching}
            className="mt-4 rounded-sm border border-border px-2 py-1 text-xs text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            data-testid="server-unreachable-retry"
          >
            {isFetching ? 'Checking…' : 'Try again'}
          </button>
        </div>
      </div>
    );
  }

  const names = down.map((d) => (d === 'postgres' ? 'its database' : d === 'redis' ? 'Redis' : d));
  return (
    <div
      className="flex h-dvh w-full flex-col items-center justify-center gap-3 bg-bg p-6 text-fg"
      data-testid="outage"
    >
      <div className="panel max-w-lg p-6" role="alert">
        <h1 className="text-base font-medium">RepoPulse can’t reach {names.join(' or ')}</h1>
        <p className="mt-2 text-sm text-fg-muted">
          Your admin needs to check the server. Nothing you would see right now is current, so
          nothing is shown. This page checks again every {OUTAGE_POLL_MS / 1000} seconds and opens
          the app by itself once the server recovers.
        </p>
        <p className="mt-2 font-mono text-xs text-fg-faint" data-testid="outage-detail">
          {down.map((d) => `${d}: down`).join(' · ')}
        </p>
        <button
          type="button"
          onClick={() => void refetch()}
          disabled={isFetching}
          className="mt-4 rounded-sm border border-border px-2 py-1 text-xs text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          data-testid="outage-retry"
        >
          {isFetching ? 'Checking…' : 'Check again'}
        </button>
      </div>
    </div>
  );
}

/**
 * Install components System health reports as not working (W20-17, UX_TODO
 * ADM-62). `setup_needed` and `unknown` are not faults: an optional model not
 * configured must not light a warning on every screen.
 */
export function brokenComponentCount(components: { state: string }[] | undefined): number {
  return (components ?? []).filter((c) => c.state === 'degraded' || c.state === 'unavailable')
    .length;
}

/** True for a failure that could mean the server lost a dependency: a 5xx, or no answer at all. */
export function isServerSideFailure(error: unknown): boolean {
  const status = (error as { status?: unknown } | null | undefined)?.status;
  return typeof status === 'number' ? status >= 500 : error instanceof Error;
}

const MID_SESSION_HEALTH_KEY = ['healthz', 'mid-session'] as const;

/**
 * An outage that starts MID-SESSION (W20-10, UX_TODO ADM-43 remainder).
 *
 * OutageGate only runs when the very first session probe fails. When Postgres
 * or Redis goes away while someone is already using the app, every card on the
 * screen showed its own "Internal Server Error" and nothing said why. Any
 * query that fails server-side now makes the shell ask /healthz once; if the
 * server says a dependency is down, ONE banner says so and the page under it
 * is hidden (kept mounted, so nothing typed is lost) until it recovers. If
 * /healthz is fine, nothing changes: the cards report their own errors.
 */
function useMidSessionOutage(): { down: string[]; checking: boolean; recheck: () => void } {
  const queryClient = useQueryClient();
  const [suspect, setSuspect] = useState(false);

  useEffect(
    () =>
      queryClient.getQueryCache().subscribe((event) => {
        if (event.type !== 'updated') return;
        const { query } = event;
        if (query.queryKey[0] === 'healthz') return;
        if (query.state.status === 'error' && isServerSideFailure(query.state.error)) {
          setSuspect(true);
        }
      }),
    [queryClient],
  );

  const {
    data: down,
    refetch,
    isFetching,
  } = useQuery<string[]>({
    queryKey: MID_SESSION_HEALTH_KEY,
    queryFn: () =>
      apiFetch<unknown>('/healthz').then(
        () => [],
        (err: unknown) => downFromHealthDetail(errorDetailOf(err)),
      ),
    enabled: suspect,
    retry: false,
    staleTime: 0,
    refetchInterval: (q) => ((q.state.data?.length ?? 0) > 0 ? OUTAGE_POLL_MS : false),
  });

  const isDown = suspect && (down?.length ?? 0) > 0;
  const wasDown = useRef(false);
  useEffect(() => {
    if (isDown) {
      wasDown.current = true;
      return;
    }
    if (suspect && down !== undefined && down.length === 0) {
      // Healthy: stand down. Coming back from an outage, ask again for
      // everything that failed during it, so the page is current.
      setSuspect(false);
      queryClient.removeQueries({ queryKey: MID_SESSION_HEALTH_KEY });
      if (wasDown.current) {
        wasDown.current = false;
        void queryClient.invalidateQueries({ predicate: (q) => q.state.status === 'error' });
      }
    }
  }, [isDown, suspect, down, queryClient]);

  return { down: isDown ? (down ?? []) : [], checking: isFetching, recheck: () => void refetch() };
}

function OutageBanner({
  down,
  checking,
  recheck,
}: {
  down: string[];
  checking: boolean;
  recheck: () => void;
}) {
  const names = down.map((d) => (d === 'postgres' ? 'its database' : d === 'redis' ? 'Redis' : d));
  return (
    <div
      role="alert"
      className="m-4 rounded-md border border-crit/40 bg-crit/10 p-4 text-sm text-fg"
      data-testid="outage-banner"
    >
      <p className="font-medium">RepoPulse can’t reach {names.join(' or ')}.</p>
      <p className="mt-1 text-fg-muted">
        Your admin needs to check the server. Nothing you would see right now is current, so the
        page is hidden until it recovers — anything you had typed is kept. This checks again every{' '}
        {OUTAGE_POLL_MS / 1000} seconds.
      </p>
      <button
        type="button"
        onClick={recheck}
        disabled={checking}
        className="mt-2 rounded-sm border border-border px-2 py-1 text-xs text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        data-testid="outage-banner-retry"
      >
        {checking ? 'Checking…' : 'Check again'}
      </button>
    </div>
  );
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
      className="flex h-dvh w-full flex-col items-center justify-center gap-3 bg-bg text-fg-muted"
      data-testid="session-probe"
      aria-busy={!slow}
    >
      <p className="text-sm">Checking your session…</p>

      {slow && (
        <div className="flex flex-col items-center gap-2 text-xs" data-testid="session-probe-stuck">
          <p>
            This is taking longer than it should. The server may be unreachable, or this session may
            no longer be valid.
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

function AppShell({ inert = false }: { inert?: boolean }) {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  // Under the sign-in overlay the app stays mounted but must not be reachable
  // (X-02). React 18 does not know the `inert` attribute, so it is set here.
  const rootRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    rootRef.current?.toggleAttribute('inert', inert);
  }, [inert]);

  // W20-04 (UX_TODO ADM-04). The rail defaulted `isAdmin` to true because the
  // shell never passed it, so members were shown Settings and then refused it.
  // Already fetched by the session probe; this reads the same cache entry.
  const { data: me } = useApiQuery<MeContext>({ endpoint: SESSION_ENDPOINT });
  const isAdmin = me?.role === 'admin';

  // The single app-wide sync stream (SSE) — cache-bust + chip + toasts.
  useSyncStream();
  const outage = useMidSessionOutage();

  // Rail badge counts (UX_SPEC §3.1, R-A4). The review queue reuses the exact
  // query My Focus makes, so react-query serves both from one request rather
  // than adding a count endpoint that could disagree with the list.
  //
  // The Reviews badge (W20-10, UX_TODO X-03) counts NEW serious findings
  // since this person last looked — the same request as the top-bar Inbox, so
  // the two cannot disagree. Absent until it has answered, never a fake 0.
  const { data: reviewQueue } = useApiQuery<{ items: { requested?: boolean | null }[] }>({
    endpoint: '/me/review-queue',
  });
  const { data: inbox } = useInbox();
  // W20-17 (UX_TODO ADM-62): admins see, on Settings in the rail, how many
  // install components are not working, from the System health they would
  // otherwise only see while it was open. Same request and poll as that panel.
  const { data: system } = useApiQuery<{ components: { state: string }[] }>(
    { endpoint: '/admin/system' },
    { enabled: isAdmin && !inert, refetchInterval: 60_000 },
  );
  const notWorking = brokenComponentCount(system?.components);
  // W20-16 (UX_TODO DSH-85/64): only the PRs the forge says ask YOU count —
  // rows listed because their request list is not captured yet do not.
  const railBadges: Record<string, number> = {
    ...(reviewQueue === undefined
      ? {}
      : {
          '/pull-requests': reviewQueue.items.filter((i) => i.requested === true).length,
        }),
    ...(inbox === undefined ? {} : { '/findings': inbox.findings_count }),
    ...(isAdmin && notWorking > 0 ? { '/admin': notWorking } : {}),
  };

  // WHICH FILTERS THIS SCREEN APPLIES, and the options for the one that needs
  // them (W16-50). FilterBar has accepted `repoOptions` since it was written
  // and Topbar has forwarded them; nothing ever supplied any, so the repository
  // picker contained only "All repos" and could never be set. Fetched only
  // where the picker is actually shown — react-query serves the /repos screen
  // from the same cache entry.
  const scope = filterScopeFor(pathname);
  const { data: repoList } = useApiQuery<{
    items: { id: number; org: string; name: string; forge?: { host: string | null } | null }[];
  }>({ endpoint: '/repos', query: { window: search.window } }, { enabled: scope.repos });
  const repoOptions = topbarRepoOptions(repoList?.items ?? []);
  // W20-20 (UX_TODO DSH-63): the person box suggested nothing, because no
  // list of logins was ever passed. Fetched only where the box is shown.
  const { data: people } = useApiQuery<{ items: string[] }>(
    { endpoint: '/org/people' },
    { enabled: scope.person },
  );

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

  // W20-17 (UX_TODO ADM-33, UX_SPEC §7): after a navigation, focus moves to
  // the new page's heading (else <main>), so keyboard and screen-reader users
  // start on the page they asked for instead of back at the rail. Not on the
  // first render: landing on the app is not a navigation.
  const mainRef = useRef<HTMLElement>(null);
  const firstPath = useRef(true);
  useEffect(() => {
    if (firstPath.current) {
      firstPath.current = false;
      return;
    }
    const raf = requestAnimationFrame(() => {
      const main = mainRef.current;
      if (!main || main.contains(document.activeElement)) return;
      const heading = main.querySelector<HTMLElement>('h1');
      const target = heading ?? main;
      if (!target.hasAttribute('tabindex')) target.setAttribute('tabindex', '-1');
      target.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(raf);
  }, [pathname]);

  return (
    <div
      ref={rootRef}
      // h-dvh (W20-17, UX_TODO ADM-64): 100vh is taller than the visible area
      // on mobile browsers, so the bottom of each page and the toasts sat
      // under the browser's toolbar. w-full, not w-screen: 100vw adds a
      // horizontal scrollbar wherever scrollbars take space.
      className="flex h-dvh w-full overflow-hidden bg-bg text-fg"
      aria-hidden={inert || undefined}
    >
      {/* W20-17 (UX_TODO ADM-33): the first Tab stop on every page. */}
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:fixed focus:left-2 focus:top-2 focus:z-[70] focus:rounded-md focus:bg-surface focus:px-3 focus:py-2 focus:text-sm focus:text-fg focus:outline focus:outline-2 focus:outline-accent"
        data-testid="skip-link"
        onClick={(e) => {
          e.preventDefault();
          const main = mainRef.current;
          if (!main) return;
          main.setAttribute('tabindex', '-1');
          main.focus();
        }}
      >
        Skip to content
      </a>
      {/* W17-14: the rail is DESKTOP only now. Below 768px it used to collapse
          to a column of unlabelled icons that ate 56px of a 390px screen
          permanently; narrow screens get the labelled drawer instead. */}
      <div className="hidden md:flex">
        <Rail search={preservedSearch} badges={railBadges} isAdmin={isAdmin} />
      </div>
      <NavDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        badges={railBadges}
        isAdmin={isAdmin}
        search={preservedSearch}
        returnFocusTo={drawerTriggerRef}
      />
      {/* PHONE (W20-22, UX_TODO ADM-64): below md this column is the scroll
          container, so the banners, filter bar and breadcrumb scroll away with
          the page and only the Menu row stays (sticky). From md up <main>
          scrolls on its own under a fixed header, as before. */}
      <div
        className="flex min-w-0 flex-1 flex-col overflow-y-auto md:overflow-hidden"
        data-testid="shell-column"
      >
        {/* The drawer's trigger. Labelled in words, not a bare hamburger, and
            it reports its own state — a control that opens something must say
            so (aria-expanded / aria-controls). */}
        <div className="sticky top-0 z-30 flex items-center gap-2 border-b border-border bg-bg px-3 py-2 md:hidden">
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
        {/* Global: ⌘K works from every screen (UX_SPEC §3.3). W20-17: named
            and gated like the rail, and keeps the global filters. */}
        <CommandPalette isAdmin={isAdmin} search={preservedSearch} />
        <Topbar
          value={search}
          onChange={onFilterChange}
          scope={scope}
          repoOptions={repoOptions}
          personOptions={people?.items}
          actions={<Inbox />}
        />
        <Breadcrumb crumbs={crumbs} search={preservedSearch} />
        {outage.down.length > 0 ? <OutageBanner {...outage} /> : null}
        {/* Hidden, not unmounted, during an outage: drafts survive (ADM-43). */}
        <main
          id="main"
          ref={mainRef}
          className="flex-1 overflow-x-auto p-5 focus:outline-none md:min-h-0 md:overflow-auto"
          data-testid="main"
          hidden={outage.down.length > 0}
        >
          {/* W20-17 (UX_TODO INS-17): while nothing is tracked, every persona
              home gets the way to setup, not only Overview. */}
          <FirstRunPanel me={me} pathname={pathname} />
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
