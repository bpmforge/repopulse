import { IDENT } from './source-graph.js';

// Function signatures read from masked source (W18-05).
//
// Three structural rules need the same two facts about a function: what its
// parameters are called, and where its body is. A real parser would answer
// both, but the fast lane runs with nothing installed, so this reads them off
// the text that maskSource leaves — comments and strings blanked, every bracket
// that is code still in place, offsets unchanged.
//
// EVERY PARSE MAY GIVE UP. Anything this cannot read with certainty — a
// parameter list that does not split cleanly, a body it cannot find — returns
// null, and every rule built on it treats null as "say nothing". A reader that
// guesses here invents findings downstream.

const OPEN: Record<string, string> = { '(': ')', '[': ']', '{': '}' };
const CLOSE = new Set([')', ']', '}']);
const WS = /\s/;

/** Index of the bracket closing the one at `open` — (), [] or {} — or -1. */
export function closeOf(text: string, open: number): number {
  const stack: string[] = [];
  for (let i = open; i < text.length; i++) {
    const c = text[i] as string;
    if (OPEN[c]) stack.push(OPEN[c] as string);
    else if (CLOSE.has(c)) {
      if (stack.pop() !== c) return -1;
      if (stack.length === 0) return i;
    }
  }
  return -1;
}

/**
 * Index of the `>` closing a type-argument list at `open`, or -1.
 *
 * `=>` inside it is an arrow, not a close. A `;` or an unbalanced bracket means
 * the `<` was a comparison after all.
 */
export function closeAngle(text: string, open: number): number {
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const c = text[i] as string;
    if (c === '<') depth++;
    else if (c === '>' && text[i - 1] !== '=') {
      depth--;
      if (depth === 0) return i;
    } else if (OPEN[c]) {
      const end = closeOf(text, i);
      if (end === -1) return -1;
      i = end;
    } else if (c === ';' || CLOSE.has(c)) return -1;
  }
  return -1;
}

export function skipWs(text: string, i: number): number {
  while (i < text.length && WS.test(text[i] as string)) i++;
  return i;
}

/** Index of the last non-space character before `i`, or -1. */
export function prevNonWs(text: string, i: number): number {
  let k = i - 1;
  while (k >= 0 && WS.test(text[k] as string)) k--;
  return k;
}

/** Splits on top-level commas; brackets and type arguments nest. */
export function splitTopLevel(text: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === '<') depth++;
    else if (c === '>' && text[i - 1] !== '=') depth--;
    else if (c === ',' && depth === 0) {
      parts.push(text.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(text.slice(from));
  // A trailing comma leaves an empty last part; it is not a parameter.
  if (parts.length > 0 && (parts[parts.length - 1] as string).trim() === '') parts.pop();
  return parts;
}

export interface Param {
  /** null for a destructured parameter. */
  name: string | null;
  rest: boolean;
  hasDefault: boolean;
  decorated: boolean;
  /** Every identifier inside a destructuring pattern — JSDoc may name them. */
  patternNames: string[];
}

/**
 * Index of a top-level `=` that is an initialiser (not `=>`, `==`, `<=`), or -1.
 * A top-level `;` ends the search: `let x: T;` has no initialiser, and the next
 * statement's `=` is not its.
 */
function initialiser(text: string): number {
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (c === '(' || c === '[' || c === '{' || c === '<') depth++;
    else if (c === ')' || c === ']' || c === '}') depth--;
    else if (c === '>' && text[i - 1] !== '=') depth--;
    else if (c === ';' && depth === 0) return -1;
    else if (
      c === '=' &&
      depth === 0 &&
      text[i + 1] !== '>' &&
      text[i + 1] !== '=' &&
      !'=!<>'.includes(text[i - 1] ?? '')
    ) {
      return i;
    }
  }
  return -1;
}

const PARAM = new RegExp(`^(\\.\\.\\.)?\\s*(${IDENT})\\s*\\??\\s*(?::[\\s\\S]*)?$`);
const MODIFIER = /^(?:(?:public|private|protected|readonly|override)\s+)+/;

