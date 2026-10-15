import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { readGoMod, readNpmLock, readRequirements, type AddFn } from './scope.js';
import { walkSnapshot } from './walk.js';

// What a repository DECLARES it depends on, per manifest (W18-06).
//
// The dependency-hygiene rules ask a narrower question than the CVE funnel:
// not "does this package ship" but "did somebody in THIS project choose it, for
// runtime". Only a direct, runtime declaration is a choice; a transitive
// package is somebody else's, and a dev-only one never reaches production.
//
// WHY NOT THE STORED SBOM (D8). syft's CycloneDX root is the scanned directory
// and its bom-ref never appears in `dependencies[]`, so resolveScopes reports
// every component as prod-direct (scope.ts says the same). A duplicate-purpose
// rule fed that list would flag a transitive `moment` next to a direct `dayjs`
// — the noise this rule exists to avoid. The SBOM is the right input for
// "what ships"; for "what was chosen" the manifests are the authority.
//
// WHY THROUGH V1's READERS (D10). package-lock.json, requirements*.txt and
// go.mod are already parsed by the V1 scoping tier; this reuses those parsers
// through their `add` callback rather than writing second ones that could
// drift. What V1 does not read — package.json without a lockfile (yarn, pnpm,
// workspace members), pyproject.toml, Cargo.toml and pom.xml — is read here,
// and only for the declared list: V1's resolved set and its CVE verdicts are
// unchanged by this file.
//
// NOT READ, stated rather than guessed at: Gradle build scripts (a program, not
// a manifest), Pipfile, setup.py (a program), yarn.lock / pnpm-lock.yaml (their
// package.json already says what was declared).

export type DeclaredEcosystem = 'npm' | 'pypi' | 'go' | 'maven' | 'cargo';

/**
 * `direct` — declared for runtime by this manifest. `transitive` — present
 * only because something else needs it. `dev` — test/build time only.
 * `unknown` — the file lists packages without saying which were chosen (a
 * `pip freeze` dump), so nothing in it can be called a choice.
 */
export type DeclaredScope = 'direct' | 'transitive' | 'dev' | 'unknown';

export interface DeclaredDependency {
  ecosystem: DeclaredEcosystem;
  /** As the manifest writes it; Maven as `groupId:artifactId`. */
  name: string;
  scope: DeclaredScope;
  /** Snapshot-relative manifest path. */
  manifest: string;
  /** The manifest's directory ('' for the root) — one project, one unit. */
  unit: string;
}

export interface DeclaredSet {
  dependencies: DeclaredDependency[];
  /** Manifests read, snapshot-relative, sorted. */
  manifests: string[];
  /** Manifests that could not be parsed — never read as "no dependencies". */
  unreadable: { manifest: string; reason: string }[];
}

const MANIFESTS =
  /^(package-lock\.json|package\.json|go\.mod|requirements[\w.-]*\.txt|pyproject\.toml|Cargo\.toml|pom\.xml)$/i;

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};

/** Reads every manifest in a snapshot into one declared list. */
export function readDeclaredDependencies(snapshotDir: string): DeclaredSet {
  const files = walkSnapshot(snapshotDir, MANIFESTS);
  const out: DeclaredSet = { dependencies: [], manifests: [], unreadable: [] };

  // Lockfiles first, so a package.json knows whether its lockfile answered.
  const ordered = [...files].sort(
    (a, b) =>
      Number(path.basename(b.relativePath) === 'package-lock.json') -
      Number(path.basename(a.relativePath) === 'package-lock.json'),
  );
  const lockedUnits = new Set<string>();
  for (const file of ordered) {
    const base = path.basename(file.relativePath);
    const unit = path.dirname(file.relativePath) === '.' ? '' : path.dirname(file.relativePath);
    // A package.json beside a READABLE lockfile is already answered by it,
    // and reading both would count the same choice twice. Beside a lockfile
    // V1 cannot parse (lockfileVersion 1), the package.json is the answer.
    if (base === 'package.json' && lockedUnits.has(unit)) continue;
    try {
      const text = readFileSync(file.absolutePath, 'utf8');
      const found = readManifest(base, text, file.relativePath);
      if (found === null) {
        out.unreadable.push({ manifest: file.relativePath, reason: 'unsupported manifest shape' });
        continue;
      }
      if (base === 'package-lock.json') lockedUnits.add(unit);
      for (const d of found) out.dependencies.push({ ...d, manifest: file.relativePath, unit });
      out.manifests.push(file.relativePath);
    } catch (error) {
      out.unreadable.push({
        manifest: file.relativePath,
        reason: (error as Error).message.slice(0, 200),
      });
    }
  }
  out.manifests.sort();
  return out;
}

