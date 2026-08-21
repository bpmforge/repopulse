import { describe, expect, it } from 'vitest';
import { ALL_DIMENSIONS, DIMENSIONS_AWAITING_PRODUCER, awaitingProducer } from './contracts.js';

// Facets that cannot return anything (W9-14).
//
// The rule this pins: a dimension may be selectable with no producer — several
// are reserved on purpose — but it may never be selectable SILENTLY. An empty
// result with no explanation reads as "your code is clean here", which is the
// opposite of "nothing has looked".

describe('dimensions awaiting a producer', () => {
  it('every entry is a real facet — no stale keys', () => {
    // A typo here would be worse than useless: the label would never render and
    // the facet would go back to failing silently.
    for (const dimension of Object.keys(DIMENSIONS_AWAITING_PRODUCER)) {
      expect(ALL_DIMENSIONS as readonly string[]).toContain(dimension);
    }
  });

  it('names the three the audit found, and each says why', () => {
    expect(Object.keys(DIMENSIONS_AWAITING_PRODUCER).sort()).toEqual([
      'iac',
      'slop',
      'test_coverage',
    ]);
    for (const [dimension, reason] of Object.entries(DIMENSIONS_AWAITING_PRODUCER)) {
      // A reason that does not point at the ticket, spec or scanner responsible
      // is a shrug in a tooltip.
      expect(reason.length, dimension).toBeGreaterThan(20);
    }
  });

  it('does not mark dimensions that DO have producers', () => {
    // These are written by shipped scanners today; marking one would tell a
    // user their real findings cannot exist.
    for (const dimension of [
      'code_health',
      'security',
      'sast',
      'secrets',
      'dependency',
      'logging',
      'chain',
      'architecture',
      'test_gap',
      // W9-13 gave this one a producer. If a later refactor unwires the perf
      // scanner, this line is the one that should start failing.
      'performance',
    ]) {
      expect(awaitingProducer(dimension), dimension).toBe(false);
    }
  });
});
