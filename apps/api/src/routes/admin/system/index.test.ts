import { describe, expect, it } from 'vitest';
import { worstState, type ComponentState } from './index.js';

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