/** Reads one parameter, or null when its shape is not one this knows. */
function parseParam(raw: string): Param | null {
  let text = raw.trim();
  let decorated = false;
  // Decorators: `@Inject() svc: Svc`, `@Body() dto`.
  while (text.startsWith('@')) {
    decorated = true;
    const m = new RegExp(`^@${IDENT}(?:\\.${IDENT})*`).exec(text);
    if (!m) return null;
    text = text.slice(m[0].length).trimStart();
    if (text.startsWith('(')) {
      const end = closeOf(text, 0);
      if (end === -1) return null;
      text = text.slice(end + 1).trimStart();
    }
  }
  text = text.replace(MODIFIER, '');
  const eq = initialiser(text);
  const hasDefault = eq !== -1;
  const head = (hasDefault ? text.slice(0, eq) : text).trim();
  const rest = head.startsWith('...');
  const body = rest ? head.slice(3).trimStart() : head;
  if (body.startsWith('{') || body.startsWith('[')) {
    const end = closeOf(body, 0);
    if (end === -1) return null;
    const pattern = body.slice(0, end + 1);
    return {
      name: null,
      rest,
      hasDefault,
      decorated,
      patternNames: pattern.match(new RegExp(IDENT, 'g')) ?? [],
    };
  }
  const m = PARAM.exec(head);
  if (!m) return null;
  return { name: m[2] as string, rest, hasDefault, decorated, patternNames: [] };
}

/** Parameters between the parentheses at `open`, or null if any is unreadable. */
export function parseParams(text: string, open: number): { params: Param[]; close: number } | null {
  const close = closeOf(text, open);
  if (close === -1) return null;
  const params: Param[] = [];
  for (const raw of splitTopLevel(text.slice(open + 1, close))) {
    const param = parseParam(raw);
    if (!param) return null;
    params.push(param);
  }
  return { params, close };
}

export interface FunctionSite {
  /** '' for an anonymous function. */
  name: string;
  kind: 'function' | 'arrow' | 'method';
  /** Where the declaration starts, modifiers included — its line is the finding's. */
  index: number;
  exported: boolean;
  isAsync: boolean;
  generator: boolean;
  /** `this: T` in TypeScript is not a parameter anyone passes; it is dropped. */
  params: Param[];
  /** 'none' for a signature with no body: an overload, an abstract or interface member. */
  body: { kind: 'block' | 'expr' | 'none'; start: number; end: number };
}

/**
 * Skips a return-type annotation after `)` and finds the body.
 *
 * The body is the first top-level `{` that does not start a type: one after
 * `:`, `|`, `&`, `,` or `=>` is an object type (`): { a: string } {`).
 */
function bodyAfter(text: string, close: number, arrow: boolean): FunctionSite['body'] | null {
  let i = skipWs(text, close + 1);
  const annotated = text[i] === ':';
  if (annotated) i++;
  for (; i < text.length; i++) {
    const c = text[i] as string;
    if (WS.test(c)) continue;
    if (c === '=' && text[i + 1] === '>') {
      // In a function's return type, `=>` belongs to a function type.
      if (!arrow) {
        i++;
        continue;
      }
      const start = skipWs(text, i + 2);
      if (text[start] === '{') {
        const end = closeOf(text, start);
        return end === -1 ? null : { kind: 'block', start, end };
      }
      return { kind: 'expr', start, end: start };
    }
    if (c === '{') {
      const p = prevNonWs(text, i);
      const before = text[p] ?? '';
      const typeStart =
        annotated && (':|&,(<'.includes(before) || (before === '>' && text[p - 1] === '='));
      const end = closeOf(text, i);
      if (end === -1) return null;
      if (typeStart || arrow) {
        i = end;
        continue;
      }
      return { kind: 'block', start: i, end };
    }
    if (c === '(' || c === '[') {
      const end = closeOf(text, i);
      if (end === -1) return null;
      i = end;
      continue;
    }
    if (c === '<') {
      const end = closeAngle(text, i);
      if (end === -1) return null;
      i = end;
      continue;
    }
    if (c === ';' || c === '}' || c === ',') {
      return arrow ? null : { kind: 'none', start: i, end: i };
    }
    if (!annotated) return arrow ? null : { kind: 'none', start: i, end: i };
  }
  return null;
}

