import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSyncStream,
  isDirtyQuery,
  type EventSourceLike,
  type SyncStreamCallbacks,
} from './useSyncStream.js';

// A controllable fake EventSource (jsdom has none). Records the URL it was
// constructed with so we can assert Last-Event-ID resumption.
class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  onopen: ((event: unknown) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  closed = false;
  readonly url: string;
  private listeners = new Map<string, (e: { data: string; lastEventId?: string }) => void>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, listener: (e: { data: string; lastEventId?: string }) => void) {
    this.listeners.set(type, listener);
  }
  close() {
    this.closed = true;
  }
  emit(type: string, data: unknown, lastEventId?: string) {
    const payload = JSON.stringify({ type, data });
    this.listeners.get(type)?.(
      lastEventId !== undefined ? { data: payload, lastEventId } : { data: payload },
    );
  }
}

function makeCallbacks() {
  const calls = {
    connection: [] as string[],
    progress: [] as { repoId: number; phase: string; pct: number }[],
    done: [] as number[],
    toasts: [] as { message: string; tone: string }[][],
    invalidations: [] as { repoIds: number[]; org: boolean }[],
    firstInsight: [] as number[],
  };
  const callbacks: SyncStreamCallbacks = {
    onConnection: (s) => calls.connection.push(s),
    onRepoProgress: (repoId, p) => calls.progress.push({ repoId, ...p }),
    onRepoDone: (repoId) => calls.done.push(repoId),
    onToasts: (t) => calls.toasts.push(t.map((x) => ({ message: x.message, tone: x.tone }))),
    invalidate: (d) => calls.invalidations.push(d),
    onFirstInsight: (repoId) => calls.firstInsight.push(repoId),
  };
  return { calls, callbacks };
}

