import { SyncStatusChip, WidgetFrame, useUiStore } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import { serializeGlobalSearch } from '@repopulse/shared/url-state';
import type { GlobalSearch } from '../../api/urlState.js';
import { KpiRow } from './KpiRow.js';
import { HealthTileGrid } from './HealthTileGrid.js';
import { HotspotLeaderboard } from './HotspotLeaderboard.js';
import { AttentionFeed } from './AttentionFeed.js';
import type { HealthTiles } from './contracts.js';

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

  if (firstRun) {
    return (
      <WidgetFrame
        title="Welcome to RepoPulse"
        state="empty"
        // ROLE GAP (W4-03): UX_SPEC §4.a wants admin ("Connect your org") vs
        // member ("Ask an admin") copy, but no endpoint exposes the caller's
        // role — api-v1.ts sets request.role server-side and never returns it,
        // and /me is the minimal {user} shape. Defaulting to the member-safe
        // wording: showing admin copy to a member is a dead end for someone who
        // cannot act on it, while the reverse is merely less direct. Filed as a
        // follow-up rather than narrowed here.
        emptyMessage="No repositories are connected yet. An admin can connect your organization from Admin → Connections."
      />
    );
  }

  return (
    <div className="flex flex-col gap-4" data-testid="org-overview">
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

      <KpiRow window={window} />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <HealthTileGrid window={window} search={preserved} />
        <AttentionFeed window={window} search={preserved} />
      </div>

      <HotspotLeaderboard window={window} search={preserved} />
    </div>
  );
}
