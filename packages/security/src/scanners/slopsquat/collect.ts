import { readFileSync } from 'node:fs';
import path from 'node:path';
import { walkSnapshot } from '../../validation/walk.js';
import {
  DECLARING_MANIFEST,
  readDeclarations,
  readResolved,
  RESOLVING_LOCKFILE,
  type ManifestRead,
} from './manifests.js';
import { normalizePackageName, type SlopEcosystem } from './names.js';

// Everything the detector needs from one source tree (W21-05): declarations
// with lines, lockfile evidence per directory, the repository's own npm
// package names, and the npm scopes an .npmrc sends elsewhere. One walk, the
// same skips as the V1 lockfile walk (node_modules, vendor, …), so the two
// never disagree about which directories are this repository's.

export interface CollectedTree {
  reads: ManifestRead[];
  resolved: Map<string, Map<SlopEcosystem, Set<string>>>;
  ownNames: Set<string>;
  privateScopes: Set<string>;
  /** Manifests that could not be read, stated rather than dropped. */
  unreadable: string[];
}

/**
 * Test-fixture trees: manifests nobody installs, written to exercise a parser
 * (this repository's own fixtures declare hallucinated packages on purpose).
 */
export const FIXTURE_SEGMENT = /(^|\/)(fixtures|__fixtures__|testdata|test-fixtures)\//;

const WANTED = new RegExp(`${DECLARING_MANIFEST.source}|${RESOLVING_LOCKFILE.source}|^\\.npmrc$`);

/** `@scope:registry=` lines that point somewhere other than the public registry. */
export function privateScopesOf(npmrc: string): string[] {
  const out: string[] = [];
  for (const raw of npmrc.split(/\r?\n/)) {
    const m = /^\s*(@[^:\s]+):registry\s*=\s*(\S+)/.exec(raw);
    if (m && !/registry\.npmjs\.org/.test(m[2]!)) out.push(m[1]!);
  }
  return out;
}

export function collectTree(files: readonly { path: string; text: string }[]): CollectedTree {
  const out: CollectedTree = {
    reads: [],
    resolved: new Map(),
    ownNames: new Set(),
    privateScopes: new Set(),
    unreadable: [],
  };
  for (const file of files) {
    const base = path.basename(file.path);
    if (base === '.npmrc') {
      for (const scope of privateScopesOf(file.text)) out.privateScopes.add(scope);
      continue;
    }
    if (RESOLVING_LOCKFILE.test(base)) {
      const lock = readResolved(file.path, file.text);
      if (!lock) {
        out.unreadable.push(file.path);
        continue;
      }
      const unit = path.dirname(file.path);
      const byEco = out.resolved.get(unit) ?? new Map<SlopEcosystem, Set<string>>();
      const set = byEco.get(lock.ecosystem) ?? new Set<string>();
      for (const name of lock.names) set.add(normalizePackageName(lock.ecosystem, name));
      byEco.set(lock.ecosystem, set);
      out.resolved.set(unit, byEco);
      continue;
    }
    const read = readDeclarations(file.path, file.text);
    if (!read) continue;
    if (read.ownName) out.ownNames.add(normalizePackageName('npm', read.ownName));
    out.reads.push(read);
  }
  return out;
}

/** The same, read from a snapshot directory. */
export function collectSnapshot(snapshotDir: string): CollectedTree {
  const files: { path: string; text: string }[] = [];
  const unreadable: string[] = [];
  for (const f of walkSnapshot(snapshotDir, WANTED)) {
    if (FIXTURE_SEGMENT.test(f.relativePath.split(path.sep).join('/'))) continue;
    try {
      files.push({
        path: f.relativePath.split(path.sep).join('/'),
        text: readFileSync(f.absolutePath, 'utf8'),
      });
    } catch {
      unreadable.push(f.relativePath);
    }
  }
  const tree = collectTree(files);
  tree.unreadable.push(...unreadable);
  return tree;
}
