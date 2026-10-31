import { describe, expect, it } from 'vitest';
import { isUpToDate, latestBaseline, toolVersionsEqual } from './up-to-date.js';
import { dataStamp, shortHash } from './data-stamp.js';

// W23-01. "Is this scan already answered?" — the rule is only as good as the
// ways it refuses, so most of this is about what must NOT match.
//
// The db is a fake that returns whatever rows it is handed WITHOUT applying the
// WHERE clause. That is deliberate: isUpToDate re-applies its own predicates in
// memory, so feeding it rows from another workspace, another commit or another
// state proves the guarantees hold even if the SQL layer were wrong.

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
  scannerVersion: string;
  finishedAt: Date | null;
}

const row = (over: Partial<Row> = {}): Row => ({
  id: 10,
  workspaceId: 1,
  repoId: 2,
  scannerKey: 'semgrep',
  commitSha: 'abc123',
  status: 'succeeded',
  partial: false,
  scope: 'full',
  trigger: 'schedule',
  findingCount: 7,
  toolVersions: { opengrep: '1.0.0', rulepack: 'a.yaml' },
  dataVersion: null,
  scannerVersion: 'semgrep.v1',
  finishedAt: new Date('2026-10-30T00:00:00Z'),
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

const query = {
  workspaceId: 1,
  repoId: 2,
  scannerKey: 'semgrep',
  commitSha: 'abc123',
  toolVersions: { opengrep: '1.0.0', rulepack: 'a.yaml' },
  dataVersion: null,
};

describe('isUpToDate (W23-01)', () => {
  it('returns the earlier run (id and finding count) when everything matches', async () => {
    const hit = await isUpToDate(fakeDb([row()]), query);
    expect(hit).toMatchObject({ id: 10, findingCount: 7 });
  });

  it('prefers the newest of several matching runs', async () => {
    // The query orders newest first; the first match wins.
    const hit = await isUpToDate(fakeDb([row({ id: 30 }), row({ id: 20 })]), query);
    expect(hit?.id).toBe(30);
  });

  it('does not match a succeeded run from ANOTHER WORKSPACE', async () => {
    const hit = await isUpToDate(fakeDb([row({ workspaceId: 99 })]), query);
    expect(hit).toBeNull();
  });

  it('does not match another repo, scanner or commit', async () => {
    expect(await isUpToDate(fakeDb([row({ repoId: 3 })]), query)).toBeNull();
    expect(await isUpToDate(fakeDb([row({ scannerKey: 'code_health_tools' })]), query)).toBeNull();
    expect(await isUpToDate(fakeDb([row({ commitSha: 'def456' })]), query)).toBeNull();
  });

  it('does not match a failed, running or partial run', async () => {
    expect(await isUpToDate(fakeDb([row({ status: 'failed' })]), query)).toBeNull();
    expect(await isUpToDate(fakeDb([row({ status: 'running' })]), query)).toBeNull();
    expect(await isUpToDate(fakeDb([row({ status: 'budget_exceeded' })]), query)).toBeNull();
    // The findings are real, the SET is not the answer.
    expect(await isUpToDate(fakeDb([row({ partial: true })]), query)).toBeNull();
  });

  it('does not chain off a skipped row, nor off a PR-incremental one', async () => {
    expect(await isUpToDate(fakeDb([row({ scope: 'skipped' })]), query)).toBeNull();
    // The PR semgrep path scans changed files only — not the whole-tree answer.
    expect(await isUpToDate(fakeDb([row({ trigger: 'pr_synced' })]), query)).toBeNull();
  });

  it('does not match when any tool version differs, appears or disappears', async () => {
    expect(
      await isUpToDate(fakeDb([row()]), {
        ...query,
        toolVersions: { opengrep: '1.0.1', rulepack: 'a.yaml' },
      }),
    ).toBeNull();
    expect(
      await isUpToDate(fakeDb([row()]), {
        ...query,
        toolVersions: { opengrep: '1.0.0', rulepack: 'a.yaml', thirdParty: 'x' },
      }),
    ).toBeNull();
    expect(await isUpToDate(fakeDb([row()]), { ...query, toolVersions: null })).toBeNull();
    expect(await isUpToDate(fakeDb([row({ toolVersions: null })]), query)).toBeNull();
  });

  it('treats key order as irrelevant and null/undefined on both sides as equal', async () => {
    const reordered = { rulepack: 'a.yaml', opengrep: '1.0.0' };
    expect(await isUpToDate(fakeDb([row()]), { ...query, toolVersions: reordered })).not.toBeNull();
    const none = row({ toolVersions: null });
    expect(await isUpToDate(fakeDb([none]), { ...query, toolVersions: null })).not.toBeNull();
    const withoutVersions = {
      workspaceId: 1,
      repoId: 2,
      scannerKey: 'semgrep',
      commitSha: 'abc123',
    };
    expect(await isUpToDate(fakeDb([none]), withoutVersions)).not.toBeNull();
  });

  it('compares data_version when the query carries one, and ignores it when null', async () => {
    const stamped = row({ dataVersion: 'grype-db-2026-10-29' });
    expect(
      await isUpToDate(fakeDb([stamped]), { ...query, dataVersion: 'grype-db-2026-10-29' }),
    ).not.toBeNull();
    // A refreshed database re-scans an unchanged tree.
    expect(
      await isUpToDate(fakeDb([stamped]), { ...query, dataVersion: 'grype-db-2026-10-31' }),
    ).toBeNull();
    // A run that recorded no stamp cannot satisfy a query that has one.
    expect(await isUpToDate(fakeDb([row()]), { ...query, dataVersion: 'x' })).toBeNull();
    // null on the query side = ignore, whatever the run recorded.
    expect(await isUpToDate(fakeDb([stamped]), { ...query, dataVersion: null })).not.toBeNull();
  });

  it('never matches an unpinned (empty) commit', async () => {
    expect(
      await isUpToDate(fakeDb([row({ commitSha: '' })]), { ...query, commitSha: '' }),
    ).toBeNull();
  });

  it('skips a non-matching newer row and finds the older matching one', async () => {
    const hit = await isUpToDate(
      fakeDb([row({ id: 30, status: 'failed' }), row({ id: 20 })]),
      query,
    );
    expect(hit?.id).toBe(20);
  });
});

describe('toolVersionsEqual', () => {
  it('is a deep equality on string maps', () => {
    expect(toolVersionsEqual({ a: '1' }, { a: '1' })).toBe(true);
    expect(toolVersionsEqual({ a: '1' }, { a: '2' })).toBe(false);
    expect(toolVersionsEqual({ a: '1' }, { a: '1', b: '2' })).toBe(false);
    expect(toolVersionsEqual({}, {})).toBe(true);
    expect(toolVersionsEqual({}, null)).toBe(false);
    expect(toolVersionsEqual(null, undefined)).toBe(true);
  });
});

describe('latestBaseline (W23-09): what a probe may cache versions from', () => {
  const q = { workspaceId: 1, repoId: 2, scannerKey: 'semgrep', commitSha: 'abc123' };

  it('returns the newest qualifying run with its recorded versions', async () => {
    const hit = await latestBaseline(
      fakeDb([row({ id: 12, dataVersion: 'd2' }), row({ id: 11, dataVersion: 'd1' })]),
      q,
    );
    expect(hit).toMatchObject({ id: 12, dataVersion: 'd2' });
    expect(hit?.toolVersions).toEqual({ opengrep: '1.0.0', rulepack: 'a.yaml' });
  });

  it('applies the same exclusions as isUpToDate, in memory', async () => {
    const rows = [
      row({ id: 9, workspaceId: 99 }),
      row({ id: 8, commitSha: 'other' }),
      row({ id: 7, status: 'failed' }),
      row({ id: 6, partial: true }),
      row({ id: 5, scope: 'skipped' }),
      row({ id: 4, trigger: 'pr_synced' }),
    ];
    expect(await latestBaseline(fakeDb(rows), q)).toBeNull();
  });

  it('is null for a manual job with no commit', async () => {
    expect(await latestBaseline(fakeDb([row()]), { ...q, commitSha: '' })).toBeNull();
  });
});

describe('dataStamp (W23-09)', () => {
  it('is order-independent and readable', () => {
    expect(dataStamp({ rulepack: 'a.yaml', image: 'scan:dev' })).toBe(
      dataStamp({ image: 'scan:dev', rulepack: 'a.yaml' }),
    );
    expect(dataStamp({ rulepack: 'a.yaml', image: 'scan:dev' })).toBe(
      'image@scan:dev rulepack@a.yaml',
    );
  });

  it('omits inputs that do not apply (undefined) and refuses to stamp half the evidence (null)', () => {
    expect(dataStamp({ a: '1', b: undefined })).toBe('a@1');
    expect(dataStamp({ a: '1', b: null })).toBeNull();
    expect(dataStamp({ a: undefined })).toBeNull();
  });

  it('shortHash is stable and 12 hex chars', () => {
    expect(shortHash('x')).toBe(shortHash('x'));
    expect(shortHash('x')).toMatch(/^[0-9a-f]{12}$/);
    expect(shortHash('x')).not.toBe(shortHash('y'));
  });
});
