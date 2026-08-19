import { describe, expect, it } from 'vitest';
import {
  applyNarration,
  buildNarratePrompt,
  buildPulse,
  deltaBullet,
  numbersPreserved,
  type PulseDelta,
} from './pulse.js';

// Weekly Pulse (W6-06, R-A7).

const delta = (over: Partial<PulseDelta> = {}): PulseDelta => ({
  key: 'M5',
  label: 'Review coverage',
  current: 0.8,
  previous: 0.6,
  higherBetter: true,
  unit: 'ratio',
  ...over,
});

describe('deterministic bullets', () => {
  it('states the movement with both endpoints, so a reader can check it', () => {
    // "from 60% to 80%" beats "+20%": the claim is verifiable against the
    // dashboard, which is what makes a weekly note trustworthy.
    const bullet = deltaBullet(delta());
    expect(bullet.text).toContain('60%');
    expect(bullet.text).toContain('80%');
    expect(bullet.direction).toBe('better');
  });

  it('reads a DROP in a lower-is-better metric as an improvement', () => {
    const bullet = deltaBullet(delta({ key: 'M8', label: 'Stale PRs', current: 3, previous: 9, higherBetter: false, unit: 'count' }));
    expect(bullet.direction).toBe('better');
    expect(bullet.text).toContain('improved');
  });

  it('says "first measured" rather than implying improvement from zero', () => {
    // The most tempting lie in a weekly summary: it makes every newly computed
    // metric look like progress.
    const bullet = deltaBullet(delta({ previous: null }));
    expect(bullet.text).toMatch(/first measured/);
    expect(bullet.direction).toBe('unknown');
    expect(bullet.text).not.toMatch(/improved/);
  });

  it('says a metric was not computed rather than reporting it as zero', () => {
    const bullet = deltaBullet(delta({ current: null }));
    expect(bullet.text).toMatch(/not computed/);
    expect(bullet.direction).toBe('unknown');
  });
});

describe('the five-bullet pulse', () => {
  const input = {
    repoLabel: 'acme',
    windowDays: 7,
    deltas: [delta(), delta({ key: 'M8', label: 'Stale PRs', current: 3, previous: 9, higherBetter: false, unit: 'count' })],
    openFindings: 4,
    newFindingsThisWindow: 2,
    planItemsVerified: 1,
  };

  it('is always exactly five bullets, in the same slots', () => {
    // A summary whose shape changes week to week cannot be skimmed, and
    // skimming is the only way a weekly note gets read at all.
    expect(buildPulse(input)).toHaveLength(5);
    expect(buildPulse({ ...input, deltas: [] })).toHaveLength(5);
  });

  it('is deterministic — same input, same bullets', () => {
    expect(buildPulse(input)).toEqual(buildPulse(input));
  });

  it('leads with movement, not with "not computed"', () => {
    const pulse = buildPulse({ ...input, deltas: [delta({ current: null }), delta({ key: 'M8' })] });
    expect(pulse[0]?.direction).not.toBe('unknown');
  });

  it('reports findings and plan progress in fixed slots', () => {
    const pulse = buildPulse(input);
    expect(pulse[1]?.text).toMatch(/4 findings are open/);
    expect(pulse[2]?.text).toMatch(/1 plan item verified/);
  });
});

describe('optional T2 polish', () => {
  it('tells the model the numbers are already correct', () => {
    const prompt = buildNarratePrompt([{ id: 'a', text: 'Review coverage is 80%.', direction: 'better' }], 'acme');
    expect(prompt).toMatch(/Reproduce each one EXACTLY/);
    expect(prompt).toMatch(/Do not add any number/);
  });

  it('accepts a rewording that preserves every number', () => {
    const original = [{ id: 'a', text: 'Review coverage improved by 20%, from 60% to 80%.', direction: 'better' as const }];
    const out = applyNarration(original, ['Coverage climbed from 60% to 80% — a 20% gain.']);
    expect(out[0]?.text).toMatch(/climbed/);
  });

  it('DISCARDS a rewording that invents or changes a number', () => {
    // The whole reason the template comes first. A stiff sentence beats a
    // fluent one with a fabricated figure, because the fluent one gets quoted.
    const original = [{ id: 'a', text: 'Review coverage improved by 20%, from 60% to 80%.', direction: 'better' as const }];
    const out = applyNarration(original, ['Coverage surged from 60% to 95%.']);
    expect(out[0]?.text).toBe(original[0]!.text);
  });

  it('falls back wholesale when the model returns the wrong number of bullets', () => {
    const original = [
      { id: 'a', text: 'A 1.', direction: 'flat' as const },
      { id: 'b', text: 'B 2.', direction: 'flat' as const },
    ];
    expect(applyNarration(original, ['only one'])).toEqual(original);
  });

  it('numbersPreserved is order-insensitive but count-sensitive', () => {
    expect(numbersPreserved('from 60% to 80%', '80% up from 60%')).toBe(true);
    expect(numbersPreserved('60 to 80', '60 to 80 (up 20)')).toBe(false);
  });
});
