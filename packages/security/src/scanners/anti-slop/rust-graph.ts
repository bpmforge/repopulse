import { lineAt } from './source-graph.js';
import { PHANTOM_MODULE_RULE_ID, PHANTOM_SYMBOL_RULE_ID, type PhantomRef } from './phantom-refs.js';
import { UNUSED_EXPORT_RULE_ID, type UnusedExport } from './unused-exports.js';

// The Rust module graph (W18-14, mechanical-checks plan §A).
//
// Rust's module tree is declared, not discovered: `mod foo;` in a file obliges
// the compiler to find foo.rs or foo/mod.rs beside it, and `use crate::a::B`
// names a path through that tree. Both are answerable from the crate's own
// files, with no cargo and no rustc — which is what the sandbox has.
//
// Three checks, all within one crate:
//   - slop.phantom_module: a `mod foo;` whose file does not exist, or a
//     `use crate::a::b::X` whose middle segment names nothing in its parent.
//   - slop.phantom_symbol: a `use crate::a::X` where module `a` defines no X.
//   - slop.unused_export: a crate-visible item (`pub(crate)`, `pub(super)`,
//     `pub(in ...)`) whose name appears nowhere else in its crate.
//
// WHAT MAKES A MODULE UNKNOWABLE, and so never a source of findings. Its
// surface cannot be read from its text when it has a glob import (`use x::*`
// brings in names nobody spelled), an item-level macro invocation (a macro can
// define any item — tokio declares half its modules inside `cfg_rt! { }`), or
// `include!` (the items live in a generated file). The name set is otherwise a
// deliberate OVER-approximation: every item keyword in the file, at any depth,
// counts as defining its name. A name defined only in an inline submodule then
// reads as present — a missed finding, never a wrong one.
//
// CRATE ROOTS come from Cargo's default layout only, because the snapshot
// reader never loads Cargo.toml: src/lib.rs, src/main.rs, src/bin/*, build.rs,
// and the files directly under tests/, examples/ and benches/. A crate with a
// custom `[lib] path` is simply never reached, so nothing in it is reported.

export const RUST = /\.rs$/;

/** Default-layout crate roots (see the top of this file). */
const CRATE_ROOT =
  /(^|\/)(src\/(lib|main)\.rs|src\/bin\/[^/]+\.rs|src\/bin\/[^/]+\/main\.rs|build\.rs|(tests|examples|benches)\/[^/]+\.rs|(examples|benches)\/[^/]+\/main\.rs)$/;

/** Directories the snapshot reader skips — a module there was never read. */
const UNREAD_SEGMENT =
  /(^|\/)(node_modules|\.git|dist|build|coverage|vendor|\.next|\.venv|__pycache__)(\/|$)/;

/** Scanner fixtures are broken on purpose. */
const FIXTURE_PATH = /(^|\/)(fixtures?|__fixtures__|testdata|test-data)\//;

const KEYWORDS = new Set([
  'as',
  'async',
  'await',
  'break',
  'const',
  'continue',
  'crate',
  'dyn',
  'else',
  'enum',
  'extern',
  'false',
  'fn',
  'for',
  'if',
  'impl',
  'in',
  'let',
  'loop',
  'match',
  'mod',
  'move',
  'mut',
  'pub',
  'ref',
  'return',
  'self',
  'Self',
  'static',
  'struct',
  'super',
  'trait',
  'true',
  'type',
  'unsafe',
  'use',
  'where',
  'while',
]);

/**
 * Blanks comments and literal contents, keeping offsets and newlines.
 *
 * Quote characters survive so a masked `"..."` still reads as an expression.
 * Strings are KEPT on request for the name count: `#[serde(default = "f")]`
 * names `f` in a string, and a name that only appears there is still used.
 *
 * The one Rust-specific trap is `'`: it opens a char literal (`'a'`, `'\n'`)
 * and a lifetime (`'a`) alike, and treating a lifetime as a char would blank
 * the rest of the line.
 */
