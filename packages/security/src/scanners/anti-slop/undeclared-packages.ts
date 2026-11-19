import { readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { walkSnapshot } from '../../validation/walk.js';
import { CODE, importsOf, lineAt, maskSource } from './source-graph.js';

// Imports of a package nobody declared (W27-21).
//
// The phantom rules next door (phantom-refs.ts) answer for RELATIVE imports:
// a file or a name the repository does not have. This is the other half:
// `require("fastcsv-stream-writer-pro")` in a project whose package.json has
// never heard of it. Either the package was never installed and the line
// throws at load, or it resolves by accident through somebody else's
// dependency and breaks on the next install. A model writes this line often,
// because it has seen a thousand files that import a helper package and no
// package.json to go with them.
//
// Answered from the repository's own manifests, so it needs no registry, no
// lockfile and no node_modules. That is also its limit, and every limit is
// resolved towards silence:
//
//   - a file with no package.json above it is skipped (a script, Deno);
//   - an unparseable package.json above a file makes the file unknowable;
//   - every package.json on the way UP to the root counts, since a workspace
//     package may use what the root declares (hoisting);
//   - workspace siblings (any package.json `name` in the repository), Node
//     built-ins, tsconfig/jsconfig `paths` aliases, `declare module` names and
//     bare specifiers that name a directory of the project (baseUrl imports)
//     are never packages somebody forgot to declare;
//   - a `require` inside a `try` is the optional-dependency idiom.
//   - a type-only import (`import type`, `export type … from`, `{ type X }`)
//     is erased at build time, so nothing fails at load (W27-21, outline).
//
// Ships in shadow like every in-code rule (shippedRuleStatus in run.ts).

export const UNDECLARED_PACKAGE_RULE_ID = 'slop.undeclared_package';

export interface PackageManifest {
  /** Snapshot-relative path of a package.json, tsconfig*.json or jsconfig.json. */
  path: string;
  text: string;
}

export interface UndeclaredPackage {
  ruleId: typeof UNDECLARED_PACKAGE_RULE_ID;
  file: string;
  line: number;
  /** The package name (`@scope/name` or `name`), not the whole specifier. */
  name: string;
  specifier: string;
  /** The package.json a person would add it to (the nearest one above the file). */
  manifest: string;
  /** The importing statement, verbatim: the evidence quote. */
  statement: string;
  message: string;
}

const MANIFEST_NAMES = /^(package\.json|[tj]sconfig(\.[\w-]+)?\.json)$/;

/** walkSnapshot's depth cap: below it a package.json may exist unseen. */
const MAX_DIR_DEPTH = 6;

/** Reads the manifests this rule needs from a snapshot tree. */
export function readPackageManifests(snapshotDir: string): PackageManifest[] {
  const out: PackageManifest[] = [];
  for (const file of walkSnapshot(snapshotDir, MANIFEST_NAMES)) {
    try {
      out.push({
        path: file.relativePath.split('\\').join('/'),
        text: readFileSync(file.absolutePath, 'utf8'),
      });
    } catch {
      // Ephemeral snapshot: a file that vanished is read as absent, and an
      // absent package.json silences the files under it rather than flagging them.
    }
  }
  return out;
}

const BUILTINS: ReadonlySet<string> = new Set([
  ...builtinModules.map((m) => m.split('/')[0] as string),
  // Runtimes and hosts that provide modules without a manifest entry.
  'bun',
  'electron',
  'vscode',
  'k6',
]);

/** Docusaurus and friends: aliases a framework defines, no tsconfig involved. */
const FRAMEWORK_ALIASES: ReadonlySet<string> = new Set([
  '@site',
  '@theme',
  '@theme-original',
  '@theme-init',
  '@generated',
  '@docusaurus',
  '@env',
]);

const DEP_SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
  'bundledDependencies',
  'bundleDependencies',
];

const FIXTURE_PATH = /(^|\/)(fixtures?|__fixtures__|testdata|test-data|__mocks__)\//;
const UNREAD_SEGMENT =
  /(^|\/)(node_modules|dist|build|coverage|vendor|\.next|out|generated|__generated__)(\/|$)/;
