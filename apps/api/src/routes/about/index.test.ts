import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import aboutRoutes, { type AboutResponse } from './index.js';

// W20-23 (UX_TODO X-11). The route itself; that it sits behind the session
// guard and answers a member is in routes/views/index.test.ts, which already
// has two signed-in users.
describe('GET /about (W20-23)', () => {
  it('names the release an install runs', async () => {
    const app = Fastify();
    await app.register(aboutRoutes, { env: { REPOPULSE_VERSION: ' 1.4.2 ' } });
    const res = await app.inject({ method: 'GET', url: '/about' });
    expect(res.statusCode).toBe(200);
    expect(res.json<AboutResponse>()).toEqual({ version: '1.4.2' });
    await app.close();
  });

  it('falls back to the package version from a source build', async () => {
    const app = Fastify();
    await app.register(aboutRoutes, { env: {} });
    const res = await app.inject({ method: 'GET', url: '/about' });
    expect(res.json<AboutResponse>().version).toMatch(/^\d+\.\d+\.\d+/);
    await app.close();
  });
});
