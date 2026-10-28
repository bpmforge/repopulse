import { describe, expect, it } from 'vitest';
import { isRerunnable } from './target.js';
import { productionRunners } from './runners.js';

// 2026-10-28: AI-slop pattern findings (bpm-ch-*) could not get a verified fix,
// although the pattern is an Opengrep rule that can be re-run on the patched
// file exactly like logging's bpm-log-* rules. Model judgement still cannot.
describe('which findings a verified fix can be drafted for', () => {
  it('accepts anti-slop pattern rules and still refuses model judgement', () => {
    expect(isRerunnable('anti_slop', 'bpm-ch-go-discarded-error')).toBe(true);
    expect(isRerunnable('anti_slop', 'bpm-ch-empty-catch')).toBe(true);
    expect(isRerunnable('anti_slop', 'slop.low_logic_density')).toBe(true);
    expect(isRerunnable('anti_slop', 'slop.judgment')).toBe(false);
    expect(isRerunnable('logging_hygiene', 'bpm-log-injection')).toBe(true);
    expect(isRerunnable('secrets', 'aws-access-key')).toBe(false);
  });

  it('has a production runner that re-checks anti-slop pattern findings', () => {
    const slop = productionRunners().filter((r) => r.scannerKeys.includes('anti_slop'));
    expect(slop.map((r) => r.key).sort()).toEqual(['anti_slop_fast_lane', 'anti_slop_pack']);
  });
});
