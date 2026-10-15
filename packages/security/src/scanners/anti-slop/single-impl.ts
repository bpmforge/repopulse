import {
  CODE,
  ENTRY_FILE,
  IDENT,
  importsOf,
  isSurfaced,
  lineAt,
  looksMinified,
  maskSource,
  resolveSpecifier,
  surfacedBy,
  TEST_OR_FIXTURE,
} from './source-graph.js';
import { braceDepths, classesOf, closeOf, skipWs, splitTopLevel } from './signatures.js';

// Single-implementation interfaces (W18-05, CODE_HEALTH_SUITE.md §1 R-05).
//
// An interface or abstract class with exactly one implementation in the whole
// repository: a jump on every read, bought for a second implementation that
// does not exist. Counting implementations is a graph question over every
// file, so this needs the WHOLE tree — on a partial read the second
// implementation may be in a file nobody read, and the rule does not run.
//
// TypeScript interfaces are STRUCTURAL, which is where a naive count goes
// wrong: an object literal typed `: Store`, a `satisfies Store`, a cast, or a
// function returning `{ … }` as a Store is an implementation with no
// `implements` keyword. Any of those, anywhere, and the interface is left
// alone. So is one that:
//
//   - is mentioned by any test, mock or fixture — a test double counts as the
//     second implementation, which is the commonest reason the seam exists;
//   - is on a public surface — declared in, named by, or `export *`-reachable
//     from an index/main/.d.ts file — where the other implementations live in
//     consumers' repositories;
//   - is extended by another interface, or its one implementation is itself
//     abstract — a hierarchy, not a single implementation;
//   - shares its name with any other declaration (declaration merging, or two
//     unrelated types whose counts cannot be told apart);
//   - is nested in a namespace or `declare` block (augmentation).
//
// Python is NOT covered, on measurement (plan.json W18-05): counting `ABC`
// subclasses over 116 installed packages found 29 "single implementations",
// and nearly all were extension points published for users to subclass
// (PIL handlers, rich's Pager, OpenTelemetry's BaseDistro), virtual subclasses
// added with `.register()`, or marker ABCs read by `isinstance`. Python has no
// export syntax to tell a published base from a private one, so the rule could
// not be made quiet. `Protocol` would be worse: it exists to be implemented
// without subclassing.

export const SINGLE_IMPL_RULE_ID = 'slop.single_impl_interface';

export interface SingleImpl {
  ruleId: typeof SINGLE_IMPL_RULE_ID;
  file: string;
  name: string;
  line: number;
  kind: 'interface' | 'abstract class';
  /** The one implementation: `src/x.ts:12 FooImpl`. */
  implementation: { file: string; name: string; line: number };
  declaration: string;
  message: string;
}

/** Names of option bags and records, not seams (see the top of this file). */
const DATA_SHAPE =
  /(Args|Arguments|Options|Opts|Config|Configuration|Params|Parameters|Props|Init|Settings|Data|Attrs|Attributes|Fields|Shape|State|Input|Dto|DTO|Payload|Record|Row)$/;

interface Decl {
  file: string;
  name: string;
  index: number;
  kind: SingleImpl['kind'];
}

interface Impl {
  file: string;
  name: string;
  index: number;
  abstract: boolean;
}

/** Files an entry file passes on whole, through chains of `export *`. */
function publicModules(
  code: { path: string; source: string; masked: string }[],
  paths: ReadonlySet<string>,
): Set<string> {
  const reached = new Set<string>();
  const queue = code.filter((f) => ENTRY_FILE.test(f.path)).map((f) => f.path);
  const byPath = new Map(code.map((f) => [f.path, f]));
  while (queue.length > 0) {
    const path = queue.pop() as string;
    if (reached.has(path)) continue;
    reached.add(path);
    const file = byPath.get(path);
    if (!file) continue;
    for (const ref of importsOf(file.source, file.masked)) {
      // Named re-exports surface names, not modules — isSurfaced reads those.
      if (
        ref.taken !== 'all' ||
        !/^\s*export\b/.test(file.masked.slice(ref.index, ref.index + 7))
      ) {
        continue;
      }
      const target = resolveSpecifier(path, ref.specifier, paths);
      if (target && !reached.has(target)) queue.push(target);
    }
  }
  return reached;
}

