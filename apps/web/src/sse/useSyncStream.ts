import { useEffect } from 'react';
import { useQueryClient, type QueryClient } from '@tanstack/react-query';
import {
  useUiStore,
  type RepoSyncProgress,
  type SseConnection,
  type Toast,
} from '../components/store/uiStore.js';

// SSE client (DASHBOARD §6, NFR-10). ONE EventSource to /api/v1/events, mounted
// in __root. Policy:
//   • sync.progress → update the zustand chip directly (no refetch churn)
//   • any sync event → debounce-invalidate the matching query keys (500ms)
//   • toast-worthy events (sync.done, budget.warning) → batched role=status toasts
//   • reconnect with exponential backoff, resuming via Last-Event-ID
// SSE is an optimization — correctness lives in GET /sync/status — so a dropped
// frame only means a slightly staler dashboard until the next poll/reconnect.

const STREAM_URL = '/api/v1/events';
const INVALIDATE_DEBOUNCE_MS = 500;
const TOAST_BATCH_MS = 500;
const RECONNECT_BASE_MS = 1000;
const RECONNECT_MAX_MS = 30_000;

/**
 * The first-insight threshold (R-A3, W4-21).
 *
 * Backfill is RECENT-FIRST, so the useful window fills long before the whole
 * year does — and until this toast existed, nothing told anyone. The signal is
 * the pct the worker already publishes: status.ts defines percentComplete as
 * `min over entities of (now − oldest) / 365d`, so pct ≥ 30/365 means every
 * entity covers at least the last 30 days. That is a DECODE of the server's own
 * number, not a second definition of coverage.
 *
 * pct arrives rounded to whole percent, so a repo at exactly 30 days reports 8
 * and only crosses this at 9 (~33 days). The toast therefore fires slightly
 * LATE rather than early, which is the safe direction: it never claims a window
 * is ready before it is.
 */
const FIRST_INSIGHT_PCT = (30 / 365) * 100;

/**
 * Phases in which the 30-day window is complete REGARDLESS of pct.
 *
 * A pct threshold alone is wrong for a young repo, and not as an edge case: a
 * repo whose entire history is three days old has coverage of 3/365 ≈ 1% and
 * would NEVER cross the threshold — while in fact every day it has ever had is
 * already ingested. Coverage measures how far back we reached, not whether
 * anything is missing.
 *
 * Once history backfill is complete (`enrichment`) or the repo is `live`, every
 * entity cursor is done, so there is nothing older to fetch and the last 30 days
 * are covered by definition.
 */
const HISTORY_COMPLETE_PHASES = new Set(['enrichment', 'live']);

/** The server frame: `{ type, data }` (packages/ingest SyncStreamEvent). */
type SyncEventType = 'sync.progress' | 'sync.done' | 'budget.warning' | 'sync.repo';
interface WireEvent {
  type: SyncEventType;
  data: Record<string, unknown>;
}

/** Minimal EventSource surface — injectable so tests supply a fake (jsdom has none). */
export interface EventSourceLike {
  addEventListener(
    type: string,
    listener: (event: { data: string; lastEventId?: string }) => void,
  ): void;
  close(): void;
  onopen: ((event: unknown) => void) | null;
  onerror: ((event: unknown) => void) | null;
}
export type EventSourceFactory = (url: string) => EventSourceLike;

export interface SyncStreamCallbacks {
  onConnection(state: SseConnection): void;
  onRepoProgress(repoId: number, progress: RepoSyncProgress): void;
  onRepoDone(repoId: number): void;
  /**
   * A repo's 30-day window just became complete (R-A3). Separate from
   * onRepoProgress so the caller can name the repo — the event carries an id,
   * and "last 30 days ready for payments" is the point of the message.
   */
  onFirstInsight?(repoId: number): void;
  onToasts(toasts: Toast[]): void;
  /** Debounced flush: which repos + whether org-level views went stale. */
  invalidate(dirty: { repoIds: number[]; org: boolean }): void;
  /**
   * A repository's display name for a toast (W20-17, UX_TODO INS-33). The
   * event carries only an id; without this the toast said "Repo 41".
   */
  repoName?(repoId: number): string;
  /**
   * The stream reopened after a drop (W20-17, UX_TODO ADM-46). Events sent
   * while it was down are not replayed, so the caller refetches what failed
   * and marks the rest stale.
   */
  onReconnected?(): void;
}

