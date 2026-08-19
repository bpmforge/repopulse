import { describe, expect, it } from 'vitest';
import {
  buildVerifyPrompt,
  mayBeSurfacedLoudly,
  needsVerification,
  pickVerifierHost,
  planVerifyCalls,
  verdictToStatus,
  CHALLENGE_SEVERITY_FLOOR,
} from './verify.js';

// Verify pass + challenger gate (W6-05, FR-ANALYSIS-9/10).

const HOSTS = [
  { baseUrl: 'http://a:1234', modelSlot: 'qwen' },
  { baseUrl: 'http://b:1234', modelSlot: 'nemotron' },
];

const finding = (over: Record<string, unknown> = {}) => ({
  id: 1,
  severity: 4,
  dimension: 'security',
  file: 'src/a.ts',
  title: 'SQL by concatenation',
  evidenceQuote: "db.query('x' + id)",
  rationale: 'user input concatenated',
  finderHostUrl: 'http://a:1234',
  ...over,
});

describe('maker ≠ verifier', () => {
  it('never picks the host that produced the finding', () => {
    // The rule the whole pass rests on. A model asked whether it was right
    // agrees with itself, so a same-host verify would confirm nearly always and
    // the "verified by a second model" badge would mean nothing — worse than no
    // badge, because people would trust it.
    const host = pickVerifierHost(HOSTS, 'http://a:1234');
    expect(host?.baseUrl).toBe('http://b:1234');
  });

  it('returns null rather than falling back to the finder host', () => {
    expect(pickVerifierHost([HOSTS[0]!], 'http://a:1234')).toBeNull();
  });

  it('SKIPS verification entirely when no independent host exists', () => {
    // The finding stays `unverified`, which is exactly what it is. A
    // self-confirmation would be a lie with a badge on it.
    const plan = planVerifyCalls([finding()], [HOSTS[0]!]);
    expect(plan).toEqual([]);
  });

  it('plans at most ONE verify call per finding', () => {
    const plan = planVerifyCalls([finding(), finding({ id: 2 })], HOSTS);
    expect(plan).toHaveLength(2);
    expect(plan.every((p) => p.host.baseUrl === 'http://b:1234')).toBe(true);
  });

  it('does not spend a second model on low-severity findings', () => {
    expect(needsVerification(3)).toBe(true);
    expect(needsVerification(2)).toBe(false);
    expect(planVerifyCalls([finding({ severity: 2 })], HOSTS)).toEqual([]);
  });
});

describe('refute-first prompt', () => {
  it('asks the verifier to refute, not to review', () => {
    // "Is this correct?" invites agreement: the model has been handed a
    // confident claim and a reason to accept it. Asking it to refute makes
    // agreement the expensive answer.
    const prompt = buildVerifyPrompt(finding(), '@@ -1 +1 @@\n+db.query()');
    expect(prompt).toMatch(/REFUTE/);
    expect(prompt).toMatch(/default position is that they are WRONG/);
    expect(prompt).toMatch(/Confirm ONLY if you cannot refute/);
  });

  it('carries the claimed evidence so the verifier can check it against the diff', () => {
    const prompt = buildVerifyPrompt(finding(), '@@ diff');
    expect(prompt).toContain("db.query('x' + id)");
    expect(prompt).toContain('@@ diff');
  });
});

describe('challenger gate (FR-ANALYSIS-10)', () => {
  it('blocks an UNVERIFIED severity-4 finding from loud surfacing', () => {
    // An unverified critical claim on an org banner is the most expensive way
    // this product can be wrong: everyone sees it, and being wrong once there
    // costs more trust than ten correct findings earn.
    expect(
      mayBeSurfacedLoudly({ severity: CHALLENGE_SEVERITY_FLOOR, verifyStatus: 'unverified' }),
    ).toBe(false);
    expect(mayBeSurfacedLoudly({ severity: 5, verifyStatus: 'unverified' })).toBe(false);
  });

  it('allows it once a second model confirmed it', () => {
    expect(mayBeSurfacedLoudly({ severity: 5, verifyStatus: 'confirmed' })).toBe(true);
  });

  it('never surfaces a contradicted finding, at any severity', () => {
    expect(mayBeSurfacedLoudly({ severity: 5, verifyStatus: 'contradicted' })).toBe(false);
    expect(mayBeSurfacedLoudly({ severity: 1, verifyStatus: 'contradicted' })).toBe(false);
  });

  it('lets low-severity findings through without a challenge', () => {
    // The gate exists for claims that shout. Requiring a second model for every
    // note would double the cost of the cheapest findings.
    expect(mayBeSurfacedLoudly({ severity: 2, verifyStatus: 'unverified' })).toBe(true);
  });
});

describe('verdict mapping', () => {
  it('maps refuted to contradicted and not-refuted to confirmed', () => {
    expect(verdictToStatus({ refuted: true, reason: 'quote absent' })).toBe('contradicted');
    expect(verdictToStatus({ refuted: false, reason: 'holds' })).toBe('confirmed');
  });
});
