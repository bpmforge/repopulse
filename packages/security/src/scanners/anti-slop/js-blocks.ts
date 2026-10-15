// Brace structure of a masked JS/TS file (W18-09).
//
// The two structural rules ask "which function is this statement in", which a
// regex cannot answer and a parser would add a dependency the fast lane does
// not have. Braces can, once comments and strings are masked: every function
// body is a `{` whose left context says so — `=>`, a parameter list after a
// name, or a TypeScript return type after one.

export type BraceKind = 'function' | 'block';

export interface Brace {
  open: number;
  close: number;
  parent: number;
  kind: BraceKind;
}

const CONTROL = new Set(['if', 'for', 'while', 'switch', 'catch', 'with', 'case']);

/** Index of the `(` matching the `)` at `close`, or -1. */
export function matchParenBack(text: string, close: number): number {
  let depth = 0;
  for (let k = close; k >= 0; k--) {
    const ch = text[k];
    if (ch === ')') depth++;
    else if (ch === '(') {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

function wordBefore(text: string, index: number): string {
  let k = index - 1;
  while (k >= 0 && /\s/.test(text[k] as string)) k--;
  let w = k;
  while (w >= 0 && /[\w$]/.test(text[w] as string)) w--;
  return text.slice(w + 1, k + 1);
}

/** Is the paren group closing at `close` a parameter list rather than a condition? */
function paramsAt(text: string, close: number): boolean {
  const open = matchParenBack(text, close);
  if (open === -1) return false;
  const word = wordBefore(text, open);
  if (CONTROL.has(word)) return false;
  // `for await (…)` — the word before the paren is `await`.
  if (word === 'await' && /\bfor\s+await\s*$/.test(text.slice(Math.max(0, open - 40), open))) {
    return false;
  }
  // A bare group `(…) {` with no name can only be a method or a function if
  // something named it; `x = (a) {` is not valid code, so treat as a block.
  return word !== '' || /[>*]\s*$/.test(text.slice(Math.max(0, open - 3), open));
}

function classify(text: string, open: number): BraceKind {
  let k = open - 1;
  while (k >= 0 && /\s/.test(text[k] as string)) k--;
  if (k < 0) return 'block';
  if (text[k] === '>' && text[k - 1] === '=') return 'function';
  if (text[k] === ')') return paramsAt(text, k) ? 'function' : 'block';
  // A TypeScript return type: `foo(a): Promise<X> {`. Walk back over the type
  // to the `)` before its colon; object and function types in the annotation
  // are given up on (they read as a block, which only costs a finding).
  const tail = text.slice(Math.max(0, open - 300), open);
  const typed = /\)\s*:\s*[\w$.<>[\],|&\s'"?]+$/.exec(tail);
  if (typed) {
    const close = open - tail.length + typed.index;
    return paramsAt(text, close) ? 'function' : 'block';
  }
  return 'block';
}

/**
 * Every brace pair in a masked source, with its parent and kind; null when the
 * braces do not balance (the masking misread something, so say nothing).
 */
export function braceTree(masked: string): Brace[] | null {
  const braces: Brace[] = [];
  const stack: number[] = [];
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (ch === '{') {
      braces.push({
        open: i,
        close: -1,
        parent: stack.length ? stack[stack.length - 1]! : -1,
        kind: classify(masked, i),
      });
      stack.push(braces.length - 1);
    } else if (ch === '}') {
      const top = stack.pop();
      if (top === undefined) return null;
      (braces[top] as Brace).close = i;
    }
  }
  return stack.length ? null : braces;
}

/** The innermost brace containing `index`, or -1. Braces are in open order. */
export function innermost(braces: readonly Brace[], index: number): number {
  let found = -1;
  for (let b = 0; b < braces.length; b++) {
    const brace = braces[b] as Brace;
    if (brace.open > index) break;
    if (brace.open < index && brace.close > index) found = b;
  }
  return found;
}

/** Index of the `{` opening the brace whose open offset is `open`. */
export function braceAt(braces: readonly Brace[], open: number): number {
  let lo = 0;
  let hi = braces.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const at = (braces[mid] as Brace).open;
    if (at === open) return mid;
    if (at < open) lo = mid + 1;
    else hi = mid - 1;
  }
  return -1;
}

/** Next non-whitespace offset at or after `from`. */
export function skipSpace(text: string, from: number): number {
  let k = from;
  while (k < text.length && /\s/.test(text[k] as string)) k++;
  return k;
}

/**
 * Bundler output: a line no person wrote. Its braces are real, but a finding
 * on line 1 of a 400 KB chunk is not something anyone can act on.
 */
export function looksMinified(source: string): boolean {
  return source.split('\n').some((line) => line.length > 1000);
}
