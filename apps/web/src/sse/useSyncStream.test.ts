import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createSyncStream,
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
  };
  const callbacks: SyncStreamCallbacks = {
    onConnection: (s) => calls.connection.push(s),
    onRepoProgress: (repoId, p) => calls.progress.push({ repoId, ...p }),
    onRepoDone: (repoId) => calls.done.push(repoId),
    onToasts: (t) => calls.toasts.push(t.map((x) => ({ message: x.message, tone: x.tone }))),
    invalidate: (d) => calls.invalidations.push(d),
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
});
