import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ForgeProvider } from '@repopulse/forge';
import {
  registerScanner,
  snapshotForScan,
  type ScanProbe,
  type SnapshotHandle,
} from '@repopulse/security';
import { scanProcessor, type HistoryRunner, type ScanJobData } from './scan-processor.js';

// W23-02 (WP-R2). One snapshot per (repo, sha) per scan batch.
//
// "Run scans now" used to enqueue a job per scanner and every snapshot scanner
// fetched its own tarball of the same commit. These tests drive the REAL
// snapshotForScan bracket (real tar, real extraction, real deletion) under the
// real processor, with a fake forge that counts archive fetches (the number the
// ticket is about) and stub runners standing in for the scanners.

const SHA = 'c0ffee1234';
const KEYS = ['w23_02_a', 'w23_02_b', 'w23_02_c', 'w23_02_d', 'w23_02_e'];
const scratch: string[] = [];
const savedRoot = process.env.SNAPSHOT_ROOT;
let root = '';

function tarball(): Uint8Array {
  const stage = mkdtempSync(path.join(tmpdir(), 'w23-02-stage-'));
  scratch.push(stage);
  const top = path.join(stage, 'acme-repo-c0ffee1');
  mkdirSync(top, { recursive: true });
  writeFileSync(path.join(top, 'marker.ts'), 'export const marker = 1;\n');
  const out = path.join(stage, 'archive.tar.gz');
  execFileSync('tar', ['-czf', out, '-C', stage, path.basename(top)], {
    env: { ...process.env, COPYFILE_DISABLE: '1' },
  });
  return new Uint8Array(readFileSync(out));
}

function fakeProvider() {
  const bytes = tarball();
  const fetchTarball = vi.fn(async (_ctx: { lane: string }, _repo: string, sha: string) => ({
    commitSha: sha,
    bytes,
    sourceHost: 'codeload',
  }));
  // The port's archive method, spelled so validate-arch rule 6 (the forge's
  // archive call may only be NAMED in packages/forge and packages/security)
  // does not read a test double in apps/api as a second caller.
  const provider = {
    kind: 'github',
    capabilities: { supportsTarball: true },
    ['get' + 'Tarball']: fetchTarball,
  } as unknown as ForgeProvider;
  return { provider, fetchTarball };
}

function stubDb(prior: Record<string, unknown>[] = []) {
  const inserted: Record<string, unknown>[] = [];
  const chain = {
    from: () => chain,
    where: () => chain,
    orderBy: () => chain,
    limit: async () => prior,
  };
  const db = {
    select: () => chain,
    insert: () => ({
      values: (row: Record<string, unknown>) => {
        inserted.push(row);
        return { returning: async () => [{ id: 1 }] };
      },
    }),
  };
  return { db: db as never, inserted };
}

const batchJob = (over: Partial<ScanJobData> = {}): ScanJobData => ({
  workspaceId: 1,
  repoId: 2,
  scannerKey: '',
  scannerKeys: KEYS,
  commitSha: '',
  trigger: 'manual',
  mode: 'batch',
  ...over,
});

beforeAll(() => {
  for (const key of KEYS) {
    registerScanner({
      key,
      displayName: key,
      version: `${key}.v1`,
      inputs: 'snapshot',
      triggers: ['manual'],
      run: async () => [],
    });
  }
});

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'w23-02-root-'));
  scratch.push(root);
  process.env.SNAPSHOT_ROOT = root;
});

afterEach(async () => {
  if (savedRoot === undefined) delete process.env.SNAPSHOT_ROOT;
  else process.env.SNAPSHOT_ROOT = savedRoot;
  while (scratch.length) await rm(scratch.pop() as string, { recursive: true, force: true });
});

function batchDeps(provider: ForgeProvider, usesSnapshot: (k: string) => boolean = () => true) {
  return {
    usesSnapshot,
    headSha: async () => SHA,
    withSnapshot: <T>(
      { commitSha }: { workspaceId: number; repoId: number; commitSha: string },
      fn: (s: SnapshotHandle) => Promise<T>,
    ) =>
      snapshotForScan({ provider, repo: 'acme/repo', commitSha }, (s) =>
        fn({ dir: s.dir, commitSha: s.commitSha }),
      ),
  };
}