/**
 * Is `name` implemented structurally somewhere — an object literal typed as
 * it, a `satisfies`, a cast, a function returning a literal as it?
 */
function structurallyImplemented(masked: string, name: string): boolean {
  const n = name.replace(/\$/g, '\\$');
  if (new RegExp(`\\b(?:satisfies|as)\\s+(?:${IDENT}\\.)*${n}(?![\\w$])`).test(masked)) return true;
  if (new RegExp(`<\\s*${n}\\s*>\\s*[({]`).test(masked)) return true;
  // `const x: Name = {` or `= ({`; also `Name[]` / `Array<Name>` holding literals.
  if (new RegExp(`:\\s*(?:${IDENT}\\.)*${n}(?:\\[\\])?\\s*=\\s*[[({]`).test(masked)) return true;
  // A function declared to return one: a literal anywhere in its body counts.
  const returns = new RegExp(
    `\\)\\s*:\\s*(?:Promise\\s*<\\s*)?(?:${IDENT}\\.)*${n}\\s*>?\\s*(=>|\\{)`,
    'g',
  );
  for (const m of masked.matchAll(returns)) {
    const at = (m.index ?? 0) + m[0].length;
    if (m[1] === '=>') {
      if (/^\s*\(?\s*\{/.test(masked.slice(at, at + 40))) return true;
      continue;
    }
    const end = closeOf(masked, at - 1);
    if (end === -1 || /\breturn\s*\(?\s*\{/.test(masked.slice(at, end))) return true;
  }
  // Generic arguments that carry a literal: `useState<Name>({…})`, `new Map<…, Name>`.
  if (new RegExp(`<[^<>;]*\\b${n}\\s*>\\s*\\(\\s*\\{`).test(masked)) return true;
  return false;
}

function tsDeclarations(
  path: string,
  masked: string,
): { decls: Decl[]; names: Map<string, number>; extendedInterfaces: Set<string> } {
  const decls: Decl[] = [];
  const names = new Map<string, number>();
  const extendedInterfaces = new Set<string>();
  const depths = braceDepths(masked);

  const any = new RegExp(
    `(?<![\\w$.])(?:class|interface|type|enum|function|const|let|var|namespace)\\s+(${IDENT})`,
    'g',
  );
  for (const m of masked.matchAll(any)) {
    if ((depths[m.index ?? 0] ?? 0) > 0) continue;
    names.set(m[1] as string, (names.get(m[1] as string) ?? 0) + 1);
  }

  const iface = new RegExp(`(?<![\\w$.])interface\\s+(${IDENT})\\s*(<)?`, 'g');
  for (const m of masked.matchAll(iface)) {
    const at = m.index ?? 0;
    // Find the heritage clause: everything up to the body's `{`.
    let i = at + m[0].length - (m[2] ? 1 : 0);
    if (m[2]) {
      let depth = 0;
      for (; i < masked.length; i++) {
        if (masked[i] === '<') depth++;
        else if (masked[i] === '>' && masked[i - 1] !== '=' && --depth === 0) break;
      }
      i++;
    }
    const open = masked.indexOf('{', i);
    if (open === -1) continue;
    const clause = masked.slice(i, open);
    const ext = /^\s*extends\b([\s\S]*)$/.exec(clause);
    if (ext) {
      for (const part of splitTopLevel(ext[1] as string)) {
        const base = new RegExp(`(${IDENT})\\s*(?:<[\\s\\S]*>)?\\s*$`).exec(part.trim());
        if (base) extendedInterfaces.add(base[1] as string);
      }
    }
    // Top level only: inside `declare global {}` / a namespace it augments.
    if ((depths[at] ?? 0) > 0) continue;
    const before = masked.slice(Math.max(0, at - 30), at);
    if (/\bdeclare\s+$/.test(before)) continue;
    decls.push({ file: path, name: m[1] as string, index: at, kind: 'interface' });
  }

  for (const cls of classesOf(masked)) {
    if (cls.abstract && cls.name && (depths[cls.index] ?? 0) === 0) {
      decls.push({ file: path, name: cls.name, index: cls.index, kind: 'abstract class' });
    }
  }
  return { decls, names, extendedInterfaces };
}

/** Single-implementation interfaces and abstract classes, or [] on a partial read. */
export function singleImplInterfaces(
  files: readonly { path: string; source: string }[],
  opts: { complete: boolean },
): SingleImpl[] {
  if (!opts.complete) return [];
  const out: SingleImpl[] = [];
  out.push(...typescriptSingles(files));
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}

function typescriptSingles(files: readonly { path: string; source: string }[]): SingleImpl[] {
  const code = files
    .filter((f) => CODE.test(f.path))
    .map((f) => ({ ...f, masked: maskSource(f.source) }));
  const paths = new Set(code.map((f) => f.path));
  const exposed = publicModules(code, paths);
  const surfaced = surfacedBy(code);

  const decls: Decl[] = [];
  const declared = new Map<string, number>();
  const extendedInterfaces = new Set<string>();
  const impls = new Map<string, Impl[]>();
  for (const file of code) {
    const found = tsDeclarations(file.path, file.masked);
    decls.push(...found.decls);
    for (const [name, n] of found.names) declared.set(name, (declared.get(name) ?? 0) + n);
    for (const name of found.extendedInterfaces) extendedInterfaces.add(name);
    for (const cls of classesOf(file.masked)) {
      // An abstract class may be `implements`-ed in TypeScript too, so both
      // lists count for both kinds.
      for (const base of [cls.extends, ...cls.implements]) {
        if (!base) continue;
        const list = impls.get(base) ?? [];
        list.push({ file: file.path, name: cls.name, index: cls.index, abstract: cls.abstract });
        impls.set(base, list);
      }
    }
  }

  const testText = code.filter((f) => TEST_OR_FIXTURE.test(f.path)).map((f) => f.masked);
  const entryText = code.filter((f) => ENTRY_FILE.test(f.path)).map((f) => f.masked);
  const out: SingleImpl[] = [];

  for (const decl of decls) {
    if (TEST_OR_FIXTURE.test(decl.file) || exposed.has(decl.file)) continue;
    if (looksMinified(decl.file, code.find((f) => f.path === decl.file)!.source)) continue;
    if (isSurfaced(surfaced, decl.name, decl.file)) continue;
    if ((declared.get(decl.name) ?? 0) !== 1) continue;
    if (extendedInterfaces.has(decl.name)) continue;
    const list = impls.get(decl.name) ?? [];
    if (list.length !== 1) continue;
    const impl = list[0] as Impl;
    if (impl.abstract || !impl.name || (impls.get(impl.name) ?? []).length > 0) continue;
    if (DATA_SHAPE.test(decl.name)) continue;
    const word = new RegExp(`(?<![\\w$])${decl.name.replace(/\$/g, '\\$')}(?![\\w$])`);
    if (testText.some((t) => word.test(t)) || entryText.some((t) => word.test(t))) continue;
    if (code.some((f) => structurallyImplemented(f.masked, decl.name))) continue;

    const source = code.find((f) => f.path === decl.file)!;
    const implFile = code.find((f) => f.path === impl.file)!;
    const line = lineAt(source.masked, skipWs(source.masked, decl.index));
    const implLine = lineAt(implFile.masked, impl.index);
    out.push(
      finding(decl, line, source.source, { file: impl.file, name: impl.name, line: implLine }),
    );
  }
  return out;
}

function finding(
  decl: Decl,
  line: number,
  source: string,
  implementation: SingleImpl['implementation'],
): SingleImpl {
  return {
    ruleId: SINGLE_IMPL_RULE_ID,
    file: decl.file,
    name: decl.name,
    line,
    kind: decl.kind,
    implementation,
    declaration: (source.split('\n')[line - 1] ?? '').trim(),
    message:
      `${decl.kind} ${decl.name} has exactly one implementation in this repository ` +
      `(${implementation.name}, ${implementation.file}:${implementation.line}), no test double ` +
      'and no public export. Every reader pays a jump through it for a second implementation ' +
      `that does not exist; use ${implementation.name} directly until one does.`,
  };
}
