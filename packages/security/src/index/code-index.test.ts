import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildCodeIndex, CODE_INDEX_EXTRACTOR, isIndexable } from './code-index.js';

// W22-01: the code map keeps names, line spans, hashes and edges, never code
// (decision 4). Built here on a small tree with Lodestone's real extractor.

const MARKER = 'only-in-a-string-literal-7f3a';

let dir = '';
beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'code-index-'));
  const put = (rel: string, text: string) => {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  };
  put(
    'src/util.ts',
    [
      'export function helper(x: number) {',
      '  return x + 1;',
      '}',
      'export function unused() {',
      `  return "${MARKER}";`,
      '}',
    ].join('\n'),
  );
  put(
    'src/main.ts',
    [
      "import { helper } from './util';",
      'export function run(items: number[]) {',
      '  const out = items.map((i) => helper(i));',
      '  console.log(out);',
      '  return helper(out.length);',
      '}',
    ].join('\n'),
  );
  put(
    'app/models.py',
    'def load(path):\n    return open(path).read()\n\ndef main():\n    return load("x")\n',
  );
  put('dist/bundle.js', 'function bundled() {}\n');
  put('web/app.min.js', 'function minified(){}\n');
  put('README.md', 'Call `helper()` to add one.\n');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('the code map (W22-01)', () => {
  it('indexes source files, skipping build output, minified bundles and prose', async () => {
    const index = await buildCodeIndex(dir);
    expect(index.extractor).toBe(CODE_INDEX_EXTRACTOR);
    expect(index.files.map((f) => f.path).sort()).toEqual([
      'app/models.py',
      'src/main.ts',
      'src/util.ts',
    ]);
    expect(isIndexable('a/B.kt')).toBe(true);
    expect(isIndexable('a/b.pb.go')).toBe(false);
    expect(isIndexable('notes.md')).toBe(false);
  });

  it('records definitions with their line spans, and a hash per file', async () => {
    const index = await buildCodeIndex(dir);
    expect(index.defs).toContainEqual(
      expect.objectContaining({
        path: 'src/util.ts',
        symbol: 'helper',
        kind: 'function',
        startLine: 1,
        endLine: 3,
      }),
    );
    expect(index.defs).toContainEqual(
      expect.objectContaining({ path: 'app/models.py', symbol: 'load' }),
    );
    const util = index.files.find((f) => f.path === 'src/util.ts')!;
    expect(util.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(util).toMatchObject({ language: 'typescript', method: 'tree-sitter', lineCount: 6 });
  });

  it('keeps calls and references to names the repository defines, and drops the rest', async () => {
    const index = await buildCodeIndex(dir);
    const calls = index.calls.filter((c) => c.path === 'src/main.ts');
    expect(calls).toContainEqual({ path: 'src/main.ts', caller: 'run', callee: 'helper', line: 3 });
    expect(calls).toContainEqual({ path: 'src/main.ts', caller: 'run', callee: 'helper', line: 5 });
    // map, log, open, read: library calls, not edges in this repository's graph.
    expect(index.calls.map((c) => c.callee)).not.toContain('log');
    expect(index.calls.map((c) => c.callee)).not.toContain('open');
    const helperRefs = index.refs.find((r) => r.path === 'src/main.ts' && r.symbol === 'helper');
    expect(helperRefs?.lines).toEqual(expect.arrayContaining([1, 3, 5]));
    expect(index.refs.map((r) => r.symbol)).not.toContain('items');
    expect(index.imports).toContainEqual({ path: 'src/main.ts', target: './util', line: 1 });
  });

  it('holds no source text: every value is a name, a path, a number or a hash', async () => {
    const index = await buildCodeIndex(dir);
    const json = JSON.stringify(index);
    expect(json).not.toContain(MARKER);
    expect(json).not.toContain('return x + 1');
    expect(json).not.toContain('console.log(out)');
    const strings: string[] = [];
    const walk = (v: unknown) => {
      if (typeof v === 'string') strings.push(v);
      else if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    };
    walk({ ...index, extractor: undefined });
    // No string carries whitespace or a statement: names, paths, kinds and hashes have none.
    for (const s of strings) expect(s, s).not.toMatch(/[\s;(){}=]/);
  });

  it('returns an empty map for an empty tree and never throws', async () => {
    const empty = mkdtempSync(path.join(tmpdir(), 'code-index-empty-'));
    try {
      const index = await buildCodeIndex(empty);
      expect(index.files).toEqual([]);
      expect(index.truncated).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});