type Found = Omit<DeclaredDependency, 'manifest' | 'unit'>;

/** One manifest's declarations, or null when its shape is not one we read. */
export function readManifest(base: string, text: string, manifest: string): Found[] | null {
  const found: Found[] = [];
  const collect =
    (map: (kind: 'prod-direct' | 'prod-transitive' | 'dev', name: string) => DeclaredScope) =>
    (...[ecosystem, name, , scope]: Parameters<AddFn>): void => {
      found.push({ ecosystem, name, scope: map(scope.kind, name) });
    };
  const v1Scope = (kind: 'prod-direct' | 'prod-transitive' | 'dev'): DeclaredScope =>
    kind === 'prod-direct' ? 'direct' : kind === 'prod-transitive' ? 'transitive' : 'dev';

  if (base === 'package-lock.json') {
    return readNpmLock(text, manifest, collect(v1Scope)) ? found : null;
  }
  if (base === 'go.mod') {
    readGoMod(text, manifest, collect(v1Scope));
    return found;
  }
  if (/^requirements[\w.-]*\.txt$/i.test(base)) {
    const shape = requirementsShape(text);
    readRequirements(
      text,
      manifest,
      collect((kind, name) => {
        if (kind === 'dev') return 'dev';
        if (shape.transitive.has(pep503(name))) return 'transitive';
        return shape.frozen ? 'unknown' : 'direct';
      }),
    );
    return found;
  }
  if (base === 'package.json') return readPackageJson(text);
  if (base === 'pyproject.toml') return readPyproject(text);
  if (base === 'Cargo.toml') return readCargoToml(text);
  if (base === 'pom.xml') return readPom(text);
  return null;
}

const pep503 = (name: string): string => name.toLowerCase().replace(/[-_.]+/g, '-');

/**
 * Packages that are almost never anybody's own choice — they arrive under
 * requests, httpx, jinja2 and friends. Two of them in a fully pinned file is
 * the signature of `pip freeze`, whose every line looks like a declaration
 * and most of which are not.
 */
const NEARLY_ALWAYS_TRANSITIVE = new Set([
  'certifi',
  'idna',
  'charset-normalizer',
  'chardet',
  'urllib3',
  'h11',
  'httpcore',
  'sniffio',
  'markupsafe',
  'typing-extensions',
  'six',
]);

/**
 * What a requirements file can tell us beyond its names.
 *
 * pip-compile writes `# via <package>` under each pin, which IS the dependency
 * graph: a pin reached only via other packages is transitive. A pin reached
 * via `-r requirements.in` was asked for. Without annotations, a fully pinned
 * file holding the usual transitive set is treated as a freeze dump.
 */
