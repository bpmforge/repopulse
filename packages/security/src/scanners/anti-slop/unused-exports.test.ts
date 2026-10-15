import { describe, expect, it } from 'vitest';
import {
  exportsOf,
  importsOf,
  maskSource,
  resolveSpecifier,
  unusedExports,
} from './unused-exports.js';

// Unused exports (W18-01). Every case here is a way the rule could invent a
// finding, because a wrong one is an invitation to delete live code.

const names = (found: { name: string }[]): string[] => found.map((f) => f.name).sort();

describe('exportsOf', () => {
  it('reads declarations, export lists and enums, not re-exports or defaults', () => {
    const src = [
      'export function a() {}',
      'export async function b() {}',
      'export function* gen() {}',
      'export const c = 1, d = 2;',
      'export class E {}',
      'export abstract class F {}',
      'export const enum G { X }',
      'export type H = string;',
      'export interface I {}',
      'const j = 1; const k = 2;',
      'export { j, k as kk };',
      "export { z } from './other';",
      'export default function main() {}',
    ].join('\n');
    expect(names(exportsOf(src))).toEqual(
      ['E', 'F', 'G', 'H', 'I', 'a', 'b', 'c', 'gen', 'j', 'kk'].sort(),
    );
  });

  it('ignores exports inside comments and strings', () => {
    const src = [
      '// export function a() {}',
      '/* export const b = 1 */',
      "const s = 'export const c = 1';",
    ].join('\n');
    expect(exportsOf(src)).toEqual([]);
  });

  it('records the declaration line verbatim', () => {
    const [decl] = exportsOf('\n\nexport const answer = 42;\n');
    expect(decl).toMatchObject({
      name: 'answer',
      line: 3,
      declaration: 'export const answer = 42;',
    });
  });
});

describe('importsOf', () => {
  it('reads named, default, aliased, type-only and multi-line imports', () => {
    const src = [
      "import def, { a, b as c } from './x.js';",
      "import type { T } from './t';",
      'import {',
      '  m,',
      '  type n,',
      "} from './m';",
    ].join('\n');
    const got = importsOf(src).map((i) => [
      i.specifier,
      i.taken === 'all' ? 'all' : [...i.taken].sort(),
    ]);
    expect(got).toEqual([
      ['./x.js', ['a', 'b', 'default']],
      ['./t', ['T']],
      ['./m', ['m', 'n']],
    ]);
  });

  it('treats namespace imports, star re-exports, require and import() as taking everything', () => {
    const src = [
      "import * as ns from './a';",
      "export * from './b';",
      "export * as c from './c';",
      "const d = require('./d');",
      "const e = await import('./e');",
    ].join('\n');
    expect(importsOf(src).map((i) => [i.specifier, i.taken])).toEqual([
      ['./a', 'all'],
      ['./b', 'all'],
      ['./c', 'all'],
      ['./d', 'all'],
      ['./e', 'all'],
    ]);
  });

  it('reads named re-exports as taking those names', () => {
    const [imp] = importsOf("export { a, b as c } from './x';");
    expect(imp?.specifier).toBe('./x');
    expect([...(imp?.taken as Set<string>)].sort()).toEqual(['a', 'b']);
  });
});

describe('resolveSpecifier', () => {
  const files = new Set(['src/a.ts', 'src/lib/index.ts', 'src/b.tsx', 'lib/c.js']);
  it('resolves NodeNext .js specifiers, bare extensions and index files', () => {
    expect(resolveSpecifier('src/x.ts', './a.js', files)).toBe('src/a.ts');
    expect(resolveSpecifier('src/x.ts', './b', files)).toBe('src/b.tsx');
    expect(resolveSpecifier('src/x.ts', './lib', files)).toBe('src/lib/index.ts');
    expect(resolveSpecifier('src/deep/x.ts', '../../lib/c.js', files)).toBe('lib/c.js');
  });
  it('never resolves package or alias specifiers', () => {
    expect(resolveSpecifier('src/x.ts', 'react', files)).toBeNull();
    expect(resolveSpecifier('src/x.ts', '@/a', files)).toBeNull();
  });
});

describe('maskSource', () => {
  it('keeps offsets and newlines', () => {
    const src = "const a = 'x\\'y'; // hi\n/* b\nc */ d";
    const masked = maskSource(src);
    expect(masked.length).toBe(src.length);
    expect(masked.split('\n').length).toBe(src.split('\n').length);
    expect(masked).not.toContain('hi');
    expect(masked).toContain(' d');
  });
});

