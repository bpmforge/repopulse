import { Gauge } from 'prom-client';
import type { Queue } from 'bullmq';
import { metricsRegistry } from '@repopulse/shared';
import { QUEUE } from './topology.js';

// Worker/queue telemetry (NFR-12) on the shared W1-09 registry: queue depth
// (waiting+delayed), failed count, and DLQ depth. Registered once; the gauge's
// async collect() reads live BullMQ counts at scrape time.

let registered = false;
let queuesRef: Queue[] = [];

const queueDepth = new Gauge({
  name: 'repopulse_ingest_queue_depth',
  help: 'Waiting + delayed jobs per ingest queue',
  labelNames: ['queue'],
  registers: [],
  async collect() {
    for (const q of queuesRef) {
      const counts = await q.getJobCounts('waiting', 'delayed', 'active', 'failed');
      queueDepth.set({ queue: q.name }, (counts.waiting ?? 0) + (counts.delayed ?? 0));
      queueActive.set({ queue: q.name }, counts.active ?? 0);
      queueFailed.set({ queue: q.name }, counts.failed ?? 0);
    }
  },
});

const queueActive = new Gauge({
  name: 'repopulse_ingest_queue_active',
  help: 'Active (in-flight) jobs per ingest queue',
  labelNames: ['queue'],
  registers: [],
});

const queueFailed = new Gauge({
  name: 'repopulse_ingest_queue_failed',
  help: 'Failed jobs per ingest queue (pre-DLQ)',
  labelNames: ['queue'],
  registers: [],
});

const dlqDepth = new Gauge({
  name: 'repopulse_ingest_dlq_depth',
  help: 'Jobs parked in the dead-letter queue (NFR-11)',
  registers: [],
  async collect() {
    const dlq = queuesRef.find((q) => q.name === QUEUE.dlq);
    if (dlq) {
      const counts = await dlq.getJobCounts('waiting', 'active', 'delayed', 'completed', 'failed');
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      dlqDepth.set(total);
    }
  },
});

/**
 * Register the ingest queue gauges on the shared registry and point them at the
 * live queues. queueDepth carries the counts-fetching collect() and must be
 * registered first (same collect-ordering caveat as forge-metrics.ts).
 */
export function registerQueueMetrics(queues: Queue[]): void {
  queuesRef = queues;
  if (registered) return;
  registered = true;
  metricsRegistry.registerMetric(queueDepth);
  metricsRegistry.registerMetric(queueActive);
  metricsRegistry.registerMetric(queueFailed);
  metricsRegistry.registerMetric(dlqDepth);
}
