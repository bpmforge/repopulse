import { describe, expect, it } from 'vitest';
import { attributionReport } from './attribution.js';
import { DEFAULT_LICENSE_POLICY, licenseFindings } from './license.js';
import { categoryOfId, parseSpdx, resolveLicense } from './spdx.js';
import type { ResolvedComponent } from './sbom.js';

// License categories and SPDX expressions (W18-39).

describe('license categories', () => {
  it.each([
    ['MIT', 'permissive'],
    ['Apache-2.0', 'permissive'],
    ['BSD-3-Clause', 'permissive'],
    ['LGPL-2.1-only', 'weak-copyleft'],
    ['MPL-2.0', 'weak-copyleft'],
    ['GPL-3.0-or-later', 'strong-copyleft'],
    ['GPL-2.0+', 'strong-copyleft'],
    ['AGPL-3.0-only', 'network-copyleft'],
    ['SSPL-1.0', 'network-copyleft'],
    ['LicenseRef-Proprietary', 'unknown'],
    ['UNLICENSED', 'unknown'],
  ])('%s is %s', (id, category) => {
    expect(categoryOfId(id)).toBe(category);
  });
});

describe('SPDX expressions resolve the way the spec reads them', () => {
  it('OR is the consumer’s choice: the cheapest side wins', () => {
    expect(resolveLicense('MIT OR GPL-3.0-only')).toEqual({ category: 'permissive', ids: ['MIT'] });
    expect(resolveLicense('GPL-3.0-only OR AGPL-3.0-only').category).toBe('strong-copyleft');
    // An unreadable side is never chosen over a readable one.
    expect(resolveLicense('LicenseRef-x OR Apache-2.0').category).toBe('permissive');
  });

  it('AND binds both: the strictest side governs and every id applies', () => {
    expect(resolveLicense('MIT AND GPL-3.0-only')).toEqual({
      category: 'strong-copyleft',
      ids: ['MIT', 'GPL-3.0-only'],
    });
  });

  it('honours precedence and parentheses', () => {
    // AND binds tighter than OR.
    expect(resolveLicense('MIT OR GPL-3.0-only AND AGPL-3.0-only').category).toBe('permissive');
    expect(resolveLicense('(MIT OR GPL-3.0-only) AND AGPL-3.0-only').category).toBe('network-copyleft');
  });

  it('treats a linking exception as weak copyleft', () => {
    expect(resolveLicense('GPL-2.0-only WITH Classpath-exception-2.0').category).toBe('weak-copyleft');
    expect(resolveLicense('GPL-2.0-only WITH Some-other-exception').category).toBe('strong-copyleft');
  });

  it('never calls text that is not an expression permissive', () => {
    expect(parseSpdx('SEE LICENSE IN LICENSE.md')).toBeNull();
    expect(resolveLicense('SEE LICENSE IN LICENSE.md').category).toBe('unknown');
    expect(resolveLicense('MIT OR').category).toBe('unknown');
    expect(resolveLicense(null).category).toBe('unknown');
  });
});

const component = (license: string | null, scope: ResolvedComponent['scope'] = 'prod-direct'): ResolvedComponent =>
  ({ ecosystem: 'npm', name: 'pkg', version: '1.0.0', license, dev: scope === 'dev', ref: null, scope, depth: 1 }) as ResolvedComponent;

describe('license findings by category', () => {
  it('flags strong and network copyleft by default, not weak copyleft or permissive', () => {
    const run = (license: string) => licenseFindings([component(license)]);
    expect(run('GPL-3.0-only')[0]).toMatchObject({ ruleId: 'license.policy', category: 'strong-copyleft' });
    expect(run('AGPL-3.0-only')[0]).toMatchObject({ category: 'network-copyleft' });
    expect(run('LGPL-3.0-only')).toEqual([]);
    expect(run('MIT')).toEqual([]);
  });

  it('does not flag a dual license the user may take permissively, without any allow list', () => {
    expect(licenseFindings([component('MIT OR GPL-3.0-only')])).toEqual([]);
    expect(licenseFindings([component('MIT AND GPL-3.0-only')])).toHaveLength(1);
  });

  it('is tunable per workspace', () => {
    const strict = { ...DEFAULT_LICENSE_POLICY, flagCategories: ['weak-copyleft' as const] };
    expect(licenseFindings([component('MPL-2.0')], strict)).toHaveLength(1);
    expect(licenseFindings([component('GPL-3.0-only')], strict)).toEqual([]);
  });

  it('reports an unrecognised license as unknown, and stays silent in dev scope', () => {
    const [f] = licenseFindings([component('Custom Corp License')]);
    expect(f).toMatchObject({ ruleId: 'license.unknown', category: 'unknown' });
    expect(licenseFindings([component('GPL-3.0-only', 'dev')])).toEqual([]);
  });
});

describe('attribution report', () => {
  it('groups shipped components by license and leaves dev out', () => {
    const text = attributionReport(
      [
        { ...component('MIT'), name: 'b' },
        { ...component('MIT'), name: 'a' },
        { ...component('GPL-3.0-only'), name: 'g' },
        { ...component(null), name: 'u' },
        { ...component('MIT', 'dev'), name: 'devtool' },
      ],
      { title: 'acme/app' },
    );
    expect(text).toContain('# acme/app — third-party notices');
    expect(text.indexOf('- a 1.0.0')).toBeLessThan(text.indexOf('- b 1.0.0'));
    expect(text).toContain('## GPL-3.0-only (strong-copyleft)');
    expect(text).toContain('## License not stated (unknown)');
    expect(text).not.toContain('devtool');
  });
});
