import { maskSource } from './source-graph.js';

// Comment, string and code views of one file, for the leftover-content rules
// (W18-07): placeholder values live in STRINGS, commented-out code in
// COMMENTS, deprecated calls in CODE. Each rule has to know which of the
// three a character belongs to, or `// new Buffer(` reads as a call and
// `'example.com'` in a docstring reads as an endpoint.
//
// The brace family (JS/TS, Java, C#, Kotlin, Go, PHP, Rust) reuses the
// fast lane's `maskSource`: it already understands regex literals and
// template expressions, and a second JavaScript lexer would drift from it.
// The hash family (Python, Ruby) gets its own scanner below, because `//` is
// floor division there and `#` starts a comment.

export type Family = 'brace' | 'hash';

export type Language =
  'js' | 'python' | 'ruby' | 'java' | 'go' | 'csharp' | 'kotlin' | 'php' | 'rust';

const LANGUAGE_BY_EXTENSION: [RegExp, Language][] = [
  [/\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/, 'js'],
  [/\.(py|pyi)$/, 'python'],
  [/\.rb$/, 'ruby'],
  [/\.java$/, 'java'],
  [/\.go$/, 'go'],
  [/\.cs$/, 'csharp'],
  [/\.(kt|kts)$/, 'kotlin'],
  [/\.php$/, 'php'],
  [/\.rs$/, 'rust'],
];

export function languageOf(path: string): Language | null {
  for (const [re, lang] of LANGUAGE_BY_EXTENSION) if (re.test(path)) return lang;
  return null;
}

export interface StringLit {
  /** Offset of the opening quote. */
  start: number;
  /** Offset just past the closing quote. */
  end: number;
  /** The text between the quotes; template `${…}` parts become `X`. */
  value: string;
  line: number;
  /** Python: a string standing alone as a statement — a docstring. */
  docstring: boolean;
}

export interface CommentLine {
  line: number;
  /** The comment's text with its markers (`//`, `#`, `/*`, `*`) removed. */
  text: string;
  /** Nothing but the comment on this line. */
  whole: boolean;
  /** `/** … *\/` — documentation, never commented-out code. */
  doc: boolean;
  /** Consecutive lines of one comment share a group number. */
  group: number;
}

export interface Lexed {
  lang: Language;
  family: Family;
  source: string;
  lines: string[];
  /** Comments AND string contents blanked; quote characters kept. */
  code: string;
  /** Comments blanked, strings kept. */
  withStrings: string;
  strings: StringLit[];
  comments: CommentLine[];
  lineOf: (offset: number) => number;
  /** Offset of the first character of a 1-based line. */
  lineStart: (line: number) => number;
}

function lineStarts(source: string): number[] {
  const starts = [0];
  for (let k = 0; k < source.length; k++) if (source.charCodeAt(k) === 10) starts.push(k + 1);
  return starts;
}

function lineIndex(starts: readonly number[]): (offset: number) => number {
  return (offset: number): number => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((starts[mid] as number) <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/** Python/Ruby: blanks `#` comments and string contents, recording both. */
function maskHash(source: string): {
  code: string;
  withStrings: string;
  strings: Omit<StringLit, 'line' | 'docstring'>[];
  commentStarts: number[];
} {
  const code = source.split('');
  const withStrings = source.split('');
  const strings: Omit<StringLit, 'line' | 'docstring'>[] = [];
  const commentStarts: number[] = [];
  const blank = (arr: string[], from: number, to: number): void => {
    for (let k = from; k < to; k++) if (arr[k] !== '\n') arr[k] = ' ';
  };
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (c === '#') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      commentStarts.push(i);
      blank(code, i, stop);
      blank(withStrings, i, stop);
      i = stop;
    } else if (c === '"' || c === "'") {
      const triple = source[i + 1] === c && source[i + 2] === c;
      const q = triple ? 3 : 1;
      let j = i + q;
      while (j < source.length) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (triple ? source.startsWith(c.repeat(3), j) : source[j] === c) break;
        if (!triple && source[j] === '\n') break;
        j++;
      }
      const close = Math.min(j, source.length);
      blank(code, i + q, close);
      strings.push({
        start: i,
        end: Math.min(close + q, source.length),
        value: source.slice(i + q, close),
      });
      i = close + q;
    } else {
      i++;
    }
  }
  return { code: code.join(''), withStrings: withStrings.join(''), strings, commentStarts };
}

