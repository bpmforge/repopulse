import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ForgeProvider } from '@repopulse/forge';
import {
  INPUT_HASH_KEY,
  INPUT_PATHS_KEY,
  commitTreeSha,
  hashFileSet,
  hashSnapshotFiles,
  latestBaseRun,
  manifestSetHash,
  mergePaths,
  readManifestSet,
  realToolVersions,
  stampInputs,
  toolLabel,
} from './input-hash.js';

// W23-04. A gate may say "the same" only when it read every input — most of
// this file is the ways it must refuse.

/** A provider whose contents API serves `files`; a missing path is a forge 404. */
function provider(
  files: Record<string, string | { truncated: true }>,
  calls: string[] = [],
): ForgeProvider {
  return {
    kind: 'github',
    capabilities: { supportsTarball: true },
    getFileContent: async (_ctx: unknown, _repo: string, p: string, ref: string) => {
      calls.push(`${ref}:${p}`);
      const hit = files[p];
      if (hit === undefined) throw Object.assign(new Error('not found'), { status: 404 });
      if (typeof hit !== 'string') {
        return { path: p, ref, sizeBytes: 2_000_000, content: null, truncated: true };
      }
      return { path: p, ref, sizeBytes: hit.length, content: hit, truncated: false };
    },
    getTarball: async () => {
      throw new Error('the gate must never fetch a tarball');
    },
  } as unknown as ForgeProvider;
}

describe('hashFileSet', () => {
  it('ignores order and duplicates, and tells absent from empty', () => {
    const a = hashFileSet([
      { path: 'a', content: '1' },
      { path: 'b', content: '2' },
    ]);
    expect(hashFileSet([{ path: 'b', content: '2' }, { path: 'a', content: '1' }, { path: 'a', content: '1' }])).toBe(a);
    expect(hashFileSet([{ path: 'a', content: '' }])).not.toBe(hashFileSet([{ path: 'a', content: null }]));
    expect(hashFileSet([{ path: 'a', content: '1' }])).not.toBe(hashFileSet([{ path: 'a', content: '2' }]));
  });
});

describe('manifestSetHash (contents API, no tarball)', () => {
  const files = { 'package.json': '{"a":1}', 'package-lock.json': '{"l":1}' };

  it('is stable for the same bytes at a different commit, and moves when a manifest does', async () => {
    const paths = ['package.json', 'package-lock.json', 'go.mod'];
    const one = await manifestSetHash(provider(files), 'o/r', 'sha1', paths);
    const two = await manifestSetHash(provider(files), 'o/r', 'sha2', paths);
    const changed = await manifestSetHash(
      provider({ ...files, 'package-lock.json': '{"l":2}' }),
      'o/r',
      'sha3',
      paths,
    );
    expect(one).not.toBeNull();
    expect(two).toBe(one);
    expect(changed).not.toBe(one);
  });

  it('counts a manifest that appears as a change (absent is a value)', async () => {
    const paths = ['package.json', 'go.mod'];
    const before = await manifestSetHash(provider({ 'package.json': 'x' }), 'o/r', 's', paths);
    const after = await manifestSetHash(provider({ 'package.json': 'x', 'go.mod': 'module a' }), 'o/r', 's', paths);
    expect(after).not.toBe(before);
  });

  it('is null when a file was truncated — the caller must run the scan', async () => {
    expect(
      await manifestSetHash(provider({ 'package.json': { truncated: true } }), 'o/r', 's', ['package.json']),
    ).toBeNull();
  });

  it('lets a non-404 forge error propagate rather than reading it as absent', async () => {
    const broken = {
      ...provider({}),
      getFileContent: async () => {
        throw Object.assign(new Error('boom'), { status: 502 });
      },
    } as unknown as ForgeProvider;
    await expect(manifestSetHash(broken, 'o/r', 's', ['package.json'])).rejects.toThrow('boom');
  });

  it('reads on the scan lane, once per path, deduplicated', async () => {
    const calls: string[] = [];
    await readManifestSet(provider(files, calls), 'o/r', 'abc', ['package.json', '/package.json', 'x']);
    expect(calls).toEqual(['abc:package.json', 'abc:x']);
  });

  it('hashes a snapshot on disk to the same value as the contents API', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'w2304-snap-'));
    mkdirSync(path.join(dir, 'pkg'), { recursive: true });
    writeFileSync(path.join(dir, 'package.json'), files['package.json']);
    writeFileSync(path.join(dir, 'pkg', 'yarn.lock'), 'y');
    const paths = ['package.json', 'pkg/yarn.lock', 'go.mod'];
    const disk = hashSnapshotFiles(dir, paths);
    const api = await readManifestSet(
      provider({ 'package.json': files['package.json'], 'pkg/yarn.lock': 'y' }),
      'o/r',
      's',
      paths,
    );
    expect(disk.hash).toBe(api.hash);
  });
});

