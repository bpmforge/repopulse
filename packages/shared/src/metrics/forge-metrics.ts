import { Counter, Gauge } from 'prom-client';
import { metricsRegistry } from './registry.js';

// Structural mirror of packages/forge's BudgetedClient.metricsSnapshot()
// (packages/forge/src/client/metrics.ts) - duck-typed rather than imported,
// since packages/shared may not depend on packages/forge (ARCHITECTURE.md
// §3 dependency matrix runs the other way). Any object shaped like this
// works, so a test can supply a plain fixture with no forge dependency.
export interface ForgeMetricsSnapshot {
  requestsTotal: Record<string, number>; // key: `${family}|${lane}|${status}`
  forge304Total: number;
  pointsSpent: Record<string, number>; // key: 'rest' | 'graphql'
  budgetRemaining: number | null;
  queueDepth: Record<string, number>; // key: lane
}

export interface ForgeMetricsSource {
  metricsSnapshot(): ForgeMetricsSnapshot;
}

let sourcesGetter: () => ForgeMetricsSource[] = () => [];
let lastRequestsTotal = new Map<string, number>();
let last304Total = 0;
let lastPointsSpent = new Map<string, number>();
let registered = false;

// FORGE_PROVIDER.md §3 instrumentation names, exactly. Registered once per
// process. Counters/gauges are updated from `collect()` (attached to the
// gauge below), which runs immediately before every scrape and pulls the
// latest totals across every currently-active client, so this works
// whether there are zero, one, or many BudgetedClient instances (one per
// forge connection, W1-05's design) without re-registering per connection.
// `registers: []` on every metric here - without it, prom-client silently
// auto-registers onto its own implicit default global registry too
// (verified empirically), which this module must never touch; every metric
// is explicitly attached to our own `metricsRegistry` in
// `registerForgeMetrics()` instead.
const forgeRequestsTotal = new Counter({
  name: 'forge_requests_total',
  help: 'Forge HTTP requests by endpoint family, lane, and response status.',
  labelNames: ['family', 'lane', 'status'],
  registers: [],
});
const forge304TotalMetric = new Counter({
  name: 'forge_304_total',
  help: 'Forge responses served from the ETag cache at zero primary charge.',
  registers: [],
});
const forgePointsSpent = new Counter({
  name: 'forge_points_spent',
  help: 'Forge rate-limit points spent, by bucket (rest/graphql).',
  labelNames: ['bucket'],
  registers: [],
});
const forgeQueueDepth = new Gauge({
  name: 'forge_queue_depth',
  help: 'Forge concurrency-queue depth by lane, summed across active connections.',
  labelNames: ['lane'],
  registers: [],
});
// Counters only ever go up; prom-client has no "set absolute value" for a
// Counter, so `collect()` increments each by the delta since the last scrape.
const forgeBudgetRemaining = new Gauge({
  name: 'forge_budget_remaining',
  help: 'Forge primary rate-limit budget remaining, summed across active connections.',
  registers: [],
  collect(): void {
    const snapshots = sourcesGetter().map((s) => s.metricsSnapshot());

    const requestsTotal = new Map<string, number>();
    let total304 = 0;
    const pointsSpent = new Map<string, number>();
    let budgetRemainingSum: number | null = null;
    const queueDepth = new Map<string, number>();

    for (const snap of snapshots) {
      for (const [key, count] of Object.entries(snap.requestsTotal)) {
        requestsTotal.set(key, (requestsTotal.get(key) ?? 0) + count);
      }
      total304 += snap.forge304Total;
      for (const [bucket, points] of Object.entries(snap.pointsSpent)) {
        pointsSpent.set(bucket, (pointsSpent.get(bucket) ?? 0) + points);
      }
      if (snap.budgetRemaining !== null) {
        budgetRemainingSum = (budgetRemainingSum ?? 0) + snap.budgetRemaining;
      }
      for (const [lane, depth] of Object.entries(snap.queueDepth)) {
        queueDepth.set(lane, (queueDepth.get(lane) ?? 0) + depth);
      }
    }

    for (const [key, total] of requestsTotal) {
      const delta = total - (lastRequestsTotal.get(key) ?? 0);
      if (delta > 0) {
        const [family, lane, status] = key.split('|') as [string, string, string];
        forgeRequestsTotal.inc({ family, lane, status }, delta);
      }
    }
    lastRequestsTotal = requestsTotal;

    const delta304 = total304 - last304Total;
    if (delta304 > 0) forge304TotalMetric.inc(delta304);
    last304Total = total304;

    for (const [bucket, total] of pointsSpent) {
      const delta = total - (lastPointsSpent.get(bucket) ?? 0);
      if (delta > 0) forgePointsSpent.inc({ bucket }, delta);
    }
    lastPointsSpent = pointsSpent;

    this.set(budgetRemainingSum ?? 0);
    for (const [lane, depth] of queueDepth) {
      forgeQueueDepth.set({ lane }, depth);
    }
  },
});

/**
 * Registers the forge metrics once per process and points them at
 * `getSources()` - call this with a getter that returns the current list of
 * active BudgetedClient instances (e.g. W1-06's connection pool); safe to
 * call multiple times, only the latest getter is used.
 */
export function registerForgeMetrics(getSources: () => ForgeMetricsSource[]): void {
  sourcesGetter = getSources;
  if (registered) return;
  registered = true;
  // forgeBudgetRemaining carries the only `collect()` hook (it updates all
  // five metrics as a side effect) and MUST be registered first: verified
  // empirically that Registry.metrics() serializes each metric in
  // registration order, calling only ITS OWN collect() first - a metric
  // registered before the one with collect() gets serialized from stale
  // data, since the side-effecting collect() hasn't run yet.
  metricsRegistry.registerMetric(forgeBudgetRemaining);
  metricsRegistry.registerMetric(forgeRequestsTotal);
  metricsRegistry.registerMetric(forge304TotalMetric);
  metricsRegistry.registerMetric(forgePointsSpent);
  metricsRegistry.registerMetric(forgeQueueDepth);
}

/** Test-only: undoes registerForgeMetrics() and zeroes the delta-tracking state. */
export function resetForgeMetricsForTest(): void {
  sourcesGetter = () => [];
  lastRequestsTotal = new Map();
  last304Total = 0;
  lastPointsSpent = new Map();
  registered = false;
  forgeRequestsTotal.reset();
  forge304TotalMetric.reset();
  forgePointsSpent.reset();
  forgeBudgetRemaining.reset();
  forgeQueueDepth.reset();
}
