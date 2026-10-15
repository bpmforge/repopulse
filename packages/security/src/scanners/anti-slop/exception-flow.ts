import { CODE, lineAt, maskSource } from './source-graph.js';
import { braceAt, braceTree, looksMinified, skipSpace, type Brace } from './js-blocks.js';
import {
  PYTHON,
  PY_TEST_PATH,
  blockEnd,
  logicalLines,
  maskPython,
  parentsOf,
  type PyLine,
} from './python-source.js';

// Exception control flow (W18-09, R-03, mechanical-checks plan §E).
//
// A `throw` whose only catcher is a `catch` a few lines below it in the SAME
// function is a goto with a stack trace: the exception never leaves, so it is
// not reporting a failure to anyone — it is choosing a branch, expensively and
// invisibly. The fix is the branch itself (return early, an if/else, a result
// value), and the smell is common in model-written code because "validate, throw,
// catch, return an error response" reads like robustness.
//
// WHAT DOES NOT COUNT, because the throw does leave or is not this function's:
//   - a throw inside a nested function, arrow or method (a callback's throw
//     is caught by whoever calls the callback, not this try);
//   - a try with only `finally`;
//   - a handler that can throw or raise anywhere outside a nested function
//     (`catch (e) { cleanup(); throw e }`, `if (!retryable(e)) throw e`): it
//     is a filter, and the error it caught may still leave. Only a handler
//     that always swallows makes the throw a pure branch — and that is also
//     the case nobody downstream can ever see;
//   - `throw err` or `throw this.failure`, passing along an error that already
//     exists, and in Python a bare `raise` or a raise of a variable whose
//     class the text does not name;
//   - Python: a raise the handlers cannot catch (`raise KeyError` under
//     `except ValueError`);
//   - test files, where raise-and-catch is how a test proves a handler works.

export const EXCEPTION_FLOW_RULE_ID = 'slop.exception_control_flow';

export interface ExceptionFlow {
  ruleId: typeof EXCEPTION_FLOW_RULE_ID;
  file: string;
  /** Line of the first throw/raise the local handler catches. */
  line: number;
  /** Line of the handler that catches it. */
  handlerLine: number;
  /** How many throw/raise statements in the try body the handler catches. */
  throws: number;
  /** The throw line, verbatim — the evidence quote. */
  statement: string;
  message: string;
}

const JS_TEST_PATH = /(\.(test|spec)\.[cm]?[jt]sx?$)|(^|\/)(__tests__|__mocks__|tests?|e2e)\//;
const FIXTURE_PATH = /(^|\/)(fixtures?|__fixtures__|testdata|test-data)\//;

interface Pair {
  throwAt: number;
  handlerAt: number;
  key: number;
}

/** A `throw` statement keyword (not `gen.throw(…)`, not part of a word). */
const THROW = /(?<![\w$.])throw\b/g;

