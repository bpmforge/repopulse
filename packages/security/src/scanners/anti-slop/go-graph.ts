import { PHANTOM_MODULE_RULE_ID, PHANTOM_SYMBOL_RULE_ID, type PhantomRef } from './phantom-refs.js';
import { UNUSED_EXPORT_RULE_ID, type UnusedExport } from './unused-exports.js';

// The Go fast lane (W18-12, mechanical-checks plan §A).
//
// Go makes the graph unusually readable: an import path under the module's own
// path IS a directory of the snapshot, and a package's surface is every
// top-level declaration in that directory, capitalised or not — there is no
// export list to misread. So the same two questions the TypeScript lane asks
// can be answered from text alone:
//
//   - phantom package: `import "example.com/app/internal/cache"` where the
//     snapshot has no Go file in internal/cache;
//   - phantom identifier: `cache.NewLRU(…)` where no file in that directory
//     declares NewLRU at the top level.
//
// Both are compile errors, so a real repository that builds has none; what is
// left to get wrong is our reading of it. Every guard below exists because a
// specific shape would otherwise make a building repository look broken:
//
//   - a package name SHADOWED by a local (`func f(config *config.Config)` then
//     `config.Port`) — the selector is a field, not a package member;
//   - a path under the module that belongs to a NESTED module (its own go.mod,
//     or a `require` of a longer path) — that directory is someone else's;
//   - GENERATED files that are produced at build time and never committed — a
//     directory with a `//go:generate` line is not judged;
//   - directories the snapshot reader never descends into (vendor, build…).

export { PHANTOM_MODULE_RULE_ID, PHANTOM_SYMBOL_RULE_ID, UNUSED_EXPORT_RULE_ID };

interface GoFile {
  path: string;
  dir: string;
  source: string;
  /** Comments and string contents blanked, offsets and newlines kept. */
  masked: string;
}

interface GoModule {
  path: string;
  /** Directory of the go.mod, relative to the snapshot root ('' = root). */
  dir: string;
  /** Module paths this go.mod requires or replaces: never our directories. */
  foreign: string[];
}

interface GoImport {
  alias: string | null;
  path: string;
  /** Offset of the path's opening quote. */
  index: number;
}

interface Declared {
  name: string;
  line: number;
  kind: 'func' | 'type' | 'var' | 'const';
}

/** Directories readSnapshotSources skips, plus the ones the go tool ignores. */
const UNREAD_SEGMENT =
  /^(node_modules|\.git|dist|build|coverage|vendor|\.next|\.venv|__pycache__|testdata)$|^[._]/;

/** Trees that are broken on purpose — test inputs, scanner fixtures. */
const FIXTURE_PATH = /(^|\/)(fixtures?|__fixtures__|testdata|test-data)\//;

const IDENT_RE = /^[A-Za-z_]\w*$/;

/** The go tool's own marker for generated code (go help generate). */
const GENERATED_FILE = /^\/\/ Code generated .* DO NOT EDIT\.$/m;

/**
 * Blanks Go comments and, unless asked to keep them, string and rune contents.
 * Raw strings may span lines; their newlines are kept so line numbers hold.
 */
export function maskGo(source: string, keepStrings = false): string {
  const out = source.split('');
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
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
    } else if (c === '`') {
      const end = source.indexOf('`', i + 1);
      const stop = end === -1 ? source.length : end;
      if (!keepStrings) blank(i + 1, stop);
      i = stop + 1;
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < source.length && source[j] !== c && source[j] !== '\n') {
        if (source[j] === '\\') j++;
        j++;
      }
      if (!keepStrings) blank(i + 1, Math.min(j, source.length));
      i = j + 1;
    } else {
      i++;
    }
  }
  return out.join('');
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let k = 0; k < index; k++) if (source.charCodeAt(k) === 10) line++;
  return line;
}

function dirOf(path: string): string {
  const cut = path.lastIndexOf('/');
  return cut === -1 ? '' : path.slice(0, cut);
}

function joinDir(dir: string, rest: string): string {
  if (!dir) return rest;
  if (!rest) return dir;
  return `${dir}/${rest}`;
}

