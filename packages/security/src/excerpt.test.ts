import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { IncomingFinding } from '@repopulse/insights';
import { attachExcerpts, looksLikeSecret, readExcerpt } from './excerpt.js';

let dir = '';
let outside = '';
const numbered = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n');

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'excerpt-'));
  outside = await mkdtemp(path.join(tmpdir(), 'excerpt-out-'));
  await mkdir(path.join(dir, 'src'));
  await writeFile(path.join(dir, 'src/a.ts'), numbered(100));
  await writeFile(path.join(dir, 'src/small.ts'), 'one\ntwo\nthree');
  await writeFile(path.join(dir, 'src/bin.dat'), Buffer.from([1, 2, 0, 3]));
  await writeFile(path.join(dir, 'src/long.ts'), 'x'.repeat(1000));
  await writeFile(path.join(dir, 'src/creds.ts'), 'a\nconst k = "AKIAABCDEFGHIJKLMNOP";\nb');
  await writeFile(
    path.join(dir, 'src/q.ts'),
    [
      'const LIMIT = 50;',
      '',
      'export function list(db: Db) {',
      '  return db.query(`SELECT * FROM t LIMIT ${LIMIT}`);',
      '}',
    ].join('\n'),
  );
  await writeFile(path.join(outside, 'secret.txt'), 'outside the snapshot');
  await symlink(path.join(outside, 'secret.txt'), path.join(dir, 'src/link.txt'));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe('readExcerpt', () => {
  it('takes 8 lines either side of the finding', async () => {
    const ex = await readExcerpt({ dir, file: 'src/a.ts', lineStart: 50, lineEnd: 52 });
    expect(ex!.startLine).toBe(42);
    expect(ex!.lines.split('\n')[0]).toBe('line 42');
    expect(ex!.lines.split('\n').at(-1)).toBe('line 60');
  });

  it('clamps to the start and end of the file', async () => {
    const ex = await readExcerpt({ dir, file: 'src/small.ts', lineStart: 2 });
    expect(ex).toEqual({ startLine: 1, lines: 'one\ntwo\nthree' });
  });

  it('caps a long range at 60 lines', async () => {
    const ex = await readExcerpt({ dir, file: 'src/a.ts', lineStart: 10, lineEnd: 90 });
    expect(ex!.lines.split('\n')).toHaveLength(60);
  });

  it('clips very long lines', async () => {
    const ex = await readExcerpt({ dir, file: 'src/long.ts', lineStart: 1 });
    expect(ex!.lines.length).toBeLessThan(400);
    expect(ex!.lines.endsWith('…')).toBe(true);
  });

  it('returns null for a line past the end, a binary file and a missing file', async () => {
    expect(await readExcerpt({ dir, file: 'src/small.ts', lineStart: 99 })).toBeNull();
    expect(await readExcerpt({ dir, file: 'src/bin.dat', lineStart: 1 })).toBeNull();
    expect(await readExcerpt({ dir, file: 'src/nope.ts', lineStart: 1 })).toBeNull();
    expect(await readExcerpt({ dir, file: 'src/a.ts', lineStart: 0 })).toBeNull();
  });

  it('refuses a path that leaves the snapshot, by .. or by symlink', async () => {
    expect(await readExcerpt({ dir, file: '../etc/passwd', lineStart: 1 })).toBeNull();
    expect(await readExcerpt({ dir, file: 'src/../../x', lineStart: 1 })).toBeNull();
    expect(await readExcerpt({ dir, file: 'src/link.txt', lineStart: 1 })).toBeNull();
  });

  it('returns nothing when the window looks like it holds a credential', async () => {
    expect(await readExcerpt({ dir, file: 'src/creds.ts', lineStart: 2 })).toBeNull();
  });
});

describe('looksLikeSecret', () => {
  it.each([
    '-----BEGIN RSA PRIVATE KEY-----',
    'AKIAABCDEFGHIJKLMNOP',
    'ghp_abcdefghijklmnopqrstuvwxyz0123',
    'password = "correct-horse-battery"',
    'const t = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmnop"',
  ])('catches %s', (text) => expect(looksLikeSecret(text)).toBe(true));

  it.each(['const x = 1;', 'db.query("select 1")', 'password = getPassword()'])(
    'passes %s',
    (text) => expect(looksLikeSecret(text)).toBe(false),
  );
});

describe('attachExcerpts', () => {
  const base: IncomingFinding = {
    dimension: 'logging',
    severity: 2,
    confidence: 4,
    file: 'src/a.ts',
    lineStart: 50,
    lineEnd: 50,
    title: 't',
    evidenceQuote: 'e',
    rationale: 'r',
    suggestedFix: null,
    scannerKey: 'logging_hygiene',
    ruleId: 'bpm-log-console-log',
    yields: null,
  };

  it('adds context to a code finding and leaves a repo-level one untouched', async () => {
    const [a, b] = await attachExcerpts(dir, [base, { ...base, file: null, lineStart: null }]);
    expect(a!.context?.startLine).toBe(42);
    expect(b!.context).toBeUndefined();
  });

  it('never adds context for a secrets finding or a credential-named rule', async () => {
    const out = await attachExcerpts(dir, [
      { ...base, scannerKey: 'secrets' },
      { ...base, ruleId: 'hardcoded-password' },
    ]);
    expect(out.every((f) => f.context === null)).toBe(true);
  });

  it('W22-02: a finding with context also carries its evidence packet; one without context, none', async () => {
    const [a, b, c] = await attachExcerpts(dir, [
      { ...base, file: 'src/q.ts', lineStart: 4, lineEnd: 4 },
      { ...base, file: 'src/missing.ts', lineStart: 4, lineEnd: 4 },
      { ...base, file: 'src/q.ts', lineStart: 4, lineEnd: 4, scannerKey: 'secrets' },
    ]);
    expect(a!.context?.startLine).toBe(1);
    expect(a!.contextPacket).toMatchObject({
      v: 1,
      enclosing: { name: 'list', startLine: 3, endLine: 5 },
      definitions: expect.arrayContaining([
        expect.objectContaining({ name: 'LIMIT', kind: 'module_const', line: 1 }),
        expect.objectContaining({ name: 'db', kind: 'parameter', line: 3 }),
      ]),
    });
    expect(b!.context).toBeNull();
    expect(b!.contextPacket).toBeNull();
    expect(c!.contextPacket).toBeNull();
  });

  it('does nothing without a directory', async () => {
    expect(await attachExcerpts(undefined, [base])).toEqual([base]);
  });
});
