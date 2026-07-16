import type { Lane } from '../types.js';

export interface PrimaryBudgetSnapshot {
  remaining: number | null;
  limit: number | null;
  resetAt: number | null;
}

export interface PrimaryBudgetOptions {
  /** FR-FORGE-3 configurable floor: below this, backfill/reconcile park. */
  floor: number;
}

export interface RateLimitHeaders {
  remaining?: number | undefined;
  limit?: number | undefined;
  /** epoch ms */
  resetAt?: number | undefined;
}

// One primary bucket per (connection, {rest|graphql}) - GraphQL is tracked as
// a fully separate primary bucket from REST (FORGE_PROVIDER.md §3d).
export class PrimaryBudget {
  private remaining: number | null = null;
  private limit: number | null = null;
  private resetAt: number | null = null;
  private readonly floor: number;

  constructor(opts: PrimaryBudgetOptions) {
    this.floor = opts.floor;
  }

  snapshot(): PrimaryBudgetSnapshot {
    return { remaining: this.remaining, limit: this.limit, resetAt: this.resetAt };
  }

  // FR-FORGE-3: "never guessed" - only a real x-ratelimit-* response moves
  // this. Before the first response, remaining stays null (unseeded).
  seedFromHeaders(headers: RateLimitHeaders): void {
    if (typeof headers.remaining === 'number') this.remaining = headers.remaining;
    if (typeof headers.limit === 'number') this.limit = headers.limit;
    if (typeof headers.resetAt === 'number') this.resetAt = headers.resetAt;
  }

  /** Optimistic local decrement between responses, so concurrent in-flight calls don't overrun. */
  reserve(cost: number): void {
    if (this.remaining !== null) this.remaining = Math.max(0, this.remaining - cost);
  }

  /** §3: below floor, backfill/reconcile park; webhook/user may drain the reserve down to zero. */
  admits(lane: Lane): boolean {
    if (this.remaining === null) return true; // unseeded: first call must go through to discover limits
    if (this.remaining > this.floor) return true;
    return (lane === 'webhook' || lane === 'user') && this.remaining > 0;
  }
}
