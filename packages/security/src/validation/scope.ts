import { readFileSync } from 'node:fs';
import path from 'node:path';
import { walkSnapshot } from './walk.js';
import type { DepScope, ScopeVerdict } from './types.js';

// V1 — dependency scoping against the manifest's own resolved set (W8-13,
// SECURITY_SUITE.md §3.6, FR-SEC-13).
//
// grype matched against the SBOM. This tier asks the manifest the SECOND
// question the SBOM cannot answer on its own: is this package actually in the
// resolved dependency set, at this version, and is it shipped or is it
// build-time? The lockfile is the authority on all three — it is the file the
// installer obeys.
//
// WHY NOT resolveScopes (registers/sbom.ts). Because it cannot answer it today
// and this tier must. syft's CycloneDX root component is the SCANNED DIRECTORY
// and its bom-ref never appears in `dependencies[]`, so that walk starts from a
// node with no edges and every component falls through to prod-direct depth 1
// (W8-06 pinned this as a limitation). The graph is genuinely there — it is
// just rooted at the project component instead. Rather than reach into another
// ticket's reader, this one goes to the lockfile, which is what §3.6 specifies
// as V1's mechanism anyway ("lockfile graph") and is a source the SBOM is
// derived FROM rather than a second opinion about it.
//
// DEV NEVER MEANS DISMISSED. A dev-only CVE is priced lower (the D12 exposure
// factor) and stays on the list: build-time supply chain is how a package
// steals a publish token, and a funnel that hid dev findings would hide exactly
// the class of attack that has been happening.

export type ScopeEcosystem = 'npm' | 'pypi' | 'go';

interface ResolvedEntry {
  scope: DepScope;
  versions: Set<string>;
  manifest: string;
}

export interface ResolvedSet {
  /** `ecosystem\0lowercased-name` -> what the manifests say about it. */
  entries: Map<string, ResolvedEntry>;
  /** Manifest files actually read, snapshot-relative. */
  manifests: string[];
  /** Ecosystems we found no readable manifest for, with the reason. */
  unreadable: Map<ScopeEcosystem, string>;
}

/** grype's artifact type -> the ecosystem this tier speaks. */
export function scopeEcosystemOf(packageType: string): ScopeEcosystem | null {
  if (packageType === 'npm') return 'npm';
  if (packageType === 'python') return 'pypi';
  if (packageType === 'go-module') return 'go';
  return null;
}

/**
 * Package names compared case- and separator-insensitively.
 *
 * PEP 503 says pypi names are compared with runs of `-`, `_` and `.` collapsed
 * to a single `-`, so `PyYAML`, `pyyaml` and `py-yaml` are one project. npm
 * names are already lowercase. Comparing raw strings would report a package
 * present in the lockfile as absent, which is the direction that proposes
 * `not_affected` on something real.
 */
function normalizeName(ecosystem: ScopeEcosystem, name: string): string {
  const lower = name.toLowerCase();
  return ecosystem === 'pypi' ? lower.replace(/[-_.]+/g, '-') : lower;
}

const key = (ecosystem: ScopeEcosystem, name: string): string =>
  `${ecosystem}\0${normalizeName(ecosystem, name)}`;

/** `v1.2.3`, `=1.2.3` and `1.2.3` are one version. */
function normalizeVersion(version: string): string {
  return version.trim().replace(/^[=vV]+/, '');
}

const asRecord = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};

/**
 * Reads every manifest in the snapshot into one resolved set.
 *
 * Manifests are read from the SNAPSHOT, never fetched: C1 says all repository
 * content arrives through the tarball, and this is source we already have on
 * disk for the SHA the SBOM was built from — so V1's answer is about the same
 * tree grype matched, which is the only way the two can be compared at all.
 */
