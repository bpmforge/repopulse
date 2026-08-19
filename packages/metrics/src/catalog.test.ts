import { describe, expect, it } from 'vitest';
import { METRIC_CATALOG, findMetricByFrId } from './catalog.js';

describe('METRIC_CATALOG (FR-METRICS-15)', () => {
  it('has every FR-METRICS-1..12 id present exactly once', () => {
    for (let n = 1; n <= 12; n++) {
      const frId = `FR-METRICS-${n}`;
      const matches = METRIC_CATALOG.filter((m) => m.frId === frId);
      expect(matches, `${frId} should appear exactly once`).toHaveLength(1);
    }
  });

  it('has exactly 14 entries (M1-M14), no more no less', () => {
    // 12 until W9-05 added the two debt signals. The count is asserted rather
    // than the shape because this catalog IS the UI's tooltip source: a metric
    // that exists in code and not here renders with no definition, and one
    // that exists here and not in code renders a definition for a number
    // nobody computes.
    expect(METRIC_CATALOG).toHaveLength(14);
  });

  it('carries the two debt signals with their own FR ids', () => {
    // M13/M14 hang off FR-CH-7 rather than FR-METRICS-n: they came from the
    // code-health suite, and pretending otherwise would put a gap in the
    // FR-METRICS numbering that a later reader would try to fill.
    const debt = METRIC_CATALOG.filter((m) => m.frId === 'FR-CH-7').map((m) => m.id);
    expect(debt).toEqual(['M13', 'M14']);
  });

  it('every entry carries id, name, formula, unit, direction, heuristicNotes', () => {
    for (const entry of METRIC_CATALOG) {
      expect(entry.id).toMatch(/^M(1[0-4]|[1-9])$/);
      expect(entry.name.length).toBeGreaterThan(0);
      expect(entry.formula.length).toBeGreaterThan(0);
      expect(entry.unit.length).toBeGreaterThan(0);
      expect(['higher_better', 'lower_better', 'neutral']).toContain(entry.direction);
      expect(entry.heuristicNotes.length).toBeGreaterThan(0);
    }
  });

  it('findMetricByFrId resolves a known id and misses an unknown one', () => {
    expect(findMetricByFrId('FR-METRICS-5')?.name).toBe('Review coverage %');
    expect(findMetricByFrId('FR-METRICS-99')).toBeUndefined();
  });
});
