import { HAND_CHECKED_MANIFEST } from './hand-checked.data.js';
import { STARTER_SET_BAR, meetsStarterBar, type StarterSetEntry } from './starter-set.js';

// Hand-checked performance rules (W21-20, owner decision 2026-10-26
// "Hand-checked bar", docs/work/HAND_CHECK_W21-20.md).
//
// Performance rules have no independent public benchmark, so the starter set
// (starter-set.ts) can never qualify one. Instead a performance rule ships live
// on new installs when a PERSON has marked its hits on real open-source code
// and it clears the same bar: at least 5 true hits and precision of at least
// 80%, where precision = true / (true + wrong) and "small list" hits (correct
// shape, small input by design) count as neither.
//
// The evidence is the marked sheet, nothing else: hand-checked.data.ts is
// generated from docs/benchmarks/perf-hand-check/sheet.csv's `brad` column by
// `pnpm --filter @repopulse/security hand-checked`, and hand-checked.test.ts
// fails when the two disagree or an entry falls below the bar. Claude's
// proposed labels are in the sheet too and are never read here.
//
// An admin's registry row still wins, exactly as for the starter set.

/** The bar: the starter set's own, so the two cannot drift apart. */
export const HAND_CHECKED_BAR = STARTER_SET_BAR;

/** The stage reason shown in Settings → Rules and the finding panel. */
export const HAND_CHECKED_REASON = 'live via hand-checked evidence';

/** The sheet the manifest is derived from, relative to the repository root. */
export const HAND_CHECKED_SHEET = 'docs/benchmarks/perf-hand-check/sheet.csv';

/**
 * One rule's marked evidence. The starter set's entry shape, so the API and
 * the trust panels show it unchanged; `suites` are the repositories, and
 * `small` is the hits marked "small list".
 */
export interface HandCheckedEntry extends StarterSetEntry {
  small: number;
}

export interface HandCheckedManifest {
  source: typeof HAND_CHECKED_SHEET;
  ticket: 'W21-20';
  bar: { minPrecision: number; minTruePositives: number };
  /** Every marked row, so a sheet with unmarked rows cannot produce a manifest. */
  marked: number;
  rules: HandCheckedEntry[];
  /** Marked rules that do not clear the bar: stated, so the line is visible. */
  notLive: HandCheckedEntry[];
}

/** Parses RFC 4180 CSV (quoted fields, doubled quotes, newlines in quotes). */
export function parseSheetCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') field += ch;
  }
  if (field !== '' || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const MARKS = new Set(['true', 'small', 'wrong']);
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** True when marked evidence clears the bar (true = TP, wrong = FP). Pure. */
export const meetsHandCheckedBar = meetsStarterBar;

/**
 * Derives the manifest from the marked sheet. Reads the `brad` column only;
 * throws on a row that is not marked, because a half-marked sheet is not a
 * verdict. Pure; no I/O.
 */
export function deriveHandChecked(csv: string): HandCheckedManifest {
  const [header, ...rows] = parseSheetCsv(csv).filter((r) => r.length > 1);
  const col = (name: string): number => {
    const i = header!.indexOf(name);
    if (i < 0) throw new Error(`sheet.csv has no "${name}" column`);
    return i;
  };
  const [cRule, cRepo, cBrad] = [col('rule'), col('repo'), col('brad')];
  const perRule = new Map<string, Map<string, { tp: number; fp: number; small: number }>>();
  for (const r of rows) {
    const mark = r[cBrad]!.trim();
    if (!MARKS.has(mark)) throw new Error(`unmarked or invalid row ${r[0]}: "${mark}"`);
    const repos = perRule.get(r[cRule]!) ?? new Map();
    perRule.set(r[cRule]!, repos);
    const c = repos.get(r[cRepo]!) ?? { tp: 0, fp: 0, small: 0 };
    repos.set(r[cRepo]!, c);
    if (mark === 'true') c.tp += 1;
    else if (mark === 'wrong') c.fp += 1;
    else c.small += 1;
  }
  const rules: HandCheckedEntry[] = [];
  const notLive: HandCheckedEntry[] = [];
  for (const [ruleId, repos] of perRule) {
    const suites = [...repos.entries()]
      .map(([suite, c]) => ({ suite, tp: c.tp, fp: c.fp }))
      .sort((a, b) => a.suite.localeCompare(b.suite));
    const tp = suites.reduce((n, s) => n + s.tp, 0);
    const fp = suites.reduce((n, s) => n + s.fp, 0);
    const small = [...repos.values()].reduce((n, c) => n + c.small, 0);
    const entry: HandCheckedEntry = {
      ruleId,
      engine: 'yaml',
      dimension: 'performance',
      tp,
      fp,
      small,
      precision: tp + fp > 0 ? round3(tp / (tp + fp)) : 0,
      suites,
    };
    (meetsHandCheckedBar(entry) ? rules : notLive).push(entry);
  }
  const byId = (a: HandCheckedEntry, b: HandCheckedEntry) => a.ruleId.localeCompare(b.ruleId);
  return {
    source: HAND_CHECKED_SHEET,
    ticket: 'W21-20',
    bar: { ...HAND_CHECKED_BAR },
    marked: rows.length,
    rules: rules.sort(byId),
    notLive: notLive.sort(byId),
  };
}

const LIVE = new Map(HAND_CHECKED_MANIFEST.rules.map((r) => [r.ruleId, r]));

/** The hand-checked entry for a rule, or undefined when it is not live by hand-check. */
export function handCheckedEntry(ruleId: string): HandCheckedEntry | undefined {
  return LIVE.get(ruleId);
}

/** Every hand-checked live rule id, in manifest order. */
export function handCheckedRuleIds(): string[] {
  return [...LIVE.keys()];
}

export function isHandCheckedRule(ruleId: string): boolean {
  return LIVE.has(ruleId);
}
