// Test integrity (W18-03, mechanical-checks plan §B).
//
// The cheapest way to turn CI green is a test that cannot fail: a body with no
// assertion, an assertion that compares a thing with itself, a test of a mock
// standing in for the module it is named after, or an assertion whose failure
// a catch block quietly eats. Every one of them reads as coverage and is none.
//
// PRECISION OVER RECALL, because these findings are accusations about tests
// someone believes in. The no-assertion rule in particular can only see the
// file it reads, so anything that MIGHT assert is treated as asserting: a
// helper whose body asserts (followed transitively, across the repository's
// test-support files), a name shaped like an assertion (`verifyX`, `checkX`,
// `assertX`), a call the query library makes throw (`getByRole`), a `throw`,
// a `done` callback, a `self.` method this repository does not define, a type
// assertion (`@ts-expect-error`). A test that survives all of that and still
// asserts nothing is one a reader can confirm in seconds.
//
// JS/TS (vitest, jest, mocha, ava, tap, node:test, Playwright) and Python
// (pytest, unittest). Our own fixture trees are never read: they are broken on
// purpose.

import { CODE, importsOf, maskPython, maskSource, resolveSpecifier } from './source-graph.js';

export const NO_ASSERTION_RULE_ID = 'test.no_assertion';
export const TAUTOLOGY_RULE_ID = 'test.tautology';
export const MOCKS_SUBJECT_RULE_ID = 'test.mocks_subject';
export const SWALLOWED_FAILURE_RULE_ID = 'test.swallowed_failure';

export const TEST_INTEGRITY_RULE_IDS = [
  NO_ASSERTION_RULE_ID,
  TAUTOLOGY_RULE_ID,
  MOCKS_SUBJECT_RULE_ID,
  SWALLOWED_FAILURE_RULE_ID,
] as const;

export type TestIntegrityRuleId = (typeof TEST_INTEGRITY_RULE_IDS)[number];

export interface TestIntegrityFinding {
  ruleId: TestIntegrityRuleId;
  file: string;
  line: number;
  title: string;
  /** The offending line (or statement), whitespace collapsed — the evidence quote. */
  evidence: string;
  message: string;
}

interface SourceFile {
  path: string;
  source: string;
}

// ---- Which files ---------------------------------------------------------

const JS_TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?$)|((^|\/)__tests__\/.+\.[cm]?[jt]sx?$)/;
/** Vitest type tests: every "assertion" is a type, checked by tsc, not a call. */
const TYPE_TEST_FILE = /\.test-d\.[cm]?[jt]sx?$/;
const PY_TEST_FILE = /(^|\/)(test_[^/]*|[^/]*_test)\.py$/;
const FIXTURE_PATH =
  /(^|\/)(fixtures?|__fixtures__|testdata|test-data|__snapshots__|node_modules)\//;
/** Where helpers that tests call usually live. Over-reading here costs recall, not precision. */
const SUPPORT_PATH =
  /(^|\/)(tests?|__tests__|_?testing|test-?utils|test-?helpers|spec|specs|support|e2e|__mocks__|mocks?)\/|(^|\/)conftest\.py$|(^|\/|[-_.])(test|tests|testing|spec|helpers?|setup|support|mocks?|matchers?|assertions?)[-_.][^/]*$/i;

const isJsTest = (p: string): boolean =>
  JS_TEST_FILE.test(p) && !TYPE_TEST_FILE.test(p) && !FIXTURE_PATH.test(p);
const isPyTest = (p: string): boolean => PY_TEST_FILE.test(p) && !FIXTURE_PATH.test(p);

// ---- Small text tools ----------------------------------------------------

function lineIndex(source: string): number[] {
  const starts = [0];
  for (let k = 0; k < source.length; k++) if (source.charCodeAt(k) === 10) starts.push(k + 1);
  return starts;
}