export function requirementsShape(text: string): { transitive: Set<string>; frozen: boolean } {
  const via = new Map<string, string[]>();
  let current: string | null = null;
  let inVia = false;
  let pinned = 0;
  let loose = 0;
  const names: string[] = [];

  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    const req = /^([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*(==|>=|<=|~=|!=|>|<)?/.exec(
      trimmed,
    );
    if (trimmed !== '' && !trimmed.startsWith('#') && !trimmed.startsWith('-') && req) {
      current = pep503(req[1]!);
      names.push(current);
      if (req[2] === '==') pinned += 1;
      else loose += 1;
      inVia = false;
      const inline = /#\s*via\s+(.+)$/.exec(trimmed);
      if (inline) via.set(current, [inline[1]!.trim()]);
      continue;
    }
    if (current === null) continue;
    const viaLine = /^#\s*via\b\s*(.*)$/.exec(trimmed);
    if (viaLine) {
      inVia = true;
      via.set(current, viaLine[1] ? [viaLine[1].trim()] : []);
      continue;
    }
    const continuation = /^#\s+(\S.*)$/.exec(trimmed);
    if (inVia && continuation) {
      via.get(current)?.push(continuation[1]!.trim());
      continue;
    }
    inVia = false;
  }

  const transitive = new Set<string>();
  for (const [name, sources] of via) {
    if (sources.length === 0) continue;
    // `-r requirements.in` or `(pyproject.toml)` is the user's own input: the
    // pin was asked for. `-c constraints.txt` is NOT — a constraints file only
    // pins versions of whatever else pulled the package in (found on the
    // held-out corpus: uv's compile output lists `-c` under every pin).
    const asked = sources.some(
      (s) => s.startsWith('-r') || /\.in\b|pyproject\.toml|setup\.(cfg|py)/.test(s),
    );
    if (!asked) transitive.add(name);
  }
  const frozen =
    via.size === 0 &&
    loose === 0 &&
    pinned > 0 &&
    names.filter((n) => NEARLY_ALWAYS_TRANSITIVE.has(n)).length >= 2;
  return { transitive, frozen };
}

function readPackageJson(text: string): Found[] | null {
  const document = asRecord(JSON.parse(text));
  const found: Found[] = [];
  for (const name of Object.keys(asRecord(document['dependencies']))) {
    found.push({ ecosystem: 'npm', name, scope: 'direct' });
  }
  for (const name of Object.keys(asRecord(document['devDependencies']))) {
    found.push({ ecosystem: 'npm', name, scope: 'dev' });
  }
  // peer and optional dependencies are not recorded: a peer is the HOST's
  // choice, and an optional one may never be installed.
  return found;
}

/** `[a.b."c.d"]` -> its header text, or null for a non-header line. */
function tomlHeader(line: string): string | null {
  const match = /^\[\[?\s*([^\]]+?)\s*\]\]?\s*(?:#.*)?$/.exec(line);
  return match ? match[1]!.replace(/\s*\.\s*/g, '.') : null;
}

/** A table's `key = value` lines, keyed by header. Arrays kept joined. */
function tomlTables(text: string): Map<string, string[]> {
  const tables = new Map<string, string[]>([['', []]]);
  let current = '';
  let pending: string | null = null;
  let depth = 0;
  for (const raw of text.split('\n')) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (pending !== null) {
      pending += ` ${line}`;
      depth += (line.match(/[[{]/g) ?? []).length - (line.match(/[\]}]/g) ?? []).length;
      if (depth <= 0) {
        tables.get(current)!.push(pending);
        pending = null;
      }
      continue;
    }
    if (line === '') continue;
    const header = tomlHeader(line);
    // A key never starts with `[`, so this is a header even when a quoted
    // `cfg(target_os = "linux")` inside it holds an `=`.
    if (header !== null && line.startsWith('[')) {
      current = header;
      if (!tables.has(current)) tables.set(current, []);
      continue;
    }
    depth = (line.match(/[[{]/g) ?? []).length - (line.match(/[\]}]/g) ?? []).length;
    if (depth > 0) pending = line;
    else tables.get(current)!.push(line);
  }
  return tables;
}

const tomlKey = (line: string): string | null => {
  const match = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_.-]+))\s*=/.exec(line);
  return match ? (match[1] ?? match[2] ?? match[3]!) : null;
};

const quoted = (text: string): string[] =>
  [...text.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2] ?? '');

const requirementName = (spec: string): string | null =>
  /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)/.exec(spec)?.[1] ?? null;

/**
 * pyproject.toml — PEP 621 `[project] dependencies` and Poetry's tables.
 *
 * Extras (`[project.optional-dependencies]`) are NOT recorded: an extra is a
 * runtime choice the installer may never make, and treating it as declared
 * would flag a library that offers `[httpx]` and `[requests]` backends as its
 * whole point.
 */
