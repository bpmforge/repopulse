import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { read, security } from '@repopulse/shared';
import type { ForgeProvider } from '@repopulse/forge';
import {
  INPUT_HASH_KEY,
  INPUT_PATHS_KEY,
  MANIFEST_ROOT_PATHS,
  mergePaths,
  readManifestSet,
  type BaseRun,
} from '../../framework/input-hash.js';
import { parseGrypeMatches } from './matches.js';
import { DEPENDENCY_SCANNER_KEY } from './findings.js';

// persistFindings is the store's; what is under test is what this run hands it.
const persisted = vi.hoisted(() => ({ calls: [] as Record<string, unknown>[] }));
vi.mock('@repopulse/insights', async (importActual) => ({
  ...(await importActual<typeof import('@repopulse/insights')>()),
  persistFindings: vi.fn(async (_db: unknown, params: Record<string, unknown>) => {
    persisted.calls.push(params);
    return { created: 1, updated: 0, suppressed: 0, reopened: 0, autoResolved: 0, foldedDuplicates: 0 };
  }),
}));

// One notion of the data version (W23-09 `dependencyDataVersion`): the runner
// stamps it, the gate compares `data_version` with it. The real one reads the
// grype database on disk, so the test supplies today's value.
const NEW_STAMP = '6@2026-10-31T01:00:00Z';
const stampNow = vi.hoisted(() => ({ current: '6@2026-10-31T01:00:00Z' as string | null }));
vi.mock('./data-stamp.js', async (importActual) => ({
  ...(await importActual<typeof import('./data-stamp.js')>()),
  dependencyDataVersion: () => stampNow.current,
}));

const { dependencyScanDecision, dependencyGate, runDependencyScan } = await import('./run.js');

// W23-04. dependency_cve: unchanged manifests + unchanged data -> up_to_date;
// unchanged manifests + new data -> rematch the STORED SBOM (no tarball);
// changed manifests -> today's full path.

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures/dependency');
const fixture = (...p: string[]): string => readFileSync(path.join(FIXTURES, ...p), 'utf8');
const sbom = JSON.parse(fixture('jquery-sbom.cyclonedx.json')) as Record<string, unknown>;
const grypeJson = fixture('jquery-grype.json');
const MANIFESTS = {
  'package.json': fixture('vulnerable', 'package.json'),
  'package-lock.json': fixture('vulnerable', 'package-lock.json'),
};

function provider(files: Record<string, string>, tarballCalls: string[]): ForgeProvider {
  return {
    kind: 'github',
    capabilities: { supportsTarball: true },
    getFileContent: async (_c: unknown, _r: string, p: string, ref: string) => {
      const hit = files[p];
      if (hit === undefined) throw Object.assign(new Error('nf'), { status: 404 });
      return { path: p, ref, sizeBytes: hit.length, content: hit, truncated: false };
    },
    getTarball: async (_c: unknown, _r: string, sha: string) => {
      tarballCalls.push(sha);
      throw new Error('tarball fetched');
    },
  } as unknown as ForgeProvider;
}

async function baseFor(files: Record<string, string>, over: Partial<BaseRun> = {}): Promise<BaseRun> {
  const paths = mergePaths(MANIFEST_ROOT_PATHS, Object.keys(files));
  const set = await readManifestSet(provider(files, []), 'o/r', 'base-sha', paths);
  return {
    id: 41,
    commitSha: 'base-sha',
    scope: 'full',
    findingCount: 4,
    toolVersions: { syft: '1.5', grype: '0.117', [INPUT_HASH_KEY]: set.hash!, [INPUT_PATHS_KEY]: JSON.stringify(set.paths) },
    dataVersion: '6@2026-10-30T00:00:00Z',
    inputHash: set.hash,
    inputPaths: set.paths,
    ...over,
  };
}