describe('createSyncStream (DASHBOARD §6)', () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('connects (connecting → open) on the first EventSource open', () => {
    const { calls, callbacks } = makeCallbacks();
    const stream = createSyncStream((url) => new FakeEventSource(url), callbacks);
    expect(calls.connection).toEqual(['connecting']);
    FakeEventSource.instances[0]!.onopen?.(null);
    expect(calls.connection).toEqual(['connecting', 'open']);
    stream.stop();
  });

  it('routes sync.progress to the chip and debounces invalidation into one flush', () => {
    const { calls, callbacks } = makeCallbacks();
    const stream = createSyncStream((url) => new FakeEventSource(url), callbacks);
    const es = FakeEventSource.instances[0]!;
    es.onopen?.(null);

    es.emit('sync.progress', { repoId: 1, phase: 'history', pct: 20 });
    es.emit('sync.progress', { repoId: 1, phase: 'history', pct: 55 });
    es.emit('sync.progress', { repoId: 2, phase: 'enrichment', pct: 10 });

    // chip updates are immediate (no debounce)
    expect(calls.progress).toHaveLength(3);
    expect(calls.progress[0]).toEqual({ repoId: 1, phase: 'history', pct: 20 });
    // invalidation is debounced — nothing yet
    expect(calls.invalidations).toHaveLength(0);

    vi.advanceTimersByTime(500);
    expect(calls.invalidations).toHaveLength(1);
    expect(calls.invalidations[0]!.repoIds.sort()).toEqual([1, 2]);
    expect(calls.invalidations[0]!.org).toBe(true);
    stream.stop();
  });

  it('batches toast-worthy events (sync.done, budget.warning) into one role=status flush', () => {
    const { calls, callbacks } = makeCallbacks();
    const stream = createSyncStream((url) => new FakeEventSource(url), callbacks);
    const es = FakeEventSource.instances[0]!;
    es.onopen?.(null);

    es.emit('sync.done', { repoId: 7 });
    es.emit('budget.warning', { message: 'budget parked' });
    expect(calls.toasts).toHaveLength(0); // batched

    vi.advanceTimersByTime(500);
    expect(calls.toasts).toHaveLength(1);
    expect(calls.toasts[0]).toEqual([
      { message: 'Repo 7 finished syncing', tone: 'ok' },
      { message: 'budget parked', tone: 'warn' },
    ]);
    expect(calls.done).toEqual([7]);
    stream.stop();
  });

  // W20-17 (UX_TODO INS-33): named, and one toast for a burst of finishes.
  it('names finished repositories and batches several into one toast', () => {
    const { calls, callbacks } = makeCallbacks();
    callbacks.repoName = (id) => (id === 1 ? 'acme/api' : id === 2 ? 'acme/web' : `r${id}`);
    const stream = createSyncStream((url) => new FakeEventSource(url), callbacks);
    const es = FakeEventSource.instances[0]!;
    es.onopen?.(null);
    es.emit('sync.done', { repoId: 1 });
    vi.advanceTimersByTime(500);
    expect(calls.toasts[0]).toEqual([{ message: 'acme/api finished syncing', tone: 'ok' }]);

    for (const id of [1, 2, 3, 4, 5]) es.emit('sync.done', { repoId: id });
    vi.advanceTimersByTime(500);
    expect(calls.toasts[1]).toEqual([
      { message: '5 repositories finished syncing: acme/api, acme/web, r3 and 2 more', tone: 'ok' },
    ]);
    stream.stop();
  });

  // W20-17 (UX_TODO ADM-46): a reconnect tells the caller, a first open does not.
  it('reports a reconnect so the caller can refetch what failed', () => {
    const { callbacks } = makeCallbacks();
    const reconnected = vi.fn();
    callbacks.onReconnected = reconnected;
    const stream = createSyncStream((url) => new FakeEventSource(url), callbacks);
    const first = FakeEventSource.instances[0]!;
    first.onopen?.(null);
    expect(reconnected).not.toHaveBeenCalled();
    first.onerror?.(null);
    vi.advanceTimersByTime(30_000);
    FakeEventSource.instances.at(-1)!.onopen?.(null);
    expect(reconnected).toHaveBeenCalledTimes(1);
    stream.stop();
  });

  it('reconnects with backoff and resumes from Last-Event-ID', () => {
    const { calls, callbacks } = makeCallbacks();
    const stream = createSyncStream((url) => new FakeEventSource(url), callbacks, {
      url: '/api/v1/events',
    });
    const first = FakeEventSource.instances[0]!;
    first.onopen?.(null);
    first.emit('sync.progress', { repoId: 3, phase: 'history', pct: 5 }, 'evt-42');

    // connection drops
    first.onerror?.(null);
    expect(first.closed).toBe(true);
    expect(calls.connection).toContain('reconnecting');

    // backoff = 1000ms for the first retry
    vi.advanceTimersByTime(1000);
    const second = FakeEventSource.instances[1]!;
    expect(second).toBeDefined();
    expect(second.url).toBe('/api/v1/events?lastEventId=evt-42');
    stream.stop();
  });

  it('stop() closes the source and reports closed', () => {
    const { calls, callbacks } = makeCallbacks();
    const stream = createSyncStream((url) => new FakeEventSource(url), callbacks);
    const es = FakeEventSource.instances[0]!;
    stream.stop();
    expect(es.closed).toBe(true);
    expect(calls.connection.at(-1)).toBe('closed');
  });

  // R-A3 (W4-21). Backfill is recent-first, so the useful window fills long
  // before the year does — and nothing told anyone until this fired.
  describe('first-insight moment', () => {
    it('fires when 30-day coverage completes, and only once per repo', () => {
      const { calls, callbacks } = makeCallbacks();
      const stream = createSyncStream((url) => new FakeEventSource(url), callbacks);
      const es = FakeEventSource.instances[0]!;

      // percentComplete is (now − oldest)/365d, so 30 days ≈ 8.2%. Below that
      // the window is genuinely incomplete and the toast must NOT fire.
      es.emit('sync.progress', { repoId: 3, phase: 'history', pct: 5 });
      expect(calls.firstInsight).toEqual([]);

      es.emit('sync.progress', { repoId: 3, phase: 'history', pct: 12 });
      expect(calls.firstInsight).toEqual([3]);

      // Progress keeps arriving as the rest of the year backfills. A toast per
      // event would be noise, not a moment.
      es.emit('sync.progress', { repoId: 3, phase: 'history', pct: 40 });
      es.emit('sync.progress', { repoId: 3, phase: 'history', pct: 99 });
      expect(calls.firstInsight).toEqual([3]);

      stream.stop();
    });

    it('tracks repos independently', () => {
      const { calls, callbacks } = makeCallbacks();
      const stream = createSyncStream((url) => new FakeEventSource(url), callbacks);
      const es = FakeEventSource.instances[0]!;
      es.emit('sync.progress', { repoId: 1, phase: 'history', pct: 50 });
      es.emit('sync.progress', { repoId: 2, phase: 'history', pct: 50 });
      expect(calls.firstInsight).toEqual([1, 2]);
      stream.stop();
    });

    // THE CASE A PCT THRESHOLD ALONE GETS WRONG, and not as an edge case: a repo
    // whose entire history is three days old has coverage of 3/365 ≈ 1% and
    // would never cross 8.2% — while every day it has ever had is already
    // ingested. Coverage measures how far BACK we reached, not what is missing.
    // Caught by the e2e against the fake forge, whose fixture commits are days
    // old, before this clause existed.
    it('fires for a young repo whose whole history is in, however low the pct', () => {
      const { calls, callbacks } = makeCallbacks();
      const stream = createSyncStream((url) => new FakeEventSource(url), callbacks);
      const es = FakeEventSource.instances[0]!;

      es.emit('sync.progress', { repoId: 5, phase: 'history', pct: 1 });
      expect(calls.firstInsight, 'still backfilling — nothing is proven yet').toEqual([]);

      // Every entity cursor done: there is nothing older to fetch.
      es.emit('sync.progress', { repoId: 5, phase: 'enrichment', pct: 1 });
      expect(calls.firstInsight).toEqual([5]);

      stream.stop();
    });

    it('a repo that jumps straight past the threshold still gets exactly one', () => {
      // A small repo can reach full coverage in its first page, so the very
      // first progress event may already be over the line.
      const { calls, callbacks } = makeCallbacks();
      const stream = createSyncStream((url) => new FakeEventSource(url), callbacks);
      FakeEventSource.instances[0]!.emit('sync.progress', { repoId: 9, phase: 'live', pct: 100 });
      expect(calls.firstInsight).toEqual([9]);
      stream.stop();
    });
  });
});

// W20-04 (UX_TODO INS-11): sync events refreshed every key EXCEPT the one that
// reports sync status, so Settings → Sync sat still while the chip moved.
describe('isDirtyQuery', () => {
  it('refreshes /sync/status on any sync news', () => {
    expect(isDirtyQuery(['/sync/status', {}, {}], { repoIds: [3], org: false })).toBe(true);
    expect(isDirtyQuery(['/sync/status', {}, {}], { repoIds: [], org: true })).toBe(true);
    expect(isDirtyQuery(['/sync/status', {}, {}], { repoIds: [], org: false })).toBe(false);
  });

  it('keeps the existing org and per-repo targeting', () => {
    expect(isDirtyQuery(['/org/summary', {}, {}], { repoIds: [], org: true })).toBe(true);
    expect(isDirtyQuery(['/repos/{id}', { id: 3 }, {}], { repoIds: [3], org: false })).toBe(true);
    expect(isDirtyQuery(['/repos/{id}', { id: 4 }, {}], { repoIds: [3], org: false })).toBe(false);
    expect(isDirtyQuery(['/admin/members', {}, {}], { repoIds: [3], org: true })).toBe(false);
  });
});
