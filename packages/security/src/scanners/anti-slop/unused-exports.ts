// Unused exports (W18-01, CODE_HEALTH_SUITE.md §1 R-25, FR-CH-3).
//
// The backlog's `dead_code` entry waits on knip, and knip needs the
// repository's dependencies installed — which the `--network=none` sandbox
// will never do. This is the part of that analysis that needs NOTHING
// installed: the repository's own import graph, read from source.
//
// TWO SIGNALS MUST AGREE before anything is reported, because a dead-export
// finding is an invitation to delete code and a wrong one costs a revert:
//
//   1. The graph. The module IS imported by another file in the snapshot (so it
//      is live code, not a script or an entry point), every importer names what
//      it takes, and none of them takes this export.
//   2. The text. The name appears in no other file at all. This is what covers
//      the specifiers the graph cannot resolve — tsconfig path aliases,
//      workspace package names, bundler magic — because whatever reached the
//      export through them still had to spell its name.
//
// What this deliberately does not do: report modules nothing imports. A file
// with no importers is as likely to be an entry point, a CLI or a framework
// route as dead code, and the snapshot carries no package.json to tell which.
// JS/TS only — Python and Go have their own idioms and their own tools.

export const UNUSED_EXPORT_RULE_ID = 'slop.unused_export';

export interface UnusedExport {
  ruleId: typeof UNUSED_EXPORT_RULE_ID;
  file: string;
  name: string;
  line: number;
  /** The export's own line, verbatim — the evidence quote. */
  declaration: string;
  /** How many files import the module, for the message. */
  importers: number;
  message: string;
}

const CODE = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
const RESOLVE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];

/**
 * Files whose exports are someone else's contract, never reported.
 *
 * Index and main files are a package's public surface; tests, stories and
 * configs are read by a runner by convention; route directories export names a
 * framework looks up by string. Without a package.json in the snapshot these
 * are recognised by path, and erring towards "public" costs a missed finding
 * rather than a wrong one.
 */
const PUBLIC_SURFACE = [
  /(^|\/)(index|main|mod|public-api)\.[cm]?[jt]sx?$/,
  /\.d\.[cm]?ts$/,
  /\.(test|spec|stories|story|bench|e2e)\.[cm]?[jt]sx?$/,
  /(^|\/)(__tests__|__mocks__|tests?|e2e|fixtures?|stories)\//,
  /(^|\/)[^/]*\.config\.[cm]?[jt]s$/,
  /(^|\/)(pages|app|routes)\//,
  /(^|\/)(bin|scripts?)\//,
  // Generated code: its shape belongs to the generator, not to anyone who
  // could act on a finding.
  /\.(gen|generated)\.[cm]?[jt]sx?$/,
  /(^|\/)(__generated__|generated)\//,
];

/** Names frameworks and runtimes read off a module by string. */
const CONVENTIONAL_NAMES = new Set([
  'default',
  'config',
  'metadata',
  'generateMetadata',
  'generateStaticParams',
  'getStaticProps',
  'getStaticPaths',
  'getServerSideProps',
  'loader',
  'action',
  'meta',
  'links',
  'headers',
  'handler',
  'revalidate',
  'dynamic',
  'runtime',
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
]);

/** Every name a module takes from an importer: a set, or "all of them". */
type Taken = Set<string> | 'all';

interface ExportDecl {
  name: string;
  line: number;
  declaration: string;
}

const IDENT = '[A-Za-z_$][\\w$]*';

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
 */
