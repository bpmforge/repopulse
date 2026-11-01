import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import type { ForgeProvider } from '@repopulse/forge';
import { registerBuiltinScanners } from '../../catalogue.js';
import { ruleStateStamp } from '../../framework/data-stamp.js';
import type { BaseRun } from '../../framework/input-hash.js';
import type { IncrementalPlan } from '../../framework/incremental.js';
import { runCodeHealthScan, type CodeHealthRunDeps } from './run.js';
import { codeHealthDataVersion, type ToolRunResult } from './tools.js';
import { listAdapters } from './adapters/registry.js';

// Incremental code_health_tools (W23-03), orchestration level.
//
// The tools (a container), the store (Postgres) and the forge are stand-ins: what
// is under test is WHICH files are fetched and scanned, what the sweep is allowed
// to close, what is carried forward, what the run row says, and that every
// "cannot be exact" path falls back to a full scan having written nothing. The
// same scenario against the real store is in run.incremental.integration.test.ts.

beforeAll(() => registerBuiltinScanners());

const BASE: BaseRun = {
  id: 10,
  commitSha: 'base111',
  scope: 'full',
  findingCount: 3,
  toolVersions: { lizard: '1.24.0', jscpd: '4.3.0', biome: '2.5.9' },
  dataVersion: 'dv-from-base',
  inputHash: null,
  inputPaths: [],
};

/** A db whose queries ending in .limit() see `limitRows` (the planner's), others see []. */
function makeDb(limitRows: unknown[] = []) {
  const inserts: Record<string, unknown>[] = [];
  const updates: Record<string, unknown>[] = [];
  const afterWhere = (): unknown => {
    const rest = {
      orderBy: () => rest,
      limit: async () => limitRows,
    };
    return Object.assign(rest, {
      then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve([]).then(res, rej),
    });
  };
  const db = {
    select: () => ({ from: () => ({ where: afterWhere }) }),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        inserts.push(v);
        return Object.assign(Promise.resolve(), {
          returning: async () => [{ id: 77 }],
          onConflictDoNothing: () => ({ returning: async () => [] }),
        });
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

function tools(over: Partial<ToolRunResult> = {}): ToolRunResult {
  return {
    status: 'succeeded',
    findings: [],
    adapterFindings: [],
    adapterErrors: [],
    metrics: { ch_duplication_pct: 4, ch_complexity_p90: 6, ch_worst_fn_count: 1 },
    toolVersions: { lizard: '1.24.0', jscpd: '4.3.0', biome: '2.5.9' },
    ...over,
  };
}

const persistResult = {
  created: 1,
  updated: 0,
  reopened: 0,
  autoResolved: 0,
  suppressed: 0,
  foldedDuplicates: 0,
};

interface Spy {
  fetched: string[];
  toolDirs: { dir: string; files: string[]; skipDuplication: boolean | undefined }[];
  persisted: Record<string, unknown>[];
  carried: Record<string, unknown>[];
  compares: number;
  planned: number;
}

function harness(opts: {
  files?: Record<string, string | null>;
  compare?: { files: { path: string; status: string }[]; truncated?: boolean };
  plan?: IncrementalPlan;
  baseRows?: unknown[];
}) {
  const spy: Spy = {
    fetched: [],
    toolDirs: [],
    persisted: [],
    carried: [],
    compares: 0,
    planned: 0,
  };
  const database = makeDb(opts.baseRows ?? []);
  const stage = mkdtempSync(path.join(tmpdir(), 'w23-03-ch-stage-'));
  const top = path.join(stage, 'acme-widgets-abc');
  mkdirSync(path.join(top, 'src'), { recursive: true });
  writeFileSync(path.join(top, 'src/a.ts'), 'export const a = 1;\n');
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
      spy.fetched.push(file);
      const v = (opts.files ?? {})[file];
      return { path: file, content: v === undefined ? `// ${file}\n` : v };
    },
    compareCommits: async () => {
      spy.compares += 1;
      return { truncated: false, ...(opts.compare ?? { files: [] }) };
    },
  } as unknown as ForgeProvider;

  const walk = (dir: string, rel = ''): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name), `${rel}${e.name}/`) : [`${rel}${e.name}`],
    );

  const deps: CodeHealthRunDeps = {
    db: database.db,
    provider,
    workspaceId: 1,
    repoId: 2,
    repo: 'acme/widgets',
    commitSha: 'head222',
    trigger: 'manual',
    runTools: (async (a: { targetDir: string; skipDuplication?: boolean }) => {
      spy.toolDirs.push({
        dir: a.targetDir,
        files: existsSync(a.targetDir) ? walk(a.targetDir) : [],
        skipDuplication: a.skipDuplication,
      });
      return tools();
    }) as never,
    persist: (async (_db: unknown, p: Record<string, unknown>) => {
      spy.persisted.push(p);
      return persistResult;
    }) as never,
    carry: (async (p: Record<string, unknown>) => {
      spy.carried.push(p);
      return { resighted: 2, closed: 1 };
    }) as never,
    seenFiles: (async () => ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']) as never,
    ...(opts.plan ? { plan: (async () => (spy.planned++, opts.plan)) as never } : {}),
  };
  return { deps, spy, database, bytes };
}

