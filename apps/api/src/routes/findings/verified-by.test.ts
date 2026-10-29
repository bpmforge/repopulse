import { describe, expect, it } from 'vitest';
import { verifiedByOf } from './index.js';

// W21-03: "verified by <model>" shows the second-model verify as well as a
// triage answer — whichever is newer — so the panel states a real verdict.

const none = {
  verifiedModel: null,
  verifiedConnection: null,
  verifiedVerdict: null,
  verifiedAt: null,
  secondModel: null,
  secondConnection: null,
  secondAt: null,
  verifyStatus: 'unverified',
};

describe('verifiedByOf (W21-03)', () => {
  it('is null when no model has judged the finding', () => {
    expect(verifiedByOf(none)).toBeNull();
  });

  it('shows the second-model verdict, contradicted included', () => {
    expect(
      verifiedByOf({
        ...none,
        secondModel: 'judge-b',
        secondConnection: 'Box B',
        secondAt: new Date('2026-10-26T10:00:00Z'),
        verifyStatus: 'contradicted',
      }),
    ).toEqual({
      model: 'judge-b',
      connection: 'Box B',
      verdict: 'contradicted',
      at: '2026-10-26T10:00:00.000Z',
      impact: null,
    });
  });

  it('picks the newer of a triage answer and a verify verdict', () => {
    const both = {
      ...none,
      verifiedModel: 'triager',
      verifiedConnection: 'Box A',
      verifiedVerdict: 'real',
      verifiedAt: '2026-10-25T10:00:00Z',
      secondModel: 'judge-b',
      secondConnection: 'Box B',
      secondAt: new Date('2026-10-26T10:00:00Z'),
      verifyStatus: 'confirmed',
    };
    expect(verifiedByOf(both)?.model).toBe('judge-b');
    expect(verifiedByOf({ ...both, verifiedAt: '2026-10-27T10:00:00Z' })?.model).toBe('triager');
  });

  it("carries a triage answer's impact (W22-03, 2026-10-29)", () => {
    const judged = {
      ...none,
      verifiedModel: 'judge',
      verifiedConnection: null,
      verifiedVerdict: 'real',
      verifiedAt: '2026-10-29T10:00:00Z',
      verifiedImpact: 'negligible',
    };
    expect(verifiedByOf(judged)?.impact).toBe('negligible');
    expect(verifiedByOf({ ...judged, verifiedImpact: null })?.impact).toBeNull();
  });

  it('a reason with no verdict (no second opinion could be had) is not a verifier', () => {
    expect(verifiedByOf({ ...none, secondModel: null, verifyStatus: 'unverified' })).toBeNull();
  });
});
