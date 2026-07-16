import type { FastifyInstance, InjectOptions } from 'fastify';

type InjectMethod = NonNullable<InjectOptions['method']>;

export interface DiscoveredRoute {
  method: string;
  url: string;
}

// HEAD is auto-added by Fastify for every GET route; OPTIONS likewise for
// CORS - neither is a distinct handler worth walking separately.
const SKIP_METHODS = new Set(['HEAD', 'OPTIONS']);

/**
 * Attach BEFORE `app.ready()` - Fastify's `onRoute` hook only fires while
 * queued plugins run during the avvio boot sequence, so routes registered
 * via `app.register(...)` before this call are still caught as long as
 * `app.ready()` hasn't executed yet (verified against Fastify 5.x: register()
 * only queues, onRoute fires when the boot sequence actually walks routes).
 */
export function trackRoutes(app: FastifyInstance): () => DiscoveredRoute[] {
  const routes: DiscoveredRoute[] = [];
  app.addHook('onRoute', (opts) => {
    const method = opts.method as string;
    if (SKIP_METHODS.has(method)) return;
    routes.push({ method, url: opts.url });
  });
  return () => routes;
}

export interface TenancyProbe {
  /** Cookies/headers that make a request authenticate as this tenant. */
  requestContext: { cookies?: Record<string, string>; headers?: Record<string, string> };
  /** A string unique to this tenant that must never appear in another tenant's responses. */
  marker: string;
}

export interface LeakageViolation {
  method: string;
  url: string;
  /** Index into the `probes` array of the tenant that made the request. */
  requestingProbeIndex: number;
  /** Index into the `probes` array of the tenant whose marker leaked. */
  leakedFromProbeIndex: number;
  leakedMarker: string;
}

export interface WalkOptions {
  /** Route prefixes exempt from tenancy scoping (API_DESIGN.md §1: /auth/*, /healthz, /api/v1/openapi.json). */
  exemptPrefixes?: string[];
  /** Only these HTTP methods are walked (default: GET only - side-effect-free to repeat per probe). */
  methods?: string[];
}

const DEFAULT_EXEMPT_PREFIXES = ['/auth', '/healthz', '/api/v1/openapi.json'];

function isExempt(url: string, exemptPrefixes: string[]): boolean {
  return exemptPrefixes.some((p) => url === p || url.startsWith(`${p}/`));
}

/**
 * FR-AUTH-3/NFR-4: walk every discovered route as each tenant probe and
 * assert no *other* tenant's marker ever appears in the response body.
 * Routes with path params are skipped - this walker proves the mechanism
 * against parameter-free routes; a parameterized route needs its own
 * per-route fixture data to synthesize a valid path, which is deferred
 * until real parameterized tenant-scoped routes exist (none do yet - see
 * W1-07 plan.json notes).
 */
export async function walkForTenancyLeakage(
  app: FastifyInstance,
  routes: DiscoveredRoute[],
  probes: readonly TenancyProbe[],
  opts: WalkOptions = {},
): Promise<LeakageViolation[]> {
  const exemptPrefixes = opts.exemptPrefixes ?? DEFAULT_EXEMPT_PREFIXES;
  const methods = new Set(opts.methods ?? ['GET']);
  const violations: LeakageViolation[] = [];

  const testable = routes.filter(
    (r) => methods.has(r.method) && !r.url.includes(':') && !isExempt(r.url, exemptPrefixes),
  );

  for (const route of testable) {
    for (let i = 0; i < probes.length; i++) {
      const probe = probes[i];
      if (!probe) continue;
      const injectOpts: InjectOptions = {
        method: route.method as InjectMethod,
        url: route.url,
        ...(probe.requestContext.cookies ? { cookies: probe.requestContext.cookies } : {}),
        ...(probe.requestContext.headers ? { headers: probe.requestContext.headers } : {}),
      };
      const res = await app.inject(injectOpts);
      for (let j = 0; j < probes.length; j++) {
        if (j === i) continue;
        const other = probes[j];
        if (other && res.body.includes(other.marker)) {
          violations.push({
            method: route.method,
            url: route.url,
            requestingProbeIndex: i,
            leakedFromProbeIndex: j,
            leakedMarker: other.marker,
          });
        }
      }
    }
  }

  return violations;
}
