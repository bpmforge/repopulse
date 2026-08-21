import { describe, expect, it } from 'vitest';
import { dedupKey, normalizeEvidence } from './dedup.js';

// Dedup normalisation (W8-16).
// W8-16 — the normaliser used to collapse identifiers that differ only in
// digits. Found while building the dependency scanner (W8-06), not by review.
describe('identifiers keep their digits, numbers do not', () => {
  const quote = (cve: string) => `${cve} in lodash 4.17.20 at app.ts:42`;

  it('keeps two CVEs on one package APART', () => {
    // The bug: \b\d+\b treats a hyphen as a word boundary, so CVE-2020-11023
    // and CVE-2020-11022 both became "cve--". The second vulnerability was
    // silently counted as another sighting of the first.
    expect(normalizeEvidence(quote('CVE-2020-11023'))).not.toBe(
      normalizeEvidence(quote('CVE-2020-11022')),
    );
    expect(
      dedupKey({ dimension: 'dependency', file: null, lineStart: null, evidenceQuote: quote('CVE-2020-11023') }),
    ).not.toBe(
      dedupKey({ dimension: 'dependency', file: null, lineStart: null, evidenceQuote: quote('CVE-2020-11022') }),
    );
  });

  it('keeps a GHSA id and a package name with a digit in it', () => {
    expect(normalizeEvidence('GHSA-jf85-cpcp-j695')).toBe('ghsa-jf85-cpcp-j695');
    expect(normalizeEvidence('log4j-core is vulnerable')).toBe('log4j-core is vulnerable');
  });

  // Everything the stripping was FOR still works — otherwise the fix would
  // just be a deletion of the normalisation.
  it('still strips a line number written after a filename', () => {
    expect(normalizeEvidence('at app.ts:42')).toBe(normalizeEvidence('at app.ts:57'));
  });

  it('still strips a standalone constant that shifted', () => {
    expect(normalizeEvidence('timeout( 3000 )')).toBe(normalizeEvidence('timeout( 5000 )'));
  });

  it('still strips a leading line number a model sometimes includes', () => {
    expect(normalizeEvidence('42  const x = 1')).toBe(normalizeEvidence('const x = 2'));
  });

  it('still collapses reflowed whitespace', () => {
    expect(normalizeEvidence('foo(\n   bar\n)')).toBe(normalizeEvidence('foo( bar )'));
  });

  it('is idempotent — a normaliser that is not gives one finding two keys', () => {
    const once = normalizeEvidence(quote('CVE-2020-11023'));
    expect(normalizeEvidence(once)).toBe(once);
  });
});