function jsFlows(path: string, source: string): ExceptionFlow[] {
  const masked = maskSource(source);
  const braces = braceTree(masked);
  if (!braces) return [];

  // Each try body (by brace index) → its catch body brace, when it has one.
  const catchOf = new Map<number, number>();
  for (const m of masked.matchAll(/\btry\s*\{/g)) {
    const body = braceAt(braces, m.index + m[0].length - 1);
    if (body === -1) continue;
    let k = skipSpace(masked, (braces[body] as Brace).close + 1);
    if (!masked.startsWith('catch', k) || /[\w$]/.test(masked[k + 5] ?? '')) continue;
    k = skipSpace(masked, k + 5);
    if (masked[k] === '(') {
      let depth = 0;
      for (; k < masked.length; k++) {
        if (masked[k] === '(') depth++;
        else if (masked[k] === ')' && --depth === 0) break;
      }
      k = skipSpace(masked, k + 1);
    }
    if (masked[k] !== '{') continue;
    const handler = braceAt(braces, k);
    if (handler !== -1) catchOf.set(body, handler);
  }
  if (catchOf.size === 0) return [];

  /** Innermost brace around an offset, or -1. */
  const around = (at: number): number => {
    let inner = -1;
    for (let b = 0; b < braces.length; b++) {
      const brace = braces[b] as Brace;
      if (brace.open > at) break;
      if (brace.close > at) inner = b;
    }
    return inner;
  };

  // A handler that can throw at all — `throw err`, `if (!retryable(e)) throw
  // e`, a wrapped error — is a FILTER: the throw it catches may still leave.
  // Only a handler that always swallows makes the throw a pure branch.
  const rethrows = new Set<number>();
  const throws = [...masked.matchAll(THROW)].map((m) => m.index);
  for (const at of throws) {
    for (let b = around(at); b !== -1; b = (braces[b] as Brace).parent) {
      if ((braces[b] as Brace).kind === 'function') break;
      rethrows.add(b);
    }
  }

  const pairs: Pair[] = [];
  for (const at of throws) {
    // `throw err` / `throw this.failure`: passing along an error that already
    // exists, not raising one to branch on.
    if (!/^throw\s+(?:new\b|[\w$.]+\s*\()/.test(masked.slice(at, at + 200))) continue;
    // Walk outwards: the first function boundary ends the search; the first
    // try body with a catch is the one that catches it.
    for (let b = around(at); b !== -1; b = (braces[b] as Brace).parent) {
      const brace = braces[b] as Brace;
      if (brace.kind === 'function') break;
      const handler = catchOf.get(b);
      if (handler === undefined) continue;
      if (!rethrows.has(handler)) {
        pairs.push({ throwAt: at, handlerAt: (braces[handler] as Brace).open, key: b });
      }
      break;
    }
  }
  return report(path, source, pairs, (at) => lineAt(source, at));
}

// ---- Python -----------------------------------------------------------------

/**
 * Does any line in [from, to) raise, outside a nested def or class? A handler
 * that can raise is a filter, like its JS counterpart above.
 */
function raisesWithin(lines: readonly PyLine[], from: number, to: number): boolean {
  let nested = Infinity;
  for (let k = from; k < to; k++) {
    const l = lines[k] as PyLine;
    if (l.indent <= nested) nested = Infinity;
    if (nested !== Infinity) continue;
    if (/^(async\s+)?def\b|^class\b/.test(l.text)) nested = l.indent;
    else if (/^raise\b/.test(l.text) || /:\s*raise\b/.test(l.text)) return true;
  }
  return false;
}

/** What `except X` catches beyond X itself, for the builtins people raise. */
const CAUGHT_BY: Record<string, readonly string[]> = {
  LookupError: ['KeyError', 'IndexError'],
  ArithmeticError: ['ZeroDivisionError', 'OverflowError', 'FloatingPointError'],
  OSError: [
    'IOError',
    'FileNotFoundError',
    'FileExistsError',
    'PermissionError',
    'TimeoutError',
    'ConnectionError',
    'IsADirectoryError',
    'NotADirectoryError',
  ],
  ValueError: ['UnicodeError', 'UnicodeDecodeError', 'UnicodeEncodeError'],
  RuntimeError: ['NotImplementedError', 'RecursionError'],
};
const NOT_EXCEPTION = new Set(['SystemExit', 'KeyboardInterrupt', 'GeneratorExit']);

function catches(handlers: readonly string[] | null, raised: string): boolean {
  if (handlers === null) return true; // bare `except:`
  return handlers.some(
    (h) =>
      h === raised ||
      h === 'BaseException' ||
      (h === 'Exception' && !NOT_EXCEPTION.has(raised)) ||
      (CAUGHT_BY[h]?.includes(raised) ?? false),
  );
}

interface Clause {
  at: number;
  /** Class names it names (last dotted part); null for a bare `except:`. */
  names: string[] | null;
  rethrows: boolean;
}

function pyFlows(path: string, source: string): ExceptionFlow[] {
  const lines = logicalLines(source, maskPython(source));
  if (!lines.some((l) => /^try\s*:/.test(l.text))) return [];
  const parents = parentsOf(lines);

  // Each `try:` line → its except clauses.
  const handlersOf = new Map<number, Clause[]>();
  lines.forEach((l, k) => {
    if (!/^try\s*:\s*$/.test(l.text)) return;
    const clauses: Clause[] = [];
    let n = blockEnd(lines, k);
    while (n < lines.length && (lines[n] as PyLine).indent === l.indent) {
      const head = (lines[n] as PyLine).text;
      const end = blockEnd(lines, n);
      const except = /^except\*?\s*(.*?)\s*:/.exec(head);
      if (except) {
        const spec = (except[1] ?? '').replace(/\s+as\s+\w+\s*$/, '').replace(/^\(|\)$/g, '');
        const names = spec
          ? spec
              .split(',')
              .map((s) => s.trim().split('.').pop() ?? '')
              .filter(Boolean)
          : null;
        const inline = head.slice(except[0].length).trim();
        const rethrows = /^raise\b/.test(inline) || raisesWithin(lines, n + 1, end);
        clauses.push({ at: n, names, rethrows });
      } else if (!/^(else|finally)\s*:/.test(head)) {
        break;
      }
      n = end;
    }
    if (clauses.length) handlersOf.set(k, clauses);
  });
  if (handlersOf.size === 0) return [];

  const pairs: Pair[] = [];
  lines.forEach((l, k) => {
    const raise = /^raise\s+([\w.]+)/.exec(l.text);
    if (!raise) return;
    const raised = (raise[1] as string).split('.').pop() as string;
    // A lowercase name is a variable holding who-knows-what.
    if (!/^[A-Z]/.test(raised)) return;
    let child = k;
    let p = parents[k] as number;
    while (p !== -1) {
      const head = (lines[p] as PyLine).text;
      if (/^(async\s+)?def\b|^class\b/.test(head)) return;
      const clauses = handlersOf.get(p);
      // Only the try BODY is covered; the parent chain reaches a try line only
      // from its body, since clauses are its siblings, not its children.
      if (clauses && child !== p) {
        const handler = clauses.find((c) => catches(c.names, raised));
        if (handler) {
          if (!handler.rethrows) {
            pairs.push({ throwAt: k, handlerAt: handler.at, key: p });
          }
          return;
        }
      }
      child = p;
      p = parents[p] as number;
    }
  });
  return report(path, source, pairs, (at) => (lines[at] as PyLine).line);
}

// ---- Shared -----------------------------------------------------------------

function report(
  path: string,
  source: string,
  pairs: readonly Pair[],
  lineOf: (at: number) => number,
): ExceptionFlow[] {
  const sourceLines = source.split('\n');
  const byTry = new Map<number, Pair[]>();
  for (const pair of pairs) byTry.set(pair.key, [...(byTry.get(pair.key) ?? []), pair]);
  const out: ExceptionFlow[] = [];
  for (const group of byTry.values()) {
    const first = group[0] as Pair;
    const line = lineOf(first.throwAt);
    const handlerLine = lineOf(first.handlerAt);
    const n = group.length;
    out.push({
      ruleId: EXCEPTION_FLOW_RULE_ID,
      file: path,
      line,
      handlerLine,
      throws: n,
      statement: (sourceLines[line - 1] ?? '').trim().slice(0, 300),
      message:
        `${n === 1 ? 'This throw is' : `${n} throws in this try are`} caught by the handler on ` +
        `line ${handlerLine} of the same function, so the exception never leaves: it is a ` +
        'branch. Return early or branch on the condition instead, and keep the try for ' +
        'failures that come from the calls inside it.',
    });
  }
  return out;
}

/** Throws and raises caught by a handler in the same function, one per try. */
export function exceptionFlows(
  files: readonly { path: string; source: string }[],
): ExceptionFlow[] {
  const out: ExceptionFlow[] = [];
  for (const file of files) {
    if (FIXTURE_PATH.test(file.path)) continue;
    if (CODE.test(file.path) && !/\.d\.[cm]?ts$/.test(file.path)) {
      if (JS_TEST_PATH.test(file.path) || looksMinified(file.source)) continue;
      out.push(...jsFlows(file.path, file.source));
    } else if (PYTHON.test(file.path)) {
      if (PY_TEST_PATH.test(file.path)) continue;
      out.push(...pyFlows(file.path, file.source));
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
