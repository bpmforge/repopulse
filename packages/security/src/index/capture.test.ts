import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { renderContextPacket, type ContextPacket } from '../triage/packet.js';
import { capturePackets, fitPacket } from './capture.js';

// W22-02 slice 1. The outline run (2026-10-29): six verdicts in 31 minutes, all
// "needs a human", because the stored window did not show where
// `this.workingTable` and `BATCH_SIZE` were defined. These fixtures reproduce
// that shape and pin that the packet now carries both definitions.

let dir: string;

const OUTLINE_TASK = [
  'import { QueryTypes } from "sequelize";', // 1
  'import { sequelize } from "@server/storage/database";', // 2
  'import { DEFAULT_SCHEMA } from "../migrations/constants";', // 3
  '', // 4
  'const BATCH_SIZE = 1000;', // 5
  '', // 6
  'export default class BackfillTask {', // 7
  '  private workingTable = "documents_backfill";', // 8
  '', // 9
  '  public async perform(cursor: number) {', // 10
  '    const total = await this.count();', // 11
  '    let done = 0;', // 12
  '    while (done < total) {', // 13
  '      // move one batch out of the working table', // 14
  '      const rows = await sequelize.query(', // 15
  '        `SELECT id FROM ${DEFAULT_SCHEMA}.${this.workingTable} WHERE id > ${cursor} LIMIT ${BATCH_SIZE}`,', // 16
  '        { type: QueryTypes.SELECT }', // 17
  '      );', // 18
  '      done += rows.length;', // 19
  '    }', // 20
  '    return done;', // 21
  '  }', // 22
  '', // 23
  '  private async count() {', // 24
  '    return 1;', // 25
  '  }', // 26
  '}', // 27
].join('\n');

const PY_REPO = [
  'from .settings import TABLE_NAME', // 1
  '', // 2
  'BATCH_SIZE = 500', // 3
  '', // 4
  '', // 5
  'class Mover:', // 6
  '    prefix = "tmp_"', // 7
  '', // 8
  '    def __init__(self, conn):', // 9
  '        self.conn = conn', // 10
  '', // 11
  '    def move(self, cursor):', // 12
  '        sql = f"SELECT id FROM {self.prefix}{TABLE_NAME} LIMIT {BATCH_SIZE}"', // 13
  '        return self.conn.execute(sql)', // 14
  '', // 15
  '', // 16
  'def main():', // 17
  '    Mover(None).move(0)', // 18
].join('\n');

const GO_STORE = [
  'package store', // 1
  '', // 2
  'import (', // 3
  '\t"database/sql"', // 4
  '\t"fmt"', // 5
  '', // 6
  '\t"example.com/app/internal/limits"', // 7
  ')', // 8
  '', // 9
  'const (', // 10
  '\ttableName = "events"', // 11
  '\tother     = 2', // 12
  ')', // 13
  '', // 14
  'func Purge(db *sql.DB, days int) error {', // 15
  '\tq := fmt.Sprintf("DELETE FROM %s WHERE age > %d LIMIT %d", tableName, days, limits.MaxRows)', // 16
  '\t_, err := db.Exec(q)', // 17
  '\treturn err', // 18
  '}', // 19
].join('\n');

async function put(rel: string, text: string): Promise<void> {
  await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
  await writeFile(path.join(dir, rel), text);
}

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'rp-packet-'));
  await put('server/tasks/BackfillTask.ts', OUTLINE_TASK);
  await put('server/migrations/constants.ts', 'export const DEFAULT_SCHEMA = "public";\n');
  await put(
    'server/tasks/runner.ts',
    [
      'import BackfillTask from "./BackfillTask";',
      '',
      'export async function run() {',
      '  const task = new BackfillTask();',
      '  await task.perform(0);',
      '}',
    ].join('\n'),
  );
  await put('app/mover.py', PY_REPO);
  await put('app/settings.py', 'TABLE_NAME = "events"\n');
  await put(
    'app/jobs.py',
    'from .mover import Mover\n\n\ndef nightly(conn):\n    return Mover(conn).move(1)\n',
  );
  await put('go.mod', 'module example.com/app\n\ngo 1.22\n');
  await put('internal/store/purge.go', GO_STORE);
  await put(
    'internal/limits/limits.go',
    'package limits\n\n// MaxRows caps one purge.\nconst MaxRows = 10000\n',
  );
  await put('cmd/main.go', 'package main\n\nfunc main() {\n\t_ = store.Purge(nil, 30)\n}\n');
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const def = (p: ContextPacket | null | undefined, name: string) =>
  p?.definitions.find((d) => d.name === name);

