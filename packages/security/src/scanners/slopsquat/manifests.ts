import path from 'node:path';
import type { SlopEcosystem } from './names.js';

// Where each dependency is DECLARED, with its line (W21-05).
//
// validation/declared.ts already reads manifests, but for a different question
// ("which of these did the project choose for runtime") and without positions.
// A slopsquat finding has to point at the line a person would delete, so these
// readers keep the line and the line's text, and read EVERY dependency table —
// a hallucinated dev dependency still runs its install script on every laptop
// and CI machine that installs it.
//
// NOT A REGISTRY DEPENDENCY, so never checked: local paths (`file:`, `path =`,
// `-e ./x`, Go `replace => ./x`), VCS and URL sources (`git+`, `github:`,
// `git =`, `name @ https://...`), workspace links (`workspace:`, `link:`,
// `workspace = true`) and alternative registries named on the dependency
// itself (Cargo `registry =`). An npm alias (`"x": "npm:real@^1"`) is read as
// the REAL name — that is what gets installed.
//
// A PRIVATE INDEX (pip `--index-url`, Poetry/uv/PDM sources, a Pipfile source
// other than pypi.org, a Gemfile source other than rubygems.org) makes "not on
// the public registry" meaningless for that manifest: existence is reported as
// not checked there, and only the near-miss half runs.

export interface Declaration {
  ecosystem: SlopEcosystem;
  /** As written (an npm alias resolved to its target). */
  name: string;
  /** 1-based line of the declaration. */
  line: number;
  /** The declaring line, trimmed — the evidence quote. */
  text: string;
  /** Which table/section declared it, for the rationale. */
  section: string;
}

export interface ManifestRead {
  manifest: string;
  declarations: Declaration[];
  /** The manifest points its installer at a non-public index. */
  privateIndex: boolean;
  /** npm scopes mapped to a private registry by an .npmrc in the snapshot. */
  privateScopes?: string[];
  /** For package.json: its own `name`, so workspace siblings are not flagged. */
  ownName?: string;
  /** The file did not parse, so its declarations are unknown (not "none"). */
  unparsed?: boolean;
}

/** Manifests this file reads, by basename. */
export const DECLARING_MANIFEST =
  /^(package\.json|requirements[\w.-]*\.(txt|in)|pyproject\.toml|Pipfile|setup\.cfg|go\.mod|Cargo\.toml|Gemfile|gems\.rb|pom\.xml|build\.gradle(\.kts)?)$/;

/** Lockfiles whose entries prove a name RESOLVED from a registry once. */
export const RESOLVING_LOCKFILE =
  /^(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|uv\.lock|pdm\.lock|Pipfile\.lock|go\.sum|Cargo\.lock|Gemfile\.lock|gems\.locked)$/;

const lines = (text: string): string[] => text.split(/\r?\n/);
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Reads one manifest, or null when its basename is not one we read. */
export function readDeclarations(manifest: string, text: string): ManifestRead | null {
  const base = path.basename(manifest);
  if (!DECLARING_MANIFEST.test(base)) return null;
  const out: ManifestRead = { manifest, declarations: [], privateIndex: false };
  if (base === 'package.json') readPackageJson(text, out);
  else if (/^requirements/.test(base)) readRequirements(text, out);
  else if (base === 'pyproject.toml') readPyproject(text, out);
  else if (base === 'Pipfile') readPipfile(text, out);
  else if (base === 'setup.cfg') readSetupCfg(text, out);
  else if (base === 'go.mod') readGoMod(text, out);
  else if (base === 'Cargo.toml') readCargo(text, out);
  else if (base === 'Gemfile' || base === 'gems.rb') readGemfile(text, out);
  else if (base === 'pom.xml') readPom(text, out);
  else readGradle(text, out);
  return out;
}

// ---- npm --------------------------------------------------------------------

const NPM_SECTIONS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
];

