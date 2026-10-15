import {
  CODE,
  clauseNames,
  exportsOf,
  importsOf,
  lineAt,
  maskSource,
  resolveSpecifier,
} from './source-graph.js';

// Phantom references (W18-02, mechanical-checks plan §A).
//
// The hallucination that survives into a repository is rarely a package name
// any more — slopsquat catches those. It is a NAME: `import { formatCurrency }
// from './utils'` where utils never had one, written by a model that has seen a
// thousand utils files that did. TypeScript refuses it at build time; plain
// JavaScript imports `undefined` and fails on the first call, in production.
//
// Both rules here are answered by the repository's own files, so they need no
// model and no installed dependencies, and they are bugs rather than taste —
// which is why, unlike most of the anti_slop layer, their severity is 3.
//
// WHAT MAKES A TARGET UNKNOWABLE. A module whose surface cannot be read from
// its text is skipped, never guessed at: CommonJS (`module.exports`),
// `export =`, destructured exports (`export const { a, b } = x`), and any
// `export *` that leads somewhere the snapshot does not contain.

export const PHANTOM_SYMBOL_RULE_ID = 'slop.phantom_symbol';
export const PHANTOM_MODULE_RULE_ID = 'slop.phantom_module';

export interface PhantomRef {
  ruleId: typeof PHANTOM_SYMBOL_RULE_ID | typeof PHANTOM_MODULE_RULE_ID;
  file: string;
  line: number;
  specifier: string;
  /** The missing name(s), comma-separated; null for a missing module. */
  name: string | null;
  /** The importing line, verbatim — the evidence quote. */
  statement: string;
  message: string;
}

interface Surface {
  names: Set<string>;
  hasDefault: boolean;
  /** The surface cannot be read from the text (see the top of this file). */
  unknowable: boolean;
  stars: string[];
}

/** Specifiers whose files are not source: a stylesheet, an image, JSON. */
const NON_CODE_SPECIFIER = /\.(?!(?:[cm]?[jt]sx?)$)[A-Za-z0-9]+$/;

/** Path segments readSnapshotSources never reads — a miss there proves nothing. */
const UNREAD_SEGMENT =
  /(^|\/)(node_modules|dist|build|coverage|vendor|\.next|out|generated|__generated__)(\/|$)/;

/** Tests may import files their own setup generates at run time. */
const TEST_PATH =
  /(\.(test|spec)\.[cm]?[jt]sx?$)|(^|\/)(__tests__|tests?|e2e|benchmarks?|examples?)\//;

function escapesRoot(dirParts: string[], specifier: string): boolean {
  let depth = dirParts.length;
  for (const part of specifier.split('/')) {
    if (part === '..') depth -= 1;
    else if (part !== '.' && part !== '') depth += 1;
    if (depth < 0) return true;
  }
  return false;
}

function isDirectory(dirParts: string[], specifier: string, paths: ReadonlySet<string>): boolean {
  const parts = [...dirParts];
  for (const part of specifier.split('/')) {
    if (part === '..') parts.pop();
    else if (part !== '.' && part !== '') parts.push(part);
  }
  const prefix = `${parts.join('/')}/`;
  for (const p of paths) if (p.startsWith(prefix)) return true;
  return false;
}

const DECLARATION = /\.d\.[cm]?ts$/;

const FIXTURE_PATH = /(^|\/)(fixtures?|__fixtures__|testdata|test-data)\//;

