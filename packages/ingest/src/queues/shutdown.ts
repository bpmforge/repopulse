// Graceful shutdown (INGESTION §6, FR-INGEST-3): SIGTERM stops intake first,
// then drains in-flight page transactions ≤30s; anything longer is abandoned
// and resumes from its cursor on restart. Workers close before queues/redis so
// no active job is cut mid-transaction.

export interface Closeable {
  close(force?: boolean): Promise<void>;
}

export interface ShutdownOptions {
  /** Max drain time before forcing (INGESTION §6: ≤30s). */
  timeoutMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  onTimeout?: () => void;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export class ShutdownCoordinator {
  private readonly workers: Closeable[] = [];
  private readonly queues: Closeable[] = [];
  private shuttingDown = false;

  /** Workers are closed first (stop intake + drain active jobs). */
  registerWorker(w: Closeable): void {
    this.workers.push(w);
  }

  /** Queues/connections are closed after workers have drained. */
  registerQueue(q: Closeable): void {
    this.queues.push(q);
  }

  get isShuttingDown(): boolean {
    return this.shuttingDown;
  }

  /**
   * Drain workers within the timeout, then close queues. Returns true if all
   * workers drained gracefully, false if the timeout forced a hard close
   * (jobs left active resume from cursor).
   */
  async shutdown(opts: ShutdownOptions = {}): Promise<boolean> {
    if (this.shuttingDown) return true;
    this.shuttingDown = true;
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), timeoutMs);
    });

    // Stop intake + drain active jobs (worker.close() waits for in-flight).
    const drained = await Promise.race([
      Promise.all(this.workers.map((w) => w.close())).then(() => 'drained' as const),
      timeout,
    ]);
    if (timer) clearTimeout(timer);

    const graceful = drained === 'drained';
    if (!graceful) {
      opts.onTimeout?.();
      // Force-close whatever is still active — it resumes from cursor.
      await Promise.all(this.workers.map((w) => w.close(true).catch(() => {})));
    }

    await Promise.all(this.queues.map((q) => q.close().catch(() => {})));
    return graceful;
  }

  /** Wire SIGTERM/SIGINT to a one-shot shutdown. */
  installSignalHandlers(opts: ShutdownOptions = {}): void {
    const handler = (): void => {
      void this.shutdown(opts);
    };
    process.once('SIGTERM', handler);
    process.once('SIGINT', handler);
  }
}