/** A spec that does not come from the registry. */
function npmNonRegistry(spec: string): boolean {
  return (
    /^(file|link|workspace|portal|git|git\+[a-z]+|github|gitlab|bitbucket|https?|catalog):/i.test(
      spec,
    ) ||
    // GitHub shorthand `user/repo` or `user/repo#ref`.
    /^[\w.-]+\/[\w.-]+(#.*)?$/.test(spec) ||
    spec.startsWith('.') ||
    spec.startsWith('/') ||
    spec.startsWith('~/')
  );
}

function readPackageJson(text: string, out: ManifestRead): void {
  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch {
    out.unparsed = true;
    return;
  }
  if (typeof doc['name'] === 'string') out.ownName = doc['name'];
  const all = lines(text);
  for (const section of NPM_SECTIONS) {
    const table = doc[section];
    if (table === null || typeof table !== 'object') continue;
    const header = all.findIndex((l) => new RegExp(`^\\s*"${section}"\\s*:`).test(l));
    for (const [key, value] of Object.entries(table as Record<string, unknown>)) {
      if (typeof value !== 'string') continue;
      let name = key;
      const alias = /^npm:((?:@[^/@]+\/)?[^@]+)(?:@.*)?$/.exec(value);
      if (alias) name = alias[1]!;
      else if (npmNonRegistry(value.trim())) continue;
      const keyRe = new RegExp(`^\\s*"${escapeRe(key)}"\\s*:`);
      let at = -1;
      for (let i = Math.max(0, header); i < all.length; i += 1) {
        if (keyRe.test(all[i]!)) {
          at = i;
          break;
        }
      }
      out.declarations.push({
        ecosystem: 'npm',
        name,
        line: at === -1 ? Math.max(1, header + 1) : at + 1,
        text: (at === -1 ? `"${key}": "${value}"` : all[at]!).trim(),
        section,
      });
    }
  }
}

// ---- PyPI -------------------------------------------------------------------

const PEP508_NAME = /^\s*([A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?)\s*(\[[^\]]*\])?\s*(.*)$/;

/** A PEP 508 requirement's registry name, or null for a URL/path/VCS requirement. */
function requirementName(spec: string): string | null {
  const trimmed = spec.trim();
  if (trimmed === '' || /^(\.|\/|~|git\+|hg\+|svn\+|bzr\+|https?:|file:)/i.test(trimmed))
    return null;
  const m = PEP508_NAME.exec(trimmed);
  if (!m) return null;
  // `name @ https://...` is a direct reference, not a registry package.
  if (/^@/.test(m[3]!.trim())) return null;
  return m[1]!;
}

function readRequirements(text: string, out: ManifestRead): void {
  lines(text).forEach((raw, i) => {
    const line = raw.replace(/\s+#.*$/, '').trim();
    if (line === '' || line.startsWith('#')) return;
    if (/^(-i|--index-url|--extra-index-url)\b/.test(line)) {
      // Pointing pip at another index makes "not on PyPI" meaningless here.
      if (!/https?:\/\/(pypi\.org|pypi\.python\.org)\b/.test(line)) out.privateIndex = true;
      return;
    }
    if (line.startsWith('-')) return; // -r, -c, -e, --hash, … : options, not packages
    const name = requirementName(line.replace(/\s*;.*$/, ''));
    if (name)
      out.declarations.push({
        ecosystem: 'pypi',
        name,
        line: i + 1,
        text: raw.trim(),
        section: 'requirements',
      });
  });
}

/** TOML, read line by line with the current table and any open array. */
function* tomlLines(
  text: string,
): Generator<{ table: string; key: string | null; value: string; line: number; raw: string }> {
  let table = '';
  let arrayKey: string | null = null;
  const all = lines(text);
  for (let i = 0; i < all.length; i += 1) {
    const raw = all[i]!;
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (line === '') continue;
    if (arrayKey === null && line.startsWith('[')) {
      const header = /^\[\[?\s*([^\]]+?)\s*\]\]?$/.exec(line);
      if (header) {
        table = header[1]!.replace(/\s*\.\s*/g, '.').replace(/"/g, '');
        continue;
      }
    }
    if (arrayKey !== null) {
      yield { table, key: arrayKey, value: line, line: i + 1, raw };
      if (/\]\s*,?\s*$/.test(line) && !/\[[^\]]*$/.test(line)) arrayKey = null;
      continue;
    }
    const kv = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\s*=\s*(.*)$/.exec(line);
    if (!kv) continue;
    const key = kv[1] ?? kv[2] ?? kv[3]!;
    const value = kv[4]!;
    yield { table, key, value, line: i + 1, raw };
    if (value.startsWith('[') && !/\]\s*$/.test(value)) arrayKey = key;
  }
}

const quotedStrings = (s: string): string[] =>
  [...s.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2] ?? '');

/** A Poetry/Pipfile/Cargo table value that is a path, VCS or URL source. */
const nonRegistryTable = (value: string): boolean =>
  /\b(path|git|url|file|develop|workspace)\s*=/.test(value) &&
  !/\bworkspace\s*=\s*false/.test(value);

