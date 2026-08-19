import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { extractTarball, type ExtractResult } from './extract.js';

// Snapshot lifecycle (W8-03, C1a, NFR-13).
//
// The C1a exception buys exactly one thing: source may exist on this machine
// for the length of one scan. Everything here exists to make that "one scan"
// literal - the directory is created inside a scratch root, handed to the
// caller, and removed in a `finally` on every exit path including a throw.
//
// `finally` does NOT survive SIGKILL, and pretending otherwise would be the
// dangerous half of this ticket. The sweeper below is what covers that case:
// on startup and hourly it removes any snap-* directory older than the longest
// a scan is allowed to take. The two mechanisms are for two different failures
// and neither substitutes for the other.

export const SNAPSHOT_PREFIX = 'snap-';

export interface Snapshot {
  dir: string;
  commitSha: string;
  extract: ExtractResult;
}

export interface SnapshotRootOptions {
  /** Scratch root; defaults to the OS temp dir. Never a repo or data volume. */
  root?: string;
}

export function snapshotRoot(opts: SnapshotRootOptions = {}): string {
  return opts.root ?? path.join(tmpdir(), 'repopulse-snapshots');
}

/**
 * Extracts an archive into a fresh snapshot dir, runs `fn`, then deletes it.
 *
 * The callback shape is the point: there is no `createSnapshot` that returns a
 * directory and trusts the caller to clean up. Every snapshot this codebase
 * takes is bracketed, because the one call site that forgets is the one that
 * leaves a customer's source on disk.
 */
export async function withSnapshot<T>(
  args: {
    bytes: Uint8Array;
    commitSha: string;
    root?: string;
    stripComponents?: number;
    perFileCapBytes?: number;
    totalCapBytes?: number;
  },
  fn: (snapshot: Snapshot) => Promise<T>,
): Promise<T> {
  const root = snapshotRoot({ ...(args.root !== undefined ? { root: args.root } : {}) });
  const { mkdir } = await import('node:fs/promises');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(path.join(root, SNAPSHOT_PREFIX));

  try {
    const extract = await extractTarball(args.bytes, dir, {
      stripComponents: args.stripComponents ?? 1,
      ...(args.perFileCapBytes !== undefined ? { perFileCapBytes: args.perFileCapBytes } : {}),
      ...(args.totalCapBytes !== undefined ? { totalCapBytes: args.totalCapBytes } : {}),
    });
    return await fn({ dir, commitSha: args.commitSha, extract });
  } finally {
    await shred(dir);
  }
}

/**
 * Removes a snapshot directory.
 *
 * Named shred rather than delete, and honest about what that means: this is an
 * unlink, not an overwrite. On a modern copy-on-write or flash-backed
 * filesystem overwriting a path does not reliably overwrite the blocks that
 * held it, so a pass of zeroes would buy the appearance of erasure and not the
 * fact. The real control is that the scratch root is ephemeral and the window
 * is one scan long.
 */
export async function shred(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export interface SweepResult {
  removed: string[];
  keptInFlight: number;
}

/**
 * Removes orphaned snapshot dirs (NFR-13).
 *
 * This is the SIGKILL path. A process killed mid-scan runs no `finally`, so
 * the only thing that can clean up after it is a later process - at startup
 * and then hourly.
 */
export async function sweepOrphans(
  opts: { root?: string; maxAgeMs?: number; now?: () => number } = {},
): Promise<SweepResult> {
  const root = snapshotRoot({ ...(opts.root !== undefined ? { root: opts.root } : {}) });
  // Default is deliberately longer than the longest wall-clock budget a scan
  // can be given: sweeping a directory a live scan is still reading would turn
  // a slow scan into a corrupt one.
  const maxAgeMs = opts.maxAgeMs ?? 6 * 60 * 60 * 1000;
  const now = opts.now ?? Date.now;

  let names: string[];
  try {
    names = await readdir(root);
  } catch {
    return { removed: [], keptInFlight: 0 }; // no root yet: nothing has ever run
  }

  const removed: string[] = [];
  let keptInFlight = 0;
  for (const name of names) {
    if (!name.startsWith(SNAPSHOT_PREFIX)) continue;
    const full = path.join(root, name);
    let ageMs: number;
    try {
      // Clamped at zero: filesystem mtime granularity can round a directory's
      // timestamp a millisecond into the future, and a negative age would then
      // read as "younger than any threshold" - a sweeper that skips the very
      // orphan it was just handed.
      ageMs = Math.max(0, now() - (await stat(full)).mtimeMs);
    } catch {
      continue; // vanished between readdir and stat - someone else's finally won
    }
    if (ageMs < maxAgeMs) {
      keptInFlight++;
      continue;
    }
    await shred(full);
    removed.push(name);
  }
  return { removed, keptInFlight };
}

/** Starts the hourly sweep and runs one immediately. Returns a stop handle. */
export function startSweeper(
  opts: { root?: string; intervalMs?: number; maxAgeMs?: number } = {},
): { stop: () => void; ran: Promise<SweepResult> } {
  const intervalMs = opts.intervalMs ?? 60 * 60 * 1000;
  const sweepArgs = {
    ...(opts.root !== undefined ? { root: opts.root } : {}),
    ...(opts.maxAgeMs !== undefined ? { maxAgeMs: opts.maxAgeMs } : {}),
  };
  const ran = sweepOrphans(sweepArgs);
  const timer = setInterval(() => {
    void sweepOrphans(sweepArgs);
  }, intervalMs);
  // Never hold the process open for a cleanup timer.
  timer.unref?.();
  return { stop: () => clearInterval(timer), ran };
}
