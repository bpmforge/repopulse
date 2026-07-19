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
  onToasts(toasts: Toast[]): void;
  /** Debounced flush: which repos + whether org-level views went stale. */
  invalidate(dirty: { repoIds: number[]; org: boolean }): void;
}

const EVENT_NAMES: SyncEventType[] = ['sync.progress', 'sync.done', 'budget.warning', 'sync.repo'];

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

let toastSeq = 0;
function makeToast(message: string, tone: Toast['tone']): Toast {
  toastSeq += 1;
  return { id: `sse-${toastSeq}`, message, tone };
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
  let dirtyOrg = false;
  let invalidateTimer: ReturnType<typeof setTimeout> | null = null;
  let toastBuffer: Toast[] = [];
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
      const batch = toastBuffer;
      toastBuffer = [];
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
          callbacks.onRepoProgress(repoId, {
            phase: typeof event.data.phase === 'string' ? event.data.phase : 'syncing',
            pct: num(event.data.pct) ?? 0,
          });
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
          toastBuffer.push(makeToast(`Repo ${repoId} finished syncing`, 'ok'));
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
      attempt = 0;
      callbacks.onConnection('open');
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

/** Map a debounced dirty-set to targeted TanStack Query invalidations. */
function invalidateQueries(queryClient: QueryClient, dirty: { repoIds: number[]; org: boolean }) {
  const repoIds = new Set(dirty.repoIds);
  void queryClient.invalidateQueries({
    predicate: (query) => {
      const [endpoint, path] = query.queryKey as [string, { id?: number | string }?];
      if (typeof endpoint !== 'string') return false;
      if (dirty.org && (endpoint.startsWith('/org') || endpoint.startsWith('/metrics')))
        return true;
      const id = path?.id;
      return id !== undefined && repoIds.has(Number(id));
    },
  });
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
      onToasts: (toasts) => useUiStore.getState().pushToasts(toasts),
      invalidate: (dirty) => invalidateQueries(queryClient, dirty),
    });

    return () => stream.stop();
  }, [queryClient, createEventSource]);
}
