import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

// Finding the LOCKFILES in a snapshot (W8-13 V1).
//
// A third walk, and for the same reason registers/manifests.ts is the second
// one: readSnapshotSources reads SOURCE files by extension and manifests.ts
// looks for runtime declarations (Dockerfile, .nvmrc, package.json), and the
// files this tier needs — package-lock.json, requirements*.txt, go.mod — are
// in neither set. Widening either would make every other scanner walk files it
// has no use for; V2's import scan does reuse readSnapshotSources, because
// source files are exactly what it wants.

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  // A vendor tree is somebody else's dependencies, and its manifests describe
  // THEIR resolved sets, not this repository's.
  'vendor',
  '.next',
  '.venv',
  '__pycache__',
]);

const MAX_DEPTH = 6;
/** A lockfile larger than this is a monorepo's, and parsing it is not free. */
const MAX_BYTES = 8 * 1024 * 1024;

const LOCKFILES = /^(package-lock\.json|go\.mod|requirements[\w.-]*\.txt)$/i;

export interface SnapshotFile {
  relativePath: string;
  absolutePath: string;
}

/** Every lockfile/manifest V1 can read, snapshot-relative, sorted. */
export function walkSnapshot(root: string): SnapshotFile[] {
  const found: SnapshotFile[] = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      // The snapshot is ephemeral by design and the sweeper may take it
      // mid-walk; that is not a reason to fail a scan.
      return;
    }

    for (const entry of entries) {
      if (SKIP_DIRS.has(entry)) continue;
      const full = path.join(dir, entry);
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        walk(full, depth + 1);
        continue;
      }
      if (!LOCKFILES.test(entry) || stats.size > MAX_BYTES) continue;
      found.push({ relativePath: path.relative(root, full), absolutePath: full });
    }
  };

  walk(root, 0);
  return found.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
}
