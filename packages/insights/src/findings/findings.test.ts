import { describe, expect, it } from 'vitest';
import { dedupKey, normalizeEvidence } from './dedup.js';
import {
  autoResolveOutdated,
  canTransition,
  countsAsFalsePositive,
  reappearanceDecision,
} from './lifecycle.js';

// Findings dedup + lifecycle (W6-03, ANALYSIS_TIERS.md §5, FR-ANALYSIS-6 /
// FR-INSIGHTS-1). The store's database behaviour is covered by its integration
// test; these pin the rules the store applies.

const base = {
  dimension: 'security',
  file: 'src/a.ts',
  evidenceQuote: "db.query('x' + id)",
  lineStart: 12,
};

describe('dedup key', () => {
  it('is identical for the same finding seen twice', () => {
    // The contract: re-running an unchanged PR creates zero new rows. A list
    // that grows every time the same question is asked is a list people stop
    // reading — and the count feeds the health score, so it would move a number
    // nobody changed the code to move.
    expect(dedupKey(base)).toBe(dedupKey({ ...base }));
  });

  it('survives line drift within a bucket', () => {
    expect(dedupKey({ ...base, lineStart: 15 })).toBe(dedupKey(base));
  });

  it('separates findings ten or more lines apart', () => {
    // Coarse enough to absorb drift, fine enough that two genuinely different
    // findings in one file stay distinct.
    expect(dedupKey({ ...base, lineStart: 40 })).not.toBe(dedupKey(base));
  });

  it('ignores digits and whitespace in the evidence', () => {
    expect(normalizeEvidence('Foo( 42 )')).toBe('foo( )');
    // Idempotent: normalizing twice must not drift, or the same finding gets
    // two keys and dedup silently stops working.
    expect(normalizeEvidence(normalizeEvidence('Foo( 42 )'))).toBe(normalizeEvidence('Foo( 42 )'));
    expect(dedupKey({ ...base, evidenceQuote: "db.query('x'   +   id)" })).toBe(dedupKey(base));
  });

  it('separates dimensions and files', () => {
    expect(dedupKey({ ...base, dimension: 'performance' })).not.toBe(dedupKey(base));
    expect(dedupKey({ ...base, file: 'src/b.ts' })).not.toBe(dedupKey(base));
  });
});

describe('lifecycle', () => {
  it('allows the human transitions FR-INSIGHTS-1 lists', () => {
    expect(canTransition('open', 'confirmed')).toBe(true);
    expect(canTransition('open', 'dismissed')).toBe(true);
    expect(canTransition('confirmed', 'resolved')).toBe(true);
    expect(canTransition('dismissed', 'open')).toBe(true);
  });

  it('refuses to jump straight from open to resolved', () => {
    // Resolving means someone checked it was fixed; open → resolved without
    // confirmation would let a finding be closed without ever being read.
    expect(canTransition('open', 'resolved')).toBe(false);
  });

  it('NEVER reopens a human dismissal because the model repeated itself', () => {
    // The judgement stands. A model saying the same thing again is not new
    // information about a decision a person already made.
    expect(reappearanceDecision('dismissed')).toBeNull();
    expect(reappearanceDecision('wont_fix')).toBeNull();
  });

  it('DOES reopen a resolved finding whose evidence reappears', () => {
    // Not undoing a judgement — new information: the code came back.
    const decision = reappearanceDecision('resolved');
    expect(decision?.next).toBe('open');
    expect(decision?.reason).toMatch(/reappeared/);
  });

  it('auto-resolves a stale finding as outdated_diff, never as fixed', () => {
    // We observed that we stopped seeing it, not that anyone fixed it.
    // Crediting an unwitnessed fix would make the resolution rate a number
    // nobody should trust.
    expect(autoResolveOutdated('open')).toMatchObject({
      next: 'resolved',
      reason: 'outdated_diff',
    });
    expect(autoResolveOutdated('confirmed')?.reason).toBe('outdated_diff');
  });

  it('leaves dismissed and already-resolved findings alone when the diff moves on', () => {
    expect(autoResolveOutdated('dismissed')).toBeNull();
    expect(autoResolveOutdated('wont_fix')).toBeNull();
    expect(autoResolveOutdated('resolved')).toBeNull();
  });

  it('counts only false_positive dismissals toward the FP rate', () => {
    expect(countsAsFalsePositive('dismissed', 'false_positive')).toBe(true);
    // "We accept this risk" is not the model being wrong, and folding the two
    // together would make the false-positive rate measure team policy.
    expect(countsAsFalsePositive('dismissed', 'accepted_risk')).toBe(false);
    expect(countsAsFalsePositive('resolved', 'false_positive')).toBe(false);
  });
});
