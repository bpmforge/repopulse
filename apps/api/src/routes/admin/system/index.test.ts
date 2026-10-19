import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SYSTEM_ACTIONS, worstState, type ComponentState } from './index.js';

// W17-07. The route's own integration coverage rides on the shared admin-route
// suite (RBAC, tenancy, response shape); what is tested directly here is the
// decision that is easy to get quietly wrong.
describe('overall state ranking (W17-07)', () => {
  it('an all-ready install is ready', () => {
    expect(worstState(['ready', 'ready', 'ready'])).toBe('ready');
  });

  it('a MISSING OPTIONAL MODEL does not make the install look broken', () => {
    // The whole reason setup_needed exists. An install with no AI provider is
    // fully working — Tier-1 metrics, hotspots and deterministic scanners all
    // run without one. Reporting that as unavailable teaches operators to
    // ignore red, and then they ignore the dead worker too.
    expect(worstState(['ready', 'ready', 'setup_needed'])).toBe('setup_needed');
  });

  it('a dead worker outranks anything merely unconfigured', () => {
    expect(worstState(['setup_needed', 'unavailable', 'ready'])).toBe('unavailable');
  });

  it('degraded outranks unknown, and unknown outranks setup_needed', () => {
    expect(worstState(['unknown', 'degraded'])).toBe('degraded');
    expect(worstState(['setup_needed', 'unknown'])).toBe('unknown');
  });

  it('unknown is never treated as fine', () => {
    // "We cannot tell" must not render as green. It ranks above ready so a
    // status badge cannot claim health it has not established.
    expect(worstState(['ready', 'unknown'])).toBe('unknown');
  });

  it('an empty component list is ready rather than throwing', () => {
    expect(worstState([])).toBe('ready');
  });

  it('ranks every state, so a new one cannot be silently ignored', () => {
    const all: ComponentState[] = ['ready', 'setup_needed', 'unknown', 'degraded', 'unavailable'];
    // Each state must beat every state before it in this order.
    for (let i = 1; i < all.length; i += 1) {
      expect(worstState([all[i - 1] as ComponentState, all[i] as ComponentState])).toBe(all[i]);
    }
  });
});

// W20-04 (UX_TODO ADM-03). The links shown when something is broken led to
// "Page not found": /admin/ops and /admin/connections were never routes. Held
// against the web app's generated route list, read as TEXT — the API must not
// import the web app (Law 6), but it can refuse to point into nothing.
describe('system health action links (W20-04)', () => {
  const routeTree = readFileSync(
    fileURLToPath(new URL('../../../../../web/src/routeTree.gen.ts', import.meta.url)),
    'utf8',
  );
  const block = /fullPaths:([\s\S]*?)fileRoutesByTo/.exec(routeTree)?.[1] ?? '';
  const routes = new Set([...block.matchAll(/'([^']+)'/g)].map((m) => m[1]));

  it('reads a real route list', () => {
    expect(routes.has('/admin/')).toBe(true);
  });

  it.each(Object.entries(SYSTEM_ACTIONS))('%s links to a route that exists', (_id, action) => {
    // TanStack lists index routes with their trailing slash and leaves are
    // bare; accept the href either way round.
    const href: string = action.href;
    const found = routes.has(href) || routes.has(`${href}/`) || routes.has(href.replace(/\/$/, ''));
    expect(found, `${href} is not a web route`).toBe(true);
  });
});
