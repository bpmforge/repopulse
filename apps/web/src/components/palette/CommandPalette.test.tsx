import { describe, expect, it } from 'vitest';
import { fuzzyMatch, orderByRecents } from './CommandPalette.js';

// ⌘K palette matching (W5-02, UX_SPEC §3.3).
//
// Enter selects the FIRST result, so ordering is not cosmetic — it decides
// where the keyboard sends you. These pin the two rules that make that
// predictable.

describe('palette fuzzy match', () => {
  it('matches a subsequence, in order', () => {
    expect(fuzzyMatch('pay', 'acme/payments')).toBe(true);
    expect(fuzzyMatch('acmpay', 'acme/payments')).toBe(true);
    expect(fuzzyMatch('', 'anything')).toBe(true);
  });

  it('does NOT match characters out of order', () => {
    // The whole reason for subsequence matching over a distance score: a
    // result you cannot explain is a result you cannot trust to be first.
    expect(fuzzyMatch('yap', 'acme/payments')).toBe(false);
    expect(fuzzyMatch('zzz', 'acme/payments')).toBe(false);
  });

  it('is case-insensitive both ways', () => {
    expect(fuzzyMatch('PAY', 'acme/payments')).toBe(true);
    expect(fuzzyMatch('pay', 'ACME/PAYMENTS')).toBe(true);
  });
});

describe('palette ordering', () => {
  const item = (id: string) => ({ id, label: id, hint: '', run: () => undefined });

  it('puts recents first, most recent leading', () => {
    const ordered = orderByRecents([item('a'), item('b'), item('c')], ['c', 'b']);
    expect(ordered.map((i) => i.id)).toEqual(['c', 'b', 'a']);
  });

  it('keeps declaration order for everything not recent', () => {
    // A stable tail matters: if unrecented items shuffled between renders, the
    // item under the cursor would change as you type and Enter would fire the
    // wrong thing.
    const ordered = orderByRecents([item('a'), item('b'), item('c')], []);
    expect(ordered.map((i) => i.id)).toEqual(['a', 'b', 'c']);
  });
});
