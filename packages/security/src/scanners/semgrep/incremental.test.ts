import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ForgeProvider } from '@repopulse/forge';
import { registerBuiltinScanners } from '../../catalogue.js';
import type { BaseRun } from '../../framework/input-hash.js';
import type { IncrementalPlan } from '../../framework/incremental.js';
import { runSemgrepFull, type SemgrepModeDeps } from './run-modes.js';
import type { SemgrepRunResult } from './scanner.js';

// Semgrep manual/weekly incremental merge (W23-03), orchestration level. The
// engine (a container), the store (Postgres) and the forge are stand-ins; the PR
// path (runSemgrepIncremental) is unchanged and covered by its own tests.

beforeAll(() => registerBuiltinScanners());

const BASE: BaseRun = {
  id: 10,
  commitSha: 'base111',
  scope: 'full',
  findingCount: 3,
  toolVersions: { opengrep: '1.27.1', rulepack: 'bpm-baseline.v1.yaml' },
  dataVersion: 'dv',
  inputHash: null,
  inputPaths: [],
};

const TREE_SIZE = 50;

function makeDb() {
  const inserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const where = (): unknown => {
    const rest = { orderBy: () => rest, limit: async () => [] };
    return Object.assign(rest, {
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve([]).then(res, rej),
    });
  };
  const db = {
    select: () => ({ from: () => ({ where }) }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserts.push(v);
        return Object.assign(Promise.resolve(), { returning: async () => [{ id: 88 }] });
      },
    }),
    update: () => ({
      set: (s: Record<string, unknown>) => ({
        where: async () => {
          updates.push(s);
        },
      }),
    }),
  };
  return { db: db as never, inserts, updates };
}

const scanResult = (over: Partial<SemgrepRunResult> = {}): SemgrepRunResult => ({
  status: 'succeeded',
  findings: [],
  toolErrors: [],
  scannedPaths: ['src/b.js'],
  erroredPaths: [],
  pathlessErrors: 0,
  durationMs: 5,
  toolVersions: { opengrep: '1.27.1', rulepack: 'bpm-baseline.v1.yaml' },
  ...over,
});

const walk = (dir: string, rel = ''): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(dir, e.name), `${rel}${e.name}/`) : [`${rel}${e.name}`],
  );

function harness(opts: { plan?: IncrementalPlan; files?: Record<string, string | null> } = {}) {
  const fetched: string[] = [];
  const scanned: string[][] = [];
  const persisted: Record<string, unknown>[] = [];
  const carried: Record<string, unknown>[] = [];
  const database = makeDb();

  const stage = mkdtempSync(path.join(tmpdir(), 'w23-03-sg-stage-'));
  const top = path.join(stage, 'acme-widgets-abc');
  mkdirSync(path.join(top, 'src'), { recursive: true });
  for (let i = 0; i < TREE_SIZE; i += 1) writeFileSync(path.join(top, `src/t${i}.js`), `// ${i}\n`);
  const archive = path.join(stage, 'a.tar.gz');
  execFileSync('tar', ['-czf', archive, '-C', stage, path.basename(top)]);
  const bytes = new Uint8Array(readFileSync(archive));

  const provider = {
    kind: 'github',
    capabilities: { supportsTarball: true },
    getTarball: async (_c: unknown, _r: string, sha: string) => ({
      commitSha: sha,
      bytes,
      sourceHost: 'codeload',
    }),
    getFileContent: async (_c: unknown, _r: string, file: string) => {
      fetched.push(file);
      const v = (opts.files ?? {})[file];
      return { path: file, content: v === undefined ? `// ${file}\n` : v };
    },
  } as unknown as ForgeProvider;

  const deps: SemgrepModeDeps & { trigger?: 'schedule' | 'manual' } = {
    db: database.db,
    provider,
    workspaceId: 1,
    repoId: 2,
    repo: 'acme/widgets',
    commitSha: 'head222',
    trigger: 'manual',
    runScan: async (a) => {
      scanned.push(existsSync(a.targetDir) ? walk(a.targetDir) : []);
      return scanResult({ scannedPaths: scanned.at(-1) ?? [] });
    },
    persist: (async (_db: unknown, p: Record<string, unknown>) => {
      persisted.push(p);
      return { created: 0, updated: 0, reopened: 0, autoResolved: 0, suppressed: 0, foldedDuplicates: 0 };
    }) as never,
    carry: (async (p: Record<string, unknown>) => {
      carried.push(p);
      return { resighted: 3, closed: 1 };
    }) as never,
    seenFiles: (async () => ['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js']) as never,
    ...(opts.plan ? { plan: (async () => opts.plan) as never } : {}),
  };
  return { deps, fetched, scanned, persisted, carried, database };
}

const plan = (over: Partial<Extract<IncrementalPlan, { mode: 'incremental' }>> = {}): IncrementalPlan => ({
  mode: 'incremental',
  baseRun: BASE,
  changed: ['src/b.js'],
  deleted: ['src/d.js'],
  ...over,
});