export function readResolvedSet(snapshotDir: string): ResolvedSet {
  const entries = new Map<string, ResolvedEntry>();
  const manifests: string[] = [];
  const unreadable = new Map<ScopeEcosystem, string>();
  const seenEcosystems = new Set<ScopeEcosystem>();

  const add = (
    ecosystem: ScopeEcosystem,
    name: string,
    version: string | null,
    scope: DepScope,
    manifest: string,
  ): void => {
    const id = key(ecosystem, name);
    const prior = entries.get(id);
    if (!prior) {
      entries.set(id, {
        scope,
        versions: new Set(version ? [normalizeVersion(version)] : []),
        manifest,
      });
      return;
    }
    if (version) prior.versions.add(normalizeVersion(version));
    // A package reachable both as a dev dependency and as a shipped one IS
    // shipped, and the shallower path is the one that describes its exposure.
    // Taking the last-read answer would make the result depend on directory
    // order, which is not a property anyone should be able to change by
    // renaming a folder.
    if (rank(scope) < rank(prior.scope)) prior.scope = scope;
  };

  for (const file of walkSnapshot(snapshotDir)) {
    const base = path.basename(file.relativePath);
    try {
      if (base === 'package-lock.json') {
        seenEcosystems.add('npm');
        if (readNpmLock(readFileSync(file.absolutePath, 'utf8'), file.relativePath, add)) {
          manifests.push(file.relativePath);
        } else {
          unreadable.set(
            'npm',
            `${file.relativePath} is a lockfileVersion this reader does not parse ` +
              `(v2/v3 'packages' only)`,
          );
        }
      } else if (/^requirements[\w.-]*\.txt$/i.test(base)) {
        seenEcosystems.add('pypi');
        readRequirements(readFileSync(file.absolutePath, 'utf8'), file.relativePath, add);
        manifests.push(file.relativePath);
      } else if (base === 'go.mod') {
        seenEcosystems.add('go');
        readGoMod(readFileSync(file.absolutePath, 'utf8'), file.relativePath, add);
        manifests.push(file.relativePath);
      }
    } catch (error) {
      // A manifest we could not read is UNREADABLE, never empty: treating a
      // parse error as "no dependencies" would report every CVE in the tree as
      // component_not_present — a broken parser silently clearing the board.
      unreadable.set(
        base === 'go.mod' ? 'go' : base === 'package-lock.json' ? 'npm' : 'pypi',
        `${file.relativePath}: ${(error as Error).message.slice(0, 200)}`,
      );
    }
  }

  return { entries, manifests: manifests.sort(), unreadable };
}

function rank(scope: DepScope): number {
  if (scope.kind === 'prod-direct') return 0;
  if (scope.kind === 'prod-transitive') return 1;
  return 2;
}

type AddFn = (
  ecosystem: ScopeEcosystem,
  name: string,
  version: string | null,
  scope: DepScope,
  manifest: string,
) => void;

/**
 * npm lockfile v2/v3 — the `packages` map, which is the installed TREE.
 *
 * Depth comes from walking that tree rather than from counting path segments:
 * npm hoists, so `node_modules/ms` is a top-level PATH for a package that is
 * only ever reached through `debug`, and depth-by-path would call it direct.
 * The fixture is exactly that shape.
 */
function readNpmLock(text: string, manifest: string, add: AddFn): boolean {
  const document = asRecord(JSON.parse(text));
  const packages = asRecord(document['packages']);
  if (Object.keys(packages).length === 0) return false;

  const root = asRecord(packages['']);
  const directProd = Object.keys(asRecord(root['dependencies']));
  const directDev = Object.keys(asRecord(root['devDependencies'])).concat(
    Object.keys(asRecord(root['optionalDependencies'])),
  );

  /** `node_modules/a/node_modules/b` -> `b`. */
  const nameOf = (entryPath: string): string =>
    entryPath.slice(entryPath.lastIndexOf('node_modules/') + 'node_modules/'.length);

  /** npm resolution: nearest node_modules first, then up towards the root. */
  const resolve = (fromPath: string, name: string): string | null => {
    let base = fromPath;
    for (;;) {
      const candidate = base === '' ? `node_modules/${name}` : `${base}/node_modules/${name}`;
      if (candidate in packages) return candidate;
      if (base === '') return null;
      const at = base.lastIndexOf('/node_modules/');
      base = at === -1 ? '' : base.slice(0, at);
    }
  };

  const depthByPath = new Map<string, number>();
  const queue: { entryPath: string; depth: number }[] = [];
  for (const name of [...directProd, ...directDev]) {
    const resolved = resolve('', name);
    if (resolved) queue.push({ entryPath: resolved, depth: 1 });
  }
  while (queue.length > 0) {
    const { entryPath, depth } = queue.shift()!;
    const known = depthByPath.get(entryPath);
    if (known !== undefined && known <= depth) continue;
    depthByPath.set(entryPath, depth);
    const entry = asRecord(packages[entryPath]);
    for (const child of Object.keys(asRecord(entry['dependencies']))) {
      const resolved = resolve(entryPath, child);
      if (resolved) queue.push({ entryPath: resolved, depth: depth + 1 });
    }
  }

  const directNames = new Set(directProd);
  for (const [entryPath, value] of Object.entries(packages)) {
    if (entryPath === '' || !entryPath.includes('node_modules/')) continue;
    const entry = asRecord(value);
    const name = nameOf(entryPath);
    const depth = depthByPath.get(entryPath) ?? 1;
    // `dev: true` is npm's own answer and beats anything we could infer: it
    // means the installer omits this package under --omit=dev, which is the
    // definition of build-time-only.
    const dev = entry['dev'] === true || entry['devOptional'] === true;
    const kind: DepScope['kind'] = dev
      ? 'dev'
      : depth <= 1 && directNames.has(name)
        ? 'prod-direct'
        : 'prod-transitive';
    add(
      'npm',
      name,
      typeof entry['version'] === 'string' ? entry['version'] : null,
      { kind, depth },
      manifest,
    );
  }
  return true;
}

