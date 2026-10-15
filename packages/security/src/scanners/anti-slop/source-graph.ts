// Shared source reading for the in-process checks (W18, mechanical-checks plan).
//
// Comment/string masking, export and import tables, and relative-specifier
// resolution — the pieces every graph-shaped rule needs, kept in one place so a
// lexer fix (like the regex-literal one in W18-01) lands for all of them.

export const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
export const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/** Every name a module takes from an importer: a set, or "all of them". */
export type Taken = Set<string> | 'all';

export interface ExportDecl {
  name: string;
  line: number;
  declaration: string;
}

export const IDENT = '[A-Za-z_$][\\w$]*';

const REGEX_AFTER_WORD = new Set([
  'return',
  'typeof',
  'case',
  'do',
  'else',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'yield',
  'await',
]);

/** Can a `/` at `index` start a regex literal, judged by what precedes it? */
function regexCanStart(source: string, index: number): boolean {
  let k = index - 1;
  while (k >= 0 && /\s/.test(source[k] as string)) k--;
  if (k < 0) return true;
  const prev = source[k] as string;
  if ('(,=:[!&|?{};+-*%<>~^'.includes(prev)) return true;
  if (!/[\w$]/.test(prev)) return false;
  let w = k;
  while (w >= 0 && /[\w$]/.test(source[w] as string)) w--;
  return REGEX_AFTER_WORD.has(source.slice(w + 1, k + 1));
}

/**
 * Blanks comments — and, unless asked to keep them, string contents — keeping
 * offsets and newlines.
 *
 * Offsets have to survive so a match index still maps to its line. Import
 * specifiers ARE strings, so the quote characters are kept and only their
 * contents blanked; `importsOf` reads specifiers back from the original text
 * at the same offsets.
 *
 * Strings are KEPT for the name count: a name that appears only in a string
 * elsewhere may be looked up by that string, and treating it as mentioned
 * costs a finding rather than inventing one.
 *
 * Regex literals and `${…}` template expressions are tracked, so a quote
 * inside `/'/g` or a nested template does not swallow the rest of the file.
 *
 * `commentSpans`, when given, receives each comment's [start, end) offsets: a
 * directive such as `// @ts-ignore` only acts at the START of a comment, and
 * a blanked view cannot say where one comment ends and the next begins.
 */
export function maskSource(
  source: string,
  keepStrings = false,
  commentSpans?: [number, number][],
): string {
  const out = source.split('');
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  // One entry per open template literal: the brace depth of the `${…}`
  // expression we are inside, so its closing `}` returns us to the template.
  const templates: number[] = [];
  let depth = 0;
  let i = 0;

  // Scans template text from `i` until `${` or the closing backtick.
  const templateText = (): void => {
    const from = i;
    while (i < source.length) {
      if (source[i] === '\\') {
        i += 2;
      } else if (source[i] === '`') {
        if (!keepStrings) blank(from, i);
        i++;
        return;
      } else if (source[i] === '$' && source[i + 1] === '{') {
        if (!keepStrings) blank(from, i);
        templates.push(depth);
        depth++;
        i += 2;
        return;
      } else {
        i++;
      }
    }
    if (!keepStrings) blank(from, source.length);
  };

  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      commentSpans?.push([i, stop]);
      blank(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      commentSpans?.push([i, stop]);
      blank(i, stop);
      i = stop;
    } else if (c === '/' && regexCanStart(source, i)) {
      // A regex literal: its quotes and slashes are not code, and a `'` in
      // `/'/g` must not open a string that swallows the rest of the file.
      let j = i + 1;
      let inClass = false;
      while (j < source.length && source[j] !== '\n') {
        if (source[j] === '\\') j++;
        else if (source[j] === '[') inClass = true;
        else if (source[j] === ']') inClass = false;
        else if (source[j] === '/' && !inClass) break;
        j++;
      }
      if (!keepStrings) blank(i + 1, j);
      i = j + 1;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== c && source[j] !== '\n') {
        if (source[j] === '\\') j++;
        j++;
      }
      if (!keepStrings) blank(i + 1, Math.min(j, source.length));
      i = j + 1;
    } else if (c === '`') {
      i++;
      templateText();
    } else if (c === '{') {
      depth++;
      i++;
    } else if (c === '}') {
      depth--;
      i++;
      if (templates.length > 0 && depth === templates[templates.length - 1]) {
        templates.pop();
        templateText();
      }
    } else {
      i++;
    }
  }
  return out.join('');
}

export function lineAt(source: string, index: number): number {
  let line = 1;
  for (let k = 0; k < index; k++) if (source.charCodeAt(k) === 10) line++;
  return line;
}

/** Names in a `{ a, b as c, type d }` clause, by the side that is chosen. */
export function clauseNames(clause: string, side: 'local' | 'exported'): string[] {
  return clause
    .split(',')
    .map((part) => part.trim().replace(/^type\s+/, ''))
    .filter(Boolean)
    .map((part) => {
      const [from, to] = part.split(/\s+as\s+/);
      return (side === 'exported' ? (to ?? from) : from)?.trim() ?? '';
    })
    .filter((name) => new RegExp(`^${IDENT}$`).test(name));
}

