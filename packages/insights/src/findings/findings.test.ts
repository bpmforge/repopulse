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

  it('lets a person mark an open finding fixed without confirming it first (W20-08)', () => {
    // UX_TODO FND-58: the person who fixed it had to Confirm and then Mark
    // fixed, two notes for one fix. The note is still required, so the
    // finding is still read before it closes.
    expect(canTransition('open', 'resolved')).toBe(true);
    // Nothing else changed: a judgement still only goes back to open.
    expect(canTransition('dismissed', 'resolved')).toBe(false);
    expect(canTransition('wont_fix', 'resolved')).toBe(false);
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

describe('dedup key: the W8-02 scanner extension', () => {
  const analysis = {
    dimension: 'security',
    file: 'src/a.ts',
    evidenceQuote: "db.query('x' + id)",
    lineStart: 12,
  };

  it('does NOT change the key of an existing analysis finding', () => {
    // The migration hazard this test exists for. If the new fields were
    // appended unconditionally, every finding already in the store would
    // re-key, the next run would create a duplicate of each, and every
    // occurrence count, triage decision and false-positive suppression would
    // silently detach from its finding.
    const withUndefinedExtras = dedupKey({ ...analysis, scannerKey: undefined, ruleId: undefined });
    const withNullExtras = dedupKey({ ...analysis, scannerKey: null, ruleId: null });
    expect(withUndefinedExtras).toBe(dedupKey(analysis));
    expect(withNullExtras).toBe(dedupKey(analysis));
  });

  it('separates two scanners reporting the same line', () => {
    // semgrep and a secrets scanner flagging the same line are two findings,
    // not one — they have different rules, different fixes and different
    // triage answers.
    const a = dedupKey({ ...analysis, scannerKey: 'semgrep', ruleId: 'sql-injection' });
    const b = dedupKey({ ...analysis, scannerKey: 'secrets', ruleId: 'aws-key' });
    expect(a).not.toBe(b);
    expect(a).not.toBe(dedupKey(analysis));
  });

  it('separates two rules from the SAME scanner', () => {
    const a = dedupKey({ ...analysis, scannerKey: 'semgrep', ruleId: 'rule-a' });
    const b = dedupKey({ ...analysis, scannerKey: 'semgrep', ruleId: 'rule-b' });
    expect(a).not.toBe(b);
  });

  it('keys a repo-level finding with no file or line', () => {
    // A dependency CVE has neither. Bucketing null as 0 would collide every
    // repo-level finding in a repository into one key.
    const cve = dedupKey({
      dimension: 'dependency',
      file: null,
      lineStart: null,
      evidenceQuote: 'CVE-2026-1234 in lodash@4.17.20',
      scannerKey: 'dependency',
      ruleId: 'CVE-2026-1234',
    });
    const other = dedupKey({
      dimension: 'dependency',
      file: null,
      lineStart: null,
      evidenceQuote: 'CVE-2026-9999 in express@4.0.0',
      scannerKey: 'dependency',
      ruleId: 'CVE-2026-9999',
    });
    expect(cve).not.toBe(other);
    expect(cve).toHaveLength(64);
  });
});
