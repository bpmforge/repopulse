import { useApiQuery } from '../api/useApiQuery.js';
import { useUiStore } from '../components/store/uiStore.js';

// "History still loading" for every Overview card (W20-22, UX_TODO INS-35).
//
// While a fresh install backfilled, only the health tiles used the `syncing`
// frame state; the KPI row said "No metric snapshots yet for this window." and
// the hotspot list "nothing is hot", so a filling install read as an empty
// organization. Every card that reads history now asks this one hook.
//
// Two sources, because each can be missing: the SSE progress events (live, but
// only for repositories that moved since the page opened) and GET /sync/status
// (the same read Settings → Sync polls, shared through the query cache).

interface SyncStatusLite {
  repos: { phase: string; percentComplete: number }[];
}

/** Phases in which a repository's history is still arriving. */
const LOADING_PHASES = new Set(['queued', 'history', 'enrichment', 'paused_budget']);

export interface BackfillState {
  syncing: boolean;
  /** How far, across the repositories still loading (0-100). */
  pct: number;
}

/** The rows, or none when the answer is missing or not the expected shape. */
function reposOf(status: SyncStatusLite | undefined): SyncStatusLite['repos'] {
  return Array.isArray(status?.repos) ? status.repos : [];
}

/** Pure, for tests: what the two sources together say. */
export function backfillState(
  status: SyncStatusLite | undefined,
  progress: Record<number, { pct: number }>,
): BackfillState {
  const loading = reposOf(status).filter((r) => LOADING_PHASES.has(r.phase));
  const live = Object.values(progress);
  if (loading.length === 0 && live.length === 0) return { syncing: false, pct: 100 };
  const pcts = live.length > 0 ? live.map((p) => p.pct) : loading.map((r) => r.percentComplete);
  const pct = pcts.reduce((s, n) => s + n, 0) / pcts.length;
  return { syncing: true, pct: Math.max(0, Math.min(100, pct)) };
}

/** Re-read every 15 s while something is loading; settled, not at all. */
export function backfillPoll(status: SyncStatusLite | undefined): number | false {
  return reposOf(status).some((r) => LOADING_PHASES.has(r.phase)) ? 15_000 : false;
}

export function useBackfill(): BackfillState {
  const progress = useUiStore((s) => s.repoProgress);
  const { data } = useApiQuery<SyncStatusLite>(
    { endpoint: '/sync/status' },
    { refetchInterval: backfillPoll },
  );
  return backfillState(data, progress);
}
