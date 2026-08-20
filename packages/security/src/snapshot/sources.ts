import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// Reading a snapshot's sources (W9-06).
//
// The deterministic half of anti_slop and the judgement half of both W9-03 and
// W9-04 need FILE CONTENTS rather than a diff — LDR is a property of a whole
// file, and a checklist run over a snapshot has no patch to read. This is the
// one place that walks a snapshot tree, so the caps live here instead of in
// each scanner: a scanner that reads its own files is a scanner that can
// forget a limit.

/** Extensions the W9 scanners can say anything about. */
const READABLE = /\.(js|jsx|ts|tsx|mjs|cjs|py|go|rb|java|kt|cs|php|rs)$/;

/** Directories nothing useful comes out of, skipped before they are read. */
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

export interface SourceFile {
  path: string;
  source: string;
}

export interface ReadSourcesOptions {
  /** Files to read at most. A monorepo snapshot is tens of thousands. */
  maxFiles?: number;
  /** Skip a file larger than this — a 4MB generated bundle says nothing. */
  maxFileBytes?: number;
  /** Total bytes read, the guard that actually bounds memory. */
  maxTotalBytes?: number;
}

export interface ReadSourcesResult {
  files: SourceFile[];
  /** Files skipped for size or count — reported, never silent. */
  skipped: number;
  truncated: boolean;
}

/**
 * Reads a snapshot tree's source files, relative-pathed and capped.
 *
 * `truncated` is returned rather than logged, because a caller that scanned
 * 500 of 5,000 files must be able to say so: a slop density computed over an
 * unstated fraction of a repository is a number with no denominator.
 */
export function readSnapshotSources(
  root: string,
  opts: ReadSourcesOptions = {},
): ReadSourcesResult {
  const maxFiles = opts.maxFiles ?? 2000;
  const maxFileBytes = opts.maxFileBytes ?? 512 * 1024;
  const maxTotalBytes = opts.maxTotalBytes ?? 64 * 1024 * 1024;

  const files: SourceFile[] = [];
  let skipped = 0;
  let totalBytes = 0;
  let truncated = false;

  const walk = (dir: string): void => {
    if (truncated) return;
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      // A directory that vanished between the extraction and the read is not
      // an error worth failing a scan over — the snapshot is ephemeral by
      // design and the sweeper may have taken it.
      return;
    }

    for (const entry of entries) {
      if (truncated) return;
      if (SKIP_DIRS.has(entry)) continue;
      const full = path.join(dir, entry);

      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }

      if (stats.isDirectory()) {
        walk(full);
        continue;
      }
      if (!READABLE.test(entry)) continue;
      if (stats.size > maxFileBytes) {
        skipped += 1;
        continue;
      }
      if (files.length >= maxFiles || totalBytes + stats.size > maxTotalBytes) {
        truncated = true;
        return;
      }

      try {
        files.push({ path: path.relative(root, full), source: readFileSync(full, 'utf8') });
        totalBytes += stats.size;
      } catch {
        skipped += 1;
      }
    }
  };

  walk(root);
  return { files, skipped, truncated };
}
