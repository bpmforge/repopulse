import type { ForgeProvider } from '@repopulse/forge';
import { withSnapshot, type Snapshot } from './snapshot.js';

// The one sanctioned path from a forge to a directory on this machine
// (W8-03, C1a). validate-arch rule 6 fails the build if getTarball is called
// anywhere but here.

export class SnapshotUnsupportedError extends Error {
  constructor(kind: string) {
    super(`${kind} cannot provide a source archive - check supportsTarball first`);
    this.name = 'SnapshotUnsupportedError';
  }
}

export interface SnapshotForScanArgs {
  provider: ForgeProvider;
  repo: string;
  commitSha: string;
  root?: string;
  perFileCapBytes?: number;
  totalCapBytes?: number;
}

/**
 * The tree a runner scans: the one a batch already fetched (W23-02), else its
 * own bracket. A provided tree is NOT shredded here — whoever opened the
 * bracket owns the deletion, which is what keeps "one snapshot per scan batch"
 * from becoming "a directory nobody deletes".
 */
export async function snapshotOrProvided<T>(
  provided: { dir: string; commitSha: string } | undefined,
  args: SnapshotForScanArgs,
  fn: (snapshot: { dir: string; commitSha: string }) => Promise<T>,
): Promise<T> {
  return provided ? await fn(provided) : await snapshotForScan(args, fn);
}

/**
 * Fetches a pinned archive and hands a bracketed snapshot to `fn`.
 *
 * The forge call goes out on the `scan` lane: a security scan must not be able
 * to spend the budget a user waiting on a page is spending (Law 7), and it
 * must not sit behind reconcile either, or it would never run on a busy
 * workspace.
 */
export async function snapshotForScan<T>(
  args: SnapshotForScanArgs,
  fn: (snapshot: Snapshot) => Promise<T>,
): Promise<T> {
  if (!args.provider.capabilities.supportsTarball) {
    // Checked rather than caught: the port's rule is that callers branch on
    // capabilities, and a forge that cannot supply an archive must skip
    // snapshot scanners, not fail them into a clean-looking result.
    throw new SnapshotUnsupportedError(args.provider.kind);
  }

  const tarball = await args.provider.getTarball({ lane: 'scan' }, args.repo, args.commitSha);

  return await withSnapshot(
    {
      bytes: tarball.bytes,
      commitSha: tarball.commitSha,
      ...(args.root !== undefined ? { root: args.root } : {}),
      ...(args.perFileCapBytes !== undefined ? { perFileCapBytes: args.perFileCapBytes } : {}),
      ...(args.totalCapBytes !== undefined ? { totalCapBytes: args.totalCapBytes } : {}),
    },
    fn,
  );
}
