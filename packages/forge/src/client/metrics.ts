import type { EndpointFamily, Lane } from '../types.js';

// NFR-12 instrumentation. No metrics-exposition library is pinned yet
// (docs/TECH_STACK.md has no prom-client entry) - this is an in-memory
// registry a future ops ticket (E9.3 / GET /metrics, DEPLOYMENT.md §7) reads
// from and renders in Prometheus format; not exposed over HTTP by this package.
export interface ForgeMetricsSnapshot {
  requestsTotal: Record<string, number>; // key: `${family}|${lane}|${status}`
  forge304Total: number;
  pointsSpent: Record<'rest' | 'graphql', number>;
  budgetRemaining: number | null;
  queueDepth: Record<Lane, number>;
  requestSecondsSamples: number[]; // raw histogram samples
}

export class ForgeMetrics {
  private readonly requestsTotal = new Map<string, number>();
  private forge304Total = 0;
  private readonly pointsSpent: Record<'rest' | 'graphql', number> = { rest: 0, graphql: 0 };
  private readonly requestSeconds: number[] = [];

  recordRequest(family: EndpointFamily, lane: Lane, status: number): void {
    const key = `${family}|${lane}|${status}`;
    this.requestsTotal.set(key, (this.requestsTotal.get(key) ?? 0) + 1);
    if (status === 304) this.forge304Total++;
  }

  recordPoints(bucket: 'rest' | 'graphql', points: number): void {
    this.pointsSpent[bucket] += points;
  }

  recordRequestSeconds(seconds: number): void {
    this.requestSeconds.push(seconds);
  }

  snapshot(budgetRemaining: number | null, queueDepth: Record<Lane, number>): ForgeMetricsSnapshot {
    return {
      requestsTotal: Object.fromEntries(this.requestsTotal),
      forge304Total: this.forge304Total,
      pointsSpent: { ...this.pointsSpent },
      budgetRemaining,
      queueDepth,
      requestSecondsSamples: [...this.requestSeconds],
    };
  }
}
