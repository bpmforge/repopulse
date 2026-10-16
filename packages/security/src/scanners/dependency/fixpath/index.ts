import { readFileSync } from 'node:fs';
import path from 'node:path';
import { walkSnapshot } from '../../../validation/walk.js';
import type { DepGraph } from './graph.js';
import {
  readCargoGraph,
  readGoModGraph,
  readNpmGraph,
  readPnpmGraph,
  readPoetryGraph,
  readUvGraph,
  readYarnGraph,
} from './readers.js';

export * from './graph.js';
export * from './advise.js';
export * from './readers.js';

const FIX_LOCKFILES =
  /^(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|uv\.lock|Cargo\.lock|go\.mod)$/;

export interface FixGraphs {
  graphs: DepGraph[];
  /** Lockfiles found that a reader could not make sense of. */
  unreadable: string[];
}

/** Every dependency graph the snapshot's lockfiles support. */
export function readFixGraphs(snapshotDir: string): FixGraphs {
  const graphs: DepGraph[] = [];
  const unreadable: string[] = [];
  const sibling = (rel: string, name: string): string | null => {
    try {
      return readFileSync(path.join(snapshotDir, path.dirname(rel), name), 'utf8');
    } catch {
      return null;
    }
  };
  for (const file of walkSnapshot(snapshotDir, FIX_LOCKFILES)) {
    const base = path.basename(file.relativePath);
    let graph: DepGraph | null = null;
    try {
      const text = readFileSync(file.absolutePath, 'utf8');
      if (base === 'package-lock.json') graph = readNpmGraph(text, file.relativePath);
      else if (base === 'pnpm-lock.yaml') graph = readPnpmGraph(text, file.relativePath);
      else if (base === 'yarn.lock') graph = readYarnGraph(text, file.relativePath, sibling(file.relativePath, 'package.json'));
      else if (base === 'poetry.lock') graph = readPoetryGraph(text, file.relativePath, sibling(file.relativePath, 'pyproject.toml'));
      else if (base === 'uv.lock') graph = readUvGraph(text, file.relativePath);
      else if (base === 'Cargo.lock') graph = readCargoGraph(text, file.relativePath);
      else if (base === 'go.mod') graph = readGoModGraph(text, file.relativePath);
    } catch {
      graph = null;
    }
    if (graph) graphs.push(graph);
    else unreadable.push(file.relativePath);
  }
  return { graphs, unreadable };
}