function readPyproject(text: string, out: ManifestRead): void {
  for (const { table, key, value, line, raw } of tomlLines(text)) {
    if (/^tool\.(poetry\.source|uv\.index|pdm\.source)$/.test(table)) {
      out.privateIndex = true;
      continue;
    }
    if (table === 'tool.uv' && (key === 'index-url' || key === 'extra-index-url'))
      out.privateIndex = true;
    const pep621 =
      (table === 'project' && key === 'dependencies') ||
      table === 'project.optional-dependencies' ||
      table === 'dependency-groups' ||
      (table === 'build-system' && key === 'requires');
    if (pep621) {
      for (const spec of quotedStrings(value)) {
        const name = requirementName(spec);
        if (name)
          out.declarations.push({
            ecosystem: 'pypi',
            name,
            line,
            text: raw.trim(),
            section: table,
          });
      }
      continue;
    }
    const poetry =
      table === 'tool.poetry.dependencies' ||
      table === 'tool.poetry.dev-dependencies' ||
      /^tool\.poetry\.group\.[^.]+\.dependencies$/.test(table);
    if (poetry && key && key.toLowerCase() !== 'python' && !nonRegistryTable(value)) {
      out.declarations.push({
        ecosystem: 'pypi',
        name: key,
        line,
        text: raw.trim(),
        section: table,
      });
    }
  }
}

function readPipfile(text: string, out: ManifestRead): void {
  for (const { table, key, value, line, raw } of tomlLines(text)) {
    if (table === 'source' && key === 'url') {
      if (!/pypi\.(org|python\.org)/.test(value)) out.privateIndex = true;
      continue;
    }
    if ((table === 'packages' || table === 'dev-packages') && key && !nonRegistryTable(value)) {
      out.declarations.push({
        ecosystem: 'pypi',
        name: key,
        line,
        text: raw.trim(),
        section: table,
      });
    }
  }
}

function readSetupCfg(text: string, out: ManifestRead): void {
  let section = '';
  let inList = false;
  lines(text).forEach((raw, i) => {
    const trimmed = raw.trim();
    const header = /^\[([^\]]+)\]$/.exec(trimmed);
    if (header) {
      section = header[1]!;
      inList = false;
      return;
    }
    const isOptions = section === 'options' || section === 'options.extras_require';
    const kv = /^([A-Za-z_][\w.-]*)\s*=\s*(.*)$/.exec(raw);
    if (kv && !/^\s/.test(raw)) {
      inList =
        isOptions &&
        (section !== 'options' || kv[1] === 'install_requires' || kv[1] === 'tests_require');
      if (inList && kv[2]!.trim()) addCfg(kv[2]!, i, raw);
      return;
    }
    if (inList && /^\s+\S/.test(raw) && !trimmed.startsWith('#')) addCfg(trimmed, i, raw);
  });
  function addCfg(spec: string, i: number, raw: string): void {
    const name = requirementName(spec.replace(/\s*;.*$/, ''));
    if (name)
      out.declarations.push({
        ecosystem: 'pypi',
        name,
        line: i + 1,
        text: raw.trim(),
        section: `setup.cfg ${section}`,
      });
  }
}

// ---- Go ---------------------------------------------------------------------