const DECLARATION = /\.d\.[cm]?ts$/;

interface Unit {
  dir: string;
  declared: Set<string>;
  parsed: boolean;
}

const dirOf = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const isUnder = (dir: string, file: string): boolean => dir === '' || file.startsWith(`${dir}/`);

/** The package a bare specifier names, or null when it names none. */
function packageName(specifier: string): string | null {
  if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(\/|$)/i.test(specifier)) return null;
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? `${parts[0]}/${parts[1]}` : (parts[0] as string);
}

function readUnit(manifest: PackageManifest, workspaceNames: Set<string>): Unit {
  const unit: Unit = { dir: dirOf(manifest.path), declared: new Set(), parsed: false };
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(manifest.text) as Record<string, unknown>;
  } catch {
    return unit;
  }
  if (doc === null || typeof doc !== 'object') return unit;
  unit.parsed = true;
  if (typeof doc['name'] === 'string') {
    // A package may import itself by name (the `exports` self-reference).
    workspaceNames.add(doc['name']);
  }
  for (const section of DEP_SECTIONS) {
    const table = doc[section];
    const names = Array.isArray(table)
      ? table
      : table !== null && typeof table === 'object'
        ? Object.keys(table)
        : [];
    for (const name of names) {
      if (typeof name !== 'string') continue;
      unit.declared.add(name);
      // `@types/x` types `x`, `@types/a__b` types `@a/b`: an `import type`
      // from either resolves with only the types package installed.
      const typed = /^@types\/(.+)$/.exec(name);
      if (typed) {
        const inner = typed[1] as string;
        unit.declared.add(inner.includes('__') ? `@${inner.replace('__', '/')}` : inner);
      }
    }
  }
  return unit;
}

/** `paths` keys of a tsconfig/jsconfig, read tolerantly (the file has comments). */
function aliasPrefixes(text: string): string[] {
  const block = /"paths"\s*:\s*\{([\s\S]*?)\}/.exec(text);
  if (!block) return [];
  const out: string[] = [];
  for (const m of (block[1] as string).matchAll(/"([^"]+)"\s*:/g)) {
    const key = (m[1] as string).replace(/\*.*$/, '').replace(/\/$/, '');
    if (key) out.push(key);
  }
  return out;
}

/** True when `index` sits in a `try { … }` that has not closed yet. */
function insideTry(masked: string, index: number): boolean {
  const before = masked.slice(Math.max(0, index - 400), index);
  const at = before.lastIndexOf('try');
  if (at === -1 || !/^try\s*\{/.test(before.slice(at))) return false;
  let depth = 0;
  for (const ch of before.slice(at)) {
    if (ch === '{') depth += 1;
    else if (ch === '}') depth -= 1;
  }
  return depth > 0;
}

/**
 * True for an import that leaves nothing behind at build time:
 * `import type … from`, `export type … from`, or a brace list in which every
 * name is `type X` and there is no default. On outline 36 of 41 hits were
 * these (types of `history` and `react-router`, which arrive through
 * react-router-dom): true by the letter, and nothing fails at load.
 */
function typeOnly(masked: string, index: number): boolean {
  const head = masked.slice(index, index + 600);
  if (/^(import|export)\s+type\b/.test(head)) return true;
  const m = /^import\s+\{([^}]*)\}\s*from\b/.exec(head);
  if (!m) return false;
  const names = (m[1] as string)
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  return names.length > 0 && names.every((n) => /^type\s+/.test(n));
}

/**
 * Bare imports of packages no package.json above the file declares.
 *
 * One finding per file and package, at the first import of it.
 */
