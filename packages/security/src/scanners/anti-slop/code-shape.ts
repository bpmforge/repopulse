// Bracket and statement reading over MASKED source (W18-08).
//
// The fast-lane rules read JavaScript without a parser, so every structural
// question — where does this block end, what are this call's arguments —
// is answered on text whose comments, strings and regex bodies have already
// been blanked by `maskSource`. That is what makes counting brackets safe: a
// `)` inside a string or a `{` inside a comment is no longer there.

/** Paths whose code is not the product: tests, fixtures, examples, benches. */
export const NON_PRODUCT_PATH =
  /(\.(test|spec|stories|story|bench|e2e)\.[cm]?[jt]sx?$)|(\.d\.[cm]?ts$)|(^|\/)(__tests__|__mocks__|tests?|e2e|fixtures?|examples?|benchmarks?|stories|scripts?|bin)\//;

const OPEN = '([{';
const CLOSE = ')]}';

/**
 * Index of the bracket that closes the one at `open`, or -1.
 *
 * Counts all three kinds together: masked source has no strings or comments
 * left, so the only brackets are code, and code brackets nest properly.
 */
export function closing(masked: string, open: number): number {
  let depth = 0;
  for (let i = open; i < masked.length; i++) {
    const c = masked[i] as string;
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) {
      depth--;
      if (depth === 0) return i;
      if (depth < 0) return -1;
    }
  }
  return -1;
}

/** Characters that, ending a line, mean the expression continues. */
const CONTINUES_AFTER = /[-+*/%&|^!=<>?:,.([{]$/;
/** Characters that, starting a line, mean it continues the previous one. */
const CONTINUES_BEFORE = /^(?:[-+*/%&|^=<>?:,.)\]]|in\b|instanceof\b|as\b|satisfies\b)/;

/**
 * End (exclusive) of the statement whose expression starts at `from`.
 *
 * Stops at a `;` at depth 0, at the bracket that closes the enclosing block,
 * or at a newline where automatic semicolon insertion would end it — the
 * last case is what lets the rules read semicolon-free code at all.
 */
export function statementEnd(masked: string, from: number): number {
  let depth = 0;
  for (let i = from; i < masked.length; i++) {
    const c = masked[i] as string;
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) {
      if (depth === 0) return i;
      depth--;
    } else if (depth === 0 && c === ';') return i + 1;
    else if (depth === 0 && c === '\n') {
      const before = masked.slice(from, i).trimEnd();
      const nextLineEnd = masked.indexOf('\n', i + 1);
      const after = masked.slice(i + 1, nextLineEnd === -1 ? undefined : nextLineEnd).trimStart();
      if (before && !CONTINUES_AFTER.test(before) && after && !CONTINUES_BEFORE.test(after)) {
        return i;
      }
    }
  }
  return masked.length;
}

/**
 * Splits `text` at commas that are not inside a bracket. Empty parts dropped.
 *
 * `generics` also treats `<…>` as a bracket, for TypeScript parameter lists
 * (`m: Map<K, V>`). Never for call arguments: there `a < b, c` is a
 * comparison, and reading it as a generic would undercount the arguments.
 */
export function splitTopLevel(text: string, generics = false): string[] {
  const parts: string[] = [];
  let depth = 0;
  let angle = 0;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (OPEN.includes(c)) depth++;
    else if (CLOSE.includes(c)) depth--;
    // TypeScript generics in a parameter list (`m: Map<K, V>`) hold commas
    // that are not separators. `=>` and comparison operators are not generics.
    else if (generics && c === '<' && /[\w$]$/.test(text.slice(0, i).trimEnd())) angle++;
    else if (c === '>' && angle > 0 && text[i - 1] !== '=') angle--;
    else if (c === ',' && depth === 0 && angle === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** Index of the first non-whitespace character at or after `from`. */
export function skipSpace(text: string, from: number): number {
  let i = from;
  while (i < text.length && /\s/.test(text[i] as string)) i++;
  return i;
}

/** Index of the bracket that opens the one at `close`, or -1. */
export function opening(masked: string, close: number): number {
  let depth = 0;
  for (let i = close; i >= 0; i--) {
    const c = masked[i] as string;
    if (CLOSE.includes(c)) depth++;
    else if (OPEN.includes(c)) {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

export type BlockKind = 'function' | 'loop' | 'other';

const LOOP_WORDS = new Set(['for', 'while', 'switch']);
const CONTROL_WORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'with']);

/**
 * What the `{` at `open` belongs to: a function body, a loop or switch body
 * (where `break` is local), or anything else.
 *
 * Read from what precedes it: `=>`, or a `)` whose `(` follows a name that is
 * not a control keyword, is a function; a TypeScript return annotation
 * between the `)` and the brace is skipped first.
 */
export function blockKind(masked: string, open: number): BlockKind {
  let prefix = masked.slice(0, open).trimEnd();
  if (prefix.endsWith('=>')) return 'function';
  const annotation = /\)\s*:[^(){};=]*$/.exec(prefix);
  if (annotation) prefix = prefix.slice(0, annotation.index + 1);
  if (prefix.endsWith(')')) {
    const o = opening(prefix, prefix.length - 1);
    if (o < 0) return 'other';
    const word = /([\w$]+)\s*$/.exec(prefix.slice(0, o))?.[1] ?? '';
    if (LOOP_WORDS.has(word)) return 'loop';
    if (CONTROL_WORDS.has(word)) return 'other';
    return 'function';
  }
  if (/\bdo$/.test(prefix)) return 'loop';
  return 'other';
}

/**
 * `text` (masked, from `from` to `to`) with the bodies of nested blocks of the
 * given kinds blanked, offsets kept.
 *
 * A `return` inside a callback is not the enclosing function's return, and a
 * `break` inside an inner loop is not the outer loop's; blanking those bodies
 * is how the rules ask about the code that belongs to the block they read.
 */
export function withoutNested(
  masked: string,
  from: number,
  to: number,
  kinds: readonly BlockKind[],
): string {
  const out = masked.slice(from, to).split('');
  for (let i = from; i < to; i++) {
    if (masked[i] !== '{') continue;
    if (!kinds.includes(blockKind(masked, i))) continue;
    const close = closing(masked, i);
    if (close < 0 || close > to) continue;
    for (let k = i - from; k < close - from + 1; k++) if (out[k] !== '\n') out[k] = ' ';
    i = close;
  }
  return out.join('');
}

/**
 * Markers bundlers leave: esbuild's source-path comments and interop helpers,
 * webpack's runtime. The DEFINITIONS, not mentions — source code that checks
 * `typeof __webpack_require__` is still source.
 */
const BUNDLE_MARKER =
  /^\/\/ (?:node_modules|\.\.?\/|src\/)[^\n]*\.[cm]?[jt]sx?$|\/\*{6}\/|\bfunction __webpack_require__\s*\(|\b(?:var|const) __(?:toESM|commonJS)\s*=/m;

/**
 * Minified or bundled output: a line no person wrote, or a bundler's marker.
 *
 * Nobody can act on a finding in a bundle — the function a rule points at is
 * a dependency's, inlined, and its "private" helpers were somebody's public
 * API before the bundler hid them.
 */
export function isGenerated(source: string): boolean {
  if (BUNDLE_MARKER.test(source)) return true;
  let start = 0;
  while (start < source.length) {
    const end = source.indexOf('\n', start);
    const stop = end === -1 ? source.length : end;
    if (stop - start > 1000) return true;
    start = stop + 1;
  }
  return false;
}
