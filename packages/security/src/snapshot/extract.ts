import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { createGunzip } from 'node:zlib';
import { readTar, TarLimitError, type TarEntry } from './tar.js';

// Guarded extraction (W8-03, SECURITY_SUITE.md 2.1, FR-SEC-2).
//
// Every archive here is attacker-influenced: anyone who can open a PR can put
// a file in the tree the archive is built from. So the rule is that an entry
// must EARN its way onto disk. Absolute paths, `..` segments, symlinks,
// hardlinks and device nodes are dropped and counted - never repaired, never
// silently ignored, because a dropped-entry count of 400 on a scan is itself a
// finding, and a count of 0 is the evidence that the guards did nothing today.

export const PER_FILE_CAP_BYTES = 50 * 1024 * 1024;
export const TOTAL_CAP_BYTES = 2 * 1024 * 1024 * 1024;

export type DropReason =
  | 'absolute_path'
  | 'parent_traversal'
  | 'symlink'
  | 'hardlink'
  | 'unsupported_type'
  | 'escapes_root';

export interface ExtractResult {
  filesWritten: number;
  bytesWritten: number;
  /** Counts by reason - zero across the board means the guards saw nothing. */
  dropped: Record<DropReason, number>;
  droppedNames: string[];
}

export class SnapshotSizeError extends Error {
  readonly reason = 'size_cap' as const;
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotSizeError';
  }
}

const emptyDrops = (): Record<DropReason, number> => ({
  absolute_path: 0,
  parent_traversal: 0,
  symlink: 0,
  hardlink: 0,
  unsupported_type: 0,
  escapes_root: 0,
});

/**
 * Decides an entry's fate from its NAME and TYPE alone, before any I/O.
 *
 * Returned as a pure function so the traversal cases can be tested without a
 * filesystem, and so the ordering is visible: type is checked before path,
 * because a symlink named `../../etc/passwd` should be counted as a symlink -
 * the thing it is - rather than as a traversal.
 */
export function classifyEntry(
  entry: Pick<TarEntry, 'name' | 'type'>,
  stripComponents: number,
): { ok: true; relativePath: string } | { ok: false; reason: DropReason } {
  if (entry.type === 'symlink') return { ok: false, reason: 'symlink' };
  if (entry.type === 'hardlink') return { ok: false, reason: 'hardlink' };
  if (entry.type === 'other') return { ok: false, reason: 'unsupported_type' };

  const raw = entry.name.replace(/\\/g, '/');
  if (raw.startsWith('/') || /^[a-zA-Z]:/.test(raw)) {
    return { ok: false, reason: 'absolute_path' };
  }
  const segments = raw.split('/').filter((s) => s !== '' && s !== '.');
  if (segments.includes('..')) return { ok: false, reason: 'parent_traversal' };

  const stripped = segments.slice(stripComponents);
  // A forge archive wraps everything in one `owner-repo-sha/` directory; that
  // wrapper is what stripComponents removes. An entry that IS the wrapper has
  // nothing left and is simply skipped, not dropped as a violation.
  return { ok: true, relativePath: stripped.join('/') };
}

export interface ExtractOptions {
  /** Leading path components to remove (forge archives wrap in one dir). */
  stripComponents?: number;
  perFileCapBytes?: number;
  totalCapBytes?: number;
  /** Called for each dropped entry, so a scan can report what it refused. */
  onDrop?: (name: string, reason: DropReason) => void;
}

/**
 * Extracts a gzipped tar into `destDir` under guard.
 *
 * Throws SnapshotSizeError when a cap is crossed: a partially-extracted tree
 * is not a smaller scan, it is a scan of an unknown subset, and reporting
 * findings from one would understate the repo silently.
 */
export async function extractTarball(
  bytes: Uint8Array,
  destDir: string,
  opts: ExtractOptions = {},
): Promise<ExtractResult> {
  const stripComponents = opts.stripComponents ?? 1;
  const perFileCap = opts.perFileCapBytes ?? PER_FILE_CAP_BYTES;
  const totalCap = opts.totalCapBytes ?? TOTAL_CAP_BYTES;

  const result: ExtractResult = {
    filesWritten: 0,
    bytesWritten: 0,
    dropped: emptyDrops(),
    droppedNames: [],
  };

  const gunzip = createGunzip();
  // The gzip stream is piped, not buffered: the caps have to bite while the
  // archive is still being decompressed, or a bomb is only detected after it
  // has already cost the memory it was designed to cost.
  Readable.from([Buffer.from(bytes)]).pipe(gunzip);

  const root = path.resolve(destDir);
  await mkdir(root, { recursive: true });

  try {
    for await (const entry of readTar(gunzip, {
      maxEntryBytes: perFileCap,
      maxTotalBytes: totalCap,
    })) {
      const verdict = classifyEntry(entry, stripComponents);
      if (!verdict.ok) {
        result.dropped[verdict.reason]++;
        if (result.droppedNames.length < 100) result.droppedNames.push(entry.name);
        opts.onDrop?.(entry.name, verdict.reason);
        continue;
      }
      if (verdict.relativePath === '') continue;

      const target = path.resolve(root, verdict.relativePath);
      // Belt and braces after the name checks: whatever the parsing did, the
      // resolved path must still sit under the root. Cheap, and it is the only
      // check that is true by construction rather than by reasoning.
      if (target !== root && !target.startsWith(root + path.sep)) {
        result.dropped.escapes_root++;
        result.droppedNames.push(entry.name);
        opts.onDrop?.(entry.name, 'escapes_root');
        continue;
      }

      if (entry.type === 'dir') {
        await mkdir(target, { recursive: true });
        continue;
      }

      await mkdir(path.dirname(target), { recursive: true });
      const body = entry.body ?? new Uint8Array(0);
      // Mode 0o600 regardless of what the archive asked for: nothing in a
      // snapshot is meant to be executable, and the sandbox mounts it noexec
      // anyway. Honouring an archive's mode bits would be honouring input.
      await pipeline(
        Readable.from([Buffer.from(body)]),
        createWriteStream(target, { mode: 0o600 }),
      );
      result.filesWritten++;
      result.bytesWritten += body.byteLength;
    }
  } catch (err) {
    if (err instanceof TarLimitError) {
      throw new SnapshotSizeError(err.message);
    }
    throw err;
  }

  return result;
}
