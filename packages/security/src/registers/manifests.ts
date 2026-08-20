import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { dockerfileRuntimes, manifestRuntimes, type DeclaredRuntime } from './eol.js';

// Finding the runtime declarations in a snapshot (W10-02, FR-REG-3).
//
// A separate walk from readSnapshotSources because that one reads SOURCE
// files by extension, and every file this register cares about — Dockerfile,
// .nvmrc, package.json, pyproject.toml — is either extensionless or excluded
// there. Widening the source reader would have made every scanner read
// manifests it has no use for.

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'coverage',
  'vendor',
  '.next',
  '.venv',
  '__pycache__',
]);

const MANIFESTS = new Set(['package.json', '.nvmrc', 'pyproject.toml']);
const MAX_DEPTH = 6;
const MAX_BYTES = 512 * 1024;

const isDockerfile = (name: string): boolean => /^Dockerfile(\..+)?$|^Containerfile/.test(name);

export interface RuntimeScanResult {
  declared: DeclaredRuntime[];
  /** Files that matched but could not be read — reported, not swallowed. */
  unreadable: string[];
}

export function readDeclaredRuntimes(root: string): RuntimeScanResult {
  const declared: DeclaredRuntime[] = [];
  const unreadable: string[] = [];

  const walk = (dir: string, depth: number): void => {
    if (depth > MAX_DEPTH) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      // The snapshot is ephemeral and the sweeper may take it mid-walk.
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
      if (!MANIFESTS.has(entry) && !isDockerfile(entry)) continue;
      if (stats.size > MAX_BYTES) continue;

      const relative = path.relative(root, full);
      let contents: string;
      try {
        contents = readFileSync(full, 'utf8');
      } catch {
        unreadable.push(relative);
        continue;
      }

      declared.push(
        ...(isDockerfile(entry)
          ? dockerfileRuntimes(relative, contents)
          : manifestRuntimes(relative, contents)),
      );
    }
  };

  walk(root, 0);
  return { declared, unreadable };
}
