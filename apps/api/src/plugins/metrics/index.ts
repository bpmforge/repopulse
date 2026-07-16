import fp from 'fastify-plugin';
import type { FastifyInstance } from 'fastify';
import {
  httpRequestDurationSeconds,
  metricsRegistry,
  registerForgeMetrics,
} from '@repopulse/shared';

// NFR-12: GET /metrics in Prometheus format, backed by the shared registry
// (packages/shared/src/metrics) so later waves (queue depth/DLQ - W2-02,
// sync lag - ingest, Tier-2 host availability - packages/analysis) register
// their own counters/gauges/histograms without touching this file.
//
// DEPLOYMENT.md §7: this endpoint is meant for an internal vhost only,
// never the public webhook vhost - that separation is reverse-proxy
// config (not yet built, a deploy-wave concern), not something this app
// can enforce on its own; left unauthenticated here the same way /healthz
// is, since network topology is the actual boundary.
async function metricsPlugin(app: FastifyInstance): Promise<void> {
  // No BudgetedClient exists in this process yet (W1-06/the first real
  // forge connection is still blocked on W0-05) - registers the forge_*
  // metric names now, at zero/empty values, so they're present in /metrics
  // output from day one (acceptance: "the §3 metric names are present").
  // Whichever ticket constructs the first real BudgetedClient calls
  // registerForgeMetrics() again with the real connection-pool getter -
  // safe to call repeatedly, only the latest getter is used.
  registerForgeMetrics(() => []);

  // Route pattern (e.g. `/api/v1/repos/:id`), never the concrete path, to
  // avoid unbounded label cardinality (verified: request.routeOptions.url
  // is the pattern, not the resolved path - Fastify 5.x).
  app.addHook('onResponse', async (request, reply) => {
    httpRequestDurationSeconds.observe(
      {
        method: request.method,
        route: request.routeOptions?.url ?? 'unknown',
        status_code: String(reply.statusCode),
      },
      reply.elapsedTime / 1000,
    );
  });

  app.get('/metrics', async (_request, reply) => {
    reply.header('content-type', metricsRegistry.contentType);
    return metricsRegistry.metrics();
  });
}

export default fp(metricsPlugin, { name: '@repopulse/api-metrics' });