function readPyproject(text: string): Found[] {
  const tables = tomlTables(text);
  const found: Found[] = [];
  const add = (name: string | null, scope: DeclaredScope): void => {
    if (name && name.toLowerCase() !== 'python') found.push({ ecosystem: 'pypi', name, scope });
  };
  for (const line of tables.get('project') ?? []) {
    if (tomlKey(line) === 'dependencies') {
      for (const spec of quoted(line)) add(requirementName(spec), 'direct');
    }
  }
  for (const line of tables.get('dependency-groups') ?? []) {
    for (const spec of quoted(line.slice(line.indexOf('=') + 1))) {
      add(requirementName(spec), 'dev');
    }
  }
  for (const [header, lines] of tables) {
    const poetryProd = header === 'tool.poetry.dependencies';
    const poetryDev =
      header === 'tool.poetry.dev-dependencies' ||
      /^tool\.poetry\.group\.[^.]+\.dependencies$/.test(header);
    if (!poetryProd && !poetryDev) continue;
    for (const line of lines) add(tomlKey(line), poetryProd ? 'direct' : 'dev');
  }
  return found;
}

/**
 * Cargo.toml — `[dependencies]`, `[dev-dependencies]`, `[build-dependencies]`,
 * their `[target.<cfg>.…]` forms, and the `[dependencies.<name>]` sub-table.
 *
 * `[workspace.dependencies]` is NOT recorded: it is a version catalogue the
 * members opt into with `workspace = true`, and a member's own table is where
 * the choice shows up. A rename (`foo = { package = "bar" }`) records `bar`,
 * the crate actually compiled.
 */
function readCargoToml(text: string): Found[] {
  const found: Found[] = [];
  for (const [header, lines] of tomlTables(text)) {
    const kind = /(?:^|\.)(dependencies|dev-dependencies|build-dependencies)(?:\.([^.]+))?$/.exec(
      header,
    );
    if (!kind || header.startsWith('workspace.')) continue;
    const scope: DeclaredScope = kind[1] === 'dependencies' ? 'direct' : 'dev';
    if (kind[2]) {
      // `[dependencies.serde]` — the table IS one dependency.
      const renamed = lines.find((l) => tomlKey(l) === 'package');
      found.push({
        ecosystem: 'cargo',
        name: renamed ? (quoted(renamed)[0] ?? kind[2]) : kind[2].replace(/^"|"$/g, ''),
        scope,
      });
      continue;
    }
    for (const line of lines) {
      const key = tomlKey(line);
      if (!key) continue;
      const renamed = /\bpackage\s*=\s*"([^"]+)"/.exec(line);
      found.push({ ecosystem: 'cargo', name: renamed ? renamed[1]! : key, scope });
    }
  }
  return found;
}

/**
 * pom.xml — `<dependencies>` of the project itself.
 *
 * `<dependencyManagement>` only pins versions for whoever opts in, and
 * `<build>` holds plugin dependencies; both are removed before reading, as are
 * `<profiles>` (a dependency that exists only under a profile is a build-time
 * switch, not a declaration). `test` and `provided` scopes are not shipped in
 * the artifact and read as dev.
 */
function readPom(text: string): Found[] {
  const body = text
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, '')
    .replace(/<build>[\s\S]*?<\/build>/g, '')
    .replace(/<profiles>[\s\S]*?<\/profiles>/g, '');
  const found: Found[] = [];
  for (const m of body.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const tag = (name: string): string | null =>
      new RegExp(`<${name}>\\s*([^<]+?)\\s*</${name}>`).exec(m[1]!)?.[1] ?? null;
    const group = tag('groupId');
    const artifact = tag('artifactId');
    if (!group || !artifact) continue;
    const scope = (tag('scope') ?? 'compile').toLowerCase();
    found.push({
      ecosystem: 'maven',
      name: `${group}:${artifact}`,
      scope: scope === 'test' || scope === 'provided' || scope === 'system' ? 'dev' : 'direct',
    });
  }
  return found;
}

/** The manifest a person edits for a unit: package.json over its lockfile. */
export function editableManifest(snapshotDir: string, manifest: string): string {
  if (path.basename(manifest) !== 'package-lock.json') return manifest;
  const sibling = path.join(path.dirname(manifest), 'package.json');
  return existsSync(path.join(snapshotDir, sibling)) ? sibling : manifest;
}
