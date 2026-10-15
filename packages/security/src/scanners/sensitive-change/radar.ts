import { patchLines, type PatchLine } from './patch.js';
import {
  parseRadarNumber,
  RADAR_RULES,
  type AddedRule,
  type NumericRule,
  type RadarLanguage,
  type GuardPattern,
  type RadarRule,
  type RemovedRule,
} from './rules.js';

// The sensitive-change radar (W18-21): diff patches in, signals out.
//
// Pure and synchronous on purpose. It reads the same patches the secrets
// stream already fetched for the same head SHA, so the radar costs no forge
// call and no container — and a function with no I/O is one the fixtures can
// pin down exactly.

export interface RadarDiffFile {
  path: string;
  status?: 'added' | 'modified' | 'removed' | 'renamed';
  /** Absent when the forge omitted it (huge or binary file). */
  patch?: string | null;
}

export interface RadarSignal {
  ruleId: string;
  category: RadarRule['category'];
  kind: RadarRule['kind'];
  file: string;
  line: number;
  /** Hunk index within the file's patch. */
  hunk: number;
  /** The diff lines that tripped it, with their +/- marks, verbatim. */
  evidence: string;
  what: string;
  rationale: string;
  severity: number;
  confidence: number;
}

export interface RadarResult {
  signals: RadarSignal[];
  /** Files the radar read. */
  scanned: number;
  /** Files it could have read and did not, by reason — never silent. */
  skipped: {
    noPatch: number;
    notCode: number;
    testOrFixture: number;
    clientSide: number;
    addedOrDeleted: number;
  };
}

/**
 * The cap on a radar signal's severity, and the reason it is 3.
 *
 * FR-ANALYSIS-10 lets a severity-4+ finding surface loudly only once a second
 * model has CONFIRMED it. A radar signal is deterministic and never goes
 * through that verify pass — so at severity 4 it would sit in the list
 * unsurfaceable, and the only route to the top would be through a model's
 * opinion of it. At 3 it surfaces as it is, and no verifier can talk it down.
 */
export const RADAR_SEVERITY_CAP = 3;

const LANGUAGE_BY_EXTENSION: Record<string, RadarLanguage> = {
  js: 'js',
  jsx: 'js',
  mjs: 'js',
  cjs: 'js',
  ts: 'js',
  tsx: 'js',
  mts: 'js',
  cts: 'js',
  py: 'py',
};

export function languageOf(path: string): RadarLanguage | null {
  if (/\.d\.[cm]?ts$/.test(path)) return null;
  const ext = /\.([a-z]+)$/i.exec(path)?.[1]?.toLowerCase();
  return ext ? (LANGUAGE_BY_EXTENSION[ext] ?? null) : null;
}

/**
 * Tests, fixtures, mocks and examples. A check removed from a test is a test
 * change, and the radar is about what production code stopped doing.
 */
const NOT_PRODUCTION = [
  /(^|\/)(__tests__|__mocks__|tests?|spec|e2e|fixtures?|mocks?|examples?|docs?)\//,
  /\.(test|spec|stories|e2e)\.[cm]?[jt]sx?$/,
  /(^|\/)(test_[^/]*|[^/]*_test|conftest)\.py$/,
];

export function isProductionPath(path: string): boolean {
  return !NOT_PRODUCTION.some((re) => re.test(path));
}

/**
 * Browser code. A check in a React component decides what a page SHOWS; the
 * server decides what a request may DO, and only the second is a protection.
 * Removing `isLoggedIn()` from a router config is a UX change.
 */