const unquote = (s: string): string => s.replace(/^["`]|["`]$/g, '');

/** The module path, and every module path the file requires or replaces. */
export function parseGoMod(source: string): { module: string | null; foreign: string[] } {
  const text = source.replace(/\/\/[^\n]*/g, '');
  const mod = /^\s*module\s+("[^"]+"|`[^`]+`|\S+)/m.exec(text);
  const foreign: string[] = [];
  const addLine = (line: string): void => {
    // require: `path version`; replace: `path [version] => target`. Only the
    // left-hand path names a module whose packages are not our directories.
    const first = line.trim().split(/\s+/)[0];
    if (first && first !== ')' && first !== '(') foreign.push(unquote(first));
  };
  for (const m of text.matchAll(/^\s*(require|replace)\s*\(([\s\S]*?)^\s*\)/gm)) {
    for (const line of (m[2] as string).split('\n')) if (line.trim()) addLine(line);
  }
  for (const m of text.matchAll(/^\s*(require|replace)\s+([^(\s][^\n]*)$/gm)) {
    addLine(m[2] as string);
  }
  return { module: mod ? unquote(mod[1] as string) : null, foreign };
}

/** A file's imports, read from text with strings kept and comments blanked. */
export function goImports(source: string): GoImport[] {
  const text = maskGo(source, true);
  const out: GoImport[] = [];
  const spec = /^\s*([A-Za-z_]\w*|\.)?\s*"([^"\n]+)"/;
  const add = (chunk: string, offset: number): void => {
    const m = spec.exec(chunk);
    if (!m) return;
    out.push({
      alias: m[1] ?? null,
      path: m[2] as string,
      index: offset + chunk.indexOf('"'),
    });
  };
  for (const m of text.matchAll(/\bimport\s*\(([^)]*)\)/g)) {
    const body = m[1] as string;
    const bodyAt = (m.index ?? 0) + m[0].indexOf('(') + 1;
    let at = 0;
    for (const line of body.split(/[\n;]/)) {
      add(line, bodyAt + at);
      at += line.length + 1;
    }
  }
  for (const m of text.matchAll(/\bimport\s+(?!\()((?:[A-Za-z_]\w*|\.)?\s*"[^"\n]+")/g)) {
    add(m[1] as string, (m.index ?? 0) + m[0].indexOf(m[1] as string));
  }
  return out;
}

/** Offsets of the file's import declarations, so references skip them. */
function importSpans(masked: string): [number, number][] {
  const spans: [number, number][] = [];
  for (const m of masked.matchAll(/\bimport\s*\([^)]*\)|\bimport\s+[^\n]*/g)) {
    spans.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  }
  return spans;
}

/** The package clause, or null. */
function packageName(masked: string): string | null {
  return /^\s*package\s+([A-Za-z_]\w*)/m.exec(masked)?.[1] ?? null;
}

/**
 * Top-level names a file declares: funcs (not methods), types, vars, consts,
 * including grouped `var ( … )` blocks.
 *
 * Over-reading is the safe direction. A continuation line inside a group may be
 * taken for a name; that can only hide a finding, never invent one.
 */
