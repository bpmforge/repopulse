import { Histogram } from 'prom-client';
import { metricsRegistry } from './registry.js';

// NFR-12 "HTTP p95 by route": Prometheus computes the percentile from these
// histogram buckets at query time (`histogram_quantile(0.95, ...)`) - the
// app only needs to expose the distribution, never compute a percentile
// itself. Labeled by route PATTERN (e.g. `/api/v1/repos/:id`, never the
// concrete path) to avoid unbounded label cardinality.
export const httpRequestDurationSeconds = new Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds, by method/route/status_code.',
  labelNames: ['method', 'route', 'status_code'],
  registers: [metricsRegistry],
});
