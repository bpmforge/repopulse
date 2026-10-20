import { lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

// Reading a snapshot's sources (W9-06).
//
// The deterministic half of anti_slop and the judgement half of both W9-03 and
// W9-04 need FILE CONTENTS rather than a diff — LDR is a property of a whole
// file, and a checklist run over a snapshot has no patch to read. This is the
// one place that walks a snapshot tree, so the caps live here instead of in
// each scanner: a scanner that reads its own files is a scanner that can
// forget a limit.

/**
 * Extensions the W9 scanners can say anything about — plus go.mod, which is
 * not source but is the only place a Go import path maps to a directory
 * (W18-12). Consumers that compute over code filter by extension.
 */
const READABLE = /(\.(js|jsx|ts|tsx|mjs|cjs|py|go|rb|java|kt|cs|php|rs)|^go\.mod)$/;

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
  /**
   * W20-16 (UX_TODO AI-85). Which file NAMES are read; the scanners' list
   * (READABLE) by default. A model review reads more languages than the
   * deterministic scanners can say anything about.
   */
  readable?: RegExp;
  /**
   * Walk only what this accepts (relative path, and whether it is a
   * directory). An AI pass over `src/app` must not spend its file cap on the
   * rest of a monorepo that sorts before it. A directory is entered only when
   * accepted; a file is considered only when accepted.
   */
  include?: (relPath: string, isDir: boolean) => boolean;
}

export interface ReadSourcesResult {
  files: SourceFile[];
  /** Files skipped for size or count — reported, never silent. */
  skipped: number;
  truncated: boolean;
  /** W20-16: in scope but larger than maxFileBytes (the first 50 paths). */
  tooLarge: string[];
  /** W20-16: in scope but of a type `readable` does not accept. */
  unsupported: number;
  /** W20-16: up to five of those, so a refusal can name one. */
  unsupportedExamples: string[];
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
  const readable = opts.readable ?? READABLE;
  const include = opts.include ?? (() => true);

  const files: SourceFile[] = [];
  const tooLarge: string[] = [];
  const unsupportedExamples: string[] = [];
  let unsupported = 0;
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

      const rel = path.relative(root, full);
      if (stats.isDirectory()) {
        if (include(rel, true)) walk(full);
        continue;
      }
      if (!include(rel, false)) continue;
      if (!readable.test(entry)) {
        unsupported += 1;
        if (unsupportedExamples.length < 5) unsupportedExamples.push(rel);
        continue;
      }
      if (stats.size > maxFileBytes) {
        skipped += 1;
        if (tooLarge.length < 50) tooLarge.push(rel);
        continue;
      }
      if (files.length >= maxFiles || totalBytes + stats.size > maxTotalBytes) {
        truncated = true;
        return;
      }

      try {
        files.push({ path: rel, source: readFileSync(full, 'utf8') });
        totalBytes += stats.size;
      } catch {
        skipped += 1;
      }
    }
  };

  walk(root);
  return { files, skipped, truncated, tooLarge, unsupported, unsupportedExamples };
}

/**
 * Every file path in a snapshot tree, relative and unread (W20-08, UX_TODO
 * FND-48).
 *
 * A full scan closes a finding whose file is no longer in the tree: deleting
 * the file is a fix too, and a file that is gone can never be "reviewed". Only
 * `.git` is skipped (an archive carries none, and it is not source). Past the
 * cap the list is CLEARED rather than cut: a partial list would make every
 * file beyond it look deleted.
 */
export function listTreeFiles(root: string, maxFiles = 500_000): string[] {
  const out: string[] = [];
  let overflow = false;
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir).sort();
    } catch {
      return;
    }
    for (const entry of entries) {
      if (overflow) return;
      if (entry === '.git') continue;
      const full = path.join(dir, entry);
      let stats;
      try {
        stats = lstatSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        walk(full);
        continue;
      }
      if (out.length >= maxFiles) {
        overflow = true;
        return;
      }
      out.push(path.relative(root, full));
    }
  };
  walk(root);
  return overflow ? [] : out;
}