/** Named exports a module declares. `default` is never reported, so not read. */
export function exportsOf(source: string, masked = maskSource(source)): ExportDecl[] {
  const lines = source.split('\n');
  const found: ExportDecl[] = [];
  const add = (name: string, index: number): void => {
    const line = lineAt(masked, index);
    found.push({ name, line, declaration: (lines[line - 1] ?? '').trim() });
  };

  const declaration = new RegExp(
    `\\bexport\\s+(?:declare\\s+)?(?:async\\s+)?(?:abstract\\s+)?` +
      `(?:function\\s*\\*?|const\\s+enum|const|let|var|class|enum|type|interface|namespace)\\s+(${IDENT})`,
    'g',
  );
  for (const m of masked.matchAll(declaration)) add(m[1] as string, m.index);

  // `export { a, b as c }` WITHOUT a `from` — local bindings made public.
  // A re-export (`export { a } from './x'`) is the other module's export,
  // passed through; it is read as an import below, never as a declaration.
  for (const m of masked.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}(?!\s*from\b)/g)) {
    for (const name of clauseNames(m[1] as string, 'exported')) add(name, m.index);
  }

  const seen = new Set<string>();
  return found.filter((e) => (seen.has(e.name) ? false : (seen.add(e.name), true)));
}

export interface ImportRef {
  specifier: string;
  taken: Taken;
  /** require() or import(): often wrapped in a try as an optional load. */
  dynamic: boolean;
  /** Offset of the statement in the source, for its line. */
  index: number;
}

/** What one file takes from each specifier it names. */
export function importsOf(source: string, masked = maskSource(source)): ImportRef[] {
  const out: ImportRef[] = [];
  // The masked text blanked the specifier; read it back from the original at
  // the same offsets (the `d` flag records them).
  const spec = (m: RegExpMatchArray, group: number): string => {
    const [start, end] = m.indices?.[group] ?? [0, 0];
    return source.slice(start, end);
  };

  // import X, { a, b as c } from '…' · import { a } from '…' · import X from '…'
  // import type { a } from '…' · import * as ns from '…'
  const fromClause = /\bimport\s+(?:type\s+)?([^'"`;]*?)\s*from\s*(['"])([^'"]*)\2/dg;
  for (const m of masked.matchAll(fromClause)) {
    const clause = (m[1] as string).trim();
    const specifier = spec(m, 3);
    if (/\*\s*as\s+/.test(clause)) {
      out.push({ specifier, taken: 'all', dynamic: false, index: m.index ?? 0 });
      continue;
    }
    const taken = new Set<string>();
    const braces = /\{([^}]*)\}/.exec(clause);
    if (braces) for (const name of clauseNames(braces[1] as string, 'local')) taken.add(name);
    const withoutBraces = clause
      .replace(/\{[^}]*\}/, '')
      .replace(/,/g, '')
      .trim();
    if (withoutBraces) taken.add('default');
    out.push({ specifier, taken, dynamic: false, index: m.index ?? 0 });
  }

  // export * from '…' · export * as ns from '…' — everything passes through.
  for (const m of masked.matchAll(/\bexport\s+\*(?:\s+as\s+\w+)?\s+from\s*(['"])([^'"]*)\1/dg)) {
    out.push({ specifier: spec(m, 2), taken: 'all', dynamic: false, index: m.index ?? 0 });
  }
  // export { a, b as c } from '…'
  for (const m of masked.matchAll(
    /\bexport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*(['"])([^'"]*)\2/dg,
  )) {
    out.push({
      specifier: spec(m, 3),
      taken: new Set(clauseNames(m[1] as string, 'local')),
      dynamic: false,
      index: m.index ?? 0,
    });
  }
  // require('…') and import('…') hand back the whole module object; what is
  // read off it afterwards is not something a pattern can follow.
  for (const m of masked.matchAll(/\b(?:require|import)\s*\(\s*(['"])([^'"]*)\1\s*\)/dg)) {
    out.push({ specifier: spec(m, 2), taken: 'all', dynamic: true, index: m.index ?? 0 });
  }
  return out;
}

function normalise(parts: string[]): string {
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}

/** TypeScript sources and declarations, in the order TypeScript tries them. */
const TS_FIRST = ['.ts', '.tsx', '.d.ts', '.mts', '.d.mts', '.cts', '.d.cts'];

/**
 * Resolves a relative specifier to a snapshot file, or null.
 *
 * Follows TypeScript's order: `./x.js` means `./x.ts` (or its `.d.ts`) when
 * one exists — the NodeNext convention — and only then the `.js` file itself.
 * A published package ships x.js AND x.d.ts side by side, and reading the
 * JavaScript for the names a declaration file exports finds none of the types.
 * Bundler query suffixes (`?raw`, `?script-string`) are not part of the path.
 */
export function resolveSpecifier(
  fromFile: string,
  specifier: string,
  files: ReadonlySet<string>,
): string | null {
  if (!specifier.startsWith('.')) return null;
  const dir = fromFile.split('/').slice(0, -1);
  const base = normalise([...dir, ...specifier.replace(/[?#].*$/, '').split('/')]);
  const stripped = base.replace(/\.(js|jsx|mjs|cjs)$/, '');
  const candidates = [
    ...(stripped !== base ? TS_FIRST.map((ext) => stripped + ext) : []),
    base,
    ...[...TS_FIRST, ...RESOLVE_EXTENSIONS].map((ext) => stripped + ext),
    ...[...TS_FIRST, ...RESOLVE_EXTENSIONS].map((ext) => `${base}/index${ext}`),
  ];
  return candidates.find((c) => files.has(c)) ?? null;
}