export function maskSource(source: string, keepStrings = false): string {
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
      blank(i, stop);
      i = stop;
    } else if (c === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
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

function lineAt(source: string, index: number): number {
  let line = 1;
  for (let k = 0; k < index; k++) if (source.charCodeAt(k) === 10) line++;
  return line;
}

/** Names in a `{ a, b as c, type d }` clause, by the side that is chosen. */
function clauseNames(clause: string, side: 'local' | 'exported'): string[] {
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

/** What one file takes from each specifier it names. */
export function importsOf(
  source: string,
  masked = maskSource(source),
): { specifier: string; taken: Taken }[] {
  const out: { specifier: string; taken: Taken }[] = [];
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
      out.push({ specifier, taken: 'all' });
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
    out.push({ specifier, taken });
  }

  // export * from '…' · export * as ns from '…' — everything passes through.
  for (const m of masked.matchAll(/\bexport\s+\*(?:\s+as\s+\w+)?\s+from\s*(['"])([^'"]*)\1/dg)) {
    out.push({ specifier: spec(m, 2), taken: 'all' });
  }
  // export { a, b as c } from '…'
  for (const m of masked.matchAll(
    /\bexport\s+(?:type\s+)?\{([^}]*)\}\s*from\s*(['"])([^'"]*)\2/dg,
  )) {
    out.push({ specifier: spec(m, 3), taken: new Set(clauseNames(m[1] as string, 'local')) });
  }
  // require('…') and import('…') hand back the whole module object; what is
  // read off it afterwards is not something a pattern can follow.
  for (const m of masked.matchAll(/\b(?:require|import)\s*\(\s*(['"])([^'"]*)\1\s*\)/dg)) {
    out.push({ specifier: spec(m, 2), taken: 'all' });
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

/**
 * Resolves a relative specifier to a snapshot file, or null.
 *
 * TypeScript's NodeNext style writes `./x.js` for a file that is `./x.ts`, so
 * a JS extension is tried both as written and stripped.
 */
export function resolveSpecifier(
  fromFile: string,
  specifier: string,
  files: ReadonlySet<string>,
): string | null {
  if (!specifier.startsWith('.')) return null;
  const dir = fromFile.split('/').slice(0, -1);
  const base = normalise([...dir, ...specifier.split('/')]);
  const stripped = base.replace(/\.(js|jsx|mjs|cjs)$/, '');
  const candidates = [
    base,
    ...RESOLVE_EXTENSIONS.map((ext) => stripped + ext),
    ...RESOLVE_EXTENSIONS.map((ext) => `${base}/index${ext}`),
  ];
  return candidates.find((c) => files.has(c)) ?? null;
}

/** How many files mention each identifier, for the second signal. */
function identifierCounts(texts: Iterable<string>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const text of texts) {
    const seen = new Set(text.match(/[A-Za-z_$][\w$]*/g) ?? []);
    for (const name of seen) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

/**
 * Exports of live modules that no other file in the snapshot uses.
 *
 * Both signals described at the top of this file have to agree. The result is
 * sorted by file and line so a re-run on an unchanged tree reports the same
 * list in the same order.
 */
export function unusedExports(files: readonly { path: string; source: string }[]): UnusedExport[] {
  const code = files.filter((f) => CODE.test(f.path));
  const paths = new Set(code.map((f) => f.path));
  const masked = new Map(code.map((f) => [f.path, maskSource(f.source)]));

  // module → what its importers take, and how many importers there are.
  const takenBy = new Map<string, { all: boolean; names: Set<string>; importers: Set<string> }>();
  for (const file of code) {
    for (const { specifier, taken } of importsOf(file.source, masked.get(file.path))) {
      const target = resolveSpecifier(file.path, specifier, paths);
      if (!target || target === file.path) continue;
      const entry = takenBy.get(target) ?? { all: false, names: new Set(), importers: new Set() };
      entry.importers.add(file.path);
      if (taken === 'all') entry.all = true;
      else for (const name of taken) entry.names.add(name);
      takenBy.set(target, entry);
    }
  }

  // Strings kept for both counts: `${name()}` inside a template is a use, and
  // a name in a string may be looked up by it.
  const withStrings = new Map(code.map((f) => [f.path, maskSource(f.source, true)]));
  const mentions = identifierCounts(withStrings.values());
  const out: UnusedExport[] = [];

  for (const file of code) {
    if (PUBLIC_SURFACE.some((re) => re.test(file.path))) continue;
    const taken = takenBy.get(file.path);
    // Not imported by anything we could resolve: maybe dead, maybe an entry
    // point. Not ours to say (see the top of this file).
    if (!taken || taken.all) continue;

    const text = masked.get(file.path) as string;
    for (const decl of exportsOf(file.source, text)) {
      if (CONVENTIONAL_NAMES.has(decl.name) || taken.names.has(decl.name)) continue;

      // Signal two: no other file spells the name. identifierCounts counts
      // files, so anything above 1 means someone else mentioned it.
      if ((mentions.get(decl.name) ?? 0) > 1) continue;
      // And nothing in its own file uses it either. An export used only at
      // home is surface to trim, not dead code — and on a typed codebase it is
      // every props interface, which is the noise that gets a rule muted.
      const escaped = decl.name.replace(/\$/g, '\\$');
      const own = withStrings.get(file.path) as string;
      const ownHits = own.match(new RegExp(`(?<![\\w$])${escaped}(?![\\w$])`, 'g'))?.length ?? 0;
      if (ownHits > 1) continue;

      out.push({
        ruleId: UNUSED_EXPORT_RULE_ID,
        file: file.path,
        name: decl.name,
        line: decl.line,
        declaration: decl.declaration,
        importers: taken.importers.size,
        message:
          `${decl.name} is exported and used nowhere: ${taken.importers.size} file(s) import ` +
          'this module, none of them take it, and no file — this one included — mentions the ' +
          'name again. Likely dead code; check for consumers outside this repository before ' +
          'deleting it.',
      });
    }
  }

  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