const EVENT_NAMES: SyncEventType[] = ['sync.progress', 'sync.done', 'budget.warning', 'sync.repo'];

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

let toastSeq = 0;
function makeToast(message: string, tone: Toast['tone'], action?: Toast['action']): Toast {
  toastSeq += 1;
  return { id: `sse-${toastSeq}`, message, tone, ...(action ? { action } : {}) };
}

/**
 * ONE toast for every repository that finished in a batch window (W20-17,
 * UX_TODO INS-33; UX_SPEC §5 asks for batching): "payments finished syncing",
 * or "3 repositories finished syncing: a, b, c". Exported for its test.
 */
export function syncDoneToast(repoIds: number[], nameOf: (id: number) => string): Toast | null {
  if (repoIds.length === 0) return null;
  if (repoIds.length === 1) {
    const id = repoIds[0]!;
    return makeToast(`${nameOf(id)} finished syncing`, 'ok', {
      label: 'Open repository',
      to: `/repos/${id}`,
    });
  }
  const names = repoIds.slice(0, 3).map(nameOf);
  const more = repoIds.length > 3 ? ` and ${repoIds.length - 3} more` : '';
  return makeToast(
    `${repoIds.length} repositories finished syncing: ${names.join(', ')}${more}`,
    'ok',
    { label: 'See repositories', to: '/repos' },
  );
}

export interface SyncStream {
  stop(): void;
}

/**
 * Framework-agnostic controller (unit-tested directly with a fake EventSource +
 * fake timers). The React hook below is a thin lifecycle wrapper.
 */
