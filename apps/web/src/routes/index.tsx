import { useEffect } from 'react';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { serializeGlobalSearch } from '@repopulse/shared/url-state';
import { OrgOverview, orgWidgets } from '../widgets/org/OrgOverview.js';
import { PageHeader } from '../components/index.js';
import { useApiQuery } from '../api/useApiQuery.js';
import { asOfLabel, type MeContext, type OrgSummary } from '../widgets/org/contracts.js';
import { withRepos } from '../widgets/scopeRepos.js';
import { SaveAsViewButton } from '../views/SaveAsViewButton.js';

// Org Overview — the landing screen (UX_SPEC §4.a). Everything it renders reads
// our own Postgres through /api/v1 (Law 4); the route itself only wires the
// validated global filters from __root into the screen.
export const Route = createFileRoute('/')({
  component: OrgOverviewRoute,
});

/** Once per browser session: see landingTarget. */
const LANDED_KEY = 'repopulse.landed';

/**
 * Where `/` should send someone who has just arrived (W20-05, UX_TODO DSH-03).
 *
 * "Set as home" stored a choice nothing read, and a persona's home was applied
 * only once, when the picker was first answered. The chosen home view wins,
 * then the persona's home; the lead persona's home IS this screen, so it stays.
 *
 * Only on ARRIVAL — the first time `/` renders in a browser session — never on
 * a later click of Overview in the rail. Redirecting every visit would make the
 * Overview unreachable for anyone with a home view.
 */
export function landingTarget(me: Pick<MeContext, 'default_view_id' | 'home'>): string | null {
  if (me.default_view_id !== null) return `/views/${me.default_view_id}`;
  if (me.home && me.home !== '/') return me.home;
  return null;
}

/**
 * True once per browser session, and only when the PAGE LOAD itself was `/`
 * (sign-in redirects there). Someone who opened a deep link and later clicks
 * Overview asked for the Overview. sessionStorage can throw (private mode,
 * blocked storage): never fatal, it just means no redirect.
 */
function firstArrival(): boolean {
  try {
    if (window.sessionStorage.getItem(LANDED_KEY)) return false;
    window.sessionStorage.setItem(LANDED_KEY, '1');
    const load = performance.getEntriesByType?.('navigation')[0];
    return !load || new URL(load.name).pathname === '/';
  } catch {
    return false;
  }
}

function OrgOverviewRoute() {
  const search = Route.useSearch();
  const navigate = useNavigate();
  const { data: me } = useApiQuery<MeContext>({ endpoint: '/me/context' });
  // The KPI row's own query (same key, so one request): its `as_of` is the
  // page's freshness stamp (W20-12, UX_TODO DSH-48).
  const repos = search.repos && search.repos !== 'all' ? search.repos : undefined;
  const { data: summary } = useApiQuery<OrgSummary>({
    endpoint: '/org/summary',
    query: withRepos({ window: search.window }, repos),
  });

  useEffect(() => {
    if (!me || !firstArrival()) return;
    const target = landingTarget(me);
    if (target) void navigate({ to: target as never, replace: true });
  }, [me, navigate]);

  // The page's h1 lives here, not in OrgOverview, so the widget stays
  // embeddable (W18-28: the landing screen had no heading at all).
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Overview"
        description="Delivery, code health and risk across every tracked repository."
        meta={
          summary ? (
            <span className="text-xs text-fg-muted" data-testid="overview-as-of">
              {asOfLabel(summary.as_of)}
            </span>
          ) : undefined
        }
        actions={
          <SaveAsViewButton
            widgets={orgWidgets(search.window, serializeGlobalSearch(search))}
            window={search.window}
            repos={search.repos}
            defaultName="My overview"
          />
        }
      />
      <OrgOverview search={search} />
    </div>
  );
}