/** Just enough drizzle: records writes, serves the SBOM and the existing findings. */
function fakeDb(opts: { sbom?: unknown; existing?: unknown[] }) {
  const inserted: { table: unknown; values: Record<string, unknown> }[] = [];
  const updates: { table: unknown; set: Record<string, unknown> }[] = [];
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const rows =
            table === security.sboms ? (opts.sbom ? [opts.sbom] : []) : table === read.findings ? (opts.existing ?? []) : [];
          return Object.assign(Promise.resolve(rows), { limit: async () => rows });
        },
      }),
    }),
    insert: (table: unknown) => ({
      values: (values: Record<string, unknown>) => {
        inserted.push({ table, values });
        return { returning: async () => [{ id: 900 + inserted.length, ...values }] };
      },
    }),
    update: (table: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: () => {
          updates.push({ table, set });
          return Object.assign(Promise.resolve(), { returning: async () => [{ id: 1 }] });
        },
      }),
    }),
  };
  return { db: db as never, inserted, updates };
}

beforeEach(() => {
  persisted.calls.length = 0;
  stampNow.current = NEW_STAMP;
});

describe('dependencyScanDecision', () => {
  it('manifests and data unchanged -> up_to_date, with no tarball', async () => {
    const tar: string[] = [];
    const base = await baseFor(MANIFESTS, { dataVersion: NEW_STAMP });
    const d = await dependencyScanDecision({ provider: provider(MANIFESTS, tar), repo: 'o/r', sha: 'new-sha', baseRun: base });
    expect(d).toBe('up_to_date');
    expect(tar).toEqual([]);
  });

  it('only the data stamp changed -> rematch', async () => {
    const base = await baseFor(MANIFESTS);
    const d = await dependencyScanDecision({ provider: provider(MANIFESTS, []), repo: 'o/r', sha: 'new-sha', baseRun: base, dataVersion: NEW_STAMP });
    expect(d).toBe('rematch');
  });

  it('a manifest changed -> full, even when the data also changed', async () => {
    const base = await baseFor(MANIFESTS);
    const edited = { ...MANIFESTS, 'package-lock.json': MANIFESTS['package-lock.json'] + '\n' };
    expect(await dependencyScanDecision({ provider: provider(edited, []), repo: 'o/r', sha: 's', baseRun: base, dataVersion: NEW_STAMP })).toBe('full');
  });

  it('a new root manifest -> full', async () => {
    const base = await baseFor(MANIFESTS);
    expect(await dependencyScanDecision({ provider: provider({ ...MANIFESTS, 'go.mod': 'module x' }, []), repo: 'o/r', sha: 's', baseRun: base, dataVersion: NEW_STAMP })).toBe('full');
  });

  it('is full whenever it cannot be sure', async () => {
    const p = provider(MANIFESTS, []);
    const base = await baseFor(MANIFESTS, { dataVersion: NEW_STAMP });
    const args = { provider: p, repo: 'o/r', sha: 's' };
    expect(await dependencyScanDecision({ ...args, baseRun: null })).toBe('full');
    expect(await dependencyScanDecision({ ...args, baseRun: { ...base, inputHash: null } })).toBe('full');
    expect(await dependencyScanDecision({ ...args, baseRun: base, dataVersion: null })).toBe('full');
    expect(await dependencyScanDecision({ ...args, baseRun: base, toolVersions: { syft: '9', grype: '9' } })).toBe('full');
    const broken = { ...p, getFileContent: async () => { throw Object.assign(new Error('x'), { status: 502 }); } } as unknown as ForgeProvider;
    expect(await dependencyScanDecision({ ...args, provider: broken, baseRun: base })).toBe('full');
  });

  it('an unreadable advisory database (no stamp today) is full, never up_to_date', async () => {
    stampNow.current = null;
    const base = await baseFor(MANIFESTS, { dataVersion: NEW_STAMP });
    expect((await dependencyGate({ provider: provider(MANIFESTS, []), repo: 'o/r', sha: 's', baseRun: base })).decision).toBe('full');
  });

  it('a baseline from before the stamp existed rematches (its data age is unknown)', async () => {
    const base = await baseFor(MANIFESTS, { dataVersion: null });
    expect((await dependencyGate({ provider: provider(MANIFESTS, []), repo: 'o/r', sha: 's', baseRun: base })).decision).toBe('rematch');
  });
});