describe('the stamp on a run row', () => {
  it('rides in tool_versions, never reaches a label, and is skipped when too wide', () => {
    const stamped = stampInputs({ grype: '0.1' }, 'h', ['package.json'])!;
    expect(stamped[INPUT_HASH_KEY]).toBe('h');
    expect(JSON.parse(stamped[INPUT_PATHS_KEY]!)).toEqual(['package.json']);
    expect(toolLabel(stamped)).toBe('grype@0.1');
    expect(realToolVersions(stamped)).toEqual({ grype: '0.1' });
    expect(stampInputs({ grype: '0.1' }, null, [])).toEqual({ grype: '0.1' });
    const wide = Array.from({ length: 101 }, (_, i) => `p${i}/package.json`);
    expect(stampInputs({ grype: '0.1' }, 'h', wide)).toEqual({ grype: '0.1' });
  });

  it('merges path lists normalised and sorted', () => {
    expect(mergePaths(['/b', 'a'], ['a', ''])).toEqual(['a', 'b']);
  });
});

describe('latestBaseRun', () => {
  const row = (over: Record<string, unknown> = {}) => ({
    id: 5,
    workspaceId: 1,
    repoId: 2,
    scannerKey: 'k',
    commitSha: 'c',
    status: 'succeeded',
    partial: false,
    scope: 'full',
    trigger: 'schedule',
    findingCount: 3,
    toolVersions: { grype: '1', [INPUT_HASH_KEY]: 'h', [INPUT_PATHS_KEY]: '["package.json"]' },
    dataVersion: 'd1',
    ...over,
  });
  // Returns whatever it is handed without applying WHERE: the in-memory
  // predicates are what is under test (same technique as isUpToDate's tests).
  const db = (rows: unknown[]) =>
    ({ select: () => ({ from: () => ({ where: () => ({ orderBy: () => ({ limit: async () => rows }) }) }) }) }) as never;
  const q = { workspaceId: 1, repoId: 2, scannerKey: 'k' };

  it('returns the stamped hash and paths of the newest real run', async () => {
    const base = await latestBaseRun(db([row()]), q);
    expect(base).toMatchObject({ id: 5, inputHash: 'h', inputPaths: ['package.json'], dataVersion: 'd1' });
  });

  it('never chains off a skipped row, a PR look, a partial run, or another tenant', async () => {
    const rows = [
      row({ id: 9, scope: 'skipped' }),
      row({ id: 8, trigger: 'pr_synced' }),
      row({ id: 7, partial: true }),
      row({ id: 6, workspaceId: 99 }),
      row({ id: 4 }),
    ];
    expect((await latestBaseRun(db(rows), q))?.id).toBe(4);
  });

  it('reads a run from before the gate as having no hash', async () => {
    const base = await latestBaseRun(db([row({ toolVersions: { grype: '1' } })]), q);
    expect(base).toMatchObject({ inputHash: null, inputPaths: [] });
  });
});

describe('commitTreeSha', () => {
  it('answers null for a forge that cannot say (the gate then scans)', async () => {
    expect(await commitTreeSha(provider({}), 'o/r', 'sha')).toBeNull();
  });
  it('uses the forge op when it exists', async () => {
    const p = { ...provider({}), getCommitTreeSha: async () => 'tree1' } as unknown as ForgeProvider;
    expect(await commitTreeSha(p, 'o/r', 'sha')).toBe('tree1');
  });
});