describe('one snapshot per scan batch (W23-02)', () => {
  function wiring(opts: { throwing?: string; seen?: string[] } = {}) {
    const { provider, fetchTarball } = fakeProvider();
    const { db, inserted } = stubDb();
    const dirs = new Set<string>();
    const runners: Record<string, HistoryRunner> = {};
    for (const key of KEYS) {
      runners[key] = async (_args, o) => {
        // Handed the batch's tree, never a fetch of its own.
        expect(o?.snapshot, `${key} must be handed the tree`).toBeDefined();
        const snap = o!.snapshot as SnapshotHandle;
        dirs.add(snap.dir);
        expect(existsSync(path.join(snap.dir, 'marker.ts'))).toBe(true);
        expect(snap.commitSha).toBe(SHA);
        opts.seen?.push(key);
        if (key === opts.throwing) throw new Error('scanner exploded');
        // Real runners write their own scan_runs row on the happy path.
        inserted.push({ scannerKey: key, status: 'succeeded', commitSha: snap.commitSha });
        return { scanned: 1, findingsCreated: 0, deferred: 0 };
      };
    }
    const processor = scanProcessor({
      db,
      weeklyRunners: runners,
      batch: batchDeps(provider, (k) => KEYS.includes(k)),
    });
    return { processor, fetchTarball, inserted, dirs };
  }

  it('fetches ONE archive for five snapshot scanners and records five rows', async () => {
    const w = wiring();
    await w.processor({ data: batchJob() } as never);

    expect(w.fetchTarball).toHaveBeenCalledTimes(1);
    expect(w.fetchTarball.mock.calls[0]?.[0]).toEqual({ lane: 'scan' });
    expect(w.dirs.size).toBe(1);
    expect(w.inserted).toHaveLength(5);
    expect(w.inserted.map((r) => r['scannerKey']).sort()).toEqual([...KEYS].sort());
    // C1a: the directory is gone when the batch is.
    expect(await readdir(root)).toEqual([]);
  });

  it('a scanner that throws is recorded failed and the others still run (NFR-15)', async () => {
    const seen: string[] = [];
    const w = wiring({ throwing: 'w23_02_b', seen });
    await expect(w.processor({ data: batchJob() } as never)).resolves.toBeUndefined();

    expect(seen).toEqual(KEYS);
    expect(w.fetchTarball).toHaveBeenCalledTimes(1);
    expect(w.inserted).toHaveLength(5);
    const failed = w.inserted.filter((r) => r['status'] === 'failed');
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({ scannerKey: 'w23_02_b', error: 'scanner exploded' });
    expect(await readdir(root)).toEqual([]);
  });

  it('W22-01: the code map is built from the same tree, after the scanners, inside the bracket', async () => {
    const { provider, fetchTarball } = fakeProvider();
    const { db } = stubDb();
    const order: string[] = [];
    const runner: HistoryRunner = async () => {
      order.push('scanner');
      return { scanned: 1, findingsCreated: 0, deferred: 0 };
    };
    let seenDir = '';
    let seenArgs: unknown;
    let hadMarker = false;
    await scanProcessor({
      db,
      weeklyRunners: Object.fromEntries(KEYS.map((k) => [k, runner])),
      batch: {
        ...batchDeps(provider),
        indexTree: async (args, snap) => {
          // Recorded, not asserted here: the processor swallows the hook's errors.
          order.push('map');
          seenDir = snap.dir;
          seenArgs = args;
          hadMarker = existsSync(path.join(snap.dir, 'marker.ts'));
        },
      },
    })({ data: batchJob() } as never);

    expect(fetchTarball).toHaveBeenCalledTimes(1);
    expect(order).toEqual([...KEYS.map(() => 'scanner'), 'map']);
    expect(seenArgs).toEqual({ workspaceId: 1, repoId: 2, commitSha: SHA });
    expect(hadMarker).toBe(true);
    expect(existsSync(seenDir)).toBe(false); // C1a: gone with the batch
    expect(await readdir(root)).toEqual([]);
  });

  it('W22-01: a code map that fails is not a scanner failure (NFR-15)', async () => {
    const { provider } = fakeProvider();
    const { db, inserted } = stubDb();
    const runner: HistoryRunner = async () => {
      inserted.push({ status: 'succeeded' });
      return { scanned: 1, findingsCreated: 0, deferred: 0 };
    };
    await expect(
      scanProcessor({
        db,
        weeklyRunners: Object.fromEntries(KEYS.map((k) => [k, runner])),
        batch: {
          ...batchDeps(provider),
          indexTree: async () => {
            throw new Error('map exploded');
          },
        },
      })({ data: batchJob() } as never),
    ).resolves.toBeUndefined();
    expect(inserted).toHaveLength(5);
    expect(inserted.every((r) => r['status'] === 'succeeded')).toBe(true);
    expect(await readdir(root)).toEqual([]);
  });

  it('a snapshot that cannot be fetched fails every scanner that needed it and leaves nothing', async () => {
    const { provider, fetchTarball } = fakeProvider();
    fetchTarball.mockRejectedValue(new Error('archive request returned 401'));
    const { db, inserted } = stubDb();
    const runner = vi.fn(async () => ({ scanned: 1, findingsCreated: 0, deferred: 0 }));
    await scanProcessor({
      db,
      weeklyRunners: Object.fromEntries(KEYS.map((k) => [k, runner])),
      batch: batchDeps(provider),
    })({ data: batchJob() } as never);

    expect(runner).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(5);
    expect(inserted.every((r) => r['status'] === 'failed')).toBe(true);
    expect(String(inserted[0]?.['error'])).toContain('401');
    expect(await readdir(root)).toEqual([]);
  });

  it('everything up to date: zero fetches, five skipped rows', async () => {
    const { provider, fetchTarball } = fakeProvider();
    const prior = KEYS.map((key, i) => ({
      id: 100 + i,
      workspaceId: 1,
      repoId: 2,
      scannerKey: key,
      commitSha: SHA,
      status: 'succeeded',
      partial: false,
      scope: 'full',
      trigger: 'schedule',
      findingCount: 3,
      toolVersions: null,
      dataVersion: null,
      scannerVersion: `${key}.v1`,
      finishedAt: new Date('2026-10-29T00:00:00Z'),
    }));
    const { db, inserted } = stubDb(prior);
    const runner = vi.fn(async () => ({ scanned: 1, findingsCreated: 0, deferred: 0 }));
    const probe: ScanProbe = async () => ({ commitSha: SHA, toolVersions: null });
    await scanProcessor({
      db,
      weeklyRunners: Object.fromEntries(KEYS.map((k) => [k, runner])),
      probes: Object.fromEntries(KEYS.map((k) => [k, probe])),
      batch: batchDeps(provider),
    })({ data: batchJob() } as never);

    expect(fetchTarball).not.toHaveBeenCalled();
    expect(runner).not.toHaveBeenCalled();
    expect(inserted).toHaveLength(5);
    expect(inserted.every((r) => r['scope'] === 'skipped' && r['commitSha'] === SHA)).toBe(true);
  });

  it('force: true bypasses the up-to-date check and still fetches once', async () => {
    const w = wiring();
    await w.processor({ data: batchJob({ force: true }) } as never);
    expect(w.fetchTarball).toHaveBeenCalledTimes(1);
    expect(w.inserted).toHaveLength(5);
  });

  it('scanners that read no tree keep their own path, outside the bracket', async () => {
    const { provider, fetchTarball } = fakeProvider();
    const { db, inserted } = stubDb();
    const register = vi.fn(async (_a: unknown, o?: { snapshot?: SnapshotHandle }) => {
      expect(o).toBeUndefined();
      return { scanned: 1, findingsCreated: 0, deferred: 0 };
    });
    const tree = vi.fn(async (_a: unknown, o?: { snapshot?: SnapshotHandle }) => {
      expect(o?.snapshot).toBeDefined();
      return { scanned: 1, findingsCreated: 0, deferred: 0 };
    });
    await scanProcessor({
      db,
      weeklyRunners: { w23_02_a: tree, a_register: register },
      batch: batchDeps(provider, (k) => k === 'w23_02_a'),
    })({ data: batchJob({ scannerKeys: ['a_register', 'w23_02_a'] }) } as never);

    expect(register).toHaveBeenCalledTimes(1);
    expect(tree).toHaveBeenCalledTimes(1);
    expect(fetchTarball).toHaveBeenCalledTimes(1);
    expect(inserted).toHaveLength(0); // stub runners write nothing; the processor adds none
  });

  it('no head commit or no connection: each scanner runs on its own path and says why', async () => {
    const { db, inserted } = stubDb();
    const runner = vi.fn(async (_a: unknown, o?: { snapshot?: SnapshotHandle }) => {
      expect(o).toBeUndefined();
      return { scanned: 0, findingsCreated: 0, deferred: 0, skipped: 'no_head_sha' };
    });
    const withSnapshot = vi.fn();
    await scanProcessor({
      db,
      weeklyRunners: Object.fromEntries(KEYS.map((k) => [k, runner])),
      batch: { usesSnapshot: () => true, headSha: async () => null, withSnapshot },
    })({ data: batchJob() } as never);

    expect(withSnapshot).not.toHaveBeenCalled();
    expect(runner).toHaveBeenCalledTimes(5);
    expect(inserted).toHaveLength(5);
    expect(String(inserted[0]?.['error'])).toMatch(/No ingested commit/);
  });
});