export function undeclaredPackages(
  files: readonly { path: string; source: string }[],
  manifests: readonly PackageManifest[],
): UndeclaredPackage[] {
  const workspaceNames = new Set<string>();
  const units = manifests
    .filter((m) => /(^|\/)package\.json$/.test(m.path))
    .map((m) => readUnit(m, workspaceNames));
  if (units.length === 0) return [];

  const aliases = new Set<string>(FRAMEWORK_ALIASES);
  for (const m of manifests) {
    if (/(^|\/)package\.json$/.test(m.path)) continue;
    for (const prefix of aliasPrefixes(m.text)) aliases.add(prefix);
  }

  const code = files.filter((f) => CODE.test(f.path));
  const masked = new Map(code.map((f) => [f.path, maskSource(f.source)]));

  // `declare module 'x'` anywhere in the project types `x` for all of it.
  const ambient = new Set<string>();
  for (const f of code) {
    for (const m of f.source.matchAll(/\bdeclare\s+module\s+(['"])([^'"]+)\1/g)) {
      const name = packageName(m[2] as string);
      if (name) ambient.add(name);
    }
  }

  // baseUrl imports (`import x from 'components/Button'`): the first segment
  // is a directory beside a package.json, or under its src/.
  const projectDirs = new Set<string>();
  for (const f of code) {
    for (const unit of units) {
      if (!isUnder(unit.dir, f.path)) continue;
      const rel = (unit.dir === '' ? f.path : f.path.slice(unit.dir.length + 1)).split('/');
      if (rel.length > 1) projectDirs.add(rel[0] as string);
      if (rel.length > 2 && rel[0] === 'src') projectDirs.add(rel[1] as string);
      // A file beside the manifest, imported by its bare name.
      if (rel.length === 1) projectDirs.add((rel[0] as string).replace(/\.[cm]?[jt]sx?$/, ''));
    }
  }

  const out: UndeclaredPackage[] = [];
  for (const file of code) {
    if (FIXTURE_PATH.test(file.path) || UNREAD_SEGMENT.test(file.path)) continue;
    if (DECLARATION.test(file.path)) continue;
    const dir = dirOf(file.path);
    if (dir !== '' && dir.split('/').length > MAX_DIR_DEPTH) continue;

    const above = units.filter((u) => isUnder(u.dir, file.path));
    if (above.length === 0 || above.some((u) => !u.parsed)) continue;
    const nearest = above.reduce((a, b) => (b.dir.length > a.dir.length ? b : a));

    const text = masked.get(file.path) as string;
    const seen = new Set<string>();
    for (const imp of importsOf(file.source, text)) {
      const specifier = imp.specifier;
      // Not a registry name: relative, absolute, `#imports`, `~/x`, `$lib/x`,
      // `node:fs`, `virtual:x`, `https://…`, loader strings (`a!b`), queries.
      if (/^[./#~$]|[:!?]/.test(specifier)) continue;
      const name = packageName(specifier);
      if (name === null || seen.has(name)) continue;
      const first = name.split('/')[0] as string;
      if (BUILTINS.has(first) || workspaceNames.has(name) || ambient.has(name)) continue;
      if (above.some((u) => u.declared.has(name))) continue;
      if (projectDirs.has(first)) continue;
      let aliased = false;
      for (const prefix of aliases) {
        if (specifier === prefix || specifier.startsWith(`${prefix}/`) || first === prefix) {
          aliased = true;
          break;
        }
      }
      if (aliased) continue;
      if (imp.dynamic && insideTry(text, imp.index)) continue;
      if (!imp.dynamic && typeOnly(text, imp.index)) continue;

      seen.add(name);
      const specAt = file.source.indexOf(specifier, imp.index);
      const lineStart = file.source.lastIndexOf('\n', imp.index) + 1;
      const statement = file.source
        .slice(
          imp.dynamic ? lineStart : imp.index,
          specAt === -1 ? imp.index + 200 : specAt + specifier.length + (imp.dynamic ? 2 : 1),
        )
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 300);
      const manifest = nearest.dir === '' ? 'package.json' : `${nearest.dir}/package.json`;
      out.push({
        ruleId: UNDECLARED_PACKAGE_RULE_ID,
        file: file.path,
        line: lineAt(file.source, imp.index),
        name,
        specifier,
        manifest,
        statement,
        message:
          `${file.path} imports "${name}", and no package.json above it declares that package ` +
          `(nearest: ${manifest}). Either it was never installed and this line fails at load, ` +
          'or it resolves through another package by accident and breaks on a clean install. ' +
          'Check that the package exists and is the one intended before adding it.',
      });
    }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line);
}