const FUNCTION_HEAD = new RegExp(
  `^(export\\s+)?(?:default\\s+)?(?:declare\\s+)?(async\\s+)?function\\b\\s*(\\*)?\\s*(${IDENT})?\\s*`,
);
const VARIABLE_HEAD = new RegExp(`^(export\\s+)?(?:const|let|var)\\s+(${IDENT})\\s*`);
const METHOD_HEAD = new RegExp(
  `^((?:(?:public|private|protected|static|override|abstract|readonly|declare)\\s+)*)(async\\s+)?(\\*\\s*)?(?:(get|set)\\s+)?(${IDENT})\\s*\\??\\s*`,
);
/** Words that open a statement, never a method name. */
const NOT_A_METHOD = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'with',
  'return',
  'function',
  'new',
  'typeof',
  'await',
  'yield',
  'constructor',
  'else',
  'do',
  'try',
  'this',
  'super',
  'case',
  'throw',
  'delete',
  'void',
]);

/** Optional `<T, U>` type parameters at `i`; returns the index after them, or -1. */
function skipTypeParams(text: string, i: number): number {
  i = skipWs(text, i);
  if (text[i] !== '<') return i;
  const end = closeAngle(text, i);
  return end === -1 ? -1 : skipWs(text, end + 1);
}

/** The function an `= …` initialiser holds, if it is one: `(a) =>`, `a =>`, `function (a)`. */
function functionValue(
  text: string,
  i: number,
): Pick<FunctionSite, 'isAsync' | 'generator' | 'params' | 'body' | 'kind'> | null {
  i = skipWs(text, i);
  let isAsync = false;
  const asyncMatch = /^async\b\s*/.exec(text.slice(i, i + 12));
  if (asyncMatch) {
    isAsync = true;
    i += asyncMatch[0].length;
  }
  const fn = new RegExp(`^function\\b\\s*(\\*)?\\s*(?:${IDENT})?\\s*`).exec(text.slice(i, i + 200));
  if (fn) {
    const open = skipTypeParams(text, i + fn[0].length);
    if (open === -1 || text[open] !== '(') return null;
    const parsed = parseParams(text, open);
    if (!parsed) return null;
    const body = bodyAfter(text, parsed.close, false);
    if (!body || body.kind === 'none') return null;
    return { kind: 'function', isAsync, generator: Boolean(fn[1]), params: parsed.params, body };
  }
  const bare = new RegExp(`^(${IDENT})\\s*=>`).exec(text.slice(i, i + 200));
  if (bare) {
    const start = skipWs(text, i + bare[0].length);
    const end = text[start] === '{' ? closeOf(text, start) : start;
    if (end === -1) return null;
    return {
      kind: 'arrow',
      isAsync,
      generator: false,
      params: [
        {
          name: bare[1] as string,
          rest: false,
          hasDefault: false,
          decorated: false,
          patternNames: [],
        },
      ],
      body: { kind: text[start] === '{' ? 'block' : 'expr', start, end },
    };
  }
  const open = skipTypeParams(text, i);
  if (open === -1 || text[open] !== '(') return null;
  const parsed = parseParams(text, open);
  if (!parsed) return null;
  const body = bodyAfter(text, parsed.close, true);
  if (!body) return null;
  return { kind: 'arrow', isAsync, generator: false, params: parsed.params, body };
}

const dropThis = (params: Param[]): Param[] => params.filter((p) => p.name !== 'this');

/**
 * Reads the function declared at `index`, or null.
 *
 * `methods` admits a class or object member (`name(…) {`, `name = (…) =>`);
 * without it only declarations are read — `function`, and `const`/`let`/`var`
 * holding a function.
 */