describe('runDependencyScan with a baseline', () => {
  const deps = (db: never, files: Record<string, string>, tar: string[], baseRun: BaseRun | null, extra = {}) => ({
    db,
    provider: provider(files, tar),
    workspaceId: 1,
    repoId: 2,
    repo: 'o/r',
    commitSha: 'new-sha',
    baseRun,
    ...extra,
  });

  it('up_to_date: writes one skipped row pointing at the baseline, fetches nothing, persists nothing', async () => {
    const tar: string[] = [];
    const { db, inserted } = fakeDb({});
    const base = await baseFor(MANIFESTS, { dataVersion: NEW_STAMP });
    const result = await runDependencyScan(deps(db, MANIFESTS, tar, base));
    expect(result).toMatchObject({ status: 'succeeded', gate: 'up_to_date', findingsTotal: 4 });
    expect(tar).toEqual([]);
    expect(persisted.calls).toEqual([]);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]!.values).toMatchObject({
      scannerKey: DEPENDENCY_SCANNER_KEY,
      commitSha: 'new-sha',
      scope: 'skipped',
      baseRunId: 41,
      status: 'succeeded',
      findingCount: 4,
      dataVersion: NEW_STAMP,
    });
  });

  it('rematch: re-derives findings from the STORED SBOM, never fetches a tarball, stamps data_version', async () => {
    const tar: string[] = [];
    const grypeCalls: Record<string, unknown>[] = [];
    const { db, inserted, updates } = fakeDb({ sbom: { document: sbom, componentCount: 3 } });
    const base = await baseFor(MANIFESTS);
    const result = await runDependencyScan(
      deps(db, MANIFESTS, tar, base, {
        grypeOnSbom: async (args: Record<string, unknown>) => {
          grypeCalls.push(args);
          const parsed = parseGrypeMatches(grypeJson);
          return { status: 'succeeded', matches: parsed.matches, matchFunnel: parsed.funnel, toolVersions: { grype: '0.118' } };
        },
      }),
    );
    expect(tar).toEqual([]);
    expect(grypeCalls).toHaveLength(1);
    expect(grypeCalls[0]!['document']).toBe(sbom);
    expect(result).toMatchObject({ status: 'succeeded', gate: 'rematch', sbomStored: false, componentsScanned: 3 });

    // One run row, scope incremental, standing on the baseline, stamped with today's data.
    const runRows = inserted.filter((i) => i.table === security.scanRuns);
    expect(runRows).toHaveLength(1);
    expect(runRows[0]!.values).toMatchObject({ scope: 'incremental', baseRunId: 41, dataVersion: NEW_STAMP, commitSha: 'new-sha', status: 'running' });
    expect(inserted.some((i) => i.table === security.sboms)).toBe(false);

    // The same persist path as a full scan, with the CVEs the stored SBOM matches.
    expect(persisted.calls).toHaveLength(1);
    const findings = persisted.calls[0]!['findings'] as { cveId?: string; scannerKey?: string }[];
    expect(findings.map((f) => f.cveId)).toContain('CVE-2020-11023');
    expect(persisted.calls[0]).toMatchObject({ sweepScannerKey: DEPENDENCY_SCANNER_KEY, pullRequestId: null });

    // Closed succeeded, carrying the baseline's input stamp forward, labelled without it.
    const closed = updates.find((u) => u.table === security.scanRuns && u.set['status'] === 'succeeded')!;
    expect((closed.set['toolVersions'] as Record<string, string>)[INPUT_HASH_KEY]).toBe(base.inputHash);
    expect(closed.set['scannerVersion']).toBe('syft@1.5 grype@0.118');
    expect(closed.set['findingCount']).toBe(findings.length);
  });

  it('rematch: a finding that already exists keeps its stored words and is not re-priced', async () => {
    const grypeFn = async () => {
      const parsed = parseGrypeMatches(grypeJson);
      return { status: 'succeeded' as const, matches: parsed.matches, matchFunnel: parsed.funnel, toolVersions: { grype: '0.118' } };
    };
    const base = await baseFor(MANIFESTS);
    const { dedupKey } = await import('@repopulse/insights');

    // Pass 1, nothing stored: every finding is new, so every one is priced.
    const first = fakeDb({ sbom: { document: sbom, componentCount: 3 } });
    await runDependencyScan(deps(first.db, MANIFESTS, [], base, { grypeOnSbom: grypeFn }));
    const handed = persisted.calls[0]!['findings'] as Record<string, unknown>[];
    expect(handed.length).toBeGreaterThan(0);
    expect(first.updates.filter((u) => u.table === read.findings).length).toBe(handed.length);

    // Pass 2, every one already stored with distinctive words.
    const stored = handed.map((f) => ({
      dedupKey: dedupKey({
        dimension: f['dimension'] as string,
        file: f['file'] as string | null,
        evidenceQuote: f['evidenceQuote'] as string,
        lineStart: f['lineStart'] as number | null,
        scannerKey: (f['scannerKey'] as string | undefined) ?? null,
        ruleId: (f['ruleId'] as string | undefined) ?? null,
        fingerprint: (f['fingerprint'] as string | undefined) ?? null,
      }),
      title: 'STORED TITLE',
      rationale: 'STORED RATIONALE (imported: yes)',
      recommendation: 'STORED FIX',
    }));
    persisted.calls.length = 0;
    const second = fakeDb({ sbom: { document: sbom, componentCount: 3 }, existing: stored });
    await runDependencyScan(deps(second.db, MANIFESTS, [], base, { grypeOnSbom: grypeFn }));
    const out = persisted.calls[0]!['findings'] as { title: string; rationale: string; suggestedFix: string }[];
    expect(out).toHaveLength(handed.length);
    expect(out.every((f) => f.title === 'STORED TITLE' && f.rationale === 'STORED RATIONALE (imported: yes)' && f.suggestedFix === 'STORED FIX')).toBe(true);
    expect(second.updates.filter((u) => u.table === read.findings)).toHaveLength(0);
  });

  it('rematch: a failed grype never reaches the store (it would close every CVE)', async () => {
    const { db, updates } = fakeDb({ sbom: { document: sbom, componentCount: 3 } });
    const result = await runDependencyScan(
      deps(db, MANIFESTS, [], await baseFor(MANIFESTS), {
        grypeOnSbom: async () => ({ status: 'failed', matches: [], matchFunnel: null, toolVersions: {}, error: 'db too old' }),
      }),
    );
    expect(result).toMatchObject({ status: 'failed', gate: 'rematch', error: 'db too old' });
    expect(persisted.calls).toEqual([]);
    expect(updates.find((u) => u.table === security.scanRuns)!.set).toMatchObject({ status: 'failed', error: 'db too old' });
  });

  it('rematch without a stored SBOM for the baseline commit falls through to the full path', async () => {
    const tar: string[] = [];
    const { db, inserted } = fakeDb({});
    const result = await runDependencyScan(deps(db, MANIFESTS, tar, await baseFor(MANIFESTS)));
    expect(tar).toEqual(['new-sha']); // full: the tarball was asked for (the fake refuses it)
    expect(result.status).toBe('failed');
    expect(inserted.filter((i) => i.table === security.scanRuns).every((i) => i.values['scope'] === undefined)).toBe(true);
  });

  it('manifest change -> the full path: the tarball is fetched, no skipped or incremental row', async () => {
    const tar: string[] = [];
    const { db, inserted } = fakeDb({ sbom: { document: sbom, componentCount: 3 } });
    const edited = { ...MANIFESTS, 'package.json': MANIFESTS['package.json'] + ' ' };
    await runDependencyScan(deps(db, edited, tar, await baseFor(MANIFESTS)));
    expect(tar).toEqual(['new-sha']);
    expect(inserted.map((i) => i.values['scope'])).not.toContain('skipped');
    expect(inserted.map((i) => i.values['scope'])).not.toContain('incremental');
  });

  it('no baseline offered (a forced rescan) -> the full path, ungated', async () => {
    const tar: string[] = [];
    const { db } = fakeDb({});
    await runDependencyScan({ ...deps(db, MANIFESTS, tar, null), baseRun: undefined });
    expect(tar).toEqual(['new-sha']);
  });
});