function readGoMod(text: string, out: ManifestRead): void {
  const all = lines(text);
  const replacedLocally = new Set<string>();
  let inReplace = false;
  for (const raw of all) {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (/^replace\s*\($/.test(line)) {
      inReplace = true;
      continue;
    }
    if (inReplace && line === ')') {
      inReplace = false;
      continue;
    }
    const m = inReplace
      ? /^(\S+)(?:\s+v\S+)?\s*=>\s*(\S+)/.exec(line)
      : /^replace\s+(\S+)(?:\s+v\S+)?\s*=>\s*(\S+)/.exec(line);
    if (m && /^(\.|\/)/.test(m[2]!)) replacedLocally.add(m[1]!);
  }
  let inRequire = false;
  all.forEach((raw, i) => {
    const line = raw.replace(/\/\/.*$/, '').trim();
    if (/^require\s*\($/.test(line)) {
      inRequire = true;
      return;
    }
    if (inRequire && line === ')') {
      inRequire = false;
      return;
    }
    const m = inRequire ? /^(\S+)\s+v\S+/.exec(line) : /^require\s+(\S+)\s+v\S+/.exec(line);
    if (!m) return;
    const name = m[1]!.replace(/^"|"$/g, '');
    // A path with no dot in its first element is not fetchable from a proxy.
    if (!name.split('/')[0]!.includes('.') || replacedLocally.has(name)) return;
    out.declarations.push({
      ecosystem: 'go',
      name,
      line: i + 1,
      text: raw.trim(),
      section: 'require',
    });
  });
}

// ---- crates.io --------------------------------------------------------------

function readCargo(text: string, out: ManifestRead): void {
  const subTables = new Map<
    string,
    { line: number; raw: string; skip: boolean; rename: string | null }
  >();
  const all = lines(text);
  let current: string | null = null;
  all.forEach((raw, i) => {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    const header = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (header) {
      const h = header[1]!.replace(/"/g, '');
      const sub = /(?:^|\.)(?:dependencies|dev-dependencies|build-dependencies)\.([^.]+)$/.exec(h);
      current = sub ? `${h}` : null;
      if (sub) subTables.set(h, { line: i + 1, raw: raw.trim(), skip: false, rename: null });
      return;
    }
    if (current !== null) {
      const entry = subTables.get(current)!;
      if (/^(path|git|registry)\s*=/.test(line) || /^workspace\s*=\s*true/.test(line))
        entry.skip = true;
      const rename = /^package\s*=\s*"([^"]+)"/.exec(line);
      if (rename) entry.rename = rename[1]!;
    }
  });
  for (const [header, entry] of subTables) {
    if (entry.skip) continue;
    const name = entry.rename ?? header.split('.').pop()!;
    out.declarations.push({
      ecosystem: 'cargo',
      name,
      line: entry.line,
      text: entry.raw,
      section: header,
    });
  }
  for (const { table, key, value, line, raw } of tomlLines(text)) {
    if (!/(?:^|\.)(dependencies|dev-dependencies|build-dependencies)$/.test(table) || !key)
      continue;
    if (/\b(path|git|registry)\s*=/.test(value) || /\bworkspace\s*=\s*true/.test(value)) continue;
    const rename = /\bpackage\s*=\s*"([^"]+)"/.exec(value);
    out.declarations.push({
      ecosystem: 'cargo',
      name: rename ? rename[1]! : key,
      line,
      text: raw.trim(),
      section: table,
    });
  }
}

// ---- RubyGems ---------------------------------------------------------------

