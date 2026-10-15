// Python source reading for the in-process checks (W18-09).
//
// The JS/TS side has source-graph.ts; Python needs its own lexer because its
// block structure is indentation, not braces, and both of its string forms
// that matter here — triple-quoted strings and docstrings — span lines. A
// rule that read a docstring's `raise` or a `try:` in a comment as code would
// report things that never run.

export const PYTHON = /\.pyi?$/;

export interface PyMasked {
  /** Comments blanked and string contents blanked, quotes kept; offsets intact. */
  text: string;
  /** 1-based physical lines that begin inside a multi-line string. */
  inString: Set<number>;
}

const PREFIX = /[rRbBuUfF]/;

/**
 * Blanks comments and string contents, keeping offsets and newlines.
 *
 * Quote characters are kept, so a docstring still reads as a string-only
 * statement after masking. f-string expressions are blanked with the rest of
 * the string: nothing these rules look for lives inside one.
 */
export function maskPython(source: string): PyMasked {
  const out = source.split('');
  const inString = new Set<number>();
  let line = 1;
  let i = 0;
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  while (i < source.length) {
    const c = source[i] as string;
    if (c === '\n') {
      line++;
      i++;
    } else if (c === '#') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      blank(i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      // Raw strings do not escape — `r"\"` is not a thing, but `r"\d"` is, and
      // the backslash must not swallow the closing quote.
      let p = i - 1;
      let raw = false;
      while (p >= 0 && PREFIX.test(source[p] as string) && i - p <= 2) {
        if (/[rR]/.test(source[p] as string)) raw = true;
        p--;
      }
      const triple = source.startsWith(c.repeat(3), i);
      const quote = triple ? c.repeat(3) : c;
      let j = i + quote.length;
      while (j < source.length) {
        if (!raw && source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source.startsWith(quote, j)) break;
        // An unterminated single-line string ends at the newline, so one
        // stray quote cannot blank the rest of the file.
        if (!triple && source[j] === '\n') break;
        j++;
      }
      const contentEnd = Math.min(j, source.length);
      for (let k = i + quote.length; k < contentEnd; k++) {
        if (source[k] === '\n') {
          line++;
          inString.add(line);
        }
      }
      blank(i + quote.length, contentEnd);
      i = source.startsWith(quote, j) ? j + quote.length : j;
    } else {
      i++;
    }
  }
  return { text: out.join(''), inString };
}

export interface PyLine {
  /** 1-based line the logical line starts on. */
  line: number;
  /** Last physical line it covers. */
  endLine: number;
  /** Width of the leading whitespace, tabs counted as 8 like CPython. */
  indent: number;
  /** Masked text of the whole logical line, joined and trimmed. */
  text: string;
  /** The original first physical line, trimmed — the evidence quote. */
  raw: string;
}

function indentOf(line: string): number {
  let width = 0;
  for (const ch of line) {
    if (ch === ' ') width++;
    else if (ch === '\t') width = width + 8 - (width % 8);
    else break;
  }
  return width;
}

/**
 * Logical lines: physical lines joined across open brackets, backslash
 * continuations and multi-line strings, blank and comment-only lines dropped.
 */
export function logicalLines(source: string, masked: PyMasked = maskPython(source)): PyLine[] {
  const physical = masked.text.split('\n');
  const original = source.split('\n');
  const out: PyLine[] = [];
  let depth = 0;
  let current: PyLine | null = null;
  let continued = false;
  for (let n = 0; n < physical.length; n++) {
    const text = physical[n] as string;
    const lineNo = n + 1;
    const joining = current !== null && (depth > 0 || continued || masked.inString.has(lineNo));
    if (!joining) {
      if (current) out.push(current);
      current = null;
      if (text.trim() === '') {
        continued = false;
        continue;
      }
      current = {
        line: lineNo,
        endLine: lineNo,
        indent: indentOf(text),
        text: text.trim(),
        raw: (original[n] ?? '').trim(),
      };
    } else if (current) {
      current.text = `${current.text} ${text.trim()}`.trim();
      current.endLine = lineNo;
    }
    for (const ch of text) {
      if (ch === '(' || ch === '[' || ch === '{') depth++;
      else if (ch === ')' || ch === ']' || ch === '}') depth = Math.max(0, depth - 1);
    }
    continued = /\\\s*$/.test(text);
  }
  if (current) out.push(current);
  return out;
}

/**
 * Each logical line's parent: the nearest earlier line with a smaller indent.
 * -1 for a top-level line.
 */
export function parentsOf(lines: readonly PyLine[]): number[] {
  const parents: number[] = [];
  const stack: number[] = [];
  lines.forEach((l, k) => {
    while (stack.length && (lines[stack[stack.length - 1]!] as PyLine).indent >= l.indent) {
      stack.pop();
    }
    parents.push(stack.length ? stack[stack.length - 1]! : -1);
    stack.push(k);
  });
  return parents;
}

/** Lines k+1… that sit deeper than line k: its block, as an index range. */
export function blockEnd(lines: readonly PyLine[], k: number): number {
  const indent = (lines[k] as PyLine).indent;
  let end = k + 1;
  while (end < lines.length && (lines[end] as PyLine).indent > indent) end++;
  return end;
}

/** A statement that is only a string — a docstring, after masking. */
export function isStringOnly(text: string): boolean {
  return /^(?:[rRbBuUfF]{0,2}(?:"""|'''|"|')\s*(?:"""|'''|"|')\s*)+$/.test(text);
}

/** Tests may raise and catch on purpose; a runner reads them by convention. */
export const PY_TEST_PATH = /(^|\/)(test_[^/]*|[^/]*_test|conftest)\.py$|(^|\/)(tests?|testing)\//;
