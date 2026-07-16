import { beforeEach, describe, expect, it } from 'vitest';
import { metricsRegistry } from './registry.js';
import {
  registerForgeMetrics,
  resetForgeMetricsForTest,
  type ForgeMetricsSnapshot,
} from './forge-metrics.js';

beforeEach(() => {
  resetForgeMetricsForTest();
});

function snapshot(overrides: Partial<ForgeMetricsSnapshot> = {}): ForgeMetricsSnapshot {
  return {
    requestsTotal: {},
    forge304Total: 0,
    pointsSpent: {},
    budgetRemaining: null,
    queueDepth: {},
    ...overrides,
  };
}

describe('registerForgeMetrics (FORGE_PROVIDER.md §3 instrumentation)', () => {
  it('exposes forge_requests_total/forge_304_total/forge_points_spent/forge_budget_remaining/forge_queue_depth', async () => {
    let snap = snapshot();
    registerForgeMetrics(() => [{ metricsSnapshot: () => snap }]);

    snap = snapshot({
      requestsTotal: { 'commits|user|200': 3 },
      forge304Total: 2,
      pointsSpent: { rest: 5 },
      budgetRemaining: 4987,
      queueDepth: { user: 1, backfill: 0 },
    });

    const output = await metricsRegistry.metrics();
    expect(output).toContain('forge_requests_total{family="commits",lane="user",status="200"} 3');
    expect(output).toContain('forge_304_total 2');
    expect(output).toContain('forge_points_spent{bucket="rest"} 5');
    expect(output).toContain('forge_budget_remaining 4987');
    expect(output).toContain('forge_queue_depth{lane="user"} 1');
  });

  it('aggregates across multiple active sources', async () => {
    const snapA = snapshot({ budgetRemaining: 100, queueDepth: { user: 1 } });
    const snapB = snapshot({ budgetRemaining: 200, queueDepth: { user: 2 } });
    registerForgeMetrics(() => [
      { metricsSnapshot: () => snapA },
      { metricsSnapshot: () => snapB },
    ]);

    const output = await metricsRegistry.metrics();
    expect(output).toContain('forge_budget_remaining 300');
    expect(output).toContain('forge_queue_depth{lane="user"} 3');
  });

  it('counters only increment by the delta between scrapes, never double-count', async () => {
    let snap = snapshot({ requestsTotal: { 'commits|user|200': 3 } });
    registerForgeMetrics(() => [{ metricsSnapshot: () => snap }]);

    await metricsRegistry.metrics(); // first scrape: +3
    snap = snapshot({ requestsTotal: { 'commits|user|200': 5 } });
    await metricsRegistry.metrics(); // second scrape: +2 more (delta), not +5

    const output = await metricsRegistry.metrics();
    expect(output).toContain('forge_requests_total{family="commits",lane="user",status="200"} 5');
  });
});
