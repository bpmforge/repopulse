import { describe, expect, it } from 'vitest';
import { metricsRegistry } from './registry.js';
import { httpRequestDurationSeconds } from './http-metrics.js';

describe('httpRequestDurationSeconds (NFR-12 HTTP p95 by route)', () => {
  it('is registered on the shared registry and records labeled observations', async () => {
    httpRequestDurationSeconds.observe(
      { method: 'GET', route: '/api/v1/repos/:id', status_code: '200' },
      0.123,
    );
    const output = await metricsRegistry.metrics();
    expect(output).toContain('http_request_duration_seconds_bucket');
    expect(output).toContain('method="GET"');
    expect(output).toContain('route="/api/v1/repos/:id"');
    expect(output).toContain('status_code="200"');
  });
});
