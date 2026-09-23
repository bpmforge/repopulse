import { Link } from '@tanstack/react-router';
import { SyncStatusChip, WidgetFrame, useUiStore } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
// The widget registrations moved to widgets/registerAll.js, imported by the
// root route (W16-55): they were side-effect imports reachable only from HERE,
// so a saved view that did not pass through this screen first found an empty
// registry and rendered "widget is not available yet" for every tile.
import { serializeGlobalSearch } from '@repopulse/shared/url-state';
import type { GlobalSearch } from '../../api/urlState.js';
import { WidgetGrid } from '../../components/widget/WidgetGrid.js';
import type { Widget } from '../../components/widget/types.js';
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
export function orgWidgets(window: string, search: Record<string, string>): Widget[] {
  const options = { window, search };
  return [
    // W17-17. FIRST, above the pulse. Measured at 1440x900, the fold used to
    // land on the TITLES of Repo health and Needs attention: everything a
    // visitor could see without scrolling reported state, and nothing proposed
    // a move. Row ORDER is what places this — WidgetGrid ignores the saved `y`
    // and auto-places in array order — so the other widgets' y values are left
    // exactly as they were rather than renumbered into diff noise.
    { id: 'org-top-actions', type: 'top-actions', layout: { x: 0, y: 0, w: 12, h: 1 }, options },
    // Pinned at the top (R-A7): the pulse is what someone reads if they read
    // one thing, so it sits above the tiles rather than below them.
    { id: 'org-kpi', type: 'kpi', layout: { x: 0, y: 2, w: 12, h: 1 }, options },
    { id: 'org-health', type: 'health-grid', layout: { x: 0, y: 1, w: 6, h: 2 }, options },
    { id: 'org-attention', type: 'attention-feed', layout: { x: 6, y: 1, w: 6, h: 2 }, options },
    // Visual refresh 2026-09-11: the pulse is a short list of sentences, and
    // at full width it was five lines of text in a panel with 900px of empty
    // space to their right. It now sits at a third beside the hotspot
    // leaderboard, still in the top half of the page (R-A7).
    { id: 'org-pulse', type: 'weekly-pulse', layout: { x: 0, y: 3, w: 4, h: 2 }, options },
    { id: 'org-hotspots', type: 'hotspot-list', layout: { x: 4, y: 3, w: 8, h: 2 }, options },
    // W5-07. On the row BELOW the two 6x2 heroes, not carved out of them:
    // W4-21 deliberately made this screen read bento with exactly two heroes,
    // and shrinking one to fit the plan tile broke that assertion. Still above
    // the fold though — a regression nobody scrolls to is a regression nobody
    // acts on.
    { id: 'org-plan', type: 'plan-progress', layout: { x: 0, y: 5, w: 3, h: 2 }, options },
    // W8-10: the security rollup sits below the fold rather than above it —
    // with one scanner running it would otherwise be the loudest tile on the
    // page while saying the least.
    { id: 'org-security', type: 'security-rollup', layout: { x: 3, y: 5, w: 3, h: 2 }, options },
    // W9-11: beside the security tile — the two answer different questions
    // ("what is open" vs "what should we do first").
    { id: 'org-top-risks', type: 'top-risks', layout: { x: 6, y: 5, w: 3, h: 2 }, options },
    // W10-05. Beside Top Risks: one says what to fix first, the other says
    // which axis it belongs to and how that axis is doing.
    { id: 'org-risk-axes', type: 'risk-axes', layout: { x: 9, y: 5, w: 3, h: 2 }, options },
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
        // W16-18. The comment above calls this a "role-appropriate CTA", and
        // until now it was only ever role-appropriate COPY: the admin was told
        // to connect their organisation and given nothing to click. This is the
        // first screen of a real install — found by finally walking the
        // non-demo first run — so a dead end here is a dead end at the worst
        // possible moment. The member still gets none, correctly: they are told
        // who can act precisely because they cannot.
        {...(isAdmin
          ? {
              emptyAction: (
                <Link
                  to="/admin"
                  data-testid="welcome-connect"
                  className="rounded-sm border border-border bg-accent-strong px-3 py-1.5 text-sm text-accent-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                >
                  Connect an organization
                </Link>
              ),
            }
          : {})}
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
          className="flex items-center gap-2 panel-inset px-3 py-2"
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
