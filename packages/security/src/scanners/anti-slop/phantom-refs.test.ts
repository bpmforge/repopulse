import { describe, expect, it } from 'vitest';
import { phantomRefs } from './phantom-refs.js';
import { resolveSpecifier } from './source-graph.js';

// Phantom references (W18-02). The rule is only worth shipping if it is quiet
// on code that works, so most of these are cases that must NOT fire.

const run = (files: { path: string; source: string }[], complete = true) =>
  phantomRefs(files, { complete });

describe('phantom symbols', () => {
  it('reports a named import the target module does not export, one finding per statement', () => {
    const found = run([
      { path: 'src/utils.ts', source: 'export function formatDate() {}' },
      {
        path: 'src/app.ts',
        source: "import {\n  formatDate,\n  formatCurrency,\n  parseMoney,\n} from './utils.js';",
      },
    ]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      ruleId: 'slop.phantom_symbol',
      file: 'src/app.ts',
      line: 1,
      name: 'formatCurrency, parseMoney',
      statement: "import { formatDate, formatCurrency, parseMoney, } from './utils.js'",
    });
  });

  it('reports a default import from a module with no default export', () => {
    const found = run([
      { path: 'src/a.ts', source: 'export const x = 1;' },
      { path: 'src/b.ts', source: "import a from './a';" },
    ]);
    expect(found.map((f) => f.name)).toEqual(['default']);
  });

  it('follows re-exports, export *, export * as, and `as default`', () => {
    const found = run([
      { path: 'src/inner.ts', source: 'export const deep = 1;' },
      { path: 'src/mid.ts', source: "export * from './inner';\nexport const own = 2;" },
      {
        path: 'src/barrel.ts',
        source: [
          "export * from './mid';",
          "export { deep as renamed } from './inner';",
          "export * as ns from './inner';",
          'const d = 1;',
          'export { d as default };',
        ].join('\n'),
      },
      { path: 'src/use.ts', source: "import def, { deep, own, renamed, ns } from './barrel';" },
    ]);
    expect(found).toEqual([]);
  });

  it('stays silent when the target surface cannot be read', () => {
    const found = run([
      { path: 'src/cjs.js', source: 'module.exports = { a: 1 };' },
      { path: 'src/eq.ts', source: 'export = foo;' },
      { path: 'src/destr.ts', source: 'export const { a, b } = obj;' },
      { path: 'src/script.ts', source: 'console.log(1);' },
      { path: 'src/types.d.ts', source: 'type Hidden = string;\nexport {};' },
      { path: 'src/star.ts', source: "export * from 'some-package';" },
      {
        path: 'src/use.ts',
        source: [
          "import { a } from './cjs';",
          "import { b } from './eq';",
          "import { c } from './destr';",
          "import { d } from './script';",
          "import type { Hidden } from './types';",
          "import { e } from './star';",
        ].join('\n'),
      },
    ]);
    expect(found).toEqual([]);
  });

  it('ignores namespace imports and package specifiers', () => {
    const found = run([
      { path: 'src/a.ts', source: 'export const x = 1;' },
      { path: 'src/b.ts', source: "import * as a from './a';\nimport { nope } from 'react';" },
    ]);
    expect(found).toEqual([]);
  });
});

describe('phantom modules', () => {
  it('reports a static relative import of a file that does not exist', () => {
    const found = run([{ path: 'src/a.ts', source: "import { x } from './helpers/format';" }]);
    expect(found).toMatchObject([
      { ruleId: 'slop.phantom_module', specifier: './helpers/format', name: null, line: 1 },
    ]);
  });

  it('is off when the snapshot read was incomplete', () => {
    expect(run([{ path: 'src/a.ts', source: "import { x } from './gone';" }], false)).toEqual([]);
  });

  it('never fires on assets, queries, directories, dynamic loads, tests, fixtures or paths above the root', () => {
    const found = run([
      { path: 'src/lib/index-helper.ts', source: 'export const y = 1;' },
      {
        path: 'src/a.ts',
        source: [
          "import './styles.css';",
          "import data from './data.json';",
          "import raw from './script?raw';",
          "import { y } from './lib/';",
          "import pkg from '..';",
          "const opt = require('./optional-native.cjs');",
          "const lazy = await import('./maybe');",
          "import { z } from '../../../outside';",
          "import { b } from '../build/generated';",
        ].join('\n'),
      },
      { path: 'src/a.test.ts', source: "import { gen } from './generated-at-test-time';" },
      { path: 'fixtures/broken.js', source: "import { x } from './never-written';" },
    ]);
    expect(found).toEqual([]);
  });
});

describe('resolveSpecifier, TypeScript order', () => {
  it('prefers x.ts over x.js for a .js specifier, and strips bundler queries', () => {
    const files = new Set(['src/x.js', 'src/x.ts', 'src/y.d.ts', 'src/y.js', 'src/z.ts']);
    expect(resolveSpecifier('src/a.ts', './x.js', files)).toBe('src/x.ts');
    expect(resolveSpecifier('src/a.ts', './y.js', files)).toBe('src/y.d.ts');
    expect(resolveSpecifier('src/a.ts', './z?raw', files)).toBe('src/z.ts');
  });
});