const CLIENT_SIDE = [/\.[jt]sx$/, /(^|\/)(frontend|client|web-?app|ui)\//];

export function isClientSide(path: string): boolean {
  return CLIENT_SIDE.some((re) => re.test(path));
}

function isComment(text: string, lang: RadarLanguage): boolean {
  const t = text.trim();
  if (t === '') return true;
  if (lang === 'py') return t.startsWith('#');
  return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*');
}

/**
 * Lines that NAME a guard rather than apply it: imports, and its own
 * definition. Removing `import { requireAuth }` is reported where the call
 * site goes, once, rather than twice; removing the function that IS the check
 * is a refactor the call sites will tell us about.
 */
function isDeclaration(text: string, name: string): boolean {
  const t = text.trim();
  if (/^(import\b|from\s+\S+\s+import\b|export\s*\{)/.test(t)) return true;
  if (/^(const|let|var)\s*\{[^}]*\}\s*=\s*require\(/.test(t)) return true;
  const n = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(?:\\bfunction\\s*\\*?\\s*|\\bdef\\s+|\\bclass\\s+|\\b(?:const|let|var)\\s+)${n}\\b`,
  ).test(t);
}

/** Whitespace-insensitive, so a reindented or reformatted line still matches. */
const normalise = (text: string): string => text.replace(/\s+/g, '');

function evidenceOf(...lines: { side: 'removed' | 'added'; text: string }[]): string {
  return lines
    .map((l) => `${l.side === 'removed' ? '-' : '+'} ${l.text.trim()}`.slice(0, 300))
    .join(' → ');
}

interface FileView {
  path: string;
  lang: RadarLanguage;
  removed: PatchLine[];
  added: PatchLine[];
  patch: string;
}

/** What the WHOLE diff puts back, so a guard moved to another file is not lost. */
interface DiffIndex {
  added: Record<RadarLanguage, string[]>;
  readded: Set<string>;
  handlers: Set<string>;
}

/**
 * String literals emptied, so a guard's name inside an error message or a log
 * line is not mistaken for the guard. Quotes are kept: `''` still reads as an
 * argument to the patterns that care about call shape.
 */
function maskStrings(text: string): string {
  return text.replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '$1$1');
}

function guardsOf(rule: RemovedRule, lang: RadarLanguage): GuardPattern[] {
  return (rule.patterns[lang] ?? []).map((p) => (p instanceof RegExp ? { re: p } : p));
}

/** Each matching guard's identity: its alias when it has one, else its name. */
function namesOn(
  text: string,
  guards: readonly GuardPattern[],
): { name: string; g: GuardPattern }[] {
  const masked = maskStrings(text);
  const out: { name: string; g: GuardPattern }[] = [];
  for (const g of guards) {
    const m = g.re.exec(g.raw ? text : masked);
    if (m) out.push({ name: g.as ?? m[1] ?? m[0], g });
  }
  return out;
}

/**
 * Route registrations and handler definitions, keyed by what identifies the
 * endpoint. When one of these leaves the diff and does not come back, the
 * endpoint is gone — and the guard that sat on it went with it, protecting
 * nothing that still exists.
 */
const HANDLER_KEYS: readonly RegExp[] = [
  /\b(?:router|app|server|fastify|api|routes)\.(get|post|put|patch|delete|all|route)\(\s*(['"`][^'"`]*['"`])/,
  /^\s*@\w+(?:\.\w+)*\.(get|post|put|patch|delete|route|api_route)\(\s*(['"][^'"]*['"])/,
  /^\s*(?:async\s+)?(def)\s+(\w+)\s*\(/,
  /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?(function)\s*\*?\s*(\w+)/,
];

function handlerKeys(text: string): string[] {
  const keys: string[] = [];
  for (const re of HANDLER_KEYS) {
    const m = re.exec(text);
    if (m) keys.push(`${m[1]} ${m[2]}`);
  }
  return keys;
}

function removedRule(rule: RemovedRule, file: FileView, index: DiffIndex): RadarSignal[] {
  const guards = guardsOf(rule, file.lang);
  if (guards.length === 0) return [];

  // Any surviving mention of the guard on the `+` side of the DIFF means it
  // moved or was edited around, not removed. Presence rather than a count, on
  // purpose: hoisting `requireAuth` from three routes into one `router.use`
  // is a net loss of two mentions and no loss of protection; moving a check
  // from a controller into a service is a loss in one file and a gain in
  // another. Both are common, and counting would make the radar cry wolf.
  const kept = new Set<string>();
  for (const text of index.added[file.lang]) {
    for (const { name } of namesOn(text, guards)) kept.add(name);
  }

  // Hunks that delete an endpoint outright: the guard went with the route.
  const endpointGone = new Set<number>();
  for (const line of file.removed) {
    if (handlerKeys(line.text).some((k) => !index.handlers.has(k))) endpointGone.add(line.hunk);
  }

  const out: RadarSignal[] = [];
  for (const line of file.removed) {
    if (isComment(line.text, file.lang)) continue;
    if (endpointGone.has(line.hunk)) continue;
    // Moved verbatim somewhere in the PR — another file counts.
    if (index.readded.has(normalise(line.text))) continue;
    const lost = namesOn(line.text, guards).some(({ name, g }) => {
      if (kept.has(name) || isDeclaration(line.text, name)) return false;
      if (!g.sameStatement) return true;
      const key = g.sameStatement.exec(line.text)?.[1];
      return (
        key !== undefined &&
        file.added.some((a) => a.hunk === line.hunk && g.sameStatement!.exec(a.text)?.[1] === key)
      );
    });
    if (lost) out.push(signal(rule, file.path, line, evidenceOf(line)));
  }
  return out;
}

function addedRule(rule: AddedRule, file: FileView): RadarSignal[] {
  const plain = rule.patterns[file.lang] ?? [];
  const downgrades = rule.downgrades?.[file.lang] ?? [];
  const removedText = new Set(file.removed.map((l) => normalise(l.text)));
  const out: RadarSignal[] = [];

  for (const line of file.added) {
    if (isComment(line.text, file.lang)) continue;
    // Already there before, only moved or reindented: not a new weakening.
    if (removedText.has(normalise(line.text))) continue;
    let hit = plain.some((re) => re.test(line.text));
    if (!hit) {
      hit = downgrades.some(
        (d) =>
          d.weak.test(line.text) &&
          file.removed.some((r) => !isComment(r.text, file.lang) && d.strong.test(r.text)),
      );
    }
    if (hit) out.push(signal(rule, file.path, line, evidenceOf(line)));
  }
  return out;
}

function numericRule(rule: NumericRule, file: FileView): RadarSignal[] {
  const patterns = rule.patterns[file.lang];
  if (!patterns || !rule.context.test(file.patch)) return [];
  const out: RadarSignal[] = [];

  const valueOn = (text: string) => {
    const hits: { key: string; value: number; weaker: 'lower' | 'higher' }[] = [];
    for (const p of patterns) {
      const m = p.re.exec(text);
      if (!m) continue;
      const value = (p.value ?? parseRadarNumber)(m);
      if (value !== null) hits.push({ key: p.key, value, weaker: p.weaker });
    }
    return hits;
  };

  // Paired within a hunk, in order: the first removed `rounds` against the
  // first added `rounds`. A value changed in one hunk and an unrelated one
  // added in another are not a before and after.
  const used = new Set<PatchLine>();
  for (const removed of file.removed) {
    if (isComment(removed.text, file.lang)) continue;
    for (const before of valueOn(removed.text)) {
      const replacement = file.added.find(
        (a) =>
          a.hunk === removed.hunk &&
          !used.has(a) &&
          !isComment(a.text, file.lang) &&
          valueOn(a.text).some((h) => h.key === before.key),
      );
      if (!replacement) continue;
      used.add(replacement);
      const after = valueOn(replacement.text).find((h) => h.key === before.key)!;
      const loosened =
        before.weaker === 'lower' ? after.value < before.value : after.value > before.value;
      if (loosened) {
        out.push(signal(rule, file.path, replacement, evidenceOf(removed, replacement)));
      }
    }
  }
  return out;
}

function signal(rule: RadarRule, file: string, at: PatchLine, evidence: string): RadarSignal {
  return {
    ruleId: rule.id,
    category: rule.category,
    kind: rule.kind,
    file,
    line: at.line,
    hunk: at.hunk,
    evidence,
    what: rule.what,
    rationale: rule.rationale,
    severity: Math.min(RADAR_SEVERITY_CAP, rule.severity),
    confidence: rule.confidence,
  };
}

/**
 * `permission_classes = [IsAuthenticated]` becoming `[AllowAny]` is ONE
 * change: the specific "opt-out added" says it better than the generic
 * "check removed" beside it. In a hunk where a rule of the same category
 * already names what was put in, the removal signal is dropped.
 */
function oneSignalPerChange(found: RadarSignal[]): RadarSignal[] {
  const specific = new Set(
    found.filter((s) => s.kind !== 'removed').map((s) => `${s.category}:${s.hunk}`),
  );
  return found.filter((s) => s.kind !== 'removed' || !specific.has(`${s.category}:${s.hunk}`));
}

/**
 * One signal per rule per file. Five validators deleted from one settings
 * module are one question for a reviewer ("was dropping these intended?"),
 * not five rows to dismiss one by one. The first location leads; the evidence
 * carries the first three lines and says how many more there were.
 */
function onePerRule(found: RadarSignal[]): RadarSignal[] {
  const groups = new Map<string, RadarSignal[]>();
  for (const s of found) {
    const list = groups.get(s.ruleId) ?? [];
    list.push(s);
    groups.set(s.ruleId, list);
  }
  return [...groups.values()]
    .map((list) => {
      const [first] = list;
      if (list.length === 1) return first!;
      const more = list.length > 3 ? ` (+${list.length - 3} more)` : '';
      return {
        ...first!,
        evidence:
          list
            .slice(0, 3)
            .map((s) => s.evidence)
            .join(' · ') + more,
      };
    })
    .sort((a, b) => a.line - b.line || a.ruleId.localeCompare(b.ruleId));
}

export interface RadarOptions {
  rules?: readonly RadarRule[];
  /** Per file, so one generated file cannot bury the rest of the PR. */
  maxPerFile?: number;
}

/** Runs every rule over every production JS/TS/Python file in the diff. */
export function sensitiveChanges(
  files: readonly RadarDiffFile[],
  opts: RadarOptions = {},
): RadarResult {
  const rules = opts.rules ?? RADAR_RULES;
  const maxPerFile = opts.maxPerFile ?? 20;
  const skipped = { noPatch: 0, notCode: 0, testOrFixture: 0, clientSide: 0, addedOrDeleted: 0 };
  const views: FileView[] = [];
  const index: DiffIndex = { added: { js: [], py: [] }, readded: new Set(), handlers: new Set() };

  for (const f of files) {
    const lang = languageOf(f.path);
    if (!lang) {
      skipped.notCode += 1;
      continue;
    }
    if (!isProductionPath(f.path)) {
      skipped.testOrFixture += 1;
      continue;
    }
    if (!f.patch) {
      skipped.noPatch += 1;
      continue;
    }
    const lines = patchLines(f.patch);
    const added = lines.filter((l) => l.side === 'added');
    // Every production file's `+` side feeds the index, new files included:
    // a check moved into a new service file is still a check.
    for (const line of added) {
      if (isComment(line.text, lang)) continue;
      index.added[lang].push(line.text);
      index.readded.add(normalise(line.text));
      for (const key of handlerKeys(line.text)) index.handlers.add(key);
    }
    if (isClientSide(f.path)) {
      skipped.clientSide += 1;
      continue;
    }
    // A new file loosened nothing — there was nothing before it; the pattern
    // lane judges what it contains. A deleted file took its endpoints with it.
    // The radar's question is about code that existed and now does less.
    if (f.status === 'added' || f.status === 'removed') {
      skipped.addedOrDeleted += 1;
      continue;
    }
    views.push({
      path: f.path,
      lang,
      removed: lines.filter((l) => l.side === 'removed'),
      added,
      patch: f.patch,
    });
  }

  const signals: RadarSignal[] = [];
  for (const view of views) {
    const found: RadarSignal[] = [];
    for (const rule of rules) {
      if (rule.kind === 'removed') found.push(...removedRule(rule, view, index));
      else if (rule.kind === 'added') found.push(...addedRule(rule, view));
      else found.push(...numericRule(rule, view));
    }
    found.sort((a, b) => a.line - b.line || a.ruleId.localeCompare(b.ruleId));
    signals.push(...onePerRule(oneSignalPerChange(found)).slice(0, maxPerFile));
  }

  return { signals, scanned: views.length, skipped };
}
