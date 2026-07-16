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

  it('has exactly 12 entries (M1-M12), no more no less', () => {
    expect(METRIC_CATALOG).toHaveLength(12);
  });

  it('every entry carries id, name, formula, unit, direction, heuristicNotes', () => {
    for (const entry of METRIC_CATALOG) {
      expect(entry.id).toMatch(/^M(1[0-2]|[1-9])$/);
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