export function goDeclarations(masked: string): Declared[] {
  const out: Declared[] = [];
  const lines = masked.split('\n');
  let depth = 0;
  let group: { kind: 'type' | 'var' | 'const'; depth: number } | null = null;
  for (let n = 0; n < lines.length; n++) {
    const line = lines[n] as string;
    const atStart = depth;
    if (atStart === 0) {
      group = null;
      const fn = /^func\s+([A-Za-z_]\w*)/.exec(line);
      if (fn) out.push({ name: fn[1] as string, line: n + 1, kind: 'func' });
      const decl = /^(type|var|const)\s*(\(|([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*))/.exec(line);
      if (decl) {
        const kind = decl[1] as 'type' | 'var' | 'const';
        if (decl[2] === '(') group = { kind, depth: 1 };
        else namesIn(decl[3] as string, kind, n + 1, out);
      }
    } else if (group && atStart === group.depth) {
      const entry = /^\s*([A-Za-z_]\w*(?:\s*,\s*[A-Za-z_]\w*)*)/.exec(line);
      if (entry) namesIn(entry[1] as string, group.kind, n + 1, out);
    }
    for (const ch of line) {
      if (ch === '(' || ch === '{' || ch === '[') depth++;
      else if (ch === ')' || ch === '}' || ch === ']') depth = Math.max(0, depth - 1);
    }
  }
  return out;
}

function namesIn(list: string, kind: Declared['kind'], line: number, out: Declared[]): void {
  const names = list.split(',').map((s) => s.trim());
  // `type A B` declares only A; `var a, b int` declares both.
  for (const name of kind === 'type' ? names.slice(0, 1) : names) {
    if (IDENT_RE.test(name) && name !== '_') out.push({ name, line, kind });
  }
}

interface GoPackage {
  dir: string;
  files: GoFile[];
  /** null when the directory's non-test files disagree (or there are none). */
  name: string | null;
  declared: Set<string>;
  /** A //go:generate line: some of its files may not be committed. */
  generated: boolean;
}

function readPackages(files: readonly GoFile[]): Map<string, GoPackage> {
  const byDir = new Map<string, GoFile[]>();
  for (const f of files) {
    const list = byDir.get(f.dir) ?? [];
    list.push(f);
    byDir.set(f.dir, list);
  }
  const out = new Map<string, GoPackage>();
  for (const [dir, list] of byDir) {
    const names = new Set<string>();
    for (const f of list) {
      if (f.path.endsWith('_test.go')) continue;
      const name = packageName(f.masked);
      // `package documentation` / build-ignored `package main` tools sit beside
      // real packages; a name that is not the import's is ambiguity, not proof.
      if (name && !/(^|\/)doc\.go$/.test(f.path)) names.add(name);
    }
    const declared = new Set<string>();
    // _test.go files included: export_test.go exposes internals to the
    // external test package, and counting more names only ever hides findings.
    for (const f of list) for (const d of goDeclarations(f.masked)) declared.add(d.name);
    out.set(dir, {
      dir,
      files: list,
      name: names.size === 1 ? ([...names][0] as string) : null,
      declared,
      generated: list.some((f) => /^\s*\/\/go:generate\b/m.test(f.source)),
    });
  }
  return out;
}

export interface GoGraph {
  files: GoFile[];
  modules: GoModule[];
  packages: Map<string, GoPackage>;
}

export function buildGoGraph(sources: readonly { path: string; source: string }[]): GoGraph {
  const modules: GoModule[] = [];
  const files: GoFile[] = [];
  for (const s of sources) {
    if (s.path === 'go.mod' || s.path.endsWith('/go.mod')) {
      const parsed = parseGoMod(s.source);
      if (parsed.module) {
        modules.push({ path: parsed.module, dir: dirOf(s.path), foreign: parsed.foreign });
      }
    } else if (s.path.endsWith('.go')) {
      files.push({ path: s.path, dir: dirOf(s.path), source: s.source, masked: maskGo(s.source) });
    }
  }
  return { files, modules, packages: readPackages(files) };
}

/**
 * The snapshot directory an import path names, or null when the path is not
 * one of this repository's own packages.
 */
export function resolveGoImport(graph: GoGraph, importPath: string): string | null {
  let best: GoModule | null = null;
  for (const m of graph.modules) {
    if (importPath !== m.path && !importPath.startsWith(`${m.path}/`)) continue;
    if (!best || m.path.length > best.path.length) best = m;
  }
  if (!best) return null;
  // A required (or replaced) module with a longer path owns this import, even
  // when its directory happens to sit inside ours: it builds from the module
  // cache, not from here.
  for (const m of graph.modules) {
    for (const f of m.foreign) {
      if (f.length > best.path.length && (importPath === f || importPath.startsWith(`${f}/`))) {
        return null;
      }
    }
  }
  return joinDir(best.dir, importPath.slice(best.path.length + 1));
}

/** Is `alias` used in this file as anything other than `alias.Name`? */
function shadowed(masked: string, alias: string, spans: [number, number][]): boolean {
  const re = new RegExp(`(?<![\\w.])${alias}\\b(?!\\s*\\.)`, 'g');
  for (const m of masked.matchAll(re)) {
    const at = m.index ?? 0;
    if (spans.some(([a, b]) => at >= a && at < b)) continue;
    return true;
  }
  // `x.alias.Name` is a field chain, but `alias` there is never the package;
  // the reference regex below already refuses a preceding dot.
  return false;
}

/**
 * Phantom packages and phantom identifiers across a snapshot's Go code.
 *
 * Both need a COMPLETE read: a missing package is only missing if the reader
 * reached every directory, and a missing identifier is only missing if every
 * file of the package was read — a size-skipped file can be the one that
 * declares it, and the reader does not say which directory it was in.
 */
export function goPhantomRefs(
  sources: readonly { path: string; source: string }[],
  opts: { complete: boolean },
): PhantomRef[] {
  if (!opts.complete) return [];
  const graph = buildGoGraph(sources);
  if (graph.modules.length === 0) return [];
  const out: PhantomRef[] = [];

  for (const file of graph.files) {
    if (FIXTURE_PATH.test(file.path)) continue;
    const spans = importSpans(file.masked);
    const lines = file.source.split('\n');
    for (const imp of goImports(file.source)) {
      const dir = resolveGoImport(graph, imp.path);
      if (dir === null) continue;
      const line = lineOf(file.source, imp.index);
      const statement = (lines[line - 1] ?? '').trim();
      if (dir.split('/').some((seg) => UNREAD_SEGMENT.test(seg))) continue;
      const pkg = graph.packages.get(dir);

      if (!pkg) {
        out.push({
          ruleId: PHANTOM_MODULE_RULE_ID,
          file: file.path,
          line,
          specifier: imp.path,
          name: null,
          statement,
          message:
            `${imp.path} is a package of this module, and ${dir || 'the module root'} has no Go ` +
            'files. Importing a package that was never written does not compile.',
        });
        continue;
      }

      const alias = imp.alias ?? pkg.name;
      if (!alias || alias === '_' || alias === '.') continue;
      if (pkg.generated) continue;
      if (shadowed(file.masked, alias, spans)) continue;

      const missing = new Map<string, number>();
      const ref = new RegExp(`(?<![\\w.])${alias}\\s*\\.\\s*([A-Z]\\w*)`, 'g');
      for (const m of file.masked.matchAll(ref)) {
        const name = m[1] as string;
        if (pkg.declared.has(name) || missing.has(name)) continue;
        missing.set(name, lineOf(file.source, m.index ?? 0));
      }
      for (const [name, at] of missing) {
        out.push({
          ruleId: PHANTOM_SYMBOL_RULE_ID,
          file: file.path,
          line: at,
          specifier: imp.path,
          name,
          statement: (lines[at - 1] ?? '').trim().slice(0, 300),
          message:
            `${file.path} uses ${alias}.${name}, and no file in ${dir || 'the module root'} ` +
            `declares ${name} at package level. It does not compile.`,
        });
      }
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

/**
 * Exported names of `internal/` packages that nothing references.
 *
 * Internal packages only: the go tool refuses imports of them from outside the
 * module, so every possible consumer is in the snapshot. An exported name in
 * any other package is public API, and its callers are in repositories we
 * cannot see. Package-level `var`s are left out — `-ldflags -X` sets them by
 * name from a build script, and nothing in the Go source says so.
 */
export function goUnusedExports(
  sources: readonly { path: string; source: string }[],
  opts: { complete: boolean },
): UnusedExport[] {
  if (!opts.complete) return [];
  const graph = buildGoGraph(sources);
  if (graph.modules.length === 0) return [];

  // Who imports which directory: a package nobody imports may be a program or
  // a plugin entry point, and is not judged (the same rule as the TS lane).
  const importers = new Map<string, number>();
  for (const f of graph.files) {
    for (const imp of goImports(f.source)) {
      const dir = resolveGoImport(graph, imp.path);
      if (dir !== null) importers.set(dir, (importers.get(dir) ?? 0) + 1);
    }
  }

  // Every identifier token in the snapshot's Go code, comments blanked but
  // strings KEPT: a name spelled in a string may be looked up by reflection or
  // a template, and counting it costs a finding rather than inventing one.
  const counts = new Map<string, number>();
  for (const f of graph.files) {
    for (const m of maskGo(f.source, true).matchAll(/[A-Za-z_]\w*/g)) {
      counts.set(m[0], (counts.get(m[0]) ?? 0) + 1);
    }
  }

  const out: UnusedExport[] = [];
  for (const pkg of graph.packages.values()) {
    if (!/(^|\/)internal(\/|$)/.test(pkg.dir)) continue;
    if (pkg.generated || pkg.name === null || pkg.name === 'main') continue;
    if (
      FIXTURE_PATH.test(`${pkg.dir}/`) ||
      pkg.dir.split('/').some((s) => UNREAD_SEGMENT.test(s))
    ) {
      continue;
    }
    const users = importers.get(pkg.dir) ?? 0;
    if (users === 0) continue;
    for (const f of pkg.files) {
      if (f.path.endsWith('_test.go')) continue;
      // cgo `//export` and `//go:linkname` reach names from outside Go, and
      // a generated file's surface is the generator's (mockery emits a
      // constructor per mock whether or not a test calls it).
      if (/^\s*\/\/(export|go:linkname)\b/m.test(f.source)) continue;
      if (GENERATED_FILE.test(f.source)) continue;
      const lines = f.source.split('\n');
      for (const d of goDeclarations(f.masked)) {
        if (d.kind === 'var' || !/^[A-Z]/.test(d.name)) continue;
        if ((counts.get(d.name) ?? 0) > 1) continue;
        out.push({
          ruleId: UNUSED_EXPORT_RULE_ID,
          file: f.path,
          name: d.name,
          line: d.line,
          declaration: (lines[d.line - 1] ?? '').trim(),
          importers: users,
          message:
            `${d.name} is exported from ${pkg.dir}, an internal package only this module can ` +
            `import, and the name appears nowhere else in the module (${users} importing ` +
            `file${users === 1 ? '' : 's'}). Delete it, or unexport it if it is still needed here.`,
        });
      }
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
