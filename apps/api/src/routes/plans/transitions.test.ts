import { describe, expect, it } from 'vitest';
import { HUMAN_TRANSITIONS, humanTransitionAllowed } from './index.js';

// W17-25. No human path to done, in any state, from any state — stated as a
// property over the table rather than one example, so adding a status later
// cannot quietly add a way round the verifier.

describe('human transitions (W17-25)', () => {
  it('lets no state reach done or regressed by hand', () => {
    for (const [from, allowed] of Object.entries(HUMAN_TRANSITIONS)) {
      expect(allowed, from).not.toContain('done');
      expect(allowed, from).not.toContain('regressed');
      expect(humanTransitionAllowed(from, 'done')).toBe(false);
      expect(humanTransitionAllowed(from, 'regressed')).toBe(false);
    }
  });

  it('still lets a person accept, start, dismiss and re-propose', () => {
    expect(humanTransitionAllowed('proposed', 'accepted')).toBe(true);
    expect(humanTransitionAllowed('accepted', 'in_progress')).toBe(true);
    expect(humanTransitionAllowed('regressed', 'in_progress')).toBe(true);
    expect(humanTransitionAllowed('done', 'dismissed')).toBe(true);
    expect(humanTransitionAllowed('dismissed', 'proposed')).toBe(true);
    // An unknown state has no transitions at all.
    expect(humanTransitionAllowed('bogus', 'accepted')).toBe(false);
  });
});
