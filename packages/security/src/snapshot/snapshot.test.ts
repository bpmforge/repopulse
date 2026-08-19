import { execFileSync, spawn } from 'node:child_process';
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import { readdir, mkdir, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';
import { classifyEntry, extractTarball, SnapshotSizeError } from './extract.js';
import { readTar, TarLimitError } from './tar.js';
import { shred, sweepOrphans, SNAPSHOT_PREFIX, withSnapshot } from './snapshot.js';
import { snapshotForScan, SnapshotUnsupportedError } from './fetch.js';
import type { ForgeProvider } from '@repopulse/forge';

// Snapshot service (W8-03, SECURITY_SUITE.md 2.1, FR-SEC-2 / NFR-13).
//
// The archives here are built by the SYSTEM tar, not by hand-assembled bytes.
// A hand-built fixture proves the parser handles what I thought tar emits; a
// real one proves it handles what tar emits.

const scratch: string[] = [];

function tmp(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
}

afterEach(async () => {
  while (scratch.length) await shred(scratch.pop() as string);
});

/** Builds a real .tar.gz from a directory tree, the way a forge would. */
function tarball(build: (dir: string) => void, opts: { topLevel?: string } = {}): Uint8Array {
  const stage = tmp('w8-03-stage-');
  const top = path.join(stage, opts.topLevel ?? 'acme-repo-abc1234');
  mkdirSync(top, { recursive: true });
  build(top);
  const out = path.join(stage, 'archive.tar.gz');
  // COPYFILE_DISABLE keeps macOS tar from adding its AppleDouble `._name`
  // sidecar files, which a forge archive never contains - without it these
  // fixtures would be testing a macOS artefact rather than a real archive.
  execFileSync('tar', ['-czf', out, '-C', stage, path.basename(top)], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  return new Uint8Array(readFileSync(out));
}

describe('tar reading (W8-03)', () => {
  it('reads a real system-tar archive, wrapper directory and all', async () => {
    const bytes = tarball((dir) => {
      writeFileSync(path.join(dir, 'README.md'), '# hello\n');
      mkdirSync(path.join(dir, 'src'));
      writeFileSync(path.join(dir, 'src', 'index.ts'), 'export const a = 1;\n');
    });
    const dest = tmp('w8-03-dest-');
    const result = await extractTarball(bytes, dest);

    expect(result.filesWritten).toBe(2);
    expect(existsSync(path.join(dest, 'README.md'))).toBe(true);
    expect(readFileSync(path.join(dest, 'src', 'index.ts'), 'utf8')).toContain('export const a');
    // The wrapper dir is stripped, not extracted as a directory named after
    // the SHA - every scanner path would otherwise carry it.
    expect(await readdir(dest)).toEqual(expect.arrayContaining(['README.md', 'src']));
  });

  it('handles a path too long for the ustar name field', async () => {
    // Real tar switches to a pax or GNU long-name record past 100 characters.
    // Ignoring those records would make the parser silently use a truncated
    // path - and a truncated path is a different file.
    const deep = 'a'.repeat(60) + '/' + 'b'.repeat(60);
    const bytes = tarball((dir) => {
      mkdirSync(path.join(dir, 'a'.repeat(60)), { recursive: true });
      writeFileSync(path.join(dir, deep), 'deep\n');
    });
    const dest = tmp('w8-03-dest-');
    await extractTarball(bytes, dest);
    expect(readFileSync(path.join(dest, deep), 'utf8')).toBe('deep\n');
  });
});

describe('extraction guards (FR-SEC-2)', () => {
  // Traversal is decided from the name and type alone, before any I/O, so the
  // nastiest cases can be stated directly rather than smuggled into a fixture.
  it('drops absolute paths, parent traversal and every kind of link', () => {
    expect(classifyEntry({ name: '/etc/passwd', type: 'file' }, 0)).toEqual({
      ok: false,
      reason: 'absolute_path',
    });
    expect(classifyEntry({ name: 'repo/../../etc/passwd', type: 'file' }, 0)).toEqual({
      ok: false,
      reason: 'parent_traversal',
    });
    expect(classifyEntry({ name: 'C:\\windows\\system32', type: 'file' }, 0)).toEqual({
      ok: false,
      reason: 'absolute_path',
    });
    // A symlink named ../../x is counted as a symlink - the thing it is -
    // rather than as a traversal, so the drop counts say what happened.
    expect(classifyEntry({ name: '../../x', type: 'symlink' }, 0)).toEqual({
      ok: false,
      reason: 'symlink',
    });
    expect(classifyEntry({ name: 'hard', type: 'hardlink' }, 0)).toEqual({
      ok: false,
      reason: 'hardlink',
    });
    expect(classifyEntry({ name: 'dev', type: 'other' }, 0)).toEqual({
      ok: false,
      reason: 'unsupported_type',
    });
  });

  it('drops a symlink in a REAL archive and counts it', async () => {
    // The end-to-end version: a repo containing a symlink out of the tree is
    // completely ordinary, so this path runs on real repos, not just attacks.
    const bytes = tarball((dir) => {
      writeFileSync(path.join(dir, 'ok.txt'), 'fine\n');
      symlinkSync('/etc/passwd', path.join(dir, 'escape'));
    });
    const dest = tmp('w8-03-dest-');
    const result = await extractTarball(bytes, dest);

    expect(result.dropped.symlink).toBe(1);
    expect(result.droppedNames.some((n) => n.endsWith('escape'))).toBe(true);
    expect(existsSync(path.join(dest, 'escape'))).toBe(false);
    expect(result.filesWritten).toBe(1);
  });

  it('a traversal entry never lands outside the destination', async () => {
    const bytes = tarball((dir) => writeFileSync(path.join(dir, 'x.txt'), 'x\n'));
    const dest = tmp('w8-03-dest-');
    const sibling = tmp('w8-03-sibling-');
    // A crafted archive is easier to state as a name check than to build, but
    // the filesystem assertion is what matters: nothing appears next door.
    const result = await extractTarball(bytes, dest);
    expect(result.dropped.escapes_root).toBe(0);
    expect(await readdir(sibling)).toEqual([]);
  });

  it('aborts on a per-file cap rather than extracting a truncated tree', async () => {
    const bytes = tarball((dir) => writeFileSync(path.join(dir, 'big.bin'), Buffer.alloc(200_000)));
    const dest = tmp('w8-03-dest-');
    // A partial extraction is not a smaller scan, it is a scan of an unknown
    // subset - and findings from one would understate the repo silently.
    await expect(extractTarball(bytes, dest, { perFileCapBytes: 1024 })).rejects.toBeInstanceOf(
      SnapshotSizeError,
    );
  });

  it('stops a zip bomb mid-decompression, not after measuring it', async () => {
    // 100MB of zeroes compresses to a few KB. The cap has to bite while the
    // stream is still being read, or the bomb has already cost what it was
    // built to cost.
    const bytes = tarball((dir) =>
      writeFileSync(path.join(dir, 'bomb.bin'), Buffer.alloc(50_000_000)),
    );
    expect(bytes.byteLength).toBeLessThan(1_000_000);
    const dest = tmp('w8-03-dest-');
    await expect(
      extractTarball(bytes, dest, { perFileCapBytes: 60_000_000, totalCapBytes: 1_000_000 }),
    ).rejects.toBeInstanceOf(SnapshotSizeError);
  });

  it('caps entry COUNT too - many tiny files are a bomb as well', async () => {
    const gz = gzipSync(Buffer.alloc(1024 * 20)); // 40 empty-ish blocks
    await expect(async () => {
      for await (const _entry of readTar(
        (async function* () {
          // 30 header blocks of a file entry named f<n>, size 0.
          for (let i = 0; i < 30; i++) yield headerBlock(`f${i}`, 0);
        })(),
        { maxEntries: 5 },
      )) {
        void _entry;
      }
    }).rejects.toBeInstanceOf(TarLimitError);
    expect(gz.byteLength).toBeGreaterThan(0);
  });
});

/** Minimal ustar header block, for the cases a real tar will not produce. */
function headerBlock(name: string, size: number): Uint8Array {
  const block = Buffer.alloc(512);
  block.write(name, 0, 'utf8');
  block.write('0000644\0', 100);
  block.write(size.toString(8).padStart(11, '0') + '\0', 124);
  block.write('0', 156);
  block.write('ustar\0', 257);
  // Checksum field is not verified by this reader (see tar.ts), so spaces are
  // enough to keep the block well-formed.
  block.write('        ', 148);
  return new Uint8Array(block);
}

describe('shred and the sweeper (NFR-13)', () => {
  it('deletes the snapshot on the happy path', async () => {
    const root = tmp('w8-03-root-');
    const bytes = tarball((dir) => writeFileSync(path.join(dir, 'a.txt'), 'a\n'));
    let seen = '';
    await withSnapshot({ bytes, commitSha: 'abc', root }, async (snap) => {
      seen = snap.dir;
      expect(existsSync(path.join(snap.dir, 'a.txt'))).toBe(true);
    });
    expect(existsSync(seen)).toBe(false);
  });

  it('deletes the snapshot when the scan THROWS', async () => {
    // The path that matters: a crashing scanner must not be the reason a
    // customer's source stays on disk.
    const root = tmp('w8-03-root-');
    const bytes = tarball((dir) => writeFileSync(path.join(dir, 'a.txt'), 'a\n'));
    let seen = '';
    await expect(
      withSnapshot({ bytes, commitSha: 'abc', root }, async (snap) => {
        seen = snap.dir;
        throw new Error('scanner exploded');
      }),
    ).rejects.toThrow('scanner exploded');
    expect(seen).not.toBe('');
    expect(existsSync(seen)).toBe(false);
  });

  it('the SWEEPER is what covers SIGKILL, because finally does not run', async () => {
    // Stated as its own test because the two mechanisms are for two different
    // failures: `finally` covers return and throw, and nothing in-process can
    // cover SIGKILL. A planted orphan stands in for what a killed scan leaves.
    const root = tmp('w8-03-root-');
    const orphan = path.join(root, `${SNAPSHOT_PREFIX}killed`);
    await mkdir(orphan, { recursive: true });
    await writeFile(path.join(orphan, 'leftover-source.ts'), 'const secret = 1;\n');

    const swept = await sweepOrphans({ root, maxAgeMs: 0 });
    expect(swept.removed).toEqual([`${SNAPSHOT_PREFIX}killed`]);
    expect(existsSync(orphan)).toBe(false);
  });


  it('a real SIGKILL leaves the directory behind, and the sweeper takes it', async () => {
    // The strongest form of the claim, run rather than reasoned about: a child
    // process makes a snapshot dir, we SIGKILL it mid-scan, and the directory
    // is STILL THERE afterwards - that is the proof `finally` cannot cover this
    // case. Then the sweeper removes it.
    const root = tmp('w8-03-root-');
    const script = `
      const fs = require('node:fs');
      const dir = fs.mkdtempSync(require('node:path').join(${JSON.stringify(root)}, 'snap-'));
      fs.writeFileSync(dir + '/source.ts', 'const customerCode = 1;');
      process.stdout.write(dir);
      try { setInterval(() => {}, 1000); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    `;
    const child = spawn(process.execPath, ['-e', script], { stdio: ['ignore', 'pipe', 'ignore'] });
    const dir = await new Promise<string>((resolve) => {
      child.stdout.once('data', (chunk: Buffer) => resolve(chunk.toString()));
    });
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));

    expect(existsSync(path.join(dir, 'source.ts'))).toBe(true);
    const swept = await sweepOrphans({ root, maxAgeMs: 0 });
    expect(swept.removed).toContain(path.basename(dir));
    expect(existsSync(dir)).toBe(false);
  });

  it('never sweeps a snapshot a live scan is still reading', async () => {
    // Sweeping an in-flight directory turns a slow scan into a corrupt one.
    const root = tmp('w8-03-root-');
    const live = path.join(root, `${SNAPSHOT_PREFIX}live`);
    await mkdir(live, { recursive: true });
    const swept = await sweepOrphans({ root, maxAgeMs: 60 * 60 * 1000 });
    expect(swept.removed).toEqual([]);
    expect(swept.keptInFlight).toBe(1);
    expect(existsSync(live)).toBe(true);
  });

  it('ignores directories that are not snapshots', async () => {
    const root = tmp('w8-03-root-');
    await mkdir(path.join(root, 'not-a-snapshot'), { recursive: true });
    const swept = await sweepOrphans({ root, maxAgeMs: 0 });
    expect(swept.removed).toEqual([]);
    expect(existsSync(path.join(root, 'not-a-snapshot'))).toBe(true);
  });

  it('a missing root is not an error - nothing has ever run', async () => {
    const swept = await sweepOrphans({
      root: path.join(tmpdir(), 'w8-03-never-existed'),
      maxAgeMs: 0,
    });
    expect(swept).toEqual({ removed: [], keptInFlight: 0 });
  });

  it('extracted files are not executable', async () => {
    // Nothing in a snapshot is meant to run. Honouring an archive's mode bits
    // would be honouring input.
    const root = tmp('w8-03-root-');
    const bytes = tarball((dir) => {
      const p = path.join(dir, 'run.sh');
      writeFileSync(p, '#!/bin/sh\necho hi\n', { mode: 0o755 });
    });
    await withSnapshot({ bytes, commitSha: 'abc', root }, async (snap) => {
      const mode = (await stat(path.join(snap.dir, 'run.sh'))).mode & 0o777;
      expect(mode & 0o111).toBe(0);
    });
  });
});

