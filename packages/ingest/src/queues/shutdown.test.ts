import { describe, expect, it, vi } from 'vitest';
import { ShutdownCoordinator, type Closeable } from './shutdown.js';

function fakeCloseable(closeMs: number): Closeable & { closed: boolean; forced: boolean } {
  const state = { closed: false, forced: false };
  return {
    ...state,
    close(force?: boolean) {
      if (force) this.forced = true;
      return new Promise<void>((resolve) =>
        setTimeout(() => {
          this.closed = true;
          resolve();
        }, closeMs),
      );
    },
  } as Closeable & { closed: boolean; forced: boolean };
}

describe('ShutdownCoordinator (INGESTION §6, FR-INGEST-3)', () => {
  it('drains workers gracefully then closes queues when within the timeout', async () => {
    vi.useFakeTimers();
    const coord = new ShutdownCoordinator();
    const worker = fakeCloseable(100);
    const queue = fakeCloseable(10);
    coord.registerWorker(worker);
    coord.registerQueue(queue);

    const p = coord.shutdown({ timeoutMs: 30_000 });
    await vi.advanceTimersByTimeAsync(200);
    const graceful = await p;

    expect(graceful).toBe(true);
    expect(worker.closed).toBe(true);
    expect(worker.forced).toBe(false);
    expect(queue.closed).toBe(true);
    vi.useRealTimers();
  });

  it('force-closes workers that exceed the drain timeout (they resume from cursor)', async () => {
    vi.useFakeTimers();
    const coord = new ShutdownCoordinator();
    const slowWorker = fakeCloseable(60_000); // longer than the 30s timeout
    const onTimeout = vi.fn();
    coord.registerWorker(slowWorker);

    const p = coord.shutdown({ timeoutMs: 30_000, onTimeout });
    await vi.advanceTimersByTimeAsync(30_000);
    // let the forced close() (also 60s here) settle
    await vi.advanceTimersByTimeAsync(60_000);
    const graceful = await p;

    expect(graceful).toBe(false);
    expect(onTimeout).toHaveBeenCalledOnce();
    expect(slowWorker.forced).toBe(true);
    vi.useRealTimers();
  });

  it('is idempotent — a second shutdown() is a no-op', async () => {
    const coord = new ShutdownCoordinator();
    coord.registerWorker(fakeCloseable(0));
    expect(await coord.shutdown()).toBe(true);
    expect(coord.isShuttingDown).toBe(true);
    expect(await coord.shutdown()).toBe(true);
  });
});
