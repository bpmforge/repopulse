import type { Lane } from '../types.js';

const LANES_BY_PRIORITY: Lane[] = ['webhook', 'user', 'backfill', 'reconcile'];

// Global concurrency semaphore (<=100, FORGE_PROVIDER.md §3c) with lane
// priority ordering for whichever pending call gets the next free slot.
export class ConcurrencyQueue {
  private inFlight = 0;
  private readonly queues: Record<Lane, Array<() => void>> = {
    webhook: [],
    user: [],
    backfill: [],
    reconcile: [],
  };

  constructor(private readonly maxConcurrent: number) {}

  async acquire(lane: Lane): Promise<() => void> {
    if (this.inFlight < this.maxConcurrent) {
      this.inFlight++;
      return () => this.release();
    }
    return new Promise((resolve) => {
      this.queues[lane].push(() => {
        this.inFlight++;
        resolve(() => this.release());
      });
    });
  }

  private release(): void {
    this.inFlight--;
    for (const lane of LANES_BY_PRIORITY) {
      const next = this.queues[lane].shift();
      if (next) {
        next();
        return;
      }
    }
  }

  get queueDepth(): Record<Lane, number> {
    return {
      webhook: this.queues.webhook.length,
      user: this.queues.user.length,
      backfill: this.queues.backfill.length,
      reconcile: this.queues.reconcile.length,
    };
  }
}
