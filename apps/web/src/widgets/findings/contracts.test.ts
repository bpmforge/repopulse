import { describe, expect, it } from 'vitest';
import { reviewSummary, type Finding } from './contracts.js';

describe('reviewSummary (W17-23)', () => {
  const base: Finding = {
    id: 9,
    repo: { id: 1, org: 'acme', name: 'payments' },
    dimension: 'test_gap',
    severity: 3,
    confidence: 2,
    title: 'No tests for refunds',
    file: null,
    line_range: [null, null],
    evidence: 'src/refunds.ts has no matching *.test.ts',
    recommendation: 'Add a test.',
    status: 'wont_fix',
    dismiss_reason: null,
    occurrence_count: 2,
    verify_status: 'unverified',
    first_seen_at: '2026-08-01T00:00:00.000Z',
    last_seen_at: '2026-08-01T00:00:00.000Z',
    tier: 2,
    forge: null,
  };

  it('reads as plain text with the location and status in words', () => {
    const text = reviewSummary(base);
    expect(text.split('\n')[0]).toBe('Finding #9: No tests for refunds');
    expect(text).toContain('Location: whole repository');
    expect(text).toContain('Severity: medium · confidence 2/5 · test gap');
    expect(text).toContain('Status: wont fix');
    expect(text).toContain('Verification: not independently verified');
    // No link line when there is nothing honest to link to.
    expect(text).not.toContain('Link:');
    expect(text).not.toContain('History:');
  });

  it('carries the dismiss reason and the history with who and why', () => {
    const text = reviewSummary({ ...base, status: 'dismissed', dismiss_reason: 'false_positive' }, [
      {
        from_status: null,
        to_status: 'open',
        actor: null,
        actor_login: null,
        automatic: true,
        reason: null,
        at: '2026-08-01T00:00:00.000Z',
      },
      {
        from_status: 'open',
        to_status: 'dismissed',
        actor: null,
        actor_login: 'departed-dev',
        automatic: false,
        reason: 'false_positive: fixture',
        at: '2026-08-03T00:00:00.000Z',
      },
    ]);
    expect(text).toContain('Status: dismissed (false positive)');
    expect(text).toContain('- 2026-08-01 new → open (automatic)');
    expect(text).toContain('- 2026-08-03 open → dismissed (departed-dev: false_positive: fixture)');
  });
});
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

  it('names the ones still without a producer, and each says why', () => {
    // `slop` left this list in W9-16, when anti_slop started emitting it.
    expect(Object.keys(DIMENSIONS_AWAITING_PRODUCER).sort()).toEqual(['iac', 'test_coverage']);
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
      // W9-16 gave this one a producer: anti_slop emits it.
      'slop',
      // W9-13 gave this one a producer. If a later refactor unwires the perf
      // scanner, this line is the one that should start failing.
      'performance',
    ]) {
      expect(awaitingProducer(dimension), dimension).toBe(false);
    }
  });
});