export function functionAt(text: string, index: number, methods = false): FunctionSite | null {
  const at = skipWs(text, index);
  const head = text.slice(at, at + 300);

  const fn = FUNCTION_HEAD.exec(head);
  if (fn) {
    const open = skipTypeParams(text, at + fn[0].length);
    if (open === -1 || text[open] !== '(') return null;
    const parsed = parseParams(text, open);
    if (!parsed) return null;
    const body = bodyAfter(text, parsed.close, false);
    if (!body) return null;
    return {
      name: fn[4] ?? '',
      kind: 'function',
      index: at,
      exported: Boolean(fn[1]),
      isAsync: Boolean(fn[2]),
      generator: Boolean(fn[3]),
      params: dropThis(parsed.params),
      body,
    };
  }

  const variable = VARIABLE_HEAD.exec(head);
  if (variable) {
    let i = at + variable[0].length;
    // `const f: Handler = …` — skip the annotation to its top-level `=`.
    if (text[i] === ':') {
      const eq = initialiser(text.slice(i, i + 2000));
      if (eq === -1) return null;
      i += eq;
    }
    if (text[i] !== '=' || text[i + 1] === '=') return null;
    const value = functionValue(text, i + 1);
    if (!value) return null;
    return {
      ...value,
      name: variable[2] as string,
      index: at,
      exported: Boolean(variable[1]),
      params: dropThis(value.params),
    };
  }

  if (!methods) return null;
  const method = METHOD_HEAD.exec(head);
  if (!method || NOT_A_METHOD.has(method[5] as string) || method[4]) return null;
  const after = at + method[0].length;
  if (text[after] === '=' && text[after + 1] !== '=') {
    const value = functionValue(text, after + 1);
    if (!value) return null;
    return {
      ...value,
      name: method[5] as string,
      kind: 'method',
      index: at,
      exported: false,
      params: dropThis(value.params),
    };
  }
  const open = skipTypeParams(text, after);
  if (open === -1 || text[open] !== '(') return null;
  const parsed = parseParams(text, open);
  if (!parsed) return null;
  const body = bodyAfter(text, parsed.close, false);
  if (!body) return null;
  return {
    name: method[5] as string,
    kind: 'method',
    index: at,
    exported: false,
    isAsync: Boolean(method[2]),
    generator: Boolean(method[3]),
    params: dropThis(parsed.params),
    body,
  };
}

/** Brace depth at every offset of masked text. */
export function braceDepths(text: string): Int32Array {
  const depths = new Int32Array(text.length + 1);
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    depths[i] = depth;
    if (text[i] === '{') depth++;
    else if (text[i] === '}') depth = Math.max(0, depth - 1);
  }
  depths[text.length] = depth;
  return depths;
}

export interface ClassDecl {
  name: string;
  index: number;
  abstract: boolean;
  exported: boolean;
  /** The first name after `extends`, last segment of a qualified name; null if none. */
  extends: string | null;
  implements: string[];
  bodyStart: number;
  bodyEnd: number;
}

/** Last segment of `a.b.C<T>`, or null when the expression is not a plain name. */
function heritageName(expr: string): string | null {
  const m = new RegExp(`^\\s*(${IDENT}(?:\\s*\\.\\s*${IDENT})*)\\s*(?:<[\\s\\S]*>)?\\s*$`).exec(
    expr,
  );
  if (!m) return null;
  return (m[1] as string).split('.').pop()!.trim();
}

/** Every class declaration or expression, with its heritage clause. */
export function classesOf(text: string): ClassDecl[] {
  const out: ClassDecl[] = [];
  const re = new RegExp(
    `(?<![\\w$.])(export\\s+)?(?:default\\s+)?(?:declare\\s+)?(abstract\\s+)?class\\b\\s*(${IDENT})?`,
    'g',
  );
  for (const m of text.matchAll(re)) {
    let i = (m.index ?? 0) + m[0].length;
    const name = m[3] ?? '';
    if (name === 'extends' || name === 'implements') {
      i = (m.index ?? 0) + m[0].length - name.length;
    }
    i = skipTypeParams(text, i);
    if (i === -1) continue;
    // The heritage clause runs to the body's `{`; type arguments and call
    // arguments (`extends mixin(Base)`) may contain braces of their own.
    let j = i;
    for (; j < text.length; j++) {
      const c = text[j] as string;
      if (c === '{') break;
      if (c === '(' || c === '[') {
        const end = closeOf(text, j);
        if (end === -1) break;
        j = end;
      } else if (c === '<') {
        const end = closeAngle(text, j);
        if (end === -1) break;
        j = end;
      } else if (c === ';' || c === '}' || c === '=') break;
    }
    if (text[j] !== '{') continue;
    const bodyEnd = closeOf(text, j);
    if (bodyEnd === -1) continue;
    const clause = text.slice(i, j);
    const ext = /^\s*extends\b([\s\S]*?)(?:\bimplements\b|$)/.exec(clause);
    const imp = /\bimplements\b([\s\S]*)$/.exec(clause);
    out.push({
      name: name === 'extends' || name === 'implements' ? '' : name,
      index: m.index ?? 0,
      abstract: Boolean(m[2]),
      exported: Boolean(m[1]),
      extends: ext ? heritageName(ext[1] as string) : null,
      implements: imp
        ? splitTopLevel(imp[1] as string)
            .map(heritageName)
            .filter((n): n is string => n !== null)
        : [],
      bodyStart: j,
      bodyEnd,
    });
  }
  return out;
}
