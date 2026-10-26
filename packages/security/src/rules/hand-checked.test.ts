import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { HAND_CHECKED_MANIFEST } from './hand-checked.data.js';
import {
  HAND_CHECKED_BAR,
  HAND_CHECKED_HELD,
  HAND_CHECKED_REASON,
  HAND_CHECKED_SHEETS,
  deriveHandChecked,
  handCheckedEntry,
  isHandCheckedRule,
  meetsHandCheckedBar,
  parseSheetCsv,
} from './hand-checked.js';
import { effectiveStatus, shippedStatusOf } from './shadow.js';

// The hand-checked manifest must say exactly what the marked sheets say (W21-20).
//
// A performance rule goes live on every new install because of an entry here,
// so an entry the sheet does not support is a rule live on evidence nobody gave.
// After the sheet changes: pnpm --filter @repopulse/security hand-checked

const ROOT = new URL('../../../../', import.meta.url);
const SHEETS = HAND_CHECKED_SHEETS.map((s) => readFileSync(new URL(s, ROOT), 'utf8'));
const [SHEET, LANGS] = SHEETS as [string, string];
const PERF_PACKS = new URL('../../rulepacks/code-health/perf/', import.meta.url);

/** Every sheet's rows as objects, keyed by hit; a hit on two sheets is one hit. */
function hits(): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const csv of SHEETS) {
    const [header, ...rows] = parseSheetCsv(csv).filter((r) => r.length > 1);
    for (const r of rows) {
      const row = Object.fromEntries(header!.map((h, i) => [h, r[i]!]));
      out.set([row.rule, row.repo, row.file, row.line].join(' '), row);
    }
  }
  return out;
}

/** Recount one rule from the sheets' `brad` column, independently of deriveHandChecked. */
function recount(ruleId: string) {
  const out = { tp: 0, fp: 0, small: 0 };
  for (const r of hits().values()) {
    if (r.rule !== ruleId) continue;
    if (r.brad === 'true') out.tp += 1;
    if (r.brad === 'wrong') out.fp += 1;
    if (r.brad === 'small') out.small += 1;
  }
  return out;
}

/** Swaps one column's value on every data row; the header row is kept. */
function rewriteColumn(csv: string, column: string, to: (value: string) => string): string {
  const rows = parseSheetCsv(csv).filter((r) => r.length > 1);
  const i = rows[0]!.indexOf(column);
  const quote = (v: string) => `"${v.replace(/"/g, '""')}"`;
  return (
    rows
      .map((r, n) => (n === 0 ? r : r.map((v, j) => (j === i ? to(v) : v))).map(quote).join(','))
      .join('\n') + '\n'
  );
}