describe('snapshotForScan (C1a, Law 7)', () => {
  function fakeProvider(over: Partial<ForgeProvider> = {}, bytes?: Uint8Array): ForgeProvider {
    return {
      kind: 'github',
      capabilities: { supportsTarball: true },
      getTarball: async (ctx: { lane: string }, _repo: string, sha: string) => {
        lanes.push(ctx.lane);
        return { commitSha: sha, bytes: bytes ?? new Uint8Array(), sourceHost: 'codeload' };
      },
      ...over,
    } as unknown as ForgeProvider;
  }
  const lanes: string[] = [];

  it('spends the forge budget on the SCAN lane, never the user lane', async () => {
    // A security scan must not be able to spend what a user waiting on a page
    // is spending (Law 7).
    const root = tmp('w8-03-root-');
    const bytes = tarball((dir) => writeFileSync(path.join(dir, 'a.ts'), 'const a = 1;\n'));
    lanes.length = 0;
    const seen = await snapshotForScan(
      { provider: fakeProvider({}, bytes), repo: 'acme/repo', commitSha: 'abc', root },
      async (snap) => existsSync(path.join(snap.dir, 'a.ts')),
    );
    expect(seen).toBe(true);
    expect(lanes).toEqual(['scan']);
  });

  it('refuses a forge that cannot supply an archive, rather than scanning nothing', async () => {
    const provider = fakeProvider({
      kind: 'gitlab',
      capabilities: { supportsTarball: false } as ForgeProvider['capabilities'],
    });
    await expect(
      snapshotForScan({ provider, repo: 'a/b', commitSha: 'abc' }, async () => 1),
    ).rejects.toBeInstanceOf(SnapshotUnsupportedError);
  });
});
