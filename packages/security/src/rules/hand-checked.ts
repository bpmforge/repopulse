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
// The evidence is the marked sheets, nothing else: hand-checked.data.ts is
// generated from the `brad` column of every sheet in HAND_CHECKED_SHEETS by
// `pnpm --filter @repopulse/security hand-checked`, and hand-checked.test.ts
// fails when the two disagree or an entry falls below the bar. Claude's
// proposed labels are in the sheets too and are never read here.
//
// An admin's registry row still wins, exactly as for the starter set.

/** The bar: the starter set's own, so the two cannot drift apart. */
export const HAND_CHECKED_BAR = STARTER_SET_BAR;

/** The stage reason shown in Settings → Rules and the finding panel. */
export const HAND_CHECKED_REASON = 'live via hand-checked evidence';

/**
 * The sheets the manifest is derived from, relative to the repository root:
 * the W21-20 hand-check, then Rust, Swift and Kotlin (2026-10-26). A hit that
 * appears on more than one sheet is counted once (see deriveHandChecked).
 */
export const HAND_CHECKED_SHEETS = [
  'docs/benchmarks/perf-hand-check/sheet.csv',
  'docs/benchmarks/perf-hand-check-langs/sheet.csv',
] as const;

/**
 * One rule's marked evidence. The starter set's entry shape, so the API and
 * the trust panels show it unchanged; `suites` are the repositories, and
 * `small` is the hits marked "small list".
 */
export interface HandCheckedEntry extends StarterSetEntry {
  small: number;
}

export interface HandCheckedManifest {
  sources: typeof HAND_CHECKED_SHEETS;
  ticket: 'W21-20';
  bar: { minPrecision: number; minTruePositives: number };
  /** Every distinct marked hit, so a sheet with unmarked rows cannot produce a manifest. */
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

/**
 * Rules held in shadow by owner decision even though their marked sample
 * clears the bar. A sample is evidence, not a verdict on what it missed:
 * bpm-perf-includes-in-loop's random 30 came out clean, but the proposed
 * labels on all 200 of its hits give 77%, most misses being `.includes` on a
 * string. It stays shadow until it stops firing on strings and is re-checked
 * (2026-10-26, Brad accepted the recommendation to hold it).
 */
export const HAND_CHECKED_HELD: ReadonlyMap<string, string> = new Map([
  [
    'bpm-perf-includes-in-loop',
    'held: 77% on all 200 hits (string receivers); re-check after the fix',
  ],
]);

const MARKS = new Set(['true', 'small', 'wrong']);
const round3 = (n: number): number => Math.round(n * 1000) / 1000;

/** True when marked evidence clears the bar (true = TP, wrong = FP). Pure. */
export const meetsHandCheckedBar = meetsStarterBar;

/**
 * Derives the manifest from the marked sheets, in HAND_CHECKED_SHEETS order.
 * Reads the `brad` column only; throws on a row that is not marked, because a
 * half-marked sheet is not a verdict. A hit (rule, repository, file, line) on
 * more than one sheet counts once — the Rust/Swift/Kotlin corpus re-scanned
 * mihon — and two sheets marking the same hit differently throw, because a
 * contradiction is not a verdict either. Pure; no I/O.
 */
export function deriveHandChecked(...csvs: string[]): HandCheckedManifest {
  const marks = new Map<string, { rule: string; repo: string; mark: string }>();
  for (const csv of csvs) {
    const [header, ...rows] = parseSheetCsv(csv).filter((r) => r.length > 1);
    const col = (name: string): number => {
      const i = header!.indexOf(name);
      if (i < 0) throw new Error(`sheet.csv has no "${name}" column`);
      return i;
    };
    const [cRule, cRepo, cFile, cLine, cBrad] = ['rule', 'repo', 'file', 'line', 'brad'].map(col);
    for (const r of rows) {
      const mark = r[cBrad!]!.trim();
      if (!MARKS.has(mark)) throw new Error(`unmarked or invalid row ${r[0]}: "${mark}"`);
      const [rule, repo] = [r[cRule!]!, r[cRepo!]!];
      const key = [rule, repo, r[cFile!], r[cLine!]].join('\0');
      const seen = marks.get(key);
      if (seen && seen.mark !== mark)
        throw new Error(
          `${rule} ${repo} ${r[cFile!]}:${r[cLine!]} is marked both "${seen.mark}" and "${mark}"`,
        );
      marks.set(key, { rule, repo, mark });
    }
  }
  const perRule = new Map<string, Map<string, { tp: number; fp: number; small: number }>>();
  for (const { rule, repo, mark } of marks.values()) {
    const repos = perRule.get(rule) ?? new Map();
    perRule.set(rule, repos);
    const c = repos.get(repo) ?? { tp: 0, fp: 0, small: 0 };
    repos.set(repo, c);
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
    (meetsHandCheckedBar(entry) && !HAND_CHECKED_HELD.has(ruleId) ? rules : notLive).push(entry);
  }
  const byId = (a: HandCheckedEntry, b: HandCheckedEntry) => a.ruleId.localeCompare(b.ruleId);
  return {
    sources: HAND_CHECKED_SHEETS,
    ticket: 'W21-20',
    bar: { ...HAND_CHECKED_BAR },
    marked: marks.size,
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