/**
 * requirements.txt — pins only.
 *
 * A requirements file is a FLAT list with no graph in it, so every entry is
 * recorded at depth 1 and nothing is reported as transitive. That is a real
 * limitation and it is stated rather than papered over: pip's resolution tree
 * is not in the repository, and inventing a depth would put a number in
 * riskFactors that nothing in the snapshot supports.
 *
 * A `requirements-dev.txt` (or -test) is read as dev because that convention is
 * near-universal, and being wrong about it in this direction only ever prices a
 * finding lower — which is why the finding stays on the list either way.
 */
function readRequirements(text: string, manifest: string, add: AddFn): void {
  const dev = /(^|[-_/])(dev|test|tests|ci)\b/i.test(path.basename(manifest, '.txt'));
  for (const rawLine of text.split('\n')) {
    const line = rawLine.split('#')[0]!.trim();
    if (line === '' || line.startsWith('-')) continue;
    const match = /^([A-Za-z0-9._-]+)\s*(?:\[[^\]]*\])?\s*(?:==\s*([^\s;]+))?/.exec(line);
    if (!match) continue;
    add(
      'pypi',
      match[1]!,
      match[2] ?? null,
      { kind: dev ? 'dev' : 'prod-direct', depth: 1 },
      manifest,
    );
  }
}

/**
 * go.mod — `require` lines, with `// indirect` as the transitive marker.
 *
 * go.mod carries no dev/prod distinction at all (Go has no dev dependency
 * concept), so nothing here is ever reported as dev. Saying so is better than
 * a heuristic that guessed from directory names.
 */
function readGoMod(text: string, manifest: string, add: AddFn): void {
  let inBlock = false;
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('require (')) {
      inBlock = true;
      continue;
    }
    if (inBlock && line === ')') {
      inBlock = false;
      continue;
    }
    const body = inBlock ? line : line.startsWith('require ') ? line.slice('require '.length) : '';
    if (body === '' || body.startsWith('//')) continue;
    const match = /^([^\s]+)\s+([^\s]+)/.exec(body);
    if (!match) continue;
    const indirect = /\/\/\s*indirect/.test(body);
    add(
      'go',
      match[1]!,
      match[2]!,
      { kind: indirect ? 'prod-transitive' : 'prod-direct', depth: indirect ? 2 : 1 },
      manifest,
    );
  }
}

/**
 * V1's verdict for one vulnerable component.
 *
 * NOT-IN-THE-RESOLVED-SET IS EVIDENCE, NOT A DISMISSAL. It becomes a PROPOSED
 * `component_not_present` for a human to accept in W8-14. It is also the
 * disagreement most worth surfacing: the SBOM says the package is there and
 * the lockfile does not, and one of the two is wrong about what ships.
 */
export function scopeFor(
  resolved: ResolvedSet,
  packageType: string,
  packageName: string,
  packageVersion: string,
): ScopeVerdict {
  const ecosystem = scopeEcosystemOf(packageType);
  if (!ecosystem) {
    return {
      inResolvedSet: false,
      versionMatches: false,
      scope: null,
      manifest: null,
      // A maven or an alpine finding is not absent from the tree — it is an
      // ecosystem this reader has no manifest parser for, and reporting the
      // two the same way would propose component_not_present on a real
      // dependency of a Java repository.
      unreadableReason: `no manifest reader for grype package type '${packageType}'`,
    };
  }

  const entry = resolved.entries.get(key(ecosystem, packageName));
  if (!entry) {
    const unreadable = resolved.unreadable.get(ecosystem);
    return {
      inResolvedSet: false,
      versionMatches: false,
      scope: null,
      manifest: null,
      unreadableReason: unreadable ?? null,
    };
  }

  return {
    inResolvedSet: true,
    // No version in the manifest (an unpinned requirements entry) is not a
    // MISMATCH — it is the manifest declining to say. Reporting it as a
    // mismatch would raise a disagreement between two sources where only one
    // of them spoke.
    versionMatches:
      entry.versions.size === 0 || entry.versions.has(normalizeVersion(packageVersion)),
    scope: entry.scope,
    manifest: entry.manifest,
    unreadableReason: null,
  };
}