/** Brace family: strings recovered from `maskSource`'s kept quote characters. */
function braceStrings(
  source: string,
  code: string,
  endOfLine: (offset: number) => number,
): Omit<StringLit, 'line' | 'docstring'>[] {
  const out: Omit<StringLit, 'line' | 'docstring'>[] = [];
  let i = 0;
  while (i < code.length) {
    const c = code[i];
    if ((c === '"' || c === "'" || c === '`') && source[i] === c) {
      // Contents are blanked in `code`, so the next same quote that survived
      // masking is the closing one — escaped quotes inside were blanked.
      let j = code.indexOf(c, i + 1);
      if (c !== '`') {
        // Looked up, not scanned for: a minified bundle is one line, and
        // scanning to its end once per string is quadratic.
        const eol = endOfLine(i);
        if (j === -1 || j > eol) j = eol;
      } else if (j === -1) {
        j = code.length;
      }
      let value = source.slice(i + 1, j);
      if (c === '`') value = value.replace(/\$\{[^}]*\}/g, 'X');
      out.push({ start: i, end: Math.min(j + 1, source.length), value });
      i = j + 1;
    } else {
      i++;
    }
  }
  return out;
}

const MARKERS_BRACE = /^(?:\/\*+|\/\/+!?|\*+(?!\/))\s?/;

export function lex(path: string, source: string): Lexed | null {
  const lang = languageOf(path);
  if (!lang) return null;
  const family: Family = lang === 'python' || lang === 'ruby' ? 'hash' : 'brace';
  const starts = lineStarts(source);
  const lineOf = lineIndex(starts);
  const lines = source.split('\n');

  let code: string;
  let withStrings: string;
  let rawStrings: Omit<StringLit, 'line' | 'docstring'>[];
  const comments: CommentLine[] = [];

  if (family === 'hash') {
    const masked = maskHash(source);
    code = masked.code;
    withStrings = masked.withStrings;
    rawStrings = masked.strings;
    let group = 0;
    let lastLine = -2;
    for (const start of masked.commentStarts) {
      const line = lineOf(start);
      const lineStart = starts[line - 1] as number;
      const whole = code.slice(lineStart, start).trim() === '';
      if (!whole || line !== lastLine + 1) group++;
      const end = source.indexOf('\n', start);
      comments.push({
        line,
        text: source
          .slice(start, end === -1 ? source.length : end)
          .replace(/^#+\s?/, '')
          .trimEnd(),
        whole,
        doc: false,
        group,
      });
      lastLine = whole ? line : -2;
    }
  } else {
    code = maskSource(source);
    withStrings = maskSource(source, true);
    rawStrings = braceStrings(source, code, (offset) => {
      const line = lineOf(offset);
      return line < starts.length ? (starts[line] as number) - 1 : source.length;
    });
    // A character blanked in `withStrings` that was not blank in the source
    // is comment. The first such character on a line is where its comment
    // starts; a line inside a block comment is blanked from column 0.
    let group = 0;
    let inBlock = false;
    let blockIsDoc = false;
    let previousWhole = false;
    let offset = 0;
    for (let n = 0; n < lines.length; n++) {
      const raw = lines[n] as string;
      const masked = withStrings.slice(offset, offset + raw.length);
      offset += raw.length + 1;
      let first = -1;
      for (let k = 0; k < raw.length; k++) {
        if (masked[k] !== raw[k]) {
          first = k;
          break;
        }
      }
      if (first === -1 && !inBlock) {
        previousWhole = false;
        continue;
      }
      if (first === -1) first = 0;
      const tail = raw.slice(first);
      const continuing = inBlock;
      if (!continuing && tail.startsWith('/*')) {
        blockIsDoc = tail.startsWith('/**') && !tail.startsWith('/**/');
        const close = tail.indexOf('*/', 2);
        inBlock = close === -1;
      } else if (continuing && tail.includes('*/')) {
        inBlock = false;
      }
      const isBlock = continuing || tail.startsWith('/*');
      const whole = masked.slice(0, first).trim() === '';
      if (!(whole && previousWhole) || (!continuing && tail.startsWith('/*'))) group++;
      const text = tail
        .replace(/\*+\/\s*$/, '')
        .trim()
        .replace(MARKERS_BRACE, '')
        .trimEnd();
      comments.push({ line: n + 1, text, whole, doc: isBlock && blockIsDoc, group });
      previousWhole = whole;
    }
  }

  const strings: StringLit[] = rawStrings.map((s) => {
    const line = lineOf(s.start);
    let docstring = false;
    if (family === 'hash' && source.startsWith(source[s.start]!.repeat(3), s.start)) {
      const lineStart = starts[line - 1] as number;
      docstring =
        code
          .slice(lineStart, s.start)
          .replace(/[rRuUbBfF]+$/, '')
          .trim() === '';
    }
    return { ...s, line, docstring };
  });

  const lineStart = (line: number): number => starts[line - 1] ?? source.length;
  return { lang, family, source, lines, code, withStrings, strings, comments, lineOf, lineStart };
}
