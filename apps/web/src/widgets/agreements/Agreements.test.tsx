import { describe, expect, it } from 'vitest';
import { parseThreshold } from './Agreements.js';

// W20-17 (UX_TODO ADM-14/65): Add and Edit refuse out-of-range values with a
// reason, and the CI rate is typed as a percentage.

const lines = {
  id: 'pr_size_max',
  label: '',
  unit: 'lines',
  key: 'lines',
  placeholder: 500,
  whole: true,
  min: 1,
};
const hours = {
  id: 'review_within_hours',
  label: '',
  unit: 'hours',
  key: 'hours',
  placeholder: 24,
  min: 0,
};
const rate = {
  id: 'ci_pass_floor',
  label: '',
  unit: '%',
  key: 'rate',
  placeholder: 90,
  percent: true,
  min: 0,
};

describe('parseThreshold', () => {
  it('treats blank as the default', () => {
    expect(parseThreshold(lines, '  ')).toEqual({ threshold: {} });
  });

  it('stores a CI percentage as a fraction', () => {
    expect(parseThreshold(rate, '90')).toEqual({ threshold: { rate: 0.9 } });
    expect(parseThreshold(rate, '150')).toEqual({
      problem: expect.stringMatching(/between 1 and 100/),
    });
  });

  it('refuses negative or fractional counts and zero hours', () => {
    expect(parseThreshold(lines, '-5')).toEqual({ problem: 'Enter 1 or more.' });
    expect(parseThreshold(lines, '2.5')).toEqual({ problem: 'Enter a whole number.' });
    expect(parseThreshold(hours, '0')).toEqual({ problem: 'Enter a number greater than 0.' });
    expect(parseThreshold(hours, '1.5')).toEqual({ threshold: { hours: 1.5 } });
  });
});
