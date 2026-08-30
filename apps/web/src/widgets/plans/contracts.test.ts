import { describe, expect, it } from 'vitest';
import { criterionInWords, metricInWords } from './contracts.js';

// W16-53. Every plan item spoke in raw metric ids — "Closes automatically when
// M6 stays at most 0.05 for 30 days" — on the screen whose whole job is getting
// a person to agree to a piece of work. The metric catalog exists so a screen
// can name a metric instead of numbering it, and the route serving it says the
// UI should read it and never hardcode; nothing had ever read it.
describe('metric names in a plan (W16-53)', () => {
  const names = { M5: 'Review coverage %', M6: 'Merged-without-review rate' };

  it('names the metric in the exit criterion', () => {
    const words = criterionInWords(
      { metricKey: 'M6', op: 'lte', target: 0.05, windowDays: 30, dimPath: [] },
      names,
    );
    expect(words).toContain('Merged-without-review rate');
  });

  it('keeps the id alongside the name', () => {
    // The id is what the catalog, the reports and the API all call this thing,
    // so a reader who wants to look it up still can.
    expect(metricInWords('M5', names)).toBe('Review coverage % (M5)');
  });

  it('falls back to the id rather than showing nothing', () => {
    // The catalog is a separate request. A criterion is still better shown with
    // an unresolved key than hidden while that request is in flight — or
    // forever, if a new metric has not reached the catalog yet.
    expect(metricInWords('M99', names)).toBe('M99');
    expect(metricInWords('M5', undefined)).toBe('M5');
  });
});