describe('hand-checked manifest (W21-20)', () => {
  it('matches the marked sheets, in HAND_CHECKED_SHEETS order', () => {
    expect(HAND_CHECKED_MANIFEST).toEqual(deriveHandChecked(...SHEETS));
    expect(HAND_CHECKED_MANIFEST.sources).toEqual(HAND_CHECKED_SHEETS);
  });

  it('counts every distinct hit once, and every one is marked', () => {
    const rows = SHEETS.reduce(
      (n, s) => n + parseSheetCsv(s).filter((r) => r.length > 1).length - 1,
      0,
    );
    expect(HAND_CHECKED_MANIFEST.marked).toBe(hits().size);
    // The Rust/Swift/Kotlin corpus re-scanned mihon: its 7 Kotlin hits are on both sheets.
    expect(rows - HAND_CHECKED_MANIFEST.marked).toBe(7);
    expect(deriveHandChecked(SHEET, LANGS, LANGS)).toEqual(HAND_CHECKED_MANIFEST);
  });

  it('refuses two sheets that mark the same hit differently', () => {
    const flipped = rewriteColumn(LANGS, 'brad', (v) => (v === 'true' ? 'wrong' : v));
    expect(() => deriveHandChecked(SHEET, flipped)).toThrow(/marked both "true" and "wrong"/);
  });

  it('every live entry clears the bar on its own numbers; every other one misses it or is held', () => {
    expect(HAND_CHECKED_MANIFEST.rules.length).toBeGreaterThan(0);
    for (const e of HAND_CHECKED_MANIFEST.rules) {
      expect(e.tp, e.ruleId).toBeGreaterThanOrEqual(HAND_CHECKED_BAR.minTruePositives);
      expect(e.tp / (e.tp + e.fp), e.ruleId).toBeGreaterThanOrEqual(HAND_CHECKED_BAR.minPrecision);
    }
    for (const e of HAND_CHECKED_MANIFEST.notLive)
      expect(meetsHandCheckedBar(e) && !HAND_CHECKED_HELD.has(e.ruleId), e.ruleId).toBe(false);
  });

  it('keeps an owner-held rule in shadow even when its sample clears the bar', () => {
    for (const [ruleId, reason] of HAND_CHECKED_HELD) {
      expect(isHandCheckedRule(ruleId), ruleId).toBe(false);
      expect(reason, ruleId).toMatch(/^held: /);
      expect(
        HAND_CHECKED_MANIFEST.notLive.some((e) => e.ruleId === ruleId),
        ruleId,
      ).toBe(true);
    }
    // includes-in-loop's sample clears the bar; the hold is what keeps it out.
    const held = HAND_CHECKED_MANIFEST.notLive.find(
      (e) => e.ruleId === 'bpm-perf-includes-in-loop',
    )!;
    expect(meetsHandCheckedBar(held)).toBe(true);
  });

  it("each entry's numbers are the sheet's brad column, recounted", () => {
    for (const e of [...HAND_CHECKED_MANIFEST.rules, ...HAND_CHECKED_MANIFEST.notLive]) {
      expect(recount(e.ruleId), e.ruleId).toEqual({ tp: e.tp, fp: e.fp, small: e.small });
      expect(e.suites.reduce((n, s) => n + s.tp, 0)).toBe(e.tp);
      expect(e.suites.reduce((n, s) => n + s.fp, 0)).toBe(e.fp);
    }
  });

  it("reads Brad's column only: Claude's proposals change nothing, his marks change the result", () => {
    const all = (column: string, to: () => string) =>
      deriveHandChecked(...SHEETS.map((s) => rewriteColumn(s, column, to)));
    // Every proposal flipped to "wrong": the manifest must not move.
    expect(all('proposed', () => 'wrong')).toEqual(HAND_CHECKED_MANIFEST);
    // Every mark flipped to "wrong": nothing may stay live.
    expect(all('brad', () => 'wrong').rules).toEqual([]);
  });

  it('refuses a sheet with an unmarked row, because a half-marked sheet is not a verdict', () => {
    let first = true;
    const half = rewriteColumn(SHEET, 'brad', (v) => {
      if (!first) return v;
      first = false;
      return '';
    });
    expect(() => deriveHandChecked(half, LANGS)).toThrow(/unmarked/);
  });

  it('only ever names performance rules that exist in a perf pack', () => {
    const packs = readdirSync(PERF_PACKS)
      .map((f) => readFileSync(new URL(f, PERF_PACKS), 'utf8'))
      .join('\n');
    for (const e of [...HAND_CHECKED_MANIFEST.rules, ...HAND_CHECKED_MANIFEST.notLive]) {
      expect(e.ruleId.startsWith('bpm-perf-'), e.ruleId).toBe(true);
      expect(packs, e.ruleId).toContain(`id: ${e.ruleId}`);
    }
  });
});

describe('a hand-checked rule ships live', () => {
  const live = HAND_CHECKED_MANIFEST.rules[0]!.ruleId;
  const shadowed = HAND_CHECKED_MANIFEST.notLive[0]!.ruleId;

  it('whatever its rule file says, and says why', () => {
    expect(isHandCheckedRule(live)).toBe(true);
    expect(handCheckedEntry(live)?.ruleId).toBe(live);
    expect(shippedStatusOf({ lifecycle: 'candidate' }, live)).toBe('active');
    expect(HAND_CHECKED_REASON).toBe('live via hand-checked evidence');
  });

  it('a rule that missed the bar stays in shadow', () => {
    expect(isHandCheckedRule(shadowed)).toBe(false);
    expect(shippedStatusOf({ lifecycle: 'candidate' }, shadowed)).toBe('candidate');
  });

  it("an admin's registry row still wins", () => {
    expect(effectiveStatus(shippedStatusOf({ lifecycle: 'candidate' }, live), 'candidate')).toBe(
      'candidate',
    );
    expect(effectiveStatus(shippedStatusOf({ lifecycle: 'candidate' }, live), 'deprecated')).toBe(
      'deprecated',
    );
  });
});