function surfaceOf(source: string, masked: string): Surface {
  const names = new Set(exportsOf(source, masked).map((e) => e.name));
  let unknowable =
    /\bmodule\.exports\b|\bexports\.[A-Za-z_$]/.test(masked) ||
    /\bexport\s*=/.test(masked) ||
    /\bexport\s+(?:declare\s+)?(?:const|let|var)\s*[{[]/.test(masked) ||
    /\bdeclare\s+module\b/.test(masked);
  const hasDefault =
    /\bexport\s+default\b/.test(masked) || /\bexport\s*\{[^}]*\bas\s+default\b/.test(masked);

  // Re-exported names are this module's exports too.
  for (const m of masked.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}\s*from\b/g)) {
    for (const name of clauseNames(m[1] as string, 'exported')) names.add(name);
  }
  for (const m of masked.matchAll(/\bexport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\b/g)) {
    names.add(m[1] as string);
  }
  const stars: string[] = [];
  for (const m of masked.matchAll(/\bexport\s+\*\s+from\s*(['"])([^'"]*)\1/dg)) {
    const [start, end] = m.indices?.[2] ?? [0, 0];
    stars.push(source.slice(start, end));
  }
  // A module with no export statement at all is a script or CommonJS — either
  // way, nothing about its surface can be said.
  if (names.size === 0 && !hasDefault && stars.length === 0) unknowable = true;
  return { names, hasDefault, unknowable, stars };
}

/**
 * Phantom symbols and modules across a snapshot.
 *
 * `complete` says the snapshot read was not capped or size-skipped. A missing
 * MODULE is only reported when it is: in a truncated read, the file may simply
 * be one the reader never reached. A missing NAME needs only the target file,
 * which is in hand whenever the import resolved.
 */
export function phantomRefs(
  files: readonly { path: string; source: string }[],
  opts: { complete: boolean },
): PhantomRef[] {
  const code = files.filter((f) => CODE.test(f.path));
  const paths = new Set(code.map((f) => f.path));
  const byPath = new Map(code.map((f) => [f.path, f]));
  const masked = new Map(code.map((f) => [f.path, maskSource(f.source)]));
  const surfaces = new Map<string, Surface>();
  const surface = (path: string): Surface => {
    let s = surfaces.get(path);
    if (!s) {
      s = surfaceOf(byPath.get(path)!.source, masked.get(path)!);
      surfaces.set(path, s);
    }
    return s;
  };

  /** Every name `path` exports, following `export *`; null if unknowable. */
  const resolved = new Map<string, Set<string> | null>();
  const exportedNames = (path: string, seen: Set<string> = new Set()): Set<string> | null => {
    if (resolved.has(path)) return resolved.get(path)!;
    if (seen.has(path)) return new Set(); // a cycle adds nothing new
    seen.add(path);
    const s = surface(path);
    let out: Set<string> | null = s.unknowable ? null : new Set(s.names);
    for (const spec of s.stars) {
      if (!out) break;
      const target = resolveSpecifier(path, spec, paths);
      const inner = target ? exportedNames(target, seen) : null;
      if (!inner) out = null;
      else for (const name of inner) out.add(name);
    }
    resolved.set(path, out);
    return out;
  };

  const out: PhantomRef[] = [];
  for (const file of code) {
    // Fixtures are broken on purpose — a scanner's own trigger cases import
    // modules that do not exist, and that is the point of them.
    if (FIXTURE_PATH.test(file.path)) continue;
    const text = masked.get(file.path)!;
    for (const imp of importsOf(file.source, text)) {
      if (!imp.specifier.startsWith('.')) continue;
      const line = lineAt(file.source, imp.index);
      // The whole statement, whitespace collapsed: a multi-line import's first
      // line is just `import {`, which is no evidence of anything.
      const specAt = file.source.indexOf(imp.specifier, imp.index);
      const statement = file.source
        .slice(imp.index, specAt === -1 ? imp.index + 200 : specAt + imp.specifier.length + 1)
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300);
      const target = resolveSpecifier(file.path, imp.specifier, paths);

      if (!target) {
        if (!opts.complete || imp.dynamic || TEST_PATH.test(file.path)) continue;
        if (NON_CODE_SPECIFIER.test(imp.specifier) || /[?#]/.test(imp.specifier)) continue;
        const dirParts = file.path.split('/').slice(0, -1);
        if (UNREAD_SEGMENT.test(`${dirParts.join('/')}/${imp.specifier}`)) continue;
        // `..`, `./lib/` and the like name a DIRECTORY, which resolves through
        // a package.json the snapshot reader never loads.
        if (/(^|\/)\.{1,2}\/?$/.test(imp.specifier) || imp.specifier.endsWith('/')) continue;
        if (isDirectory(dirParts, imp.specifier, paths)) continue;
        // A path that climbs above the repository root points at something
        // outside the snapshot — a sibling checkout, an example's parent.
        if (escapesRoot(dirParts, imp.specifier)) continue;
        out.push({
          ruleId: PHANTOM_MODULE_RULE_ID,
          file: file.path,
          line,
          specifier: imp.specifier,
          name: null,
          statement,
          message:
            `${imp.specifier} does not resolve to any file in the repository. A relative import ` +
            'of a module that was never written fails at build time in TypeScript and at load ' +
            'time in JavaScript.',
        });
        continue;
      }
      if (imp.taken === 'all') continue;
      // Declaration files are skipped as targets. Every top-level declaration
      // in a .d.ts module is exported whether it says `export` or not, and a
      // .d.ts beside a .js describes the JavaScript only as far as its author
      // kept up — neither surface can be read from the text alone.
      if (DECLARATION.test(target)) continue;

      const names = exportedNames(target);
      if (!names) continue;
      const s = surface(target);
      // One finding per import statement, naming every missing name: the
      // statement is the evidence, and two findings with one evidence line
      // would fold into one in the store anyway.
      const missing = [...imp.taken].filter((name) =>
        name === 'default' ? !s.hasDefault : !names.has(name),
      );
      if (missing.length === 0) continue;
      const shown = missing.map((n) => (n === 'default' ? 'default' : `"${n}"`)).join(', ');
      out.push({
        ruleId: PHANTOM_SYMBOL_RULE_ID,
        file: file.path,
        line,
        specifier: imp.specifier,
        name: missing.join(', '),
        statement,
        message:
          `${file.path} imports ${shown} from ${imp.specifier}, and ${target} exports no such ` +
          `${missing.length === 1 ? 'name' : 'names'}. In TypeScript this does not compile; in ` +
          'JavaScript it is undefined at the first call.',
      });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
