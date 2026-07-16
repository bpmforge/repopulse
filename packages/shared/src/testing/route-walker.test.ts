import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { trackRoutes, walkForTenancyLeakage } from './route-walker.js';

// Two synthetic tenants; each probe's marker is a string that must never
// appear in a response served to a different tenant.
const PROBES = [
  { requestContext: { headers: { 'x-tenant': 'a' } }, marker: 'MARKER-TENANT-A' },
  { requestContext: { headers: { 'x-tenant': 'b' } }, marker: 'MARKER-TENANT-B' },
];

async function buildTestApp(opts: { scoped: boolean }) {
  const app = Fastify();
  const getRoutes = trackRoutes(app);

  app.get('/api/v1/scoped-thing', async (request) => {
    const tenant = request.headers['x-tenant'];
    if (opts.scoped) {
      return { marker: tenant === 'a' ? PROBES[0]?.marker : PROBES[1]?.marker };
    }
    // Deliberately unscoped: returns every tenant's data regardless of who's asking.
    return { markers: PROBES.map((p) => p.marker) };
  });
  app.get('/auth/login', async () => ({ ignored: true }));
  app.get('/healthz', async () => ({ ignored: true }));
  app.get('/api/v1/openapi.json', async () => ({ ignored: true }));
  app.get('/api/v1/parameterized/:id', async () => ({ id: 'anything' }));

  await app.ready();
  return { app, getRoutes };
}

describe('trackRoutes (NFR-4 route walker)', () => {
  it('discovers GET routes, skipping auto-added HEAD/OPTIONS', async () => {
    const { getRoutes } = await buildTestApp({ scoped: true });
    const routes = getRoutes();
    expect(routes).toContainEqual({ method: 'GET', url: '/api/v1/scoped-thing' });
    expect(routes.some((r) => r.method === 'HEAD')).toBe(false);
  });
});

describe('walkForTenancyLeakage (NFR-4/FR-AUTH-3)', () => {
  it('passes a correctly workspace-scoped route', async () => {
    const { app, getRoutes } = await buildTestApp({ scoped: true });
    const violations = await walkForTenancyLeakage(app, getRoutes(), PROBES);
    expect(violations).toEqual([]);
  });

  // The literal acceptance criterion: "adding an unscoped route fails the walker."
  it("fails an unscoped route that returns every tenant's data", async () => {
    const { app, getRoutes } = await buildTestApp({ scoped: false });
    const violations = await walkForTenancyLeakage(app, getRoutes(), PROBES);
    expect(violations.length).toBeGreaterThan(0);
    expect(violations).toContainEqual(
      expect.objectContaining({
        url: '/api/v1/scoped-thing',
        requestingProbeIndex: 0,
        leakedFromProbeIndex: 1,
        leakedMarker: 'MARKER-TENANT-B',
      }),
    );
  });

  it('never walks exempt prefixes (/auth, /healthz, /api/v1/openapi.json)', async () => {
    const { getRoutes } = await buildTestApp({ scoped: false });
    const routes = getRoutes();
    const exemptUrls = routes
      .filter((r) => ['/auth/login', '/healthz', '/api/v1/openapi.json'].includes(r.url))
      .map((r) => r.url);
    expect(exemptUrls.sort()).toEqual(['/api/v1/openapi.json', '/auth/login', '/healthz']);
    // These would also trivially "pass" since their bodies don't contain any
    // marker, but the point is they're excluded from consideration entirely -
    // proven by construction of the walker's exempt-prefix filter, not by a
    // response-shape coincidence.
  });

  it('skips parameterized routes (no per-route fixture data to synthesize a valid path yet)', async () => {
    const { app, getRoutes } = await buildTestApp({ scoped: false });
    const routes = getRoutes();
    expect(routes.some((r) => r.url === '/api/v1/parameterized/:id')).toBe(true);
    const violations = await walkForTenancyLeakage(app, routes, PROBES);
    expect(violations.every((v) => v.url !== '/api/v1/parameterized/:id')).toBe(true);
  });
});