function lineOf(starts: readonly number[], offset: number): number {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] as number) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** Index of the bracket closing the one at `open`, on masked text; -1 if none. */
function matchClose(masked: string, open: number): number {
  let depth = 0;
  for (let k = open; k < masked.length; k++) {
    const c = masked[k];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/** Top-level comma-separated spans of masked[from, to). */
function splitArgs(masked: string, from: number, to: number): [number, number][] {
  const parts: [number, number][] = [];
  let depth = 0;
  let start = from;
  for (let k = from; k < to; k++) {
    const c = masked[k];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === ',' && depth === 0) {
      parts.push([start, k]);
      start = k + 1;
    }
  }
  if (masked.slice(start, to).trim()) parts.push([start, to]);
  return parts;
}

/**
 * Removes whitespace outside string literals. Two operands are "the same
 * expression" only if this agrees — and `"a b"` must never equal `"ab"`.
 */
function normalise(text: string): string {
  let out = '';
  let k = 0;
  while (k < text.length) {
    const c = text[k] as string;
    if (c === '"' || c === "'" || c === '`') {
      let j = k + 1;
      while (j < text.length && text[j] !== c) {
        if (text[j] === '\\') j++;
        j++;
      }
      out += text.slice(k, j + 1);
      k = j + 1;
    } else {
      // Whitespace goes, except where it separates two words: `0 not in x`
      // must not become the number-shaped `0notinx`.
      if (!/\s/.test(c)) out += c;
      else if (/[\w$]$/.test(out) && /^\s*[\w$]/.test(text.slice(k)) && !out.endsWith(' ')) {
        out += ' ';
      }
      k++;
    }
  }
  return out;
}

const collapse = (text: string, max = 200): string =>
  text.replace(/\s+/g, ' ').trim().slice(0, max);

const lineText = (source: string, starts: readonly number[], line: number): string => {
  const from = starts[line - 1] ?? 0;
  const end = source.indexOf('\n', from);
  return collapse(source.slice(from, end === -1 ? source.length : end));
};

const IDENT = /[A-Za-z_$][\w$]*/g;
const identsIn = (text: string): Set<string> => new Set(text.match(IDENT) ?? []);

/**
 * Names whose call might assert, from a name → mentioned-names graph: a name
 * asserts if any definition of it asserts directly or mentions one that does.
 * By NAME, across files, on purpose — two helpers called `check` in two files
 * both count as asserting if either does. That over-reads, which costs a
 * finding, never invents one.
 */
function assertingNames(
  defs: ReadonlyMap<string, { direct: boolean; mentions: Set<string> }[]>,
): Set<string> {
  const asserting = new Set<string>();
  const callers = new Map<string, Set<string>>();
  for (const [name, list] of defs) {
    for (const def of list) {
      if (def.direct) asserting.add(name);
      for (const m of def.mentions) {
        if (m === name) continue;
        let set = callers.get(m);
        if (!set) callers.set(m, (set = new Set()));
        set.add(name);
      }
    }
  }
  const queue = [...asserting];
  while (queue.length) {
    const name = queue.pop() as string;
    for (const caller of callers.get(name) ?? []) {
      if (!asserting.has(caller)) {
        asserting.add(caller);
        queue.push(caller);
      }
    }
  }
  return asserting;
}

const mentionsAny = (text: string, names: ReadonlySet<string>): boolean => {
  for (const id of identsIn(text)) if (names.has(id)) return true;
  return false;
};

/**
 * Titles that SAY the test asserts nothing but survival — "does not throw",
 * "smoke". Not reported: the absence of an assertion is the stated contract,
 * and a reader would dismiss the finding on sight.
 */
const SMOKE_TITLE =
  /\b(smoke|sanity)|\b(just|nominally)\s+works\b|\bpass(es|ing)?\s+validations?\b|\bpassing\s+(cases?|inputs?|values?)\b|\bsucceeds\b|\bshould\s+succeed\b|\b(do(es)?\s*n[o']?t|doesnt|never|should\s*not|shouldn'?t|won'?t|must\s*not|not)\s+(throw|crash|fail|error|raise|reject|blow|explode|panic|hang)|\bwithout\s+(an?\s+)?(throw|throwing|crash|crashing|errors?|failing|failure|raising|exceptions?|warnings?|issues?)\b|\bno\s+(errors?|exceptions?|crash(es)?|throws?|raises?|failures?|warnings?)\b|\b(raises|throws)\s+nothing\b/i;

const titleWords = (name: string): string =>
  name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase();

// ---- JavaScript / TypeScript ---------------------------------------------

const JS_ASSERTION = new RegExp(
  [
    // expect(…), expect.assertions(n), expectTypeOf<T>(), supertest's .expect(200)
    // A generic call counts on its `<`: type arguments nest (`assertEqual<A<B>, C>(true)`).
    String.raw`\bexpect\w*\s*[(<.]`,
    String.raw`\b[aA]ssert\w*\s*[(<.]`,
    String.raw`\.should\b`,
    String.raw`\bshould\w*\s*[(.]`,
    // Helpers this file cannot see into, named for what they do.
    String.raw`\b(?:verify|check|ensure|must)\w*\s*\(`,
    String.raw`\bfail\s*\(`,
    String.raw`\bthrow\b`,
    // Testing Library's getBy*/findBy* throw when nothing matches.
    String.raw`\b(?:get|find)(?:All)?By[A-Z]\w*\s*\(`,
    String.raw`\bwaitFor\w*\s*\(`,
    // nock's scope.done() throws on an unmet interceptor.
    String.raw`\.done\s*\(\s*\)`,
    String.raw`\.verify\s*\(`,
    // Assertion methods on any receiver — a tap/node:test context, a tspl
    // plan, a chai-style object. Names no other common API uses.
    String.raw`\.(?:equals?|notEqual|strictEqual|notStrictEqual|deepEqual|notDeepEqual|deepStrictEqual|notDeepStrictEqual|ok|notOk|same|notSame|strictSame|throws|throwsAsync|notThrows|doesNotThrow|rejects|doesNotReject|truthy|falsy|true|false|like|notLike|matchSnapshot|snapshot|ifError)\s*\(`,
  ].join('|'),
);

/** ava / tap / node:test context methods that assert, read off the callback's own parameter. */
const CONTEXT_ASSERTIONS =
  'is|not|deepEqual|notDeepEqual|deepStrictEqual|notDeepStrictEqual|like|notLike|true|false|truthy|falsy|ok|notOk|equal|equals|notEqual|strictEqual|notStrictEqual|same|notSame|strictSame|strictNotSame|match|notMatch|throws|throwsAsync|notThrows|notThrowsAsync|doesNotThrow|rejects|resolves|resolveMatch|regex|notRegex|snapshot|matchSnapshot|pass|fail|error|ifError|ifErr|has|hasStrict|notHas|type|plan|assert|expect|emits';

const ASSERT_MODULE =
  /^(node:)?assert(\/strict)?$|^(chai|should|expect|power-assert|uvu\/assert|@std\/assert|assert-plus|@hapi\/code|unexpected|earl)$/;

const DONE_PARAM = /^(done|cb|callback|next|end|finish|resolve)$/;

/** Modifiers a runnable test may carry; anything else (`describe`, `step`, `extend`) is not a test. */
const TEST_MODIFIERS = new Set([
  'only',
  'each',
  'concurrent',
  'sequential',
  'failing',
  'fails',
  'for',
  'skipIf',
  'runIf',
  'serial',
]);
/** Modifiers that take their own argument list before the test's. */
const CALLED_MODIFIERS = new Set(['each', 'for', 'skipIf', 'runIf']);

interface JsTest {
  /** Offset of `it`/`test`. */
  at: number;
  title: string;
  /** The test function's masked text, or null when it is passed by reference. */
  fn: [number, number] | null;
  ref: string | null;
}

/** Skips a template literal on masked text starting at the backtick; returns the closing backtick. */
function skipTemplate(masked: string, open: number): number {
  let k = open + 1;
  while (k < masked.length && masked[k] !== '`') {
    if (masked[k] === '$' && masked[k + 1] === '{') {
      const close = matchClose(masked, k + 1);
      if (close === -1) return -1;
      k = close + 1;
    } else k++;
  }
  return k < masked.length ? k : -1;
}

function jsTests(source: string, masked: string): JsTest[] {
  const out: JsTest[] = [];
  // A file that defines its own `test` function is calling it, not a runner.
  const ownTest =
    /\bfunction\s+test\s*\(|\b(?:const|let|var)\s+test\s*=\s*(?:async\s*)?(?:\(|function)/.test(
      masked,
    );
  for (const m of masked.matchAll(/(?<![\w$.])(it|test)\b/g)) {
    if (m[1] === 'test' && ownTest) continue;
    let k = m.index + (m[1] as string).length;
    let ok = true;
    for (;;) {
      while (/\s/.test(masked[k] ?? '')) k++;
      if (masked[k] !== '.') break;
      k++;
      while (/\s/.test(masked[k] ?? '')) k++;
      const mod = /^[A-Za-z_$][\w$]*/.exec(masked.slice(k, k + 40))?.[0];
      if (!mod || !TEST_MODIFIERS.has(mod)) {
        ok = false;
        break;
      }
      k += mod.length;
      if (CALLED_MODIFIERS.has(mod)) {
        while (/\s/.test(masked[k] ?? '')) k++;
        const close =
          masked[k] === '('
            ? matchClose(masked, k)
            : masked[k] === '`'
              ? skipTemplate(masked, k)
              : -1;
        if (close === -1) {
          ok = false;
          break;
        }
        k = close + 1;
      }
    }
    if (!ok || masked[k] !== '(') continue;
    const close = matchClose(masked, k);
    if (close === -1) continue;
    const args = splitArgs(masked, k + 1, close);
    if (args.length < 2) continue; // `it('todo')`: a title with no body
    const title = collapse(source.slice(...(args[0] as [number, number])), 120).replace(
      /^(['"`])(.*)\1$/,
      '$2',
    );
    const fnArg = args
      .slice(1)
      .find(([a, b]) => /=>|^\s*(?:async\s+)?function\b/.test(masked.slice(a, b)));
    if (fnArg) {
      out.push({ at: m.index, title, fn: fnArg, ref: null });
      continue;
    }
    const ref = args
      .slice(1)
      .map(([a, b]) => masked.slice(a, b).trim())
      .find((t) => /^[A-Za-z_$][\w$.]*$/.test(t));
    if (ref) out.push({ at: m.index, title, fn: null, ref });
  }
  return out;
}

/** The callback's parameter list, read off the front of the function text. */
function jsParams(fnText: string): string[] {
  const t = fnText.trim().replace(/^async\s+/, '');
  const single = /^([A-Za-z_$][\w$]*)\s*=>/.exec(t);
  if (single) return [single[1] as string];
  const open = t.indexOf('(');
  if (open === -1) return [];
  const close = matchClose(t, open);
  if (close === -1) return [];
  return splitArgs(t, open + 1, close).map(([a, b]) =>
    t
      .slice(a, b)
      .trim()
      .replace(/[:=].*$/s, '')
      .trim(),
  );
}

interface JsDef {
  name: string;
  text: string;
}

/** Named functions, arrow consts and methods, with their masked text. */
function jsDefs(masked: string): JsDef[] {
  const defs: JsDef[] = [];
  const bodyFrom = (name: string, start: number, from: number): void => {
    const brace = masked.indexOf('{', from);
    if (brace === -1) return;
    const end = matchClose(masked, brace);
    if (end !== -1) defs.push({ name, text: masked.slice(start, end + 1) });
  };
  for (const m of masked.matchAll(/\bfunction\s*\*?\s*([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchClose(masked, open);
    if (close !== -1) bodyFrom(m[1] as string, m.index, close);
  }
  for (const m of masked.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+?)?=\s*(?:async\s+)?(function\b|\(|[A-Za-z_$][\w$]*\s*=>)/g,
  )) {
    const name = m[1] as string;
    const at = m.index + m[0].length - (m[2] as string).length;
    if (m[2] === 'function') {
      const open = masked.indexOf('(', at);
      const close = open === -1 ? -1 : matchClose(masked, open);
      if (close !== -1) bodyFrom(name, m.index, close);
      continue;
    }
    let k = at;
    if (masked[k] === '(') {
      k = matchClose(masked, k);
      if (k === -1) continue;
      k++;
    } else {
      k = masked.indexOf('=>', k);
    }
    const arrow = /^\s*(?::[^=]*?)?=>\s*/.exec(masked.slice(k));
    if (!arrow) continue;
    k += arrow[0].length;
    if (masked[k] === '{') {
      const end = matchClose(masked, k);
      if (end !== -1) defs.push({ name, text: masked.slice(m.index, end + 1) });
      continue;
    }
    // Expression body: to the end of the statement, or 2,000 characters.
    let depth = 0;
    let end = k;
    for (; end < masked.length && end < k + 2000; end++) {
      const c = masked[end];
      if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') {
        if (--depth < 0) break;
      } else if (c === ';' && depth === 0) break;
    }
    defs.push({ name, text: masked.slice(m.index, end) });
  }
  const KEYWORDS = new Set([
    'if',
    'for',
    'while',
    'switch',
    'catch',
    'function',
    'return',
    'it',
    'test',
    'describe',
  ]);
  for (const m of masked.matchAll(
    /^[ \t]*(?:(?:public|private|protected|static|async|override|readonly)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>()]*>)?\s*\(/gm,
  )) {
    const name = m[1] as string;
    if (KEYWORDS.has(name)) continue;
    const open = m.index + m[0].length - 1;
    const close = matchClose(masked, open);
    if (close === -1) continue;
    // A method has a block right after its parameter list (and return type).
    if (!/^\s*(?::[^{;=]+)?\{/.test(masked.slice(close + 1, close + 200))) continue;
    bodyFrom(name, m.index, close);
  }
  return defs;
}

/**
 * Checks a test makes without an assertion call:
 *
 * - `.parse()` and kin throw on bad input — that is their contract in every
 *   schema library — so a test feeding one good input is a positive check.
 * - In TypeScript, a type declaration, an annotated binding, `satisfies` or
 *   `@ts-expect-error` is checked by the compiler: a type-level test.
 */
const IMPLICIT_ASSERTION =
  /\.(?:parse|parseAsync|safeParse\w*|validateSync|decode|encode)\s*\(|\btype\s+[A-Za-z_$][\w$]*\b[^=;]*=|\binterface\s+[A-Za-z_$]|\bsatisfies\b|\b(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*:\s*[^=;]+=/;

function jsDirectlyAsserts(maskedText: string, originalText: string): boolean {
  return (
    JS_ASSERTION.test(maskedText) ||
    IMPLICIT_ASSERTION.test(maskedText) ||
    /@ts-expect-error/.test(originalText)
  );
}

/** Local names bound to an assertion library (`import { strict as a } from 'node:assert'`). */
function assertionImports(source: string, masked: string): Set<string> {
  const names = new Set<string>();
  for (const imp of importsOf(source, masked)) {
    if (!ASSERT_MODULE.test(imp.specifier)) continue;
    const stmtEnd = source.indexOf(imp.specifier, imp.index);
    const stmt = masked.slice(imp.index, stmtEnd === -1 ? imp.index + 200 : stmtEnd);
    for (const id of identsIn(stmt)) {
      if (!['import', 'from', 'as', 'type', 'const', 'let', 'var', 'require'].includes(id))
        names.add(id);
    }
  }
  for (const m of masked.matchAll(
    /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*(['"])/g,
  )) {
    const at = m.index + m[0].length;
    const spec = source.slice(at, source.indexOf(m[2] as string, at));
    if (ASSERT_MODULE.test(spec)) names.add(m[1] as string);
  }
  return names;
}

// ---- Python ----------------------------------------------------------------

const PY_ASSERTION = new RegExp(
  [
    String.raw`\bassert\b`,
    // self.assertEqual, assert_frame_equal, mock.assert_called_once_with, assert_that, tm.assert_*
    String.raw`[aA]ssert\w*\s*\(`,
    String.raw`\b(?:raises|warns|deprecated_call)\s*\(`,
    String.raw`\b(?:pytest\.|self\.)?fail\s*\(`,
    String.raw`\braise\b`,
    String.raw`\bexpect\s*\(`,
    String.raw`\b(?:check|verify|ensure)\w*\s*\(`,
  ].join('|'),
);

/** Bodies that opt out at run time: a skipped or generated test is not one that ran. */
const PY_OPT_OUT =
  /\bpytest\.(?:skip|xfail|importorskip)\s*\(|\bself\.skipTest\s*\(|\byield\b|\bskip\w*\s*\(/;
const PY_SKIP_DECORATOR = /@\s*[\w.]*\b(skip\w*|xfail|fixture|expectedFailure)\b/;

/** unittest.TestCase methods that do not assert, so a call to one proves nothing. */
const TESTCASE_PLAIN = new Set([
  'setUp',
  'tearDown',
  'subTest',
  'addCleanup',
  'enterContext',
  'skipTest',
  'id',
  'shortDescription',
  'doCleanups',
  'run',
  'debug',
]);

interface PyDef {
  name: string;
  indent: number;
  /** Offset of the `def` line's first character. */
  start: number;
  /** Offset just past the body. */
  end: number;
  /** Masked decorator lines above the def. */
  decorators: string;
  /** Masked parameter list. */
  params: string;
  /** Masked body (after the header colon). */
  body: [number, number];
  /** Defined inside another function's body. */
  nested: boolean;
  /** The class it sits directly in: its name, and whether it names a base. */
  cls: { name: string; subclass: boolean } | null;
}

const indentOf = (line: string): number => /^[ \t]*/.exec(line)?.[0].length ?? 0;

/** Every `def` in a masked Python file, with the block structure read from indentation. */
function pyDefs(masked: string, starts: readonly number[]): PyDef[] {
  const lines = masked.split('\n');
  const defs: PyDef[] = [];
  // Open blocks above the current line: [indent, kind, class info].
  const blocks: { indent: number; kind: 'def' | 'class'; cls: PyDef['cls'] }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    if (!line.trim() || /^\s*[)\]}@]/.test(line)) continue;
    const indent = indentOf(line);
    while (blocks.length && (blocks[blocks.length - 1] as { indent: number }).indent >= indent)
      blocks.pop();
    const c = /^\s*class\s+(\w+)\s*(?:\(([^)]*)\))?\s*:/.exec(line);
    if (c) {
      const bases = (c[2] ?? '').trim();
      blocks.push({
        indent,
        kind: 'class',
        cls: { name: c[1] as string, subclass: bases !== '' && bases !== 'object' },
      });
      continue;
    }
    const m = /^([ \t]*)(?:async[ \t]+)?def[ \t]+(\w+)[ \t]*\(/.exec(line);
    if (!m) continue;
    const parent = blocks[blocks.length - 1];
    const nested = blocks.some((b) => b.kind === 'def');
    blocks.push({ indent, kind: 'def', cls: null });
    const start = starts[i] as number;
    const open = start + m[0].length - 1;
    const close = matchClose(masked, open);
    if (close === -1) continue;
    const colon = masked.indexOf(':', close);
    if (colon === -1) continue;
    const colonLine = lineOf(starts, colon) - 1;
    let last = colonLine;
    for (let j = colonLine + 1; j < lines.length; j++) {
      const l = lines[j] as string;
      if (!l.trim() || /^\s*[)\]}]/.test(l)) continue;
      if (indentOf(l) <= indent) break;
      last = j;
    }
    const end = (starts[last] as number) + (lines[last] as string).length;
    // Decorators: `@` lines at the def's own indent, with the continuation
    // lines of a multi-line `@parametrize(` between them.
    let top = i;
    for (let d = i - 1; d >= 0; d--) {
      const l = lines[d] as string;
      if (/^\s*@/.test(l) && indentOf(l) === indent) top = d;
      else if (!(l.trim() && (indentOf(l) > indent || /^\s*[)\]}]/.test(l)))) break;
    }
    defs.push({
      name: m[2] as string,
      indent,
      start,
      end,
      decorators: lines.slice(top, i).join('\n'),
      params: masked.slice(open + 1, close),
      body: [colon + 1, end],
      nested,
      cls: parent?.kind === 'class' ? parent.cls : null,
    });
  }
  return defs;
}

/** One logical line from `from`: to the newline at bracket depth 0 (no trailing backslash). */
function pyStatementEnd(masked: string, from: number): number {
  let depth = 0;
  for (let k = from; k < masked.length; k++) {
    const c = masked[k];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === '\n' && depth <= 0 && masked[k - 1] !== '\\') return k;
  }
  return masked.length;
}

// ---- Tautologies ---------------------------------------------------------

const NUMBER = String.raw`-?(?:0[xXoObB][\da-fA-F_]+|\d[\d_]*(?:\.[\d_]*)?(?:[eE][-+]?\d+)?)`;
const JS_LITERAL = new RegExp(
  `^(?:true|false|null|undefined|NaN|${NUMBER}n?|'[^']*'|"[^"]*"|\`[^\`$]*\`|\\[\\]|\\{\\})$`,
);
const PY_LITERAL = new RegExp(
  `^(?:True|False|None|${NUMBER}[jJ]?|[rbuRBUfF]{0,2}(?:'[^']*'|"[^"]*"))$`,
);
/**
 * A bare name. Not an attribute chain: `obj.flags is obj.flags` checks that a
 * property is cached, and a getter can return something new on every read.
 */
const BARE_NAME = /^[A-Za-z_$][\w$]*$/;

const jsTruthy = (lit: string): boolean => {
  if (lit === 'true' || lit === '[]' || lit === '{}') return true;
  if (/^-?\d/.test(lit)) return !/^-?0+(\.0*)?n?$/.test(lit);
  return /^(['"`]).+\1$/.test(lit);
};
const pyTruthy = (lit: string): boolean =>
  lit === 'True' ||
  (/^-?\d/.test(lit) && !/^-?0+(\.0*)?j?$/.test(lit)) ||
  /^[rbuRBUfF]{0,2}(['"]).+\1$/.test(lit);

function jsTautologies(source: string, masked: string): { at: number; why: string }[] {
  const out: { at: number; why: string }[] = [];
  const text = (span: [number, number]): string => normalise(source.slice(...span));
  for (const m of masked.matchAll(/(?<![\w$.])expect\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchClose(masked, open);
    if (close === -1) continue;
    const args = splitArgs(masked, open + 1, close);
    if (args.length !== 1) continue;
    const subject = text(args[0] as [number, number]);
    const matcher =
      /^\s*\.\s*(toBe|toEqual|toStrictEqual|toBeTruthy|toBeFalsy|toBeNull|toBeUndefined|toBeDefined|toBeNaN)\s*\(/.exec(
        masked.slice(close + 1, close + 60),
      );
    if (!matcher) continue;
    const mOpen = close + 1 + matcher[0].length - 1;
    const mClose = matchClose(masked, mOpen);
    if (mClose === -1) continue;
    const margs = splitArgs(masked, mOpen + 1, mClose);
    const name = matcher[1] as string;
    const literal = JS_LITERAL.test(subject);
    let why: string | null = null;
    if (['toBe', 'toEqual', 'toStrictEqual'].includes(name)) {
      if (
        margs.length === 1 &&
        text(margs[0] as [number, number]) === subject &&
        (literal || BARE_NAME.test(subject))
      ) {
        why = `${subject} is compared with itself`;
      }
    } else if (literal && margs.length === 0) {
      const holds =
        (name === 'toBeTruthy' && jsTruthy(subject)) ||
        (name === 'toBeFalsy' && !jsTruthy(subject)) ||
        (name === 'toBeNull' && subject === 'null') ||
        (name === 'toBeUndefined' && subject === 'undefined') ||
        (name === 'toBeDefined' && subject !== 'undefined') ||
        (name === 'toBeNaN' && subject === 'NaN');
      if (holds) why = `the literal ${subject} always satisfies ${name}`;
    }
    if (why) out.push({ at: m.index, why });
  }
  // assert(true), assert.ok(1), assert.equal(x, x), t.is(x, x), t.true(true)
  for (const m of masked.matchAll(
    /(?<![\w$.])(?:assert(?:\.(ok|equal|strictEqual|deepEqual|deepStrictEqual))?|t\.(is|same|deepEqual|equal|strictSame|true|truthy|ok))\s*\(/g,
  )) {
    const open = m.index + m[0].length - 1;
    const close = matchClose(masked, open);
    if (close === -1) continue;
    const args = splitArgs(masked, open + 1, close).map((s) => text(s));
    const method = m[1] ?? m[2];
    const unary = method === undefined || ['ok', 'true', 'truthy'].includes(method);
    if (unary) {
      if (args[0] !== undefined && JS_LITERAL.test(args[0]) && jsTruthy(args[0])) {
        out.push({ at: m.index, why: `the literal ${args[0]} is always truthy` });
      }
    } else if (
      args[0] !== undefined &&
      args[0] === args[1] &&
      (JS_LITERAL.test(args[0]) || BARE_NAME.test(args[0]))
    ) {
      out.push({ at: m.index, why: `${args[0]} is compared with itself` });
    }
  }
  return out;
}

function pyTautologies(source: string, masked: string): { at: number; why: string }[] {
  const out: { at: number; why: string }[] = [];
  const text = (a: number, b: number): string => normalise(source.slice(a, b));
  // Python's `==` runs the operands' own `__eq__`, so `assert x == x` checks
  // reflexivity, which a test of a custom type may mean to. Only literals,
  // and `is` on a bare name, hold whatever the code does.
  const sameOperands = (a: string, b: string, op: string): boolean =>
    a === b && (PY_LITERAL.test(a) || (op === 'is' && BARE_NAME.test(a)));

  for (const m of masked.matchAll(/^[ \t]*assert\b/gm)) {
    const from = m.index + m[0].length;
    const end = pyStatementEnd(masked, from);
    const parts = splitArgs(masked, from, end);
    if (parts.length === 0) continue;
    const [a, b] = parts[0] as [number, number];
    const cond = text(a, b);
    let why: string | null = null;
    const trimmedStart = a + (masked.slice(a, b).length - masked.slice(a, b).trimStart().length);
    if (
      masked[trimmedStart] === '(' &&
      matchClose(masked, trimmedStart) === masked.slice(0, b).trimEnd().length - 1
    ) {
      const inner = splitArgs(masked, trimmedStart + 1, matchClose(masked, trimmedStart));
      if (inner.length >= 2)
        why = 'a non-empty tuple is always true (the parentheses swallowed the message)';
    }
    if (!why && PY_LITERAL.test(cond) && pyTruthy(cond)) why = `the literal ${cond} is always true`;
    if (!why && /^not(?:False|None|0|''|"")$/.test(cond)) why = `${cond} is always true`;
    if (!why) {
      const seg = masked.slice(a, b);
      const op = /\s(==|is)\s(?!\s*not\b)/.exec(seg);
      if (op && seg.split(/==|\bis\b/).length === 2 && !/\bnot\s+in\b|\bin\b/.test(seg)) {
        const left = text(a, a + op.index);
        const right = text(a + op.index + op[0].length, b);
        if (sameOperands(left, right, op[1] as string)) why = `${left} is compared with itself`;
      }
    }
    if (why) out.push({ at: m.index + m[0].length - 6, why });
  }

  for (const m of masked.matchAll(
    /\bself\.(assertTrue|assertFalse|assertEqual|assertEquals|assertIs|assertIsNone|assertIsNotNone|assertListEqual|assertDictEqual|assertCountEqual)\s*\(/g,
  )) {
    const open = m.index + m[0].length - 1;
    const close = matchClose(masked, open);
    if (close === -1) continue;
    const args = splitArgs(masked, open + 1, close).map(([a, b]) => text(a, b));
    const name = m[1] as string;
    const first = args[0] ?? '';
    let why: string | null = null;
    if (name === 'assertTrue' && PY_LITERAL.test(first) && pyTruthy(first))
      why = `the literal ${first} is always true`;
    else if (name === 'assertFalse' && PY_LITERAL.test(first) && !pyTruthy(first))
      why = `the literal ${first} is always false`;
    else if (name === 'assertIsNone' && first === 'None') why = 'None is None';
    else if (name === 'assertIsNotNone' && PY_LITERAL.test(first) && first !== 'None')
      why = `the literal ${first} is never None`;
    else if (
      args.length >= 2 &&
      sameOperands(first, args[1] as string, name === 'assertIs' ? 'is' : '==')
    ) {
      why = `${first} is compared with itself`;
    }
    if (why) out.push({ at: m.index, why });
  }
  return out;
}

// ---- The pass --------------------------------------------------------------

/**
 * Tests that test nothing, across a snapshot. `files` is every file read —
 * helpers in non-test support files are part of what a test can call.
 */
export function testIntegrity(files: readonly SourceFile[]): TestIntegrityFinding[] {
  const out: TestIntegrityFinding[] = [];
  // Every code path resolves imports; only tests and their support files are read.
  const codePaths = new Set(files.filter((f) => CODE.test(f.path)).map((f) => f.path));
  const js = files.filter(
    (f) =>
      CODE.test(f.path) &&
      (isJsTest(f.path) || (SUPPORT_PATH.test(f.path) && !FIXTURE_PATH.test(f.path))),
  );
  const py = files.filter(
    (f) =>
      f.path.endsWith('.py') &&
      (isPyTest(f.path) || (SUPPORT_PATH.test(f.path) && !FIXTURE_PATH.test(f.path))),
  );
  const jsMasked = new Map(js.map((f) => [f.path, maskSource(f.source)]));
  const pyMasked = new Map(py.map((f) => [f.path, maskPython(f.source, true)]));

  // Helper tables, from test files and test-support files only: production
  // code that throws is the SUBJECT, and counting it would excuse every test.
  const jsTable = new Map<string, { direct: boolean; mentions: Set<string> }[]>();
  for (const f of js) {
    const masked = jsMasked.get(f.path) as string;
    for (const def of jsDefs(masked)) {
      const list = jsTable.get(def.name) ?? [];
      list.push({ direct: JS_ASSERTION.test(def.text), mentions: identsIn(def.text) });
      jsTable.set(def.name, list);
    }
  }
  const jsAsserting = assertingNames(jsTable);

  const pyTable = new Map<string, { direct: boolean; mentions: Set<string> }[]>();
  const pyDefsByFile = new Map<string, PyDef[]>();
  for (const f of py) {
    const masked = pyMasked.get(f.path) as string;
    const defs = pyDefs(masked, lineIndex(f.source));
    pyDefsByFile.set(f.path, defs);
    for (const def of defs) {
      const body = masked.slice(...def.body);
      const list = pyTable.get(def.name) ?? [];
      list.push({ direct: PY_ASSERTION.test(body), mentions: identsIn(body) });
      pyTable.set(def.name, list);
    }
  }
  const pyAsserting = assertingNames(pyTable);
  const pyDefined = new Set(pyTable.keys());

  for (const f of js) {
    if (!isJsTest(f.path)) continue;
    const masked = jsMasked.get(f.path) as string;
    const starts = lineIndex(f.source);
    const push = (
      ruleId: TestIntegrityRuleId,
      at: number,
      title: string,
      message: string,
      evidence?: string,
    ): void => {
      const line = lineOf(starts, at);
      out.push({
        ruleId,
        file: f.path,
        line,
        title,
        evidence: evidence ?? lineText(f.source, starts, line),
        message,
      });
    };

    // --- no assertion
    const assertLib = assertionImports(f.source, masked);
    const asserting = new Set([...jsAsserting, ...assertLib]);
    // A hook that asserts (or demands assertions) covers every test it wraps.
    const hookAsserts = [...masked.matchAll(/(?<![\w$.])(?:before|after)Each\s*\(/g)].some((h) => {
      const open = h.index + h[0].length - 1;
      const close = matchClose(masked, open);
      return close !== -1 && JS_ASSERTION.test(masked.slice(open, close));
    });
    if (!hookAsserts) {
      for (const t of jsTests(f.source, masked)) {
        if (SMOKE_TITLE.test(t.title)) continue;
        if (t.fn) {
          const [a, b] = t.fn;
          const fnText = masked.slice(a, b);
          const params = jsParams(fnText);
          // A done callback (mocha's only parameter, node:test's second) is
          // an assertion that something gets called: the test times out if not.
          if (
            params.some((p) => DONE_PARAM.test(p)) ||
            /^[A-Za-z_$][\w$]*$/.test(params[1] ?? '')
          ) {
            continue;
          }
          if (SMOKE_TITLE.test(f.source.slice(a, b).replace(/\s+/g, ' '))) continue;
          if (jsDirectlyAsserts(fnText, f.source.slice(a, b))) continue;
          if (mentionsAny(fnText, asserting)) continue;
          const ctx = params[0];
          // tap's `({ same, end }) =>`: the assertion methods, destructured.
          const destructured = ctx?.startsWith('{') ? [...identsIn(ctx)] : [];
          const contextNames = new Set(CONTEXT_ASSERTIONS.split('|'));
          if (destructured.some((n) => contextNames.has(n) && mentionsAny(fnText, new Set([n]))))
            continue;
          if (
            ctx &&
            /^[A-Za-z_$][\w$]*$/.test(ctx) &&
            new RegExp(`\\b${ctx.replace(/\$/g, '\\$')}\\.(?:${CONTEXT_ASSERTIONS})\\b`).test(
              fnText,
            )
          ) {
            continue;
          }
        } else {
          // Passed by reference: judged only when its definition is in hand
          // and asserts nothing anywhere.
          const name = (t.ref as string).split('.').pop() as string;
          if (!jsTable.has(name) || asserting.has(name)) continue;
        }
        push(
          NO_ASSERTION_RULE_ID,
          t.at,
          `Test with no assertion: ${t.title}`,
          'This test calls code but never checks a result: no expect/assert, no assertion helper, ' +
            'nothing that throws on a wrong answer. It passes for as long as nothing throws, so it ' +
            'counts as coverage for behaviour it never verifies.',
        );
      }
    }

    // --- tautology
    for (const t of jsTautologies(f.source, masked)) {
      push(
        TAUTOLOGY_RULE_ID,
        t.at,
        'Assertion that cannot fail',
        `This assertion holds whatever the code under test does: ${t.why}. It is green on every run and checks nothing.`,
      );
    }

    // --- swallowed failure
    for (const m of masked.matchAll(/(?<![\w$.])try\s*\{/g)) {
      const open = m.index + m[0].length - 1;
      const close = matchClose(masked, open);
      if (close === -1) continue;
      const c = /^\s*catch\s*(?:\([^)]*\))?\s*\{/.exec(masked.slice(close + 1, close + 200));
      if (!c) continue;
      const cOpen = close + 1 + c[0].length - 1;
      const cClose = matchClose(masked, cOpen);
      if (cClose === -1) continue;
      const tryBody = masked.slice(open + 1, close);
      // Only an assertion the text itself spells: whether a helper called in
      // a try asserts is a guess, and this rule's claim is that a check WAS
      // swallowed.
      if (!/(?<![\w$.])(?:expect|assert)\w*\s*[(.]|\.should\b/.test(tryBody)) continue;
      let catchBody = masked.slice(cOpen + 1, cClose);
      for (const log of [
        ...catchBody.matchAll(/(?<![\w$.])(?:console|logger|log|this\.log\w*)\s*\.\s*\w+\s*\(/g),
      ].reverse()) {
        const lOpen = log.index + log[0].length - 1;
        const lClose = matchClose(catchBody, lOpen);
        if (lClose === -1) break;
        catchBody = catchBody.slice(0, log.index) + catchBody.slice(lClose + 1);
      }
      if (catchBody.replace(/[\s;]/g, '') !== '') continue;
      push(
        SWALLOWED_FAILURE_RULE_ID,
        close,
        'Assertion failure swallowed by a catch',
        'An assertion fails by throwing. This one sits in a try whose catch is empty or only logs, ' +
          'so a failing check is caught and the test passes anyway.',
        collapse(f.source.slice(close, cClose + 1)),
      );
    }

    // --- mocks its own subject
    const stemMatch =
      /([^/]+?)\.(?:test|spec)\.[cm]?[jt]sx?$/.exec(f.path) ??
      /__tests__\/([^/]+?)\.[cm]?[jt]sx?$/.exec(f.path);
    if (stemMatch) {
      const stem = stemMatch[1] as string;
      const stemOf = (p: string): string => {
        const parts = p.split('/');
        const base = (parts.pop() as string).replace(/\.[cm]?[jt]sx?$/, '').replace(/\.d$/, '');
        return base === 'index' ? (parts.pop() ?? base) : base;
      };
      const imports = importsOf(f.source, masked).filter(
        (i) => !/^import\s+type\b/.test(f.source.slice(i.index, i.index + 12)),
      );
      const targetOf = (spec: string): string =>
        resolveSpecifier(f.path, spec, codePaths) ?? `?${spec.replace(/\.[cm]?[jt]sx?$/, '')}`;
      for (const m of masked.matchAll(
        /(?<![\w$.])(?:vi|jest)\s*\.\s*(?:mock|doMock|unstable_mockModule)\s*\(/g,
      )) {
        const open = m.index + m[0].length - 1;
        const close = matchClose(masked, open);
        if (close === -1) continue;
        const args = splitArgs(masked, open + 1, close);
        if (args.length === 0) continue;
        const first = f.source.slice(...(args[0] as [number, number])).trim();
        const spec = /^(?:import\s*\(\s*)?(['"`])(\.[^'"`]*)\1\s*\)?$/.exec(first)?.[2];
        if (!spec) continue;
        const target = targetOf(spec);
        if (target === f.path) continue;
        if ((target.startsWith('?') ? stemOf(spec) : stemOf(target)) !== stem) continue;
        // A factory that keeps the real module (importActual, importOriginal,
        // spy: true) replaces a collaborator INSIDE it, which is legitimate.
        if (
          args.length > 1 &&
          /importActual|requireActual|importOriginal|requireMock|\bspy\s*:\s*true/.test(
            masked.slice((args[1] as [number, number])[0], close),
          )
        ) {
          continue;
        }
        const fromSubject = imports.filter(
          (i) => i.specifier.startsWith('.') && targetOf(i.specifier) === target,
        );
        if (fromSubject.length === 0) continue;
        // Another production module imported beside it may be the real
        // subject, with this mock only its collaborator.
        const other = imports.some((i) => {
          if (!i.specifier.startsWith('.') || targetOf(i.specifier) === target) return false;
          const t = targetOf(i.specifier);
          return (
            !SUPPORT_PATH.test(t) &&
            !FIXTURE_PATH.test(t) &&
            !isJsTest(t) &&
            !/\.(json|css|scss|svg|png)$/.test(i.specifier)
          );
        });
        if (other) continue;
        if (imports.some((i) => /^(@\/|~\/|#|src\/)/.test(i.specifier))) continue;
        // The finding is the test CALLING the mock: a name taken from the
        // subject, called directly in a test — not configured via vi.mocked().
        const names = new Set<string>();
        for (const i of fromSubject) {
          const stmtEnd = f.source.indexOf(i.specifier, i.index);
          const stmt = masked.slice(i.index, stmtEnd === -1 ? i.index : stmtEnd);
          for (const id of identsIn(
            stmt.replace(/^\s*(?:import|export)\b/, '').replace(/\bfrom\s*['"`]?\s*$/, ''),
          )) {
            if (
              !['as', 'type', 'from', 'const', 'let', 'var', 'await', 'import', 'require'].includes(
                id,
              )
            )
              names.add(id);
          }
        }
        const calls = [...names].some((n) =>
          new RegExp(
            `(?<![\\w$.])${n.replace(/\$/g, '\\$')}(?:\\s*\\.\\s*[A-Za-z_$][\\w$]*)?\\s*\\(|<${n.replace(/\$/g, '\\$')}[\\s/>]|\\bnew\\s+${n.replace(/\$/g, '\\$')}\\b`,
          ).test(
            masked.replace(/\b(?:vi|jest)\s*\.\s*(?:mocked|mock|doMock|spyOn)\s*\([^)]*\)/g, ''),
          ),
        );
        if (!calls) continue;
        push(
          MOCKS_SUBJECT_RULE_ID,
          m.index,
          `Test mocks its own subject: ${spec}`,
          `${f.path} is named for ${spec}, replaces that whole module with a mock, and then calls it. ` +
            "What runs is the mock, so the test checks the mock's configured answers, not the module.",
        );
      }
    }
  }

  for (const f of py) {
    if (!isPyTest(f.path)) continue;
    const masked = pyMasked.get(f.path) as string;
    const starts = lineIndex(f.source);
    const defs = pyDefsByFile.get(f.path) as PyDef[];
    const push = (
      ruleId: TestIntegrityRuleId,
      at: number,
      title: string,
      message: string,
      evidence?: string,
    ): void => {
      const line = lineOf(starts, at);
      out.push({
        ruleId,
        file: f.path,
        line,
        title,
        evidence: evidence ?? lineText(f.source, starts, line),
        message,
      });
    };

    // --- no assertion
    for (const def of defs) {
      if (!/^test/.test(def.name)) continue;
      if (PY_SKIP_DECORATOR.test(def.decorators)) continue;
      if (/\bbenchmark\b/.test(def.params)) continue;
      if (SMOKE_TITLE.test(titleWords(def.name))) continue;
      // pytest collects module-level functions and class methods only; a
      // `def test_x` nested in another function is a local helper.
      if (def.nested) continue;
      // Methods count only in a class pytest or unittest collects: `Test*`, or
      // one with a base (a TestCase). A helper class's `test_method` is data.
      const cls = def.cls;
      if (def.indent > 0 && (!cls || !(/^Test/.test(cls.name) || cls.subclass))) continue;
      const body = masked.slice(...def.body);
      // A comment or docstring can declare the smoke contract too
      // ("No exceptions should be raised").
      if (SMOKE_TITLE.test(f.source.slice(...def.body).replace(/\s+/g, ' '))) continue;
      // An empty method in a subclass overrides an inherited test to switch
      // it off; at module level, an empty test is a placeholder and reported.
      if (body.replace(/\bpass\b|\.\.\.|['"\s]/g, '') === '' && cls?.subclass) continue;
      if (PY_OPT_OUT.test(body) || PY_ASSERTION.test(body)) continue;
      if (mentionsAny(body, pyAsserting) || mentionsAny(def.params, pyAsserting)) continue;
      // An inherited helper this snapshot does not define could assert.
      if (
        [...body.matchAll(/\bself\.(\w+)\s*\(/g)].some(
          (c) => !pyDefined.has(c[1] as string) && !TESTCASE_PLAIN.has(c[1] as string),
        )
      ) {
        continue;
      }
      push(
        NO_ASSERTION_RULE_ID,
        def.start + def.indent,
        `Test with no assertion: ${def.name}`,
        'This test calls code but never checks a result: no assert, no assertion helper, no ' +
          'pytest.raises. It passes for as long as nothing raises, so it counts as coverage for ' +
          'behaviour it never verifies.',
      );
    }

    // --- tautology
    for (const t of pyTautologies(f.source, masked)) {
      push(
        TAUTOLOGY_RULE_ID,
        t.at,
        'Assertion that cannot fail',
        `This assertion holds whatever the code under test does: ${t.why}. It is green on every run and checks nothing.`,
      );
    }

    // --- swallowed failure
    const lines = masked.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const tm = /^([ \t]*)try\s*:\s*$/.exec(lines[i] as string);
      if (!tm) continue;
      const indent = (tm[1] as string).length;
      let j = i + 1;
      while (
        j < lines.length &&
        (!(lines[j] as string).trim() || indentOf(lines[j] as string) > indent)
      )
        j++;
      const tryBody = lines.slice(i + 1, j).join('\n');
      if (!/\bassert\b|[aA]ssert\w*\s*\(/.test(tryBody)) continue;
      // `try: check(); pytest.fail(...) except AssertionError: pass` is the
      // idiom for "this assertion must FAIL": the assertion is the thing under
      // test, and the fail()/raise is what catches it passing.
      if (/\b(?:pytest\.fail|self\.fail|fail)\s*\(|\braise\b/.test(tryBody)) continue;
      const handlers: { at: number; end: number; swallows: boolean }[] = [];
      while (j < lines.length) {
        const header = /^[ \t]*except\b([^:]*):(.*)$/.exec(lines[j] as string);
        if (!header || indentOf(lines[j] as string) !== indent) break;
        const types = (header[1] as string).replace(/\bas\s+\w+\s*$/, '').trim();
        let k = j + 1;
        while (
          k < lines.length &&
          (!(lines[k] as string).trim() || indentOf(lines[k] as string) > indent)
        ) {
          k++;
        }
        let body = `${header[2] as string}\n${lines.slice(j + 1, k).join('\n')}`;
        for (const log of [
          ...body.matchAll(
            /\b(?:print|(?:logging|logger|log|LOGGER|_log|self\.log\w*)\.\w+|warnings\.warn|traceback\.print_exc)\s*\(/g,
          ),
        ].reverse()) {
          const lOpen = log.index + log[0].length - 1;
          const lClose = matchClose(body, lOpen);
          if (lClose === -1) break;
          body = body.slice(0, log.index) + body.slice(lClose + 1);
        }
        // Only a handler that can catch AssertionError swallows one.
        const catchesAssertion =
          types === '' || /\b(Exception|BaseException|AssertionError)\b/.test(types);
        handlers.push({
          at: (starts[j] as number) + indentOf(lines[j] as string),
          end: starts[k] ?? f.source.length,
          swallows: catchesAssertion && body.replace(/\bpass\b|\.\.\.|[\s;]/g, '') === '',
        });
        j = k;
      }
      // An `else:` runs only when nothing was raised, which is where the
      // "should have failed" check of that same idiom lives.
      if (
        j < lines.length &&
        indentOf(lines[j] as string) === indent &&
        /^\s*else\s*:/.test(lines[j] as string)
      ) {
        continue;
      }
      for (const h of handlers.filter((x) => x.swallows)) {
        push(
          SWALLOWED_FAILURE_RULE_ID,
          h.at,
          'Assertion failure swallowed by an except',
          'An assertion fails by raising AssertionError. This one sits in a try whose except ' +
            'catches it and only passes or logs, so a failing check lets the test pass anyway.',
          collapse(f.source.slice(h.at, h.end)),
        );
      }
    }

    // --- mocks its own subject
    const stem =
      /(?:^|\/)test_([^/]+)\.py$/.exec(f.path)?.[1] ??
      /(?:^|\/)([^/]+)_test\.py$/.exec(f.path)?.[1];
    if (stem) {
      // How this file can reach the subject module: `import a.foo as x`,
      // `from a import foo`, `import foo`.
      const aliases = new Set<string>();
      for (const m of masked.matchAll(/^[ \t]*import[ \t]+([\w.]+)(?:[ \t]+as[ \t]+(\w+))?/gm)) {
        const mod = m[1] as string;
        if (mod.split('.').pop() === stem) aliases.add(m[2] ?? mod);
      }
      for (const m of masked.matchAll(/^[ \t]*from[ \t]+[\w.]+[ \t]+import[ \t]+\(?([^)\n]*)/gm)) {
        for (const part of (m[1] as string).split(',')) {
          const [name, alias] = part.trim().split(/\s+as\s+/);
          if (name === stem) aliases.add(alias ?? name);
        }
      }
      for (const def of defs) {
        if (!/^test/.test(def.name)) continue;
        const scope = `${def.decorators}\n${masked.slice(...def.body)}`;
        const calls = (path: string, attr: string): boolean =>
          new RegExp(`(?<![\\w.])${path.replace(/\./g, '\\.')}\\.${attr}\\s*\\(`).test(scope);
        const flagged: { at: number; target: string }[] = [];
        const regions: [number, number][] = [
          [def.start - def.decorators.length - (def.decorators ? 1 : 0), def.start],
          def.body,
        ];
        for (const [ra, rb] of regions) {
          const region = masked.slice(ra, rb);
          for (const m of region.matchAll(
            /(?<![\w.])(?:(?:unittest\.)?mock\.|mocker\.)?patch(\.object|\.dict)?\s*\(/g,
          )) {
            const open = ra + m.index + m[0].length - 1;
            const close = matchClose(masked, open);
            if (close === -1) continue;
            const args = splitArgs(masked, open + 1, close);
            if (args.length === 0) continue;
            if (/\bwraps\s*=/.test(masked.slice(open, close))) continue;
            const firstRaw = f.source.slice(...(args[0] as [number, number])).trim();
            const kind = m[1];
            if (kind === '.object') {
              const attr = /^(['"])(\w+)\1$/.exec(
                f.source.slice(...((args[1] ?? [0, 0]) as [number, number])).trim(),
              )?.[2];
              if (attr && aliases.has(firstRaw) && calls(firstRaw, attr))
                flagged.push({ at: ra + m.index, target: `${firstRaw}.${attr}` });
              continue;
            }
            const target = /^(['"])([\w.]+)\1$/.exec(firstRaw)?.[2];
            if (kind === '.dict') {
              if (firstRaw === 'sys.modules' && args[1]) {
                const keys = [
                  ...f.source
                    .slice(...(args[1] as [number, number]))
                    .matchAll(/(['"])([\w.]+)\1\s*:/g),
                ].map((k) => k[2] as string);
                const hit = keys.find((k) => k.split('.').pop() === stem);
                if (hit && aliases.size > 0) flagged.push({ at: ra + m.index, target: hit });
              }
              continue;
            }
            if (!target) continue;
            const segs = target.split('.');
            if (segs[segs.length - 1] === stem) {
              // The whole module, and the test then calls through that path.
              if (
                new RegExp(`(?<![\\w.])${target.replace(/\./g, '\\.')}\\.\\w+\\s*\\(`).test(scope)
              ) {
                flagged.push({ at: ra + m.index, target });
              }
            } else if (segs.length >= 2 && segs[segs.length - 2] === stem) {
              const attr = segs[segs.length - 1] as string;
              const via = [...aliases, segs.slice(0, -1).join('.')];
              if (via.some((a) => calls(a, attr))) flagged.push({ at: ra + m.index, target });
            }
          }
        }
        for (const hit of flagged) {
          push(
            MOCKS_SUBJECT_RULE_ID,
            hit.at,
            `Test mocks its own subject: ${hit.target}`,
            `${f.path} is named for the module ${stem}, patches ${hit.target} with a mock, and then ` +
              "calls it through the module. What runs is the mock, so the test checks the mock's " +
              'configured answers, not the code.',
          );
        }
      }
    }
  }

  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