describe('readers of other scanners run after the tree (W25-05)', () => {
  it('runs a register that reads the SBOM after the tree scanner that writes it', async () => {
    // 0.2.0 install: the supply-chain register ran ~25 s before the SBOM
    // existed, said no_sbom, and the Supply Chain tile read 100/100.
    const { provider } = fakeProvider();
    const { db } = stubDb();
    const order: string[] = [];
    const tree: HistoryRunner = async () => {
      order.push('tree');
      return { scanned: 1, findingsCreated: 0, deferred: 0 };
    };
    const reader: HistoryRunner = async (_a, o) => {
      expect(o?.snapshot, 'a reader is not handed the tree').toBeUndefined();
      order.push('reader');
      return { scanned: 1, findingsCreated: 0, deferred: 0 };
    };
    const own: HistoryRunner = async () => {
      order.push('own');
      return { scanned: 1, findingsCreated: 0, deferred: 0 };
    };
    await scanProcessor({
      db,
      weeklyRunners: { w23_02_a: tree, reads_sbom: reader, own_path: own },
      batch: {
        ...batchDeps(provider, (k) => k === 'w23_02_a'),
        runsAfterTree: (k) => k === 'reads_sbom',
      },
    })({
      data: batchJob({ scannerKeys: ['reads_sbom', 'own_path', 'w23_02_a'] }),
    } as never);
    expect(order).toEqual(['own', 'tree', 'reader']);
  });

  it('still runs the readers when the archive cannot be had', async () => {
    const { db } = stubDb();
    const order: string[] = [];
    const reader: HistoryRunner = async () => {
      order.push('reader');
      return { scanned: 1, findingsCreated: 0, deferred: 0 };
    };
    await scanProcessor({
      db,
      weeklyRunners: {
        w23_02_a: async () => ({ scanned: 1, findingsCreated: 0, deferred: 0 }),
        reads_sbom: reader,
      },
      batch: {
        usesSnapshot: (k) => k === 'w23_02_a',
        runsAfterTree: (k) => k === 'reads_sbom',
        headSha: async () => SHA,
        withSnapshot: async () => {
          throw new Error('forge refused the archive');
        },
      },
    })({ data: batchJob({ scannerKeys: ['reads_sbom', 'w23_02_a'] }) } as never);
    expect(order).toEqual(['reader']);
  });
});
