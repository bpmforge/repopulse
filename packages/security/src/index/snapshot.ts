import { lstat, readFile, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';

// Read-only, bounded access to the scan snapshot for evidence capture
// (W22-02 slice 1). Lives only as long as one capture call: nothing here is
// persisted, and every path stays inside the snapshot (no symlinks followed,
// no `..`), the same rules as the excerpt reader.

export const SNAPSHOT_MAX_FILE_BYTES = 1024 * 1024;
/** Files listed at most; a larger snapshot is searched in walk order up to this. */
export const SNAPSHOT_MAX_FILES = 20_000;
/** Bytes of file text kept in memory across a capture call. */
const CACHE_MAX_BYTES = 48 * 1024 * 1024;

const SKIP_DIRS = new Set([
  '.git',
  'node_modules',
  'vendor',
  'dist',
  'build',
  'out',
  'target',
  'coverage',
  '.next',
  '.nuxt',
  '__pycache__',
  '.venv',
  'venv',
  '.tox',
  '.mypy_cache',
  '.gradle',
  'Pods',
]);

export class SnapshotReader {
  private root: string | null = null;
  private files: string[] | null = null;
  private fileSet: Set<string> | null = null;
  private readonly cache = new Map<string, string | null>();
  private cachedBytes = 0;
  /** True when the walk stopped at SNAPSHOT_MAX_FILES. */
  truncated = false;

  constructor(private readonly dir: string) {}

  private async rootDir(): Promise<string> {
    this.root ??= await realpath(this.dir);
    return this.root;
  }

  /** Every regular file under the snapshot, relative and '/'-separated, walk order. */
  async list(): Promise<string[]> {
    if (this.files) return this.files;
    const root = await this.rootDir();
    const out: string[] = [];
    const walk = async (rel: string): Promise<void> => {
      if (out.length >= SNAPSHOT_MAX_FILES) return;
      let entries;
      try {
        entries = await readdir(path.join(root, rel), { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const e of entries) {
        if (out.length >= SNAPSHOT_MAX_FILES) {
          this.truncated = true;
          return;
        }
        const child = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) {
          if (!SKIP_DIRS.has(e.name)) await walk(child);
        } else if (e.isFile()) {
          out.push(child);
        }
      }
    };
    await walk('');
    this.files = out;
    this.fileSet = new Set(out);
    return out;
  }

  async has(rel: string): Promise<boolean> {
    if (!this.fileSet) await this.list();
    return this.fileSet!.has(rel);
  }

  async set(): Promise<ReadonlySet<string>> {
    if (!this.fileSet) await this.list();
    return this.fileSet!;
  }

  /** The file's text with '\n' line ends, or null (outside, symlink, large, binary, missing). */
  async read(rel: string): Promise<string | null> {
    if (this.cache.has(rel)) return this.cache.get(rel) ?? null;
    const text = await this.load(rel);
    if (text !== null && this.cachedBytes + text.length <= CACHE_MAX_BYTES) {
      this.cache.set(rel, text);
      this.cachedBytes += text.length;
    } else if (text === null) {
      this.cache.set(rel, null);
    }
    return text;
  }

  private async load(rel: string): Promise<string | null> {
    try {
      const root = await this.rootDir();
      const abs = path.resolve(root, rel);
      if (!abs.startsWith(root + path.sep)) return null;
      const st = await lstat(abs);
      if (!st.isFile() || st.size > SNAPSHOT_MAX_FILE_BYTES) return null;
      // A symlinked directory on the way could still lead out of the snapshot.
      const real = await realpath(abs);
      if (!real.startsWith(root + path.sep)) return null;
      const buf = await readFile(abs);
      if (buf.includes(0)) return null;
      return buf.toString('utf8').replace(/\r\n/g, '\n');
    } catch {
      return null;
    }
  }
}
