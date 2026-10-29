import { describe, expect, it } from 'vitest';
import {
  ageOf,
  dimensionLabel,
  findingUrl,
  foundByText,
  reviewSummary,
  statusLabel,
  verifiedByText,
  verifyLabelOf,
  VERIFY_LABEL,
  VERIFY_LABEL_NEGLIGIBLE,
  type Finding,
} from './contracts.js';

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
    expect(text).toContain('Severity: medium · confidence 2/5 · Test gap');
    expect(text).toContain("Status: Won't fix");
    expect(text).toContain('Verification: not independently verified');
    // No link line when there is nothing honest to link to.
    expect(text).not.toContain('Link:');
    expect(text).not.toContain('History:');
  });

  it('W22-03: a real hit on a small input is still confirmed, worded as small', () => {
    const small = {
      ...base,
      verify_status: 'confirmed' as const,
      verified_by: {
        model: 'm',
        connection: null,
        verdict: 'real',
        at: null,
        impact: 'negligible',
      },
    };
    expect(reviewSummary(small)).toContain(
      'Verification: confirmed on AI review: real, but small input',
    );
    expect(verifyLabelOf(small)).toBe(VERIFY_LABEL_NEGLIGIBLE);
    expect(
      verifyLabelOf({ ...small, verified_by: { ...small.verified_by, impact: 'material' } }),
    ).toBe(VERIFY_LABEL.confirmed);
    expect(verifyLabelOf(base)).toBe(VERIFY_LABEL.unverified);
    expect(verifiedByText(small.verified_by)).toBe('verified by m: judged real, but small input');
    expect(verifiedByText({ ...small.verified_by, impact: 'material' })).toBe(
      'verified by m: judged real',
    );
    // W22-03: the quick first look (a smaller model) is named as such.
    expect(
      verifiedByText({
        model: 'small',
        connection: 'LM Studio',
        verdict: 'likely_false_positive',
        at: null,
        pass: 'fast',
      }),
    ).toBe('verified by small (LM Studio): judged a likely false positive on a quick first look');
    expect(
      verifiedByText({ model: 'm', connection: null, verdict: 'real', at: null, pass: 'full' }),
    ).toBe('verified by m: judged real');
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
    expect(text).toContain('Status: Dismissed (False positive)');
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
    expect(Object.keys(DIMENSIONS_AWAITING_PRODUCER).sort()).toEqual(['test_coverage']);
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

describe('labels (W20-13, FND-26 / FND-19)', () => {
  it('says statuses and dimensions as words, every underscore included', () => {
    expect(statusLabel('wont_fix')).toBe("Won't fix");
    expect(dimensionLabel('dependency_health')).toBe('Dependency health');
    expect(dimensionLabel('brand_new_kind')).toBe('Brand new kind');
  });

  it('says age since first seen in the largest whole unit', () => {
    const now = Date.parse('2026-10-19T00:00:00Z');
    expect(ageOf('2026-10-18T00:00:00Z', now)).toBe('1d');
    expect(ageOf('2026-09-19T00:00:00Z', now)).toBe('4w');
    expect(ageOf('2026-01-19T00:00:00Z', now)).toBe('9mo');
  });
});

describe('findingUrl (W20-15, UX_TODO X-07)', () => {
  it('is absolute and opens the finding panel', () => {
    expect(findingUrl(812, 'https://pulse.example.com/')).toBe(
      'https://pulse.example.com/findings?finding=812',
    );
  });

  it('is in the review summary', () => {
    expect(
      reviewSummary(
        {
          id: 9,
          repo: { id: 1, org: 'acme', name: 'payments' },
          dimension: 'test_gap',
          severity: 3,
          confidence: 2,
          title: 'No tests for refunds',
          file: null,
          line_range: [null, null],
          evidence: 'e',
          recommendation: 'r',
          status: 'open',
          dismiss_reason: null,
          verify_status: 'unverified',
          forge: null,
        } as unknown as Finding,
        [],
        'https://pulse.example.com',
      ).split('\n')[1],
    ).toBe('In RepoPulse: https://pulse.example.com/findings?finding=9');
  });
});

describe('foundByText (W20-15, UX_TODO X-10)', () => {
  it('says whether a rule, the customer’s model or another tool raised it', () => {
    expect(
      foundByText({
        tier: 1,
        rule_id: 'bpm-sql-injection',
        found_by: { kind: 'scanner', scanner: 'semgrep', version: 'v3' },
      }),
    ).toBe('Found by: the semgrep scanner v3, rule bpm-sql-injection');
    expect(foundByText({ tier: 2, found_by: { kind: 'model', model: 'qwen3-coder' } })).toBe(
      'Found by: your AI model qwen3-coder',
    );
    expect(
      foundByText({
        tier: 1,
        found_by: { kind: 'imported', tool: 'CodeQL', source: 'sarif', tool_version: '2.19.0' },
      }),
    ).toBe('Found by: imported from CodeQL v2.19.0 (a SARIF upload)');
    // An older API without found_by still says something true.
    expect(foundByText({ tier: 2 })).toBe('Tier 2');
  });
});

// W21-01: one wording of "who found it", shared by the finding panel and the
// PR's "New on this PR" table, which had drifted apart.
describe('foundByLabel', () => {
  it('words every kind once, and says nothing for an unknown finder', async () => {
    const { foundByLabel, foundByText } = await import('./contracts.js');
    expect(foundByLabel({ kind: 'model', model: 'm-1' } as never)).toBe('your AI model m-1');
    expect(
      foundByLabel({ kind: 'scanner', scanner: 'secret_scan', version: '1.2' } as never, 'r.x'),
    ).toBe('the secret scan scanner 1.2, rule r.x');
    expect(
      foundByLabel({
        kind: 'imported',
        tool: 'CodeQL',
        tool_version: '2.19',
        source: 'code_scanning',
      } as never),
    ).toBe('imported from CodeQL v2.19 (code scanning)');
    expect(foundByLabel({ kind: 'unknown' } as never)).toBeNull();
    expect(foundByLabel(null)).toBeNull();
    // The panel's sentence is the same label behind "Found by:".
    expect(foundByText({ found_by: { kind: 'model', model: 'm-1' } } as never)).toBe(
      'Found by: your AI model m-1',
    );
  });
});
