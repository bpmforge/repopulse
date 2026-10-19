import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WINDOW,
  findingsSearchSchema,
  globalSearchSchema,
  parseGlobalSearch,
  serializeGlobalSearch,
  tableSearchSchema,
  type GlobalSearch,
} from './urlState.js';

describe('urlState — GlobalSearch contract (DASHBOARD §1, FR-WEB-2)', () => {
  it('accepts window presets and ISO custom ranges; rejects garbage', () => {
    for (const w of ['7d', '30d', '90d', '365d', '2026-01-01..2026-03-31']) {
      expect(globalSearchSchema.parse({ window: w }).window).toBe(w);
    }
    expect(globalSearchSchema.safeParse({ window: 'yesterday' }).success).toBe(false);
    expect(globalSearchSchema.safeParse({ window: '2026-01-01..nope' }).success).toBe(false);
  });

  it('defaults window to 30d and leaves repos/person optional', () => {
    const s = globalSearchSchema.parse({});
    expect(s).toEqual({ window: DEFAULT_WINDOW });
  });

  it('parse is lenient — bad fields fall back to defaults, never throws', () => {
    expect(parseGlobalSearch({ window: 'bogus', repos: '', person: 42 })).toEqual({
      window: DEFAULT_WINDOW,
    });
    expect(parseGlobalSearch({ window: '90d', repos: 'a,b', person: 'octocat' })).toEqual({
      window: '90d',
      repos: 'a,b',
      person: 'octocat',
    });
  });

  it('serialize omits defaults + the `all` repo sentinel (clean links)', () => {
    expect(serializeGlobalSearch({ window: DEFAULT_WINDOW })).toEqual({});
    expect(serializeGlobalSearch({ window: DEFAULT_WINDOW, repos: 'all' })).toEqual({});
    expect(serializeGlobalSearch({ window: '90d', repos: 'a,b', person: 'octocat' })).toEqual({
      window: '90d',
      repos: 'a,b',
      person: 'octocat',
    });
  });

  it('round-trips any non-default state: parse(serialize(s)) === s (FR-WEB-2)', () => {
    const states: GlobalSearch[] = [
      { window: '7d' },
      { window: '365d', person: 'octocat' },
      { window: '2026-01-01..2026-03-31', repos: '1,2,3' },
      { window: '90d', repos: 'a,b', person: 'me' },
    ];
    for (const s of states) {
      expect(parseGlobalSearch(serializeGlobalSearch(s))).toEqual(s);
    }
  });
});

describe('urlState — Findings + Table fragments', () => {
  it('FindingsSearch extends GlobalSearch with dimension/sev/status filters', () => {
    const s = findingsSearchSchema.parse({ window: '30d', sev: 'high,critical', status: 'open' });
    expect(s.sev).toBe('high,critical');
    expect(s.window).toBe('30d');
  });

  it('TableSearch sort must be `col:asc|desc`; density is c|m', () => {
    expect(tableSearchSchema.parse({ sort: 'cycle_time:desc', density: 'c' }).sort).toBe(
      'cycle_time:desc',
    );
    expect(tableSearchSchema.safeParse({ sort: 'cycle_time' }).success).toBe(false);
    expect(tableSearchSchema.safeParse({ density: 'x' }).success).toBe(false);
  });
});

// W20-09 (UX_TODO DSH-56): a custom range is read through the preset covering it.
describe('presetCovering / customRange', () => {
  it('passes presets through and maps a range to the smallest covering preset', async () => {
    const { presetCovering, customRange } = await import('./urlState.js');
    expect(presetCovering('90d')).toBe('90d');
    expect(presetCovering('2026-09-01..2026-09-07')).toBe('7d');
    expect(presetCovering('2026-09-01..2026-09-14')).toBe('30d');
    expect(presetCovering('2026-01-01..2026-03-31')).toBe('90d');
    expect(presetCovering('2024-01-01..2026-01-01')).toBe('365d');
    expect(presetCovering('garbage')).toBe('30d');
    expect(customRange('30d')).toBeNull();
    expect(customRange('2026-09-01..2026-09-14')).toEqual({
      start: '2026-09-01',
      end: '2026-09-14',
    });
  });
});
