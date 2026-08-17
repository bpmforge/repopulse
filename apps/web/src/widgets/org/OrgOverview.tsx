import { SyncStatusChip, WidgetFrame, useUiStore } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import { serializeGlobalSearch } from '@repopulse/shared/url-state';
import type { GlobalSearch } from '../../api/urlState.js';
import { WidgetGrid } from '../../components/widget/WidgetGrid.js';
import type { Widget } from '../../components/widget/types.js';
// Side-effect import: registers the four org widget types. The grid renders by
// TYPE, so a screen that composes widgets must ensure they are registered — an
// unregistered type degrades to a placeholder frame, which is a silent way for
// this screen to lose a panel.
import './register.js';
import { OnboardingChecklist } from '../onboarding/OnboardingChecklist.js';
import type { HealthTiles, MeContext } from './contracts.js';

// Org Overview (UX_SPEC §4.a) — the landing screen. Composition only: each
// widget owns its own query, loading skeleton and error state, so one failing
// endpoint degrades a single card instead of blanking the dashboard.

interface Props {
  search: GlobalSearch;
}

/** Org-level backfill percentage: the mean across repos currently syncing (E3.6). */
function orgSyncPct(progress: Record<number, { phase: string; pct: number }>): number | null {
  const values = Object.values(progress);
  if (values.length === 0) return null;
  return values.reduce((sum, p) => sum + p.pct, 0) / values.length;
}

/**
 * The Org Overview bento (UX_SPEC §4.a, R-D2).
 *
 * Layout is DATA now, not JSX — the same shape a saved view stores, which is the
 * point of one grid engine: the built-in home and a user-defined view differ by
 * config, not by code.
 */
function orgWidgets(window: string, search: Record<string, string>): Widget[] {
  const options = { window, search };
  return [
    { id: 'org-kpi', type: 'kpi', layout: { x: 0, y: 0, w: 12, h: 1 }, options },
    { id: 'org-health', type: 'health-grid', layout: { x: 0, y: 1, w: 6, h: 2 }, options },
    { id: 'org-attention', type: 'attention-feed', layout: { x: 6, y: 1, w: 6, h: 2 }, options },
    { id: 'org-hotspots', type: 'hotspot-list', layout: { x: 0, y: 3, w: 12, h: 2 }, options },
  ];
}

export function OrgOverview({ search }: Props) {
  const { window } = search;
  const preserved = serializeGlobalSearch(search);
  const connection = useUiStore((s) => s.sseConnection);
  const repoProgress = useUiStore((s) => s.repoProgress);
  const syncPct = orgSyncPct(repoProgress);

  // First-run detection rides the health-tiles query rather than a dedicated
  // endpoint: zero repos in the workspace IS the first-run condition, and it
  // is already fetched. A separate connections call would double the requests
  // to answer a question this response already answers.
  const { data: tiles, isSuccess } = useApiQuery<HealthTiles>({
    endpoint: '/org/health-tiles',
    query: { window },
  });
  const firstRun = isSuccess && (tiles?.items.length ?? 0) === 0;
  const { data: me } = useApiQuery<MeContext>({ endpoint: '/me/context' });

  if (firstRun) {
    // Role-appropriate CTA (UX_SPEC §4.a). W4-14 exposed the caller's role, so
    // this no longer ships the member-safe copy to everyone: an admin can act,
    // a member is told who can. While role is still loading it falls to the
    // member wording — briefly under-promising beats offering an action the
    // viewer may not be permitted to take.
    const isAdmin = me?.role === 'admin';
    return (
      <WidgetFrame
        title="Welcome to RepoPulse"
        state="empty"
        emptyMessage={
          isAdmin
            ? 'No repositories are connected yet. Connect your organization to start ingesting history.'
            : 'No repositories are connected yet. Ask an admin to connect your organization.'
        }
      />
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="org-overview">
      {/* R-A1. `hasRepos` is the one step that can be verified rather than
          claimed — the health-tiles response already answers it. */}
      <OnboardingChecklist hasRepos={(tiles?.items.length ?? 0) > 0} />

      {syncPct !== null && (
        <div
          className="flex items-center gap-2 rounded-md border border-border bg-surface-2 px-3 py-2"
          data-testid="org-sync-banner"
          role="status"
        >
          <SyncStatusChip
            connection={connection}
            progress={{ phase: 'Backfilling', pct: syncPct }}
          />
          <span className="text-xs text-fg-muted">
            Numbers fill in as history lands — syncing repos show progress, not zeros.
          </span>
        </div>
      )}

      {/* R-D2: composed through the SAME WidgetGrid saved views use, with
          sizing variety — a full-width KPI row, two 2×2 heroes side by side,
          then a full-width leaderboard. The grid already honoured per-widget
          w/h; this screen simply never used it, so "supports 2×2 hero tiles"
          was true of the engine and false of the screen. */}
      <WidgetGrid widgets={orgWidgets(window, preserved)} />
    </div>
  );
}