describe('unusedExports', () => {
  const util = [
    'export function used() { return helper(); }',
    'export function helper() { return 1; }',
    'export function dead() { return 2; }',
  ].join('\n');

  it('reports an export of an imported module that no file takes or mentions', () => {
    const found = unusedExports([
      { path: 'src/util.ts', source: util },
      { path: 'src/app.ts', source: "import { used } from './util.js';\nused();" },
    ]);
    // `helper` is used inside util.ts: surface to trim, not dead — not reported.
    expect(found.map((f) => [f.name, f.line])).toEqual([['dead', 3]]);
    expect(found[0]).toMatchObject({
      ruleId: 'slop.unused_export',
      file: 'src/util.ts',
      declaration: 'export function dead() { return 2; }',
      importers: 1,
    });
  });

  it('stays silent on a module nothing imports — it may be an entry point', () => {
    expect(unusedExports([{ path: 'src/cli.ts', source: 'export function run() {}' }])).toEqual([]);
  });

  it('stays silent when any importer takes the whole module', () => {
    const found = unusedExports([
      { path: 'src/util.ts', source: util },
      { path: 'src/app.ts', source: "import * as u from './util';\nu.used();" },
    ]);
    expect(found).toEqual([]);
  });

  it('stays silent when another file mentions the name through an unresolved alias', () => {
    const found = unusedExports([
      { path: 'src/util.ts', source: util },
      { path: 'src/app.ts', source: "import { used } from './util';" },
      { path: 'src/other.ts', source: "import { dead, helper } from '@/util';" },
    ]);
    expect(found).toEqual([]);
  });

  it('counts a use inside a template expression in its own file', () => {
    const found = unusedExports([
      {
        path: 'src/docs.ts',
        source:
          'export function base() { return "/d"; }\nexport const url = 1;\nconst u = `${base()}/x`;',
      },
      { path: 'src/app.ts', source: "import { url } from './docs';" },
    ]);
    expect(found).toEqual([]);
  });

  it('stays silent when the name only appears in a string elsewhere', () => {
    const found = unusedExports([
      { path: 'src/util.ts', source: 'export const a = 1;\nexport const lookedUp = 2;' },
      { path: 'src/app.ts', source: "import { a } from './util';\nconst k = 'lookedUp';" },
    ]);
    expect(found).toEqual([]);
  });

  it('counts a name mentioned only in a comment elsewhere as unused', () => {
    const found = unusedExports([
      { path: 'src/util.ts', source: 'export const a = 1;\nexport const ghost = 2;' },
      { path: 'src/app.ts', source: "import { a } from './util';\n// TODO: use ghost" },
    ]);
    expect(names(found)).toEqual(['ghost']);
  });

  it('follows named re-exports through a barrel', () => {
    const found = unusedExports([
      { path: 'src/util.ts', source: util },
      { path: 'src/barrel.ts', source: "export { used, dead } from './util';" },
      { path: 'src/app.ts', source: "import { used } from './barrel';" },
    ]);
    // `dead` is passed through, so it is the barrel's business, and the barrel
    // re-export also spells the name — nothing is reported for util.ts.
    expect(found.filter((f) => f.file === 'src/util.ts')).toEqual([]);
  });

  it('never reports public surfaces, framework names or non-JS files', () => {
    const lib = 'export const a = 1;\nexport const b = 2;';
    const found = unusedExports([
      { path: 'src/index.ts', source: lib },
      { path: 'src/thing.test.ts', source: lib },
      { path: 'app/page.tsx', source: lib },
      { path: 'vite.config.ts', source: lib },
      { path: 'src/route.ts', source: 'export const GET = 1;\nexport const config = 2;' },
      { path: 'src/api.gen.ts', source: lib },
      { path: 'src/mod.py', source: 'def x(): pass' },
      {
        path: 'src/use.ts',
        source: [
          "import { a } from './index';",
          "import { a as a2 } from './thing.test';",
          "import { a as a3 } from '../app/page';",
          "import { a as a4 } from '../vite.config';",
          "import { GET as g } from './route';",
          "import { a as a5 } from './api.gen';",
        ].join('\n'),
      },
    ]);
    expect(found).toEqual([]);
  });

  it('is deterministic: sorted by file then line', () => {
    const files = [
      { path: 'src/z.ts', source: 'export const z1 = 1;\nexport const z2 = 2;' },
      { path: 'src/a.ts', source: 'export const a1 = 1;\nexport const a2 = 2;' },
      { path: 'src/use.ts', source: "import { z1 } from './z';\nimport { a1 } from './a';" },
    ];
    expect(unusedExports(files).map((f) => `${f.file}:${f.name}`)).toEqual([
      'src/a.ts:a2',
      'src/z.ts:z2',
    ]);
  });
});

describe('maskSource lexing', () => {
  it('does not let a quote in a regex literal or a nested template swallow the file', () => {
    const src = [
      "const q = (a) => `'${a.replace(/'/g, `'\\\\''`)}'`;",
      'export function after(values) { return values; }',
    ].join('\n');
    expect(exportsOf(src).map((e) => e.name)).toEqual(['after']);
  });

  it('keeps template expressions as code', () => {
    const masked = maskSource('const s = `x ${callMe()} y`;');
    expect(masked).toContain('callMe()');
    expect(masked).not.toContain(' x ');
  });

  it('treats division as division', () => {
    const src = "const r = a / b; const s = 'export const no = 1'; export const yes = c / 2;";
    expect(exportsOf(src).map((e) => e.name)).toEqual(['yes']);
  });
});