export function maskRust(source: string, keepStrings = false): string {
  const out = source.split('');
  const blank = (from: number, to: number): void => {
    for (let k = from; k < to; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  const n = source.length;
  let i = 0;
  while (i < n) {
    const c = source[i] as string;
    const next = source[i + 1];
    if (c === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? n : end;
      blank(i, stop);
      i = stop;
      continue;
    }
    if (c === '/' && next === '*') {
      // Block comments nest in Rust.
      let depth = 1;
      let k = i + 2;
      while (k < n && depth > 0) {
        if (source[k] === '/' && source[k + 1] === '*') {
          depth++;
          k += 2;
        } else if (source[k] === '*' && source[k + 1] === '/') {
          depth--;
          k += 2;
        } else k++;
      }
      blank(i, k);
      i = k;
      continue;
    }
    // Raw strings: r"..", r#".."#, br#".."#, cr".." — no escapes inside.
    if (c === 'r' && (next === '"' || next === '#') && !/[\w]/.test(source[i - 1] ?? ' ')) {
      i = rawString(i + 1, i + 1);
      continue;
    }
    if (
      (c === 'b' || c === 'c') &&
      source[i + 1] === 'r' &&
      (source[i + 2] === '"' || source[i + 2] === '#') &&
      !/[\w]/.test(source[i - 1] ?? ' ')
    ) {
      i = rawString(i + 2, i + 2);
      continue;
    }
    if (c === '"') {
      let k = i + 1;
      while (k < n && source[k] !== '"') k += source[k] === '\\' ? 2 : 1;
      if (!keepStrings) blank(i + 1, Math.min(k, n));
      i = k + 1;
      continue;
    }
    if (c === "'") {
      // Char literal: an escape, or one code point, then a closing quote.
      if (next === '\\') {
        let k = i + 2;
        while (k < n && source[k] !== "'" && source[k] !== '\n') k++;
        if (source[k] === "'") {
          blank(i + 1, k);
          i = k + 1;
          continue;
        }
      } else if (next !== undefined) {
        const width = (source.codePointAt(i + 1) ?? 0) > 0xffff ? 2 : 1;
        if (source[i + 1 + width] === "'") {
          blank(i + 1, i + 1 + width);
          i = i + 2 + width;
          continue;
        }
      }
      // A lifetime: leave it as text.
      i++;
      continue;
    }
    i++;
  }
  return out.join('');

  /** `at` is the first `#` or `"` after the r prefix; returns the index past the end. */
  function rawString(at: number, start: number): number {
    let hashes = 0;
    let k = at;
    while (source[k] === '#') {
      hashes++;
      k++;
    }
    if (source[k] !== '"') return start; // `r#ident` — a raw identifier, not a string
    const close = `"${'#'.repeat(hashes)}`;
    const end = source.indexOf(close, k + 1);
    const stop = end === -1 ? n : end;
    if (!keepStrings) blank(k + 1, stop);
    return stop + close.length;
  }
}

type FrameKind = 'mod' | 'macro' | 'macro_rules' | 'other';

interface ModDecl {
  name: string;
  index: number;
  /** Enclosing inline `mod x { }` names, outermost first. */
  inline: string[];
  /** An inline module (`mod x { }`), as opposed to an out-of-line `mod x;`. */
  body: boolean;
  /** `#[path = ...]` moves the file somewhere this resolver does not follow. */
  pathAttr: boolean;
}

interface UseLeaf {
  segments: string[];
  glob: boolean;
}

interface UseStmt {
  index: number;
  /** The whole statement, whitespace collapsed — the evidence quote. */
  statement: string;
  leaves: UseLeaf[];
  /** Enclosing inline module names: `self`/`super` resolve from there. */
  inline: string[];
}

export interface RustFileIndex {
  mods: ModDecl[];
  uses: UseStmt[];
  /** Every name the file could be defining (an over-approximation). */
  names: Set<string>;
  macros: Set<string>;
  /** The surface cannot be read from the text (see the top of this file). */
  unknowable: boolean;
}

// `const`/`static` exclude a following qualifier: in `pub const fn never` the
// name is `never`, and a regex that took `fn` as the const's name would also
// consume the `fn` and never see `never` (crossbeam-channel's lib.rs did this).
const ITEM_NAME =
  /\b(?:fn|struct|enum|union|trait|type|mod)\s+(?:r#)?([A-Za-z_]\w*)|\b(?:const|static(?:\s+mut)?)\s+(?!(?:fn|unsafe|async|extern)\b)(?:r#)?([A-Za-z_]\w*)/g;
const EXTERN_CRATE = /\bextern\s+crate\s+(?:r#)?([A-Za-z_]\w*)(?:\s+as\s+([A-Za-z_]\w*))?/g;

/** Indexes one file: its mod declarations, use statements and defined names. */
export function indexRustFile(source: string, masked = maskRust(source)): RustFileIndex {
  const mods: ModDecl[] = [];
  const uses: UseStmt[] = [];
  const names = new Set<string>();
  const macros = new Set<string>();
  let unknowable = false;

  for (const m of masked.matchAll(ITEM_NAME)) names.add((m[1] ?? m[2]) as string);
  for (const m of masked.matchAll(EXTERN_CRATE)) names.add((m[2] ?? m[1]) as string);

  const frames: { kind: FrameKind; name?: string }[] = [];
  let pending: FrameKind | null = null;
  const itemLevel = (): boolean => frames.every((f) => f.kind === 'mod' || f.kind === 'macro');
  const inMacroRules = (): boolean => frames.some((f) => f.kind === 'macro_rules');
  const inlinePath = (): string[] =>
    frames.filter((f) => f.kind === 'mod').map((f) => f.name as string);

  const TOKEN =
    /(\{)|(\})|\bmacro_rules\s*!\s*(?:r#)?([A-Za-z_]\w*)|\bmod\s+(?:r#)?([A-Za-z_]\w*)\s*([;{])|\b(use)\s|([A-Za-z_]\w*)!\s*([({[])/g;
  for (const m of masked.matchAll(TOKEN)) {
    const at = m.index;
    if (m[1]) {
      const top = frames[frames.length - 1];
      frames.push({ kind: pending ?? (top?.kind === 'macro' ? 'macro' : 'other') });
      pending = null;
    } else if (m[2]) {
      frames.pop();
    } else if (m[3]) {
      macros.add(m[3]);
      names.add(m[3]);
      // Only a `{`-bodied definition opens a frame; `macro_rules! m ( .. );`
      // has parentheses the brace counter never sees.
      if (/^\s*\{/.test(masked.slice(at + m[0].length))) pending = 'macro_rules';
    } else if (m[4]) {
      const body = m[5] === '{';
      const counted = !inMacroRules() && itemLevel();
      // The match consumed the `{`, so its frame opens here either way.
      if (body) frames.push(counted ? { kind: 'mod', name: m[4] } : { kind: 'other' });
      if (!counted) continue;
      mods.push({
        name: m[4],
        index: at,
        inline: body ? inlinePath().slice(0, -1) : inlinePath(),
        body,
        pathAttr: /#\s*\[\s*path\s*=/.test(attributesBefore(masked, at)),
      });
    } else if (m[6]) {
      if (inMacroRules() || !isStatementStart(masked, at)) continue;
      const end = masked.indexOf(';', at);
      if (end === -1) continue;
      const tree = masked.slice(at + 3, end);
      const leaves = parseUseTree(tree);
      if (!leaves) continue;
      for (const leaf of leaves) {
        if (leaf.glob) {
          if (itemLevel()) unknowable = true;
        } else {
          const last = leaf.segments[leaf.segments.length - 1];
          if (last && last !== 'self') names.add(leaf.alias ?? last);
          else if (last === 'self' && leaf.segments.length > 1) {
            names.add(leaf.alias ?? (leaf.segments[leaf.segments.length - 2] as string));
          }
        }
      }
      uses.push({
        index: at,
        statement: source
          .slice(at, end + 1)
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 300),
        leaves: leaves.map(({ segments, glob }) => ({ segments, glob })),
        inline: inlinePath(),
      });
    } else if (m[7]) {
      // A macro at item level can define anything; inside a body it cannot
      // add to the module's surface.
      if (!KEYWORDS.has(m[7]) && itemLevel()) unknowable = true;
      // The match consumed the `{`: open its frame here.
      if (m[8] === '{') frames.push({ kind: inMacroRules() ? 'other' : 'macro' });
    }
  }
  return { mods, uses, names, macros, unknowable };
}

/** The attribute text directly before an item at `index` (back to the previous item). */
function attributesBefore(masked: string, index: number): string {
  let k = index - 1;
  while (k >= 0 && !';{}'.includes(masked[k] as string)) k--;
  return masked.slice(k + 1, index);
}

/** `use` as a statement — not `r#use`, not a field named `use_x`. */
function isStatementStart(masked: string, index: number): boolean {
  let k = index - 1;
  while (k >= 0 && /\s/.test(masked[k] as string)) k--;
  if (k < 0) return true;
  const prev = masked[k] as string;
  if (';{}]'.includes(prev)) return true;
  // `pub use`, `pub(crate) use`
  if (prev === ')') {
    const open = masked.lastIndexOf('(', k);
    return /\bpub\s*$/.test(masked.slice(Math.max(0, open - 8), open));
  }
  return /\bpub$/.test(masked.slice(Math.max(0, k - 3), k + 1));
}

/** Leaves of a use tree: `crate::a::{self, B as C, d::*}`. Null when it does not parse. */
export function parseUseTree(text: string): (UseLeaf & { alias?: string })[] | null {
  const tokens = text.match(/::|[{},*]|(?:r#)?[A-Za-z_]\w*/g) ?? [];
  let pos = 0;
  const out: (UseLeaf & { alias?: string })[] = [];

  const tree = (prefix: string[]): boolean => {
    const segments = [...prefix];
    if (tokens[pos] === '::') {
      // `use ::std::x` — an extern path.
      segments.push('::');
      pos++;
    }
    for (;;) {
      const t = tokens[pos];
      if (t === undefined) return false;
      if (t === '{') {
        pos++;
        while (tokens[pos] !== '}') {
          if (tokens[pos] === undefined) return false;
          if (!tree(segments)) return false;
          if (tokens[pos] === ',') pos++;
        }
        pos++;
        return true;
      }
      if (t === '*') {
        pos++;
        out.push({ segments, glob: true });
        return true;
      }
      if (t === '::' || t === ',' || t === '}') return false;
      segments.push(t.replace(/^r#/, ''));
      pos++;
      if (tokens[pos] === '::') {
        pos++;
        continue;
      }
      let alias: string | undefined;
      if (tokens[pos] === 'as') {
        alias = tokens[pos + 1];
        pos += 2;
      }
      out.push({ segments, glob: false, ...(alias !== undefined ? { alias } : {}) });
      return true;
    }
  };

  if (!tree([])) return null;
  return pos === tokens.length ? out : null;
}

// ---- The crate's module tree ---------------------------------------------

interface ModNode {
  file: string;
  /** Inline module names inside `file`; empty for a file-backed module. */
  inline: string[];
  /** Where `mod x;` declared in this module looks for x.rs / x/mod.rs. */
  dir: string;
  parent: ModNode | null;
  children: Map<string, ModNode | 'missing' | 'unresolved'>;
}

function dirname(p: string): string {
  const k = p.lastIndexOf('/');
  return k === -1 ? '' : p.slice(0, k);
}

function join(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

/** The directory a FILE's own `mod x;` declarations resolve against. */
function moduleDir(file: string, isRoot: boolean): string {
  if (isRoot || /(^|\/)mod\.rs$/.test(file)) return dirname(file);
  return file.replace(/\.rs$/, '');
}

interface Crate {
  root: ModNode;
  /** Every module node, by file then inline path. */
  nodes: ModNode[];
  /** Out-of-line declarations whose file is in neither candidate place. */
  missing: { file: string; decl: ModDecl; candidates: string[] }[];
}

function buildCrate(
  rootFile: string,
  index: Map<string, RustFileIndex>,
  paths: ReadonlySet<string>,
): Crate {
  const root: ModNode = {
    file: rootFile,
    inline: [],
    dir: moduleDir(rootFile, true),
    parent: null,
    children: new Map(),
  };
  const nodes: ModNode[] = [root];
  const missing: Crate['missing'] = [];
  const visited = new Set<string>([rootFile]);
  const queue: ModNode[] = [root];

  while (queue.length) {
    const fileNode = queue.shift()!;
    const idx = index.get(fileNode.file);
    if (!idx) continue;
    // Inline modules first, so nested declarations find their parent node.
    const byInline = new Map<string, ModNode>([['', fileNode]]);
    const nodeFor = (inline: string[]): ModNode | undefined => byInline.get(inline.join('::'));
    for (const decl of idx.mods) {
      const parent = nodeFor(decl.inline);
      if (!parent) continue;
      if (decl.body) {
        const node: ModNode = {
          file: fileNode.file,
          inline: [...decl.inline, decl.name],
          dir: join(parent.dir, decl.name),
          parent,
          children: new Map(),
        };
        parent.children.set(decl.name, node);
        byInline.set(node.inline.join('::'), node);
        nodes.push(node);
        continue;
      }
      if (decl.pathAttr) {
        parent.children.set(decl.name, 'unresolved');
        continue;
      }
      const candidates = [
        join(parent.dir, `${decl.name}.rs`),
        join(parent.dir, `${decl.name}/mod.rs`),
      ];
      const found = candidates.find((c) => paths.has(c));
      if (!found) {
        parent.children.set(decl.name, 'missing');
        missing.push({ file: fileNode.file, decl, candidates });
        continue;
      }
      if (visited.has(found)) {
        // Two declarations of one file is a compile error of its own; a cycle
        // through #[path] is not something this resolver follows.
        parent.children.set(decl.name, 'unresolved');
        continue;
      }
      visited.add(found);
      const child: ModNode = {
        file: found,
        inline: [],
        dir: moduleDir(found, false),
        parent,
        children: new Map(),
      };
      parent.children.set(decl.name, child);
      nodes.push(child);
      queue.push(child);
    }
  }
  return { root, nodes, missing };
}

type UseVerdict =
  | { kind: 'ok' }
  | { kind: 'unknown' }
  | { kind: 'missing-module'; name: string }
  | { kind: 'missing-symbol'; name: string; target: string };

/** Resolves one `use` leaf from `from`, inside `crate`. */
function resolveLeaf(
  leaf: UseLeaf,
  from: ModNode,
  crate: Crate,
  index: Map<string, RustFileIndex>,
  crateMacros: ReadonlySet<string>,
): UseVerdict {
  if (leaf.glob) return { kind: 'unknown' };
  const segs = leaf.segments;
  let node: ModNode;
  let k: number;
  if (segs[0] === 'crate') {
    node = crate.root;
    k = 1;
  } else if (segs[0] === 'self' || segs[0] === 'super') {
    node = from;
    k = 0;
    while (segs[k] === 'self' || segs[k] === 'super') {
      if (segs[k] === 'super') {
        if (!node.parent) return { kind: 'unknown' };
        node = node.parent;
      }
      k++;
    }
  } else {
    // An extern crate, a 2018 relative path, or a prelude name: not ours.
    return { kind: 'unknown' };
  }
  if (k >= segs.length) return { kind: 'ok' };

  const surface = (n: ModNode): RustFileIndex | null => {
    if (n.inline.length) return null; // inline modules share their file's names
    const idx = index.get(n.file);
    return idx && !idx.unknowable ? idx : null;
  };

  for (; k < segs.length - 1; k++) {
    const seg = segs[k] as string;
    const child = node.children.get(seg);
    if (child === 'missing' || child === 'unresolved') return { kind: 'unknown' };
    if (child) {
      node = child;
      continue;
    }
    // Not a module of this one. An enum, a type, a re-exported module — any
    // name the module defines can continue a path we do not follow.
    const s = surface(node);
    if (!s || s.names.has(seg)) return { kind: 'unknown' };
    return { kind: 'missing-module', name: seg };
  }

  const last = segs[segs.length - 1] as string;
  if (last === 'self') return { kind: 'ok' };
  if (node.children.has(last)) return { kind: 'ok' };
  const s = surface(node);
  if (!s) return { kind: 'unknown' };
  // `#[macro_export]` puts a macro at the crate root wherever it was written.
  if (s.names.has(last) || crateMacros.has(last)) return { kind: 'ok' };
  return { kind: 'missing-symbol', name: last, target: node.file };
}

/** Default-layout crate roots present in the snapshot. */
export function crateRoots(paths: Iterable<string>): string[] {
  return [...paths]
    .filter((p) => {
      const m = CRATE_ROOT.exec(p);
      if (!m || FIXTURE_PATH.test(p)) return false;
      // The layout is relative to the PACKAGE directory: tokio's
      // src/runtime/tests/queue.rs is a module of the library, not a test
      // crate, and a src/build.rs is a module named build.
      return !/(^|\/)src\//.test(p.slice(0, m.index + (m[1] ?? '').length));
    })
    .sort();
}

interface Graph {
  files: Map<string, { path: string; source: string }>;
  index: Map<string, RustFileIndex>;
  crates: Crate[];
}

function buildGraph(files: readonly { path: string; source: string }[]): Graph {
  const rust = files.filter((f) => RUST.test(f.path));
  const byPath = new Map(rust.map((f) => [f.path, f]));
  const index = new Map(rust.map((f) => [f.path, indexRustFile(f.source)]));
  const paths = new Set(byPath.keys());
  const crates = crateRoots(paths).map((root) => buildCrate(root, index, paths));
  return { files: byPath, index, crates };
}

/** Files some crate root's module walk reaches — the files the checks can judge. */
export function reachableRustFiles(
  files: readonly { path: string; source: string }[],
): Set<string> {
  return new Set(buildGraph(files).crates.flatMap((c) => c.nodes.map((n) => n.file)));
}

/**
 * Phantom modules and symbols across a snapshot's Rust crates.
 *
 * `complete` has the same meaning as in phantom-refs: a missing FILE is only
 * reported when the snapshot read skipped nothing. A missing NAME needs only
 * the target module's file, which is in hand whenever the path resolved.
 */
export function rustPhantomRefs(
  files: readonly { path: string; source: string }[],
  opts: { complete: boolean },
): PhantomRef[] {
  const g = buildGraph(files);
  const out: PhantomRef[] = [];
  const reported = new Set<string>();
  const push = (ref: PhantomRef): void => {
    const key = `${ref.ruleId}:${ref.file}:${ref.line}:${ref.name ?? ''}`;
    if (reported.has(key)) return;
    reported.add(key);
    out.push(ref);
  };

  for (const crate of g.crates) {
    if (opts.complete) {
      for (const { file, decl, candidates } of crate.missing) {
        if (FIXTURE_PATH.test(file)) continue;
        // A module under a directory the reader skips (build/, vendor/) was
        // never read, so its absence proves nothing.
        if (candidates.some((c) => UNREAD_SEGMENT.test(dirname(c)))) continue;
        const source = g.files.get(file)!.source;
        const line = lineAt(source, decl.index);
        push({
          ruleId: PHANTOM_MODULE_RULE_ID,
          file,
          line,
          specifier: decl.name,
          name: null,
          statement: (source.split('\n')[line - 1] ?? '').trim().slice(0, 300),
          message:
            `\`mod ${decl.name};\` declares a module with no file: neither ${candidates[0]} nor ` +
            `${candidates[1]} exists. The crate does not compile until one does.`,
        });
      }
    }

    const crateMacros = new Set<string>();
    for (const node of crate.nodes) {
      for (const m of g.index.get(node.file)?.macros ?? []) crateMacros.add(m);
    }

    for (const node of crate.nodes) {
      // One pass per FILE: inline module nodes share it.
      if (node.inline.length || FIXTURE_PATH.test(node.file)) continue;
      const idx = g.index.get(node.file)!;
      const source = g.files.get(node.file)!.source;
      const inlineNodes = new Map<string, ModNode>([['', node]]);
      for (const n of crate.nodes) {
        if (n.file === node.file && n.inline.length) inlineNodes.set(n.inline.join('::'), n);
      }
      for (const use of idx.uses) {
        const from = inlineNodes.get(use.inline.join('::'));
        if (!from) continue;
        const missingSymbols: { name: string; target: string }[] = [];
        let missingModule: string | null = null;
        for (const leaf of use.leaves) {
          const verdict = resolveLeaf(leaf, from, crate, g.index, crateMacros);
          if (verdict.kind === 'missing-symbol') missingSymbols.push(verdict);
          else if (verdict.kind === 'missing-module' && opts.complete)
            missingModule ??= verdict.name;
        }
        if (missingModule === null && !missingSymbols.length) continue;
        const line = lineAt(source, use.index);
        if (missingModule !== null) {
          push({
            ruleId: PHANTOM_MODULE_RULE_ID,
            file: node.file,
            line,
            specifier: missingModule,
            name: null,
            statement: use.statement,
            message:
              `${use.statement} goes through \`${missingModule}\`, which its parent module ` +
              'neither declares nor defines. The crate does not compile with this import.',
          });
        }
        if (missingSymbols.length) {
          const names = missingSymbols.map((m) => m.name);
          const targets = [...new Set(missingSymbols.map((m) => m.target))].join(', ');
          push({
            ruleId: PHANTOM_SYMBOL_RULE_ID,
            file: node.file,
            line,
            specifier: targets,
            name: names.join(', '),
            statement: use.statement,
            message:
              `${use.statement} imports ${names.map((n) => `\`${n}\``).join(', ')}, and ${targets} ` +
              `defines no such ${names.length === 1 ? 'item' : 'items'}. The crate does not ` +
              'compile with this import.',
          });
        }
      }
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

const CRATE_VISIBLE_ITEM =
  /\bpub\s*\(\s*(?:crate|super|in\s+[\w:]+)\s*\)\s+(?:(?:const|async|unsafe|extern(?:\s+"[^"]*")?)\s+)*(fn|struct|enum|union|trait|type|const|static)\s+(?:r#)?([A-Za-z_]\w*)/g;

/** Attributes that mean "used from outside the crate's own text". */
const EXTERNAL_USE_ATTR =
  /#\s*\[\s*(?:no_mangle|export_name|used|allow\s*\([^)]*\b(?:dead_code|unused)\b|proc_macro)/;

/** `#![allow(dead_code)]` — the author has already said dead code here is known. */
const ALLOW_DEAD_INNER = /#!\s*\[\s*allow\s*\([^)]*\b(?:dead_code|unused)\b/;

/**
 * Crate-visible items whose name appears nowhere else in their crate.
 *
 * Only `pub(crate)` / `pub(super)` / `pub(in ...)`: a plain `pub` item in a
 * library is public API whose consumers live in other repositories. The name
 * count keeps strings (see maskRust) and counts EVERY occurrence in the
 * snapshot's Rust files, so a method called as `x.name()`, a serde `default = "name"` and a
 * macro argument all count as uses — the price is missing an item whose name
 * happens to be a common word.
 */
export function rustUnusedItems(
  files: readonly { path: string; source: string }[],
): UnusedExport[] {
  const g = buildGraph(files);
  const out: UnusedExport[] = [];
  const seen = new Set<string>();

  // Counted over EVERY Rust file in the snapshot, not just the files the
  // module walk reached: a `#[path]` module (tokio's process/unix) is
  // unreachable to the walk and still uses the crate's items. Counting more
  // text only ever removes findings.
  const texts = [...g.files.values()].map((f) => maskRust(f.source, true));
  // Identifiers built in macros (`paste!`, `concat_idents!`) can call a
  // function no text ever spells.
  if (texts.some((t) => /\b(?:paste|concat_idents)!/.test(t))) return out;
  const counts = new Map<string, number>();
  for (const text of texts) {
    for (const word of text.match(/[A-Za-z_]\w*/g) ?? []) {
      counts.set(word, (counts.get(word) ?? 0) + 1);
    }
  }

  for (const crate of g.crates) {
    const crateFiles = [...new Set(crate.nodes.map((n) => n.file))];
    if (ALLOW_DEAD_INNER.test(maskRust(g.files.get(crate.root.file)!.source))) continue;

    for (const file of crateFiles) {
      if (FIXTURE_PATH.test(file) || seen.has(file)) continue;
      seen.add(file);
      const source = g.files.get(file)!.source;
      const masked = maskRust(source);
      if (ALLOW_DEAD_INNER.test(masked)) continue;
      for (const m of masked.matchAll(CRATE_VISIBLE_ITEM)) {
        const name = m[2] as string;
        if (name.startsWith('_') || (counts.get(name) ?? 0) > 1) continue;
        if (EXTERNAL_USE_ATTR.test(attributesBefore(masked, m.index))) continue;
        const line = lineAt(source, m.index);
        out.push({
          ruleId: UNUSED_EXPORT_RULE_ID,
          file,
          name,
          line,
          declaration: (source.split('\n')[line - 1] ?? '').trim().slice(0, 300),
          importers: 0,
          message:
            `${name} is a ${m[1]} visible to its whole crate, and nothing in the crate — this ` +
            'file included — mentions it again. It cannot be used from outside the crate, so ' +
            'this is dead code.',
        });
      }
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