describe('semgrep incremental merge on a manual run (W23-03)', () => {
  it('with a baseline, scans only the changed files: filesScanned < tree size', async () => {
    const h = harness({ plan: plan({ changed: ['src/b.js', 'src/e.js', 'README.md'] }) });
    const out = await runSemgrepFull(h.deps);

    expect(out.status).toBe('succeeded');
    expect(out.scope).toBe('incremental');
    expect(out.filesScanned).toBe(2);
    expect(out.filesScanned!).toBeLessThan(TREE_SIZE);
    // fetched one by one: the scannable changed files and nothing else
    expect(h.fetched).toEqual(['src/b.js', 'src/e.js']);
    expect(h.scanned).toEqual([['src/b.js', 'src/e.js']]);
  });

  it('sweeps only what it read, carries the rest, closes the deleted file, and says so on the row', async () => {
    const h = harness({ plan: plan() });
    const out = await runSemgrepFull(h.deps);

    expect(h.persisted[0]).toMatchObject({
      reviewedFiles: ['src/b.js'],
      sweepScannerKey: 'semgrep',
      scanRunId: 88,
    });
    // no tree list: nothing outside the changed set can be closed by silence
    expect(h.persisted[0]!['fullSweep']).toBeUndefined();
    expect(h.carried[0]).toMatchObject({
      baseRunId: 10,
      newRunId: 88,
      unchangedPaths: ['src/a.js', 'src/c.js'],
      deletedPaths: ['src/d.js'],
    });
    expect(h.database.inserts[0]).toMatchObject({ scope: 'incremental', baseRunId: 10, trigger: 'manual' });
    expect(out).toMatchObject({ carriedForward: 3, closedInDeletedFiles: 1, findingsTotal: 3 });
    const closed = h.database.updates.at(-1)!;
    expect(closed).toMatchObject({ status: 'succeeded', findingCount: 3 });
    expect(typeof closed['dataVersion'] === 'string' || closed['dataVersion'] === undefined).toBe(true);
  });

  it('a delta with nothing scannable runs no engine and still carries everything', async () => {
    const h = harness({ plan: plan({ changed: ['README.md'], deleted: [] }) });
    const out = await runSemgrepFull(h.deps);
    expect(h.scanned).toEqual([]);
    expect(out).toMatchObject({ status: 'succeeded', scope: 'incremental', filesScanned: 0 });
    expect(h.carried[0]!['unchangedPaths']).toEqual(['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js']);
  });

  it('a baseline that never read the engine version is not trusted: full', async () => {
    const h = harness({
      plan: plan({ baseRun: { ...BASE, toolVersions: { opengrep: 'unknown' } } }),
    });
    const out = await runSemgrepFull(h.deps);
    expect(out.filesScanned).toBeNull();
    expect(h.fetched).toEqual([]);
  });

  it('over the cap, a full plan, force, or a handed-in tree: a FULL run over the whole tree', async () => {
    const fullPlan: IncrementalPlan = { mode: 'full', reason: 'over_cap' };
    const cases: [string, (h: ReturnType<typeof harness>) => Promise<unknown>][] = [
      ['plan says full', (h) => runSemgrepFull(h.deps)],
      ['force', (h) => runSemgrepFull({ ...h.deps, force: true })],
    ];
    for (const [name, run] of cases) {
      const h = harness({ plan: name === 'force' ? plan() : fullPlan });
      const out = (await run(h)) as { filesScanned: number | null; scope?: string };
      expect(out.filesScanned, name).toBeNull();
      expect(out.scope, name).toBeUndefined();
      expect(h.fetched, name).toEqual([]);
      // the engine saw the whole extracted tree, and the row is an ordinary full one
      expect(h.scanned[0]!.length, name).toBe(TREE_SIZE);
      expect(h.database.inserts.every((r) => r['scope'] === undefined), name).toBe(true);
      expect(h.carried, name).toEqual([]);
    }

    const handed = harness({ plan: plan() });
    const dir = mkdtempSync(path.join(tmpdir(), 'w23-03-sg-handed-'));
    writeFileSync(path.join(dir, 'x.js'), 'x');
    const out = await runSemgrepFull({ ...handed.deps, snapshot: { dir, commitSha: 'head222' } });
    expect(out.filesScanned).toBeNull();
    expect(handed.fetched).toEqual([]);
  });

  it('a changed file the forge cannot give in full (over 1 MB) falls back to full, writing nothing first', async () => {
    const h = harness({ plan: plan(), files: { 'src/b.js': null } });
    const out = await runSemgrepFull(h.deps);
    expect(out.filesScanned).toBeNull();
    expect(h.database.inserts.every((r) => r['scope'] === undefined)).toBe(true);
    expect(h.carried).toEqual([]);
  });
});