describe('capturePackets: the outline shape (TS class field + module const in a sequelize.query template)', () => {
  it('carries both definitions the judge was missing, the enclosing method and its callers', async () => {
    const [p] = await capturePackets(dir, [
      { file: 'server/tasks/BackfillTask.ts', lineStart: 15, lineEnd: 18 },
    ]);
    expect(p).not.toBeNull();
    expect(def(p!, 'this.workingTable')).toMatchObject({
      kind: 'class_field',
      file: 'server/tasks/BackfillTask.ts',
      line: 8,
      text: '  private workingTable = "documents_backfill";',
    });
    expect(def(p!, 'BATCH_SIZE')).toMatchObject({
      kind: 'module_const',
      line: 5,
      text: 'const BATCH_SIZE = 1000;',
    });
    // One hop through a relative import.
    expect(def(p!, 'DEFAULT_SCHEMA')).toMatchObject({
      kind: 'module_const',
      file: 'server/migrations/constants.ts',
      line: 1,
      via: 'imported from "../migrations/constants"',
    });
    expect(def(p!, 'cursor')).toMatchObject({ kind: 'parameter', line: 10 });
    // A path alias is named, not guessed at.
    expect(p!.unresolved).toContainEqual({
      name: 'sequelize',
      note: expect.stringContaining('"@server/storage/database"'),
    });
    expect(p!.enclosing).toMatchObject({ name: 'perform', startLine: 10, endLine: 22 });
    expect(p!.callers).toMatchObject({
      symbol: 'perform',
      total: 1,
      crossFileGraphReliable: false,
      shown: [{ file: 'server/tasks/runner.ts', line: 5, text: 'await task.perform(0);' }],
    });

    const r = renderContextPacket(p!, 'server/tasks/BackfillTask.ts', 4000);
    expect(r.text).toContain('8|   private workingTable = "documents_backfill";');
    expect(r.text).toContain('5| const BATCH_SIZE = 1000;');
    expect(r.text).toContain('crossFileGraphReliable=false');
    expect(r.lines.get('server/tasks/BackfillTask.ts:8')).toBe(
      '  private workingTable = "documents_backfill";',
    );
    expect(r.lines.get('server/migrations/constants.ts:1')).toBe(
      'export const DEFAULT_SCHEMA = "public";',
    );
    expect(r.leftOut).toEqual([]);
  });
});

describe('capturePackets: Python and Go module constants', () => {
  it('Python: module const, class attribute through self, and a relative import', async () => {
    const [p] = await capturePackets(dir, [{ file: 'app/mover.py', lineStart: 13, lineEnd: 13 }]);
    expect(def(p, 'BATCH_SIZE')).toMatchObject({
      kind: 'module_const',
      line: 3,
      text: 'BATCH_SIZE = 500',
    });
    expect(def(p, 'self.prefix')).toMatchObject({ kind: 'class_field', line: 7 });
    expect(def(p, 'TABLE_NAME')).toMatchObject({
      kind: 'module_const',
      file: 'app/settings.py',
      line: 1,
      via: 'imported from ".settings"',
    });
    expect(p!.enclosing).toMatchObject({ name: 'move', startLine: 12, endLine: 14 });
    expect(p!.callers?.symbol).toBe('move');
    expect(p!.callers?.shown.map((c) => `${c.file}:${c.line}`)).toEqual([
      'app/mover.py:18',
      'app/jobs.py:5',
    ]);
  });

  it('Go: a const in a grouped block, a parameter, and a constant from a package in the module', async () => {
    const [p] = await capturePackets(dir, [
      { file: 'internal/store/purge.go', lineStart: 16, lineEnd: 16 },
    ]);
    expect(def(p, 'tableName')).toMatchObject({ kind: 'module_const', line: 11 });
    expect(def(p, 'days')).toMatchObject({ kind: 'parameter', line: 15 });
    expect(def(p, 'limits.MaxRows')).toMatchObject({
      kind: 'module_const',
      file: 'internal/limits/limits.go',
      line: 4,
      text: 'const MaxRows = 10000',
    });
    expect(p!.enclosing).toMatchObject({ name: 'Purge', startLine: 15, endLine: 19 });
    expect(p!.callers?.shown).toEqual([
      { symbol: 'Purge', file: 'cmd/main.go', line: 4, text: '_ = store.Purge(nil, 30)' },
    ]);
  });
});

describe('capturePackets: bounds', () => {
  it('returns null for a file it cannot read or a language it does not know, and never throws', async () => {
    const out = await capturePackets(dir, [
      { file: 'missing.ts', lineStart: 1, lineEnd: 1 },
      { file: 'README.md', lineStart: 1, lineEnd: 1 },
      { file: '../../etc/passwd.ts', lineStart: 1, lineEnd: 1 },
      null,
    ]);
    expect(out).toEqual([null, null, null, null]);
    expect(
      await capturePackets(path.join(dir, 'nope'), [{ file: 'a.ts', lineStart: 1, lineEnd: 1 }]),
    ).toEqual([null]);
  });

  it('cuts a packet to the byte cap and says what it left out', async () => {
    const [p] = await capturePackets(dir, [
      { file: 'server/tasks/BackfillTask.ts', lineStart: 16, lineEnd: 16 },
    ]);
    const small = fitPacket(p!, 700);
    expect(Buffer.byteLength(JSON.stringify(small))).toBeLessThanOrEqual(700);
    expect(small.omitted.length).toBeGreaterThan(0);
  });
});
