// Generic continuous-refill token bucket for secondary per-endpoint-family
// limits (FORGE_PROVIDER.md §3b): <=900 pts/min REST family, 2,000/min GraphQL.
export class RateBucket {
  private tokens: number;
  private lastRefillAt: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerMinute: number,
    now: number = Date.now(),
  ) {
    this.tokens = capacity;
    this.lastRefillAt = now;
  }

  private refill(now: number): void {
    const elapsedMs = now - this.lastRefillAt;
    if (elapsedMs <= 0) return;
    const refillPerMs = this.refillPerMinute / 60_000;
    this.tokens = Math.min(this.capacity, this.tokens + elapsedMs * refillPerMs);
    this.lastRefillAt = now;
  }

  tryConsume(cost: number, now: number = Date.now()): boolean {
    this.refill(now);
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  peek(now: number = Date.now()): number {
    this.refill(now);
    return this.tokens;
  }
}
