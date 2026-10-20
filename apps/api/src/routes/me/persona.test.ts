import { describe, expect, it } from 'vitest';
import { PERSONAS, PERSONA_HOME, type Persona } from './index.js';

// W4-10. The persona → home mapping is a product decision (UX_SPEC §6), and it
// lives on the API so the browser cannot carry a second copy that drifts. These
// pin the mapping itself; the round trip through the route is covered by
// e2e/journey.spec.ts against a genuinely null column.

describe('persona homes (UX_SPEC §6, D9/R-A2)', () => {
  it('routes each persona to the home §6 names', () => {
    expect(PERSONA_HOME.lead).toBe('/'); // P1 → Org Overview
    expect(PERSONA_HOME.developer).toBe('/me'); // P2 → My Focus
    expect(PERSONA_HOME.security).toBe('/findings'); // P3 → Findings Explorer
    expect(PERSONA_HOME.exec).toBe('/reports'); // P4 → Exec rollup
    // W20-17 (UX_TODO INS-16): the person running the install. A landing
    // preference, not a permission: the picker offers it to admins only, and
    // a member who sets it anyway meets the ask-an-admin page.
    expect(PERSONA_HOME.admin).toBe('/admin/setup');
  });

  it('every persona has a home — a picker option with nowhere to go is a dead end', () => {
    for (const persona of PERSONAS) {
      expect(PERSONA_HOME[persona], `no home for ${persona}`).toBeTruthy();
    }
    expect(Object.keys(PERSONA_HOME).sort()).toEqual([...PERSONAS].sort());
  });

  it('the set is closed — an unknown persona is not routable', () => {
    expect([...PERSONAS].sort()).toEqual(['admin', 'developer', 'exec', 'lead', 'security']);
    // admin/member is an AUTHORIZATION role and says nothing about which screen
    // someone wants to land on: a security reviewer and a tech lead are both
    // "member". That gap is why §6's routing needed its own column.
    expect(PERSONAS).not.toContain('member' as Persona);
  });
});