export function createSyncStream(
  createEventSource: EventSourceFactory,
  callbacks: SyncStreamCallbacks,
  opts: { url?: string } = {},
): SyncStream {
  const url = opts.url ?? STREAM_URL;

  let source: EventSourceLike | null = null;
  let stopped = false;
  let lastEventId: string | undefined;
  let attempt = 0;

  const dirtyRepos = new Set<number>();
  // Once per repo per session. Progress events keep arriving as the rest of the
  // year backfills, and a toast on every one of them would be noise rather than
  // a moment.
  const firstInsightFired = new Set<number>();
  let dirtyOrg = false;
  let invalidateTimer: ReturnType<typeof setTimeout> | null = null;
  let toastBuffer: Toast[] = [];
  // Repositories finished in this batch window, turned into ONE toast (INS-33).
  let doneBuffer: number[] = [];
  let toastTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function scheduleInvalidate() {
    if (invalidateTimer !== null) return;
    invalidateTimer = setTimeout(() => {
      invalidateTimer = null;
      const repoIds = [...dirtyRepos];
      const org = dirtyOrg;
      dirtyRepos.clear();
      dirtyOrg = false;
      if (repoIds.length > 0 || org) callbacks.invalidate({ repoIds, org });
    }, INVALIDATE_DEBOUNCE_MS);
  }

  function scheduleToasts() {
    if (toastTimer !== null) return;
    toastTimer = setTimeout(() => {
      toastTimer = null;
      const done = syncDoneToast(doneBuffer, (id) => callbacks.repoName?.(id) ?? `Repo ${id}`);
      const batch = done ? [done, ...toastBuffer] : toastBuffer;
      toastBuffer = [];
      doneBuffer = [];
      if (batch.length > 0) callbacks.onToasts(batch);
    }, TOAST_BATCH_MS);
  }

  function handle(raw: { data: string; lastEventId?: string }) {
    if (raw.lastEventId) lastEventId = raw.lastEventId;
    let event: WireEvent;
    try {
      event = JSON.parse(raw.data) as WireEvent;
    } catch {
      return; // malformed frame — ignore (SSE is best-effort)
    }
    const repoId = num(event.data.repoId);

    switch (event.type) {
      case 'sync.progress': {
        if (repoId !== undefined) {
          const pct = num(event.data.pct) ?? 0;
          const phase = typeof event.data.phase === 'string' ? event.data.phase : 'syncing';
          callbacks.onRepoProgress(repoId, { phase, pct });
          const windowCovered = pct >= FIRST_INSIGHT_PCT || HISTORY_COMPLETE_PHASES.has(phase);
          if (windowCovered && !firstInsightFired.has(repoId)) {
            firstInsightFired.add(repoId);
            callbacks.onFirstInsight?.(repoId);
          }
          dirtyRepos.add(repoId);
        }
        dirtyOrg = true;
        scheduleInvalidate();
        break;
      }
      case 'sync.done': {
        if (repoId !== undefined) {
          callbacks.onRepoDone(repoId);
          dirtyRepos.add(repoId);
          if (!doneBuffer.includes(repoId)) doneBuffer.push(repoId);
        }
        dirtyOrg = true;
        scheduleInvalidate();
        scheduleToasts();
        break;
      }
      case 'sync.repo': {
        if (repoId !== undefined) dirtyRepos.add(repoId);
        dirtyOrg = true;
        scheduleInvalidate();
        break;
      }
      case 'budget.warning': {
        const message =
          typeof event.data.message === 'string'
            ? event.data.message
            : 'Forge rate-limit budget is low — sync may pause';
        toastBuffer.push(makeToast(message, 'warn'));
        scheduleToasts();
        break;
      }
    }
  }

  function connect() {
    if (stopped) return;
    const target = lastEventId ? `${url}?lastEventId=${encodeURIComponent(lastEventId)}` : url;
    callbacks.onConnection(attempt === 0 ? 'connecting' : 'reconnecting');
    const es = createEventSource(target);
    source = es;

    es.onopen = () => {
      const reconnected = attempt > 0;
      attempt = 0;
      callbacks.onConnection('open');
      if (reconnected) callbacks.onReconnected?.();
    };
    es.onerror = () => {
      if (stopped) return;
      es.close();
      source = null;
      callbacks.onConnection('reconnecting');
      const delay = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
      attempt += 1;
      reconnectTimer = setTimeout(connect, delay);
    };
    for (const name of EVENT_NAMES) es.addEventListener(name, handle);
  }

  connect();

  return {
    stop() {
      stopped = true;
      if (invalidateTimer !== null) clearTimeout(invalidateTimer);
      if (toastTimer !== null) clearTimeout(toastTimer);
      if (reconnectTimer !== null) clearTimeout(reconnectTimer);
      source?.close();
      source = null;
      callbacks.onConnection('closed');
    },
  };
}

/**
 * Whether a cached query is stale after a debounced dirty-set (exported for
 * its test).
 *
 * `/sync/*` on ANY sync news (W20-04, UX_TODO INS-11): Settings → Sync and the
 * setup checklist read it, the events are literally about sync progress, and
 * it was the one key they never refreshed.
 */
export function isDirtyQuery(
  queryKey: readonly unknown[],
  dirty: { repoIds: number[]; org: boolean },
): boolean {
  const [endpoint, path] = queryKey as [string, { id?: number | string }?];
  if (typeof endpoint !== 'string') return false;
  if (endpoint.startsWith('/sync') && (dirty.org || dirty.repoIds.length > 0)) return true;
  if (dirty.org && (endpoint.startsWith('/org') || endpoint.startsWith('/metrics'))) return true;
  // W20-10 (UX_TODO X-03): a sync that landed may have brought new findings.
  if (dirty.org && endpoint === '/me/inbox') return true;
  const id = path?.id;
  return id !== undefined && dirty.repoIds.includes(Number(id));
}