function readGemfile(text: string, out: ManifestRead): void {
  // A `source "https://private" do ... end` block scopes its gems to that index.
  let privateDepth = 0;
  let depth = 0;
  lines(text).forEach((raw, i) => {
    const line = raw.replace(/#.*$/, '').trim();
    const source = /^source\s+['"]([^'"]+)['"]\s*(do)?/.exec(line);
    if (source) {
      const isPublic = /rubygems\.org/.test(source[1]!);
      if (source[2]) {
        depth += 1;
        if (!isPublic) privateDepth = depth;
      } else if (!isPublic) {
        out.privateIndex = true;
      }
      return;
    }
    if (/\bdo\s*(\|[^|]*\|)?\s*$/.test(line)) depth += 1;
    if (line === 'end') {
      if (privateDepth === depth) privateDepth = 0;
      depth = Math.max(0, depth - 1);
      return;
    }
    const gem = /^gem\s+['"]([^'"]+)['"](.*)$/.exec(line);
    if (!gem) return;
    if (
      privateDepth > 0 ||
      /\b(path|git|github|gitlab|bitbucket|source)\s*:/.test(gem[2]!) ||
      /:(path|git|github)\s*=>/.test(gem[2]!)
    )
      return;
    out.declarations.push({
      ecosystem: 'rubygems',
      name: gem[1]!,
      line: i + 1,
      text: raw.trim(),
      section: 'gem',
    });
  });
}

// ---- Maven ------------------------------------------------------------------

function readPom(text: string, out: ManifestRead): void {
  const all = lines(text);
  // Positions of each <dependency> block, by character offset -> line.
  const lineAt = (offset: number): number => text.slice(0, offset).split('\n').length;
  const stripped = text.replace(/<!--[\s\S]*?-->/g, (c) => c.replace(/[^\n]/g, ' '));
  for (const m of stripped.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const body = m[1]!;
    const group = /<groupId>\s*([^<\s]+)\s*<\/groupId>/.exec(body)?.[1];
    const artifact = /<artifactId>\s*([^<\s]+)\s*<\/artifactId>/.exec(body);
    if (!group || !artifact || group.includes('${') || artifact[1]!.includes('${')) continue;
    if (/<scope>\s*(system|import)\s*<\/scope>/.test(body)) continue;
    const line = lineAt(m.index! + '<dependency>'.length + artifact.index);
    out.declarations.push({
      ecosystem: 'maven',
      name: `${group}:${artifact[1]!}`,
      line,
      text: (all[line - 1] ?? '').trim(),
      section: 'dependency',
    });
  }
}

function readGradle(text: string, out: ManifestRead): void {
  lines(text).forEach((raw, i) => {
    const line = raw.replace(/\/\/.*$/, '');
    const m =
      /\b(?:implementation|api|compileOnly|runtimeOnly|testImplementation|testRuntimeOnly|kapt|ksp|annotationProcessor|classpath|compile|testCompile)\s*\(?\s*['"]([\w.-]+):([\w.-]+)(?::[^'"]*)?['"]/.exec(
        line,
      );
    if (m)
      out.declarations.push({
        ecosystem: 'maven',
        name: `${m[1]}:${m[2]}`,
        line: i + 1,
        text: raw.trim(),
        section: 'gradle',
      });
  });
}

// ---- lockfiles: what resolved -------------------------------------------------

/** Names a lockfile records as resolved from a registry, by ecosystem. */
export function readResolved(
  lockfile: string,
  text: string,
): { ecosystem: SlopEcosystem; names: Set<string> } | null {
  const base = path.basename(lockfile);
  const names = new Set<string>();
  const all = lines(text);
  if (base === 'package-lock.json' || base === 'npm-shrinkwrap.json') {
    try {
      const doc = JSON.parse(text) as {
        packages?: Record<string, { resolved?: string; link?: boolean; name?: string }>;
        dependencies?: Record<string, unknown>;
      };
      for (const [key, entry] of Object.entries(doc.packages ?? {})) {
        if (!key.includes('node_modules/') || entry.link) continue;
        const name =
          entry.name ?? key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
        if (!entry.resolved || /^https?:\/\//.test(entry.resolved)) names.add(name);
      }
      for (const key of Object.keys(doc.dependencies ?? {})) names.add(key);
    } catch {
      return null;
    }
    return { ecosystem: 'npm', names };
  }
  if (base === 'yarn.lock') {
    for (const raw of all) {
      if (/^\s/.test(raw) || !raw.trim().endsWith(':')) continue;
      for (const part of raw.replace(/:$/, '').split(',')) {
        const m = /^"?((?:@[^/@"]+\/)?[^@"]+)@/.exec(part.trim());
        if (m && !/@(file|link|workspace|portal|patch):/.test(part)) names.add(m[1]!);
      }
    }
    return { ecosystem: 'npm', names };
  }
  if (base === 'pnpm-lock.yaml') {
    for (const raw of all) {
      const m = /^\s{2}'?\/?((?:@[^/@]+\/)?[^@/'\s]+)@[^:]+'?:\s*$/.exec(raw);
      if (m) names.add(m[1]!);
    }
    return { ecosystem: 'npm', names };
  }
  if (base === 'poetry.lock' || base === 'uv.lock' || base === 'pdm.lock') {
    let inPackage = false;
    for (const raw of all) {
      if (/^\[\[package\]\]/.test(raw)) inPackage = true;
      else if (/^\[/.test(raw)) inPackage = false;
      const m = inPackage ? /^name\s*=\s*"([^"]+)"/.exec(raw) : null;
      if (m) names.add(m[1]!);
    }
    return { ecosystem: 'pypi', names };
  }
  if (base === 'Pipfile.lock') {
    try {
      const doc = JSON.parse(text) as {
        default?: Record<string, unknown>;
        develop?: Record<string, unknown>;
      };
      for (const key of [...Object.keys(doc.default ?? {}), ...Object.keys(doc.develop ?? {})])
        names.add(key);
    } catch {
      return null;
    }
    return { ecosystem: 'pypi', names };
  }
  if (base === 'go.sum') {
    for (const raw of all) {
      const m = /^(\S+)\s+v\S+\s+h1:/.exec(raw);
      if (m) names.add(m[1]!);
    }
    return { ecosystem: 'go', names };
  }
  if (base === 'Cargo.lock') {
    let name: string | null = null;
    for (const raw of all) {
      if (/^\[\[package\]\]/.test(raw)) name = null;
      const n = /^name\s*=\s*"([^"]+)"/.exec(raw);
      if (n) name = n[1]!;
      if (name && /^source\s*=\s*"registry\+/.test(raw)) names.add(name);
    }
    return { ecosystem: 'cargo', names };
  }
  if (base === 'Gemfile.lock' || base === 'gems.locked') {
    let inGem = false;
    for (const raw of all) {
      if (/^\S/.test(raw)) inGem = raw.trim() === 'GEM';
      const m = inGem ? /^ {4}([^\s(]+) \(/.exec(raw) : null;
      if (m) names.add(m[1]!);
    }
    return { ecosystem: 'rubygems', names };
  }
  return null;
}