const plan = (
  over: Partial<Extract<IncrementalPlan, { mode: 'incremental' }>> = {},
): IncrementalPlan => ({
  mode: 'incremental',
  baseRun: BASE,
  changed: ['src/b.ts'],
  deleted: ['src/d.ts'],
  ...over,
});

describe('code_health_tools incremental run (W23-03)', () => {
  it('base has A,B,C,D; B changed, D deleted: only B is fetched and scanned, A and C carried, D closed', async () => {
    const { deps, spy, database } = harness({ plan: plan() });
    const out = await runCodeHealthScan(deps);

    // one contents call, for B only: no tarball
    expect(spy.fetched).toEqual(['src/b.ts']);
    // the tools saw a scratch dir with exactly B, and did not run duplication
    expect(spy.toolDirs).toEqual([
      { dir: expect.any(String), files: ['src/b.ts'], skipDuplication: true },
    ]);
    // the sweep may only close inside the changed set: no tree list, B reviewed
    expect(spy.persisted).toHaveLength(1);
    expect(spy.persisted[0]).toMatchObject({
      reviewedFiles: ['src/b.ts'],
      sweepScannerKey: 'code_health_tools',
      scanRunId: 77,
    });
    expect(
      (spy.persisted[0]!['fullSweep'] as Record<string, unknown>)['treeFiles'],
    ).toBeUndefined();
    // A and C are carried, B (replaced by the scan) and D (deleted) are not unchanged
    expect(spy.carried[0]).toMatchObject({
      baseRunId: 10,
      newRunId: 77,
      unchangedPaths: ['src/a.ts', 'src/c.ts'],
      deletedPaths: ['src/d.ts'],
    });
    // the row says what it did, and points at its baseline
    expect(database.inserts[0]).toMatchObject({
      scope: 'incremental',
      baseRunId: 10,
      trigger: 'manual',
    });
    expect(out).toMatchObject({
      status: 'succeeded',
      scope: 'incremental',
      filesScanned: 1,
      carriedForward: 2,
      closedInDeletedFiles: 1,
      metricsWritten: 0,
    });
    // the final row: succeeded, count = new + carried, versions merged, data stamped
    const closed = database.updates.at(-1)!;
    expect(closed).toMatchObject({ status: 'succeeded', findingCount: 2 });
    expect(closed['toolVersions']).toEqual({ lizard: '1.24.0', jscpd: '4.3.0', biome: '2.5.9' });
    expect(typeof closed['dataVersion']).toBe('string');
  });

  it('protects what an incremental run cannot judge: clones and a failed adapter stay open', async () => {
    const h = harness({ plan: plan() });
    h.deps.runTools = (async () =>
      tools({ adapterErrors: [{ adapter: 'biome', reason: 'produced no output' }] })) as never;
    await runCodeHealthScan(h.deps);
    const keepOpen = (
      h.spy.persisted[0]!['fullSweep'] as {
        keepOpen: (r: { ruleId: string | null; file: string | null }) => boolean;
      }
    ).keepOpen;
    expect(keepOpen({ ruleId: 'duplication.clone', file: 'src/b.ts' })).toBe(true);
    expect(keepOpen({ ruleId: 'tool.biome.lint', file: 'src/b.ts' })).toBe(true);
    expect(keepOpen({ ruleId: 'complexity.ccn', file: 'src/b.ts' })).toBe(false);
    expect(keepOpen({ ruleId: 'tool.ruff.E501', file: 'src/b.ts' })).toBe(false);
    // an adapter that failed leaves the run unstamped, so a repeat press retries it
    expect(h.database.updates.at(-1)!['dataVersion']).toBeUndefined();
  });

  it('only files a per-file tool reads are fetched (README is not)', async () => {
    const { deps, spy } = harness({
      plan: plan({ changed: ['README.md', 'src/b.ts', 'docs/x.png'] }),
    });
    await runCodeHealthScan(deps);
    expect(spy.fetched).toEqual(['src/b.ts']);
  });

  it('a delta with nothing to scan still carries everything forward and runs no tool', async () => {
    const { deps, spy, database } = harness({
      plan: plan({ changed: ['README.md'], deleted: [] }),
    });
    const out = await runCodeHealthScan(deps);
    expect(spy.fetched).toEqual([]);
    expect(spy.toolDirs).toEqual([]);
    expect(spy.carried[0]).toMatchObject({
      unchangedPaths: ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'],
      deletedPaths: [],
    });
    expect(out).toMatchObject({ status: 'succeeded', scope: 'incremental', filesScanned: 0 });
    expect(database.inserts[0]).toMatchObject({ scope: 'incremental' });
  });

  describe('falls back to a full scan, having written nothing', () => {
    const expectFull = (h: ReturnType<typeof harness>) => {
      // never an incremental row, and the tools ran over the extracted tarball
      expect(h.database.inserts.every((r) => r['scope'] === undefined)).toBe(true);
      expect(h.spy.toolDirs).toHaveLength(1);
      expect(h.spy.toolDirs[0]!.files).toEqual(['src/a.ts']);
      expect(h.spy.toolDirs[0]!.skipDuplication).toBeUndefined();
      expect((h.spy.persisted[0]!['fullSweep'] as Record<string, unknown>)['treeFiles']).toEqual([
        'src/a.ts',
      ]);
      expect(h.spy.carried).toEqual([]);
    };

    it('over the cap: scope full, and no file was fetched one by one', async () => {
      const many = Array.from({ length: 201 }, (_, i) => ({
        path: `src/f${i}.ts`,
        status: 'modified',
      }));
      const dv = codeHealthDataVersion(undefined, await ruleStateStamp(makeDb().db, 1));
      const h = harness({
        compare: { files: many },
        baseRows: [
          {
            ...BASE,
            workspaceId: 1,
            repoId: 2,
            scannerKey: 'code_health_tools',
            status: 'succeeded',
            partial: false,
            trigger: 'schedule',
            dataVersion: dv,
            startedAt: new Date(),
            finishedAt: new Date(),
          },
        ],
      });
      const out = await runCodeHealthScan(h.deps);
      expect(h.spy.compares).toBe(1);
      expect(h.spy.fetched).toEqual([]);
      expect(out.scope).toBeUndefined();
      expectFull(h);
    });

    it('a changed file a whole-tree adapter reads (terraform -> checkov): full', async () => {
      const h = harness({ plan: plan({ changed: ['infra/main.tf'] }) });
      await runCodeHealthScan(h.deps);
      expect(h.spy.fetched).toEqual([]);
      expectFull(h);
    });

    it('a whole-tree adapter in the last full run (cppcheck): full', async () => {
      const h = harness({
        plan: plan({
          baseRun: { ...BASE, toolVersions: { ...BASE.toolVersions, cppcheck: '2.22.0' } },
        }),
      });
      await runCodeHealthScan(h.deps);
      expect(h.spy.fetched).toEqual([]);
      expectFull(h);
    });

    it('a changed file the forge cannot give in full (over 1 MB): full', async () => {
      const h = harness({ plan: plan(), files: { 'src/b.ts': null } });
      await runCodeHealthScan(h.deps);
      expectFull(h);
    });

    it('"Full rescan" (force) and a handed-in tree never plan at all', async () => {
      const forced = harness({ plan: plan() });
      await runCodeHealthScan({ ...forced.deps, force: true });
      expect(forced.spy.planned).toBe(0);
      expect(forced.spy.fetched).toEqual([]);
      expectFull(forced);

      const handed = harness({ plan: plan() });
      const dir = mkdtempSync(path.join(tmpdir(), 'w23-03-handed-'));
      mkdirSync(path.join(dir, 'src'));
      writeFileSync(path.join(dir, 'src/a.ts'), 'x');
      await runCodeHealthScan({ ...handed.deps, snapshot: { dir, commitSha: 'head222' } });
      expect(handed.spy.planned).toBe(0);
      expect(handed.spy.toolDirs[0]!.files).toEqual(['src/a.ts']);
    });
  });
});

describe('adapter scope metadata (W23-03)', () => {
  it('declares per-file adapters and whole-tree adapters, and an unclassified one reads as tree', () => {
    const scopes = Object.fromEntries(listAdapters().map((a) => [a.key, a.scope]));
    expect(scopes).toMatchObject({
      ruff: 'file',
      biome: 'file',
      shellcheck: 'file',
      hadolint: 'file',
      actionlint: 'file',
      cppcheck: 'tree',
      checkov: 'tree',
    });
    // every registered adapter states its scope: adding one without is a decision nobody made
    for (const a of listAdapters()) expect(a.scope, a.key).toBeDefined();
  });
});