/** Map a debounced dirty-set to targeted TanStack Query invalidations. */
function invalidateQueries(queryClient: QueryClient, dirty: { repoIds: number[]; org: boolean }) {
  void queryClient.invalidateQueries({ predicate: (query) => isDirtyQuery(query.queryKey, dirty) });
}

/**
 * A repo's display name from whatever the cache already holds (R-A3).
 *
 * The event carries only an id, and "last 30 days ready for payments" is the
 * whole point of the message — a toast naming "repo 41" tells nobody anything.
 * Read from the org health-tiles response the shell has already fetched rather
 * than issuing a request from inside an event handler; falls back to the id,
 * because a slightly worse message beats a missing moment.
 */
function repoNameFromCache(queryClient: QueryClient, repoId: number): string {
  const queries = queryClient.getQueriesData<{ items?: { id: number; name: string }[] }>({
    predicate: (query) => (query.queryKey as [string?])[0] === '/org/health-tiles',
  });
  for (const [, data] of queries) {
    const match = data?.items?.find((r) => Number(r.id) === repoId);
    if (match) return match.name;
  }
  // W20-17 (INS-33): the repositories list is the other cache that names them.
  const lists = queryClient.getQueriesData<{
    items?: { id: number; name: string; org?: string }[];
  }>({
    predicate: (query) => (query.queryKey as [string?])[0] === '/repos',
  });
  for (const [, data] of lists) {
    const match = data?.items?.find((r) => Number(r.id) === repoId);
    if (match) return match.org ? `${match.org}/${match.name}` : match.name;
  }
  return `Repo ${repoId}`;
}

/** Mount the single app-wide sync stream (called once, in __root). */
export function useSyncStream(createEventSource?: EventSourceFactory): void {
  const queryClient = useQueryClient();

  useEffect(() => {
    const factory: EventSourceFactory | undefined =
      createEventSource ??
      (typeof EventSource !== 'undefined'
        ? (url) => new EventSource(url, { withCredentials: true }) as unknown as EventSourceLike
        : undefined);
    if (!factory) return; // no EventSource (SSR/test without injection) — skip

    // State is read through getState() at call time to avoid stale closures.
    const stream = createSyncStream(factory, {
      onConnection: (state) => useUiStore.getState().setSseConnection(state),
      onRepoProgress: (repoId, progress) => useUiStore.getState().setRepoProgress(repoId, progress),
      onRepoDone: (repoId) => useUiStore.getState().clearRepoProgress(repoId),
      onFirstInsight: (repoId) =>
        useUiStore.getState().pushToasts([
          {
            id: `first-insight-${repoId}`,
            tone: 'ok',
            message: `Last 30 days ready for ${repoNameFromCache(queryClient, repoId)} — take a look`,
            // W20-17 (UX_TODO INS-34): "take a look" now has somewhere to go.
            action: { label: 'Open repository', to: `/repos/${repoId}` },
          },
        ]),
      onToasts: (toasts) => useUiStore.getState().pushToasts(toasts),
      invalidate: (dirty) => invalidateQueries(queryClient, dirty),
      repoName: (repoId) => repoNameFromCache(queryClient, repoId),
      // W20-17 (UX_TODO ADM-46): back after a drop, refetch what failed while
      // it was down and mark everything else stale (refetched when next seen).
      onReconnected: () => {
        void queryClient.refetchQueries({ predicate: (q) => q.state.status === 'error' });
        void queryClient.invalidateQueries({
          predicate: (q) => q.state.status !== 'error',
          refetchType: 'active',
        });
      },
    });

    return () => stream.stop();
  }, [queryClient, createEventSource]);
}
