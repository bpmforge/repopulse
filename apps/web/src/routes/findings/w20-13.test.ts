import { describe, expect, it } from 'vitest';
import { validateFindingsSearch } from './index.js';

// W20-13: the new Findings filters live in the URL like the others (FND-19,
// FND-20, FND-46, FND-64), and junk is dropped rather than white-screening.

describe('Findings search params (W20-13)', () => {
  it('reads search text, KEV, risk band, CVE, confidence and chain', () => {
    expect(
      validateFindingsSearch({
        q: 'lodash',
        kev: 'true',
        risk_band: 'act',
        cve_id: 'CVE-2026-1',
        confidence_min: '4',
        chain_id: 'ch-1',
      }),
    ).toEqual({
      q: 'lodash',
      kev: true,
      risk_band: 'act',
      cve_id: 'CVE-2026-1',
      confidence_min: 4,
      chain_id: 'ch-1',
    });
  });

  it('drops values the API would not take', () => {
    expect(
      validateFindingsSearch({ risk_band: 'panic', confidence_min: '9', kev: 'yes', q: '' }),
    ).toEqual({});
  });
});
