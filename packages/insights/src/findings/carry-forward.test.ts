import { describe, expect, it } from 'vitest';
import { carryForward, filesSeenByRun } from './carry-forward.js';

// The merge half of incremental scans (W23-03). The db is a fake that hands back
// queued rows WITHOUT applying the WHERE clause and records every write, so what
// is asserted is the decision (which ids are re-sighted, which are closed) and
// that tenancy is re-applied in memory. The SQL itself is exercised by
// carry-forward.integration.test.ts when a database is available.

interface Written {
  table: string;
  set?: Record<string, unknown>;
  values?: Record<string, unknown>;
}

function fakeDb(selects: unknown[][]) {
  const queue = [...selects];
  const writes: Written[] = [];
  const tableName = (t: unknown): string =>
    String((t as Record<symbol, unknown>)[Symbol.for('drizzle:Name')] ?? 'table');
  const db = {
    select: () => ({ from: () => ({ where: async () => queue.shift() ?? [] }) }),
    update: (t: unknown) => ({
      set: (set: Record<string, unknown>) => ({
        where: async () => {
          writes.push({ table: tableName(t), set });
        },
      }),
    }),
    insert: (t: unknown) => ({
      values: async (values: Record<string, unknown>) => {
        writes.push({ table: tableName(t), values });
      },
    }),
  };
  return { db: db as never, writes };
}

const base = {
  workspaceId: 1,
  repoId: 2,
  scannerKey: 'code_health_tools',
  baseRunId: 10,
  newRunId: 11,
};

const f = (id: number, file: string | null, over: Record<string, unknown> = {}) => ({
  id,
  file,
  workspaceId: 1,
  repoId: 2,
  status: 'open',
  scannerKey: 'code_health_tools',
  ...over,
});

describe('carryForward (W23-03)', () => {
  it('re-sights the base run findings on unchanged files, same rows, new run', async () => {
    const { db, writes } = fakeDb([[f(1, 'a.ts'), f(3, 'c.ts'), f(2, 'b.ts')], []]);
    const out = await carryForward({
      db,
      ...base,
      unchangedPaths: ['a.ts', 'c.ts'],
      deletedPaths: [],
    });
    // b.ts changed: left to the new scan's persist, not carried.
    expect(out).toEqual({ resighted: 2, closed: 0 });
    const upd = writes.filter((w) => w.set);
    expect(upd).toHaveLength(1);
    expect(upd[0]!.set).toMatchObject({ lastSeenScanRunId: 11 });
    expect(upd[0]!.set!['lastSeenAt']).toBeInstanceOf(Date);
    // an increment of the occurrence count, not a rewrite of it
    expect(upd[0]!.set!['occurrenceCount']).toBeDefined();
  });

  it('closes open findings in deleted files, with an event naming the new run', async () => {
    const { db, writes } = fakeDb([[], [f(4, 'd.ts'), f(5, 'd.ts', { status: 'confirmed' })]]);
    const out = await carryForward({ db, ...base, unchangedPaths: [], deletedPaths: ['d.ts'] });
    expect(out).toEqual({ resighted: 0, closed: 2 });
    const closes = writes.filter((w) => w.set?.['status'] === 'resolved');
    expect(closes).toHaveLength(2);
    const events = writes.filter((w) => w.values);
    expect(events).toHaveLength(2);
    expect(events[0]!.values).toMatchObject({
      workspaceId: 1,
      findingId: 4,
      fromStatus: 'open',
      toStatus: 'resolved',
      actor: null,
      reason: 'outdated_diff',
      scanRunId: 11,
    });
  });

  it('never closes a finding a person dismissed', async () => {
    const { db, writes } = fakeDb([[], [f(6, 'd.ts', { status: 'dismissed' })]]);
    const out = await carryForward({ db, ...base, unchangedPaths: [], deletedPaths: ['d.ts'] });
    expect(out.closed).toBe(0);
    expect(writes).toHaveLength(0);
  });

  it('re-applies tenancy in memory: another workspace or repo is never touched', async () => {
    const { db, writes } = fakeDb([
      [f(1, 'a.ts', { workspaceId: 99 }), f(2, 'a.ts', { repoId: 99 })],
      [f(3, 'd.ts', { workspaceId: 99 })],
    ]);
    const out = await carryForward({
      db,
      ...base,
      unchangedPaths: ['a.ts'],
      deletedPaths: ['d.ts'],
    });
    expect(out).toEqual({ resighted: 0, closed: 0 });
    expect(writes).toHaveLength(0);
  });

  it('a repo-level finding (no file) is carried; a path both unchanged and deleted is not closed', async () => {
    const { db } = fakeDb([[f(7, null)], []]);
    const out = await carryForward({
      db,
      ...base,
      unchangedPaths: ['x.ts'],
      deletedPaths: ['x.ts'],
    });
    expect(out).toEqual({ resighted: 1, closed: 0 });
  });
});

describe('filesSeenByRun', () => {
  it('lists the distinct non-null files, tenancy re-checked', async () => {
    const { db } = fakeDb([
      [f(1, 'a.ts'), f(2, 'a.ts'), f(3, null), f(4, 'b.ts', { workspaceId: 5 })],
    ]);
    expect(
      await filesSeenByRun(db, {
        workspaceId: 1,
        repoId: 2,
        scannerKey: 'code_health_tools',
        runId: 10,
      }),
    ).toEqual(['a.ts']);
  });
});
