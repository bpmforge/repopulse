import type { FastifyInstance } from 'fastify';
import { appVersion } from '../../lib/release.js';

// GET /api/v1/about (W20-23, UX_TODO X-11; W20_DECISIONS_2 row 8). The About
// page every signed-in user can open: which release is installed. The
// release's published accuracy numbers are a checked-in file the web bundle
// carries (apps/web/src/about/release-accuracy.json), so they always describe
// the build being looked at and need no request.
//
// The version was only on /admin/system, which members cannot read. This
// route says the same thing and nothing else: no workspace data, so there is
// no tenancy filter to apply, and it sits behind the api-v1 session guard
// like every other /api/v1 route, so a signed-out visitor gets 401.

export interface AboutResponse {
  /** REPOPULSE_VERSION (the image tag an install runs), else the package version. */
  version: string;
}

export interface AboutRoutesOptions {
  /** Injected by tests; defaults to the process environment. */
  env?: Record<string, string | undefined>;
}

export default async function aboutRoutes(
  app: FastifyInstance,
  opts: AboutRoutesOptions = {},
): Promise<void> {
  app.get('/about', async (): Promise<AboutResponse> => ({ version: appVersion(opts.env) }));
}
