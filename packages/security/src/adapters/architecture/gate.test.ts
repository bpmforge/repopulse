import { describe, expect, it } from 'vitest';
import type { ForgeProvider } from '@repopulse/forge';
import { INPUT_HASH_KEY, type BaseRun } from '../../framework/input-hash.js';
import { architectureScanDecision, runArchitectureScan } from './run.js';
import { ARCHITECTURE_SCANNER_KEY } from './tools.js';

// W23-04. architecture_register: keyed on the commit's tree sha.

const base = (over: Partial<BaseRun> = {}): BaseRun => ({
  id: 12,
  commitSha: 'old',
  scope: 'full',
  findingCount: 5,
  toolVersions: { madge: '6', [INPUT_HASH_KEY]: 'tree-A' },
  dataVersion: null,
  inputHash: 'tree-A',
  inputPaths: [],
  ...over,
});

function provider(trees: Record<string, string>, tarball: string[] = []): ForgeProvider {
  return {
    kind: 'github',
    capabilities: { supportsTarball: true },
    getCommitTreeSha: async (_c: unknown, _r: string, sha: string) => trees[sha] ?? null,
    getTarball: async (_c: unknown, _r: string, sha: string) => {
      tarball.push(sha);
      throw new Error('tarball fetched');
    },
  } as unknown as ForgeProvider;
}

describe('architectureScanDecision', () => {
  const run = (trees: Record<string, string>, baseRun: BaseRun | null, extra = {}) =>
    architectureScanDecision({ provider: provider(trees), repo: 'o/r', sha: 'new', baseRun, ...extra });

  it('a new commit with the same tree -> up_to_date', async () => {
    expect(await run({ new: 'tree-A' }, base())).toBe('up_to_date');
  });
  it('a different tree -> full', async () => {
    expect(await run({ new: 'tree-B' }, base())).toBe('full');
  });
  it('unknown tree, no baseline, or a pre-gate baseline -> full', async () => {
    expect(await run({}, base())).toBe('full');
    expect(await run({ new: 'tree-A' }, null)).toBe('full');
    expect(await run({ new: 'tree-A' }, base({ inputHash: null }))).toBe('full');
  });
  it('a forge without a tree-sha op always scans', async () => {
    const p = { kind: 'github', capabilities: { supportsTarball: true } } as unknown as ForgeProvider;
    expect(await architectureScanDecision({ provider: p, repo: 'o/r', sha: 'new', baseRun: base() })).toBe('full');
  });
  it('a forge error -> full', async () => {
    const p = { ...provider({}), getCommitTreeSha: async () => { throw new Error('x'); } } as unknown as ForgeProvider;
    expect(await architectureScanDecision({ provider: p, repo: 'o/r', sha: 'new', baseRun: base() })).toBe('full');
  });
  it('differing tool versions -> full when the caller supplies them', async () => {
    expect(await run({ new: 'tree-A' }, base(), { toolVersions: { madge: '7' } })).toBe('full');
    expect(await run({ new: 'tree-A' }, base(), { toolVersions: { madge: '6' } })).toBe('up_to_date');
  });
});

describe('runArchitectureScan with a baseline', () => {
  const fakeDb = () => {
    const inserted: Record<string, unknown>[] = [];
    return {
      inserted,
      db: {
        insert: () => ({
          values: (v: Record<string, unknown>) => {
            inserted.push(v);
            return { returning: async () => [{ id: 600 + inserted.length }] };
          },
        }),
        update: () => ({ set: () => ({ where: async () => undefined }) }),
      } as never,
    };
  };
  const deps = (db: never, p: ForgeProvider, baseRun: BaseRun | null | undefined) => ({
    db,
    provider: p,
    workspaceId: 1,
    repoId: 2,
    repo: 'o/r',
    commitSha: 'new',
    baseRun,
  });

  it('same tree -> one skipped row, no tarball', async () => {
    const tar: string[] = [];
    const { db, inserted } = fakeDb();
    const result = await runArchitectureScan(deps(db, provider({ new: 'tree-A' }, tar), base()));
    expect(result).toMatchObject({ status: 'succeeded', gate: 'up_to_date', findingsTotal: 5 });
    expect(tar).toEqual([]);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({
      scannerKey: ARCHITECTURE_SCANNER_KEY,
      commitSha: 'new',
      scope: 'skipped',
      baseRunId: 12,
      findingCount: 5,
    });
  });

  it('changed tree -> the full path (tarball asked for); no baseline -> ungated, same', async () => {
    for (const b of [base(), undefined]) {
      const tar: string[] = [];
      const { db, inserted } = fakeDb();
      await runArchitectureScan(deps(db, provider({ new: 'tree-B' }, tar), b));
      expect(tar).toEqual(['new']);
      expect(inserted.map((i) => i['scope'])).not.toContain('skipped');
    }
  });
});
