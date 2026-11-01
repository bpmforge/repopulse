import { mkdtempSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { ForgeProvider } from '@repopulse/forge';
import { fetchChangedFiles, planIncremental, splitComparison } from './incremental.js';
import { shred } from '../snapshot/index.js';

// W23-03. The planner's whole value is in what it REFUSES to limit, so most of
// this is the ways it says full. The db returns whatever rows it is handed
// without applying the WHERE clause; the planner re-applies its predicates.

interface Row {
  id: number;
  workspaceId: number;
  repoId: number;
  scannerKey: string;
  commitSha: string;
  status: string;
  partial: boolean;
  scope: string;
  trigger: string;
  findingCount: number;
  toolVersions: Record<string, string> | null;
  dataVersion: string | null;
  startedAt: Date;
  finishedAt: Date | null;
}

const NOW = new Date('2026-10-31T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

const row = (over: Partial<Row> = {}): Row => ({
  id: 10,
  workspaceId: 1,
  repoId: 2,
  scannerKey: 'code_health_tools',
  commitSha: 'base111',
  status: 'succeeded',
  partial: false,
  scope: 'full',
  trigger: 'schedule',
  findingCount: 4,
  toolVersions: { lizard: '1.24.0' },
  dataVersion: 'dv1',
  startedAt: daysAgo(2),
  finishedAt: daysAgo(2),
  ...over,
});

function fakeDb(rows: Row[]) {
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => rows,
  };
  return { select: () => chain } as never;
}

type Files = { path: string; status: string; previousPath?: string }[];

function provider(
  result: { files: Files; truncated?: boolean } | Error | 'none',
  calls: unknown[][] = [],
): ForgeProvider {
  if (result === 'none') return {} as ForgeProvider;
  return {
    compareCommits: async (...args: unknown[]) => {
      calls.push(args);
      if (result instanceof Error) throw result;
      return { files: result.files, truncated: result.truncated ?? false };
    },
  } as unknown as ForgeProvider;
}

const args = (db: unknown, p: ForgeProvider, over: Record<string, unknown> = {}) => ({
  db: db as never,
  provider: p,
  repo: 'acme/widgets',
  workspaceId: 1,
  repoId: 2,
  scannerKey: 'code_health_tools',
  headSha: 'head222',
  dataVersion: 'dv1',
  maxChangedFiles: 200,
  now: NOW,
  ...over,
});

describe('planIncremental (W23-03)', () => {
  it('plans a delta within the cap: changed, deleted, and the base run', async () => {
    const calls: unknown[][] = [];
    const plan = await planIncremental(
      args(
        fakeDb([row()]),
        provider(
          {
            files: [
              { path: 'src/b.ts', status: 'modified' },
              { path: 'src/new.ts', status: 'added' },
              { path: 'src/d.ts', status: 'removed' },
              { path: 'src/r.ts', status: 'renamed', previousPath: 'src/old.ts' },
            ],
          },
          calls,
        ),
      ),
    );
    expect(plan).toMatchObject({
      mode: 'incremental',
      baseRun: { id: 10, commitSha: 'base111' },
      changed: ['src/b.ts', 'src/new.ts', 'src/r.ts'],
      deleted: ['src/d.ts', 'src/old.ts'],
    });
    // base to head, on the scan lane for this repo
    expect(calls[0]).toEqual([{ lane: 'scan', repoId: '2' }, 'acme/widgets', 'base111', 'head222']);
  });

  it('over the cap is full', async () => {
    const files = Array.from({ length: 201 }, (_, i) => ({ path: `f${i}.ts`, status: 'modified' }));
    expect(await planIncremental(args(fakeDb([row()]), provider({ files })))).toMatchObject({
      mode: 'full',
      reason: 'over_cap',
    });
  });

  it('exactly at the cap is still incremental', async () => {
    const files = Array.from({ length: 200 }, (_, i) => ({ path: `f${i}.ts`, status: 'modified' }));
    expect((await planIncremental(args(fakeDb([row()]), provider({ files })))).mode).toBe(
      'incremental',
    );
  });

  it('a truncated comparison is full', async () => {
    expect(
      await planIncremental(args(fakeDb([row()]), provider({ files: [], truncated: true }))),
    ).toMatchObject({ mode: 'full', reason: 'compare_truncated' });
  });

  it('a forge that cannot compare, or refuses, is full', async () => {
    expect(await planIncremental(args(fakeDb([row()]), provider('none')))).toMatchObject({
      mode: 'full',
      reason: 'forge_cannot_compare',
    });
    expect(
      await planIncremental(args(fakeDb([row()]), provider(new Error('404 base gone')))),
    ).toMatchObject({ mode: 'full', reason: 'compare_unavailable' });
  });

  it('no earlier run is full, and a run of another workspace is not a base', async () => {
    expect((await planIncremental(args(fakeDb([]), provider({ files: [] })))).mode).toBe('full');
    expect(
      (await planIncremental(args(fakeDb([row({ workspaceId: 99 })]), provider({ files: [] })))).mode,
    ).toBe('full');
  });

  it('partial, skipped and PR runs are not baselines', async () => {
    for (const over of [{ partial: true }, { scope: 'skipped' }, { trigger: 'pr_synced' }]) {
      expect(
        (await planIncremental(args(fakeDb([row(over)]), provider({ files: [] })))).mode,
      ).toBe('full');
    }
  });

  it('different tool versions or data version is full', async () => {
    expect(
      await planIncremental(
        args(fakeDb([row()]), provider({ files: [] }), { toolVersions: { lizard: '2.0.0' } }),
      ),
    ).toMatchObject({ mode: 'full', reason: 'tool_versions_changed' });
    expect(
      await planIncremental(args(fakeDb([row()]), provider({ files: [] }), { dataVersion: 'dv2' })),
    ).toMatchObject({ mode: 'full', reason: 'data_version_changed' });
    // unreadable now cannot vouch for anything
    expect(
      await planIncremental(args(fakeDb([row()]), provider({ files: [] }), { dataVersion: null })),
    ).toMatchObject({ mode: 'full', reason: 'data_version_unreadable' });
  });

  it('matching tool versions are accepted (and the input stamp is ignored)', async () => {
    const plan = await planIncremental(
      args(
        fakeDb([row({ toolVersions: { lizard: '1.24.0', input_hash: 'h', input_paths: '[]' } })]),
        provider({ files: [] }),
        { toolVersions: { lizard: '1.24.0' } },
      ),
    );
    expect(plan.mode).toBe('incremental');
  });

  describe('drift guard', () => {
    const incr = (id: number) => row({ id, scope: 'incremental', startedAt: daysAgo(1), finishedAt: daysAgo(1) });

    it('9 incrementals since the last full: still incremental', async () => {
      const runs = [...Array.from({ length: 9 }, (_, i) => incr(30 - i)), row({ id: 5 })];
      expect((await planIncremental(args(fakeDb(runs), provider({ files: [] })))).mode).toBe(
        'incremental',
      );
    });

    it('10 incrementals since the last full: the next run is full', async () => {
      const runs = [...Array.from({ length: 10 }, (_, i) => incr(30 - i)), row({ id: 5 })];
      expect(await planIncremental(args(fakeDb(runs), provider({ files: [] })))).toMatchObject({
        mode: 'full',
        reason: 'chain_limit',
      });
    });

    it('a full older than 30 days: full, however short the chain', async () => {
      const old = row({ startedAt: daysAgo(31), finishedAt: daysAgo(31) });
      expect(await planIncremental(args(fakeDb([old]), provider({ files: [] })))).toMatchObject({
        mode: 'full',
        reason: 'last_full_too_old',
      });
      const fresh = row({ startedAt: daysAgo(29), finishedAt: daysAgo(29) });
      expect((await planIncremental(args(fakeDb([fresh]), provider({ files: [] })))).mode).toBe(
        'incremental',
      );
    });

    it('only incrementals on record (no full ever) is full', async () => {
      expect(
        await planIncremental(args(fakeDb([incr(3), incr(2)]), provider({ files: [] }))),
      ).toMatchObject({ mode: 'full', reason: 'no_full_run_on_record' });
    });

    it('the limits are the caller\'s to set', async () => {
      const runs = [incr(7), incr(6), row({ id: 5 })];
      expect(
        await planIncremental(args(fakeDb(runs), provider({ files: [] }), { maxChain: 2 })),
      ).toMatchObject({ mode: 'full', reason: 'chain_limit' });
      expect(
        await planIncremental(args(fakeDb([row()]), provider({ files: [] }), { maxAgeDays: 1 })),
      ).toMatchObject({ mode: 'full', reason: 'last_full_too_old' });
    });
  });
});

describe('splitComparison', () => {
  it('a path that exists at the head is never deleted', () => {
    expect(
      splitComparison([
        { path: 'a.ts', status: 'renamed', previousPath: 'b.ts' },
        { path: 'b.ts', status: 'added' },
      ]),
    ).toEqual({ changed: ['a.ts', 'b.ts'], deleted: [] });
  });
});

describe('fetchChangedFiles (W23-03)', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await shred(d);
  });
  const scratch = () => {
    const d = mkdtempSync(path.join(tmpdir(), 'w23-03-fetch-'));
    dirs.push(d);
    return d;
  };
  const fetcher = (files: Record<string, string | null | 'missing'>, calls: string[]) =>
    ({
      getFileContent: async (_ctx: unknown, _repo: string, file: string) => {
        calls.push(file);
        const v = files[file];
        if (v === 'missing') throw Object.assign(new Error('nf'), { status: 404 });
        return { path: file, content: v ?? null };
      },
    }) as unknown as ForgeProvider;

  it('fetches exactly the paths asked for, one call each, and mirrors them under root', async () => {
    const calls: string[] = [];
    const root = scratch();
    const out = await fetchChangedFiles({
      provider: fetcher({ 'src/b.ts': 'export const b = 1;', 'big.bin': null }, calls),
      repo: 'acme/widgets',
      repoId: 2,
      commitSha: 'head222',
      paths: ['src/b.ts', 'big.bin'],
      root,
    });
    expect(calls).toEqual(['src/b.ts', 'big.bin']);
    expect(out.written).toEqual(['src/b.ts']);
    // no content = never written empty
    expect(out.unreadable).toEqual(['big.bin']);
    expect(readFileSync(path.join(root, 'src/b.ts'), 'utf8')).toBe('export const b = 1;');
    expect(existsSync(path.join(root, 'big.bin'))).toBe(false);
  });

  it('refuses a path that would escape the scratch directory', async () => {
    const calls: string[] = [];
    const out = await fetchChangedFiles({
      provider: fetcher({}, calls),
      repo: 'acme/widgets',
      repoId: 2,
      commitSha: 'head222',
      paths: ['../../etc/passwd'],
      root: scratch(),
    });
    expect(calls).toEqual([]);
    expect(out.unreadable).toEqual(['../../etc/passwd']);
  });

  it('honours the cap without fetching past it; a 404 throws unless asked to skip', async () => {
    const calls: string[] = [];
    const out = await fetchChangedFiles({
      provider: fetcher({ 'a.ts': 'a', 'b.ts': 'b', 'c.ts': 'c' }, calls),
      repo: 'acme/widgets',
      repoId: 2,
      commitSha: 'head222',
      paths: ['a.ts', 'b.ts', 'c.ts'],
      root: scratch(),
      maxFiles: 2,
    });
    expect(calls).toEqual(['a.ts', 'b.ts']);
    expect(out.overCap).toEqual(['c.ts']);

    const base = {
      repo: 'acme/widgets',
      repoId: 2,
      commitSha: 'h',
      paths: ['gone.ts'],
    };
    await expect(
      fetchChangedFiles({ ...base, provider: fetcher({ 'gone.ts': 'missing' }, []), root: scratch() }),
    ).rejects.toThrow();
    const skipped = await fetchChangedFiles({
      ...base,
      provider: fetcher({ 'gone.ts': 'missing' }, []),
      root: scratch(),
      onMissing: 'skip',
    });
    expect(skipped.gone).toEqual(['gone.ts']);
  });
});
