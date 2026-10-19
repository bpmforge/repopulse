import { readFileSync } from 'node:fs';
import { statfs } from 'node:fs/promises';

// What System health says about the install itself (W20-10, UX_TODO ADM-13 and
// ADM-44): which release this is, and how much disk is left.

let packageVersion: string | null | undefined;

/** The api package's own version — the fallback when no release tag is passed. */
function readPackageVersion(): string | null {
  if (packageVersion !== undefined) return packageVersion;
  try {
    const raw = readFileSync(new URL('../../package.json', import.meta.url), 'utf8');
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    packageVersion = typeof version === 'string' ? version : null;
  } catch {
    packageVersion = null;
  }
  return packageVersion;
}

/**
 * The release an operator would name: REPOPULSE_VERSION (the image tag the
 * compose file runs, pinned by a bundle's install.sh), else the package
 * version. `dev` from a source build says so rather than pretending.
 */
export function appVersion(env: Record<string, string | undefined> = process.env): string {
  const tag = env.REPOPULSE_VERSION?.trim();
  if (tag) return tag;
  return readPackageVersion() ?? 'unknown';
}

export interface DiskSpace {
  path: string;
  freeBytes: number;
  totalBytes: number;
}

/** Free space on the filesystem holding `path`, or null when it cannot be read. */
export async function diskSpace(path: string): Promise<DiskSpace | null> {
  try {
    const s = await statfs(path);
    // bavail, not bfree: the blocks an unprivileged process can actually use.
    return { path, freeBytes: s.bavail * s.bsize, totalBytes: s.blocks * s.bsize };
  } catch {
    return null;
  }
}

const GiB = 1024 ** 3;

/**
 * How worried to be (ADM-44). Postgres, report files and backups (OUT_DIR
 * defaults to the install directory) share one host with no retention, and the
 * first sign of a full disk was every write failing with "Internal Server
 * Error". Warn at 10% or 5 GiB free, whichever comes first; at 3% or 1 GiB
 * writes are about to fail.
 */
export function diskState(d: DiskSpace): 'ready' | 'degraded' | 'unavailable' {
  const ratio = d.totalBytes > 0 ? d.freeBytes / d.totalBytes : 0;
  if (ratio < 0.03 || d.freeBytes < 1 * GiB) return 'unavailable';
  if (ratio < 0.1 || d.freeBytes < 5 * GiB) return 'degraded';
  return 'ready';
}

export function formatBytes(n: number): string {
  if (n >= GiB) return `${(n / GiB).toFixed(1)} GiB`;
  return `${Math.round(n / 1024 ** 2)} MiB`;
}
