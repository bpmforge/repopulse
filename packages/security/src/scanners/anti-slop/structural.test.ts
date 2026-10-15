import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { delegationWrappers } from './delegation-wrappers.js';
import { singleImplInterfaces } from './single-impl.js';
import { staleJsdocParams } from './stale-jsdoc.js';
import { functionAt, parseParams } from './signatures.js';
import { maskSource } from './source-graph.js';
import { loadChecklist } from '../owasp/checklist.js';
import { ANTI_SLOP_CHECKLIST_UP_TO } from './run.js';

// Structural slop the T2 checklist used to answer (W18-05): delegation-only
// wrappers, single-implementation interfaces, stale JSDoc parameters. The
// fixtures are two small repositories — every rule must fire on `triggering`
// and say NOTHING on `clean`, whose files are the near-misses found while
// measuring the rules on real code.

const FIXTURES = new URL('../../../fixtures/structural/', import.meta.url).pathname;

function readTree(root: string): { path: string; source: string }[] {
  const out: { path: string; source: string }[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir).sort()) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else out.push({ path: path.relative(root, full), source: readFileSync(full, 'utf8') });
    }
  };
  walk(root);
  return out;
}

const triggering = readTree(path.join(FIXTURES, 'triggering'));
const clean = readTree(path.join(FIXTURES, 'clean'));

describe('fixtures', () => {
  it('slop.delegation_wrapper fires on every forward in triggering', () => {
    expect(delegationWrappers(triggering).map((f) => [f.file, f.name, f.callee])).toEqual([
      ['src/legacy.js', 'fetchOrder', 'inner.fetchOrder'],
      ['src/wrappers.ts', 'getUser', 'loadUser'],
      ['src/wrappers.ts', 'parseConfig', 'JSON.parse'],
      ['src/wrappers.ts', 'formatAll', 'api.join'],
      ['src/wrappers.ts', 'stamp', 'formatDate'],
    ]);
  });

  it('slop.single_impl_interface fires on the interface and the abstract class', () => {
    const found = singleImplInterfaces(triggering, { complete: true });
    expect(found.map((f) => [f.name, f.kind, f.implementation.name, f.line])).toEqual([
      ['ClockSource', 'interface', 'SystemClock', 3],
      ['Exporter', 'abstract class', 'CsvExporter', 14],
    ]);
  });

  it('slop.stale_jsdoc_param fires on renamed, removed and nested heads', () => {
    expect(staleJsdocParams(triggering).map((f) => [f.file, f.name, f.stale, f.line])).toEqual([
      ['src/docs.js', 'alladdrs', ['request'], 2],
      ['src/docs.ts', 'loadOne', ['userId'], 5],
      ['src/docs.ts', 'take', ['source', 'limit'], 13],
      ['src/docs.ts', 'render', ['opts'], 22],
      ['src/docs.ts', 'clear', ['key'], 30],
    ]);
  });

  it('every rule is silent on the clean near-misses', () => {
    expect(delegationWrappers(clean)).toEqual([]);
    expect(singleImplInterfaces(clean, { complete: true })).toEqual([]);
    expect(staleJsdocParams(clean)).toEqual([]);
  });
});

describe('slop.delegation_wrapper', () => {
  const run = (source: string, extra: { path: string; source: string }[] = []) =>
    delegationWrappers([{ path: 'src/a.ts', source }, ...extra]).map((f) => f.name);

  it('reports the line, the callee and a quote of the declaration', () => {
    const [found] = delegationWrappers([
      {
        path: 'src/a.ts',
        source: "import { g } from './g';\n\nfunction f(a, b) {\n  return g(a, b);\n}\nf(1, 2);",
      },
    ]);
    expect(found).toMatchObject({
      ruleId: 'slop.delegation_wrapper',
      line: 3,
      callee: 'g',
      declaration: 'function f(a, b) {',
    });
  });

  it('reads arrow bodies to the end of the expression, with or without semicolons', () => {
    expect(run('const f = (a) => g(a)\nconst h = (b) => g(b)\n  .then(x)\nf(1); h(1);')).toEqual([
      'f',
    ]);
    expect(run('const f = (a) => g(a) || null;\nf(1);')).toEqual([]);
  });

  it('skips a wrapper used as a value anywhere in the repository', () => {
    const other = { path: 'src/b.ts', source: "import { f } from './a';\nlist.forEach(f);" };
    expect(run('export const f = (a) => g(a);', [other])).toEqual([]);
    // Imported and called is still a call.
    const caller = { path: 'src/b.ts', source: "import { f } from './a';\nf(1);" };
    expect(run('export const f = (a) => g(a);', [caller])).toEqual(['f']);
  });

  it('skips exported wrappers an entry file names or another file re-exports', () => {
    const entry = { path: 'src/index.ts', source: "export { f } from './a';" };
    expect(run('export function f(a) { return g(a); }', [entry])).toEqual([]);
    const barrel = { path: 'src/all.ts', source: "export * from './a';" };
    expect(run('export function f(a) { return g(a); }', [barrel])).toEqual([]);
    // Unexported, an entry naming the same word is irrelevant.
    expect(run('function f(a) { return g(a); }\nf(1);', [entry])).toEqual(['f']);
  });

  it('never reads tests, fixtures, routes, entry files or minified bundles', () => {
    const src = 'function f(a) { return g(a); }\nf(1);';
    for (const p of [
      'src/a.test.ts',
      'tests/a.ts',
      'fixtures/a.ts',
      'src/index.ts',
      'app/routes/a.ts',
      'vendor.min.js',
    ]) {
      expect(delegationWrappers([{ path: p, source: src }]), p).toEqual([]);
    }
    const minified = `function f(a) { return g(a); }\nf(1);\n${'x'.repeat(1200)}`;
    expect(delegationWrappers([{ path: 'src/a.js', source: minified }])).toEqual([]);
  });

  it('skips methods with modifiers that make them hooks, and decorated methods', () => {
    expect(run('class A {\n  protected m(a) { return g(a); }\n}\nnew A().m(1);')).toEqual([]);
    expect(run('class A {\n  @Get()\n  m(a) { return g(a); }\n}\nnew A().m(1);')).toEqual([]);
    expect(run('class A {\n  m(a) { return g(a); }\n}\nnew A().m(1);')).toEqual(['m']);
    expect(run('class A {\n  m(a) { return g(a); }\n}\nmodule.exports = { A };')).toEqual([]);
  });

  it('treats a CommonJS require as an import, not module state', () => {
    expect(run("const lib = require('lib');\nfunction f(a) { return lib.f(a); }\nf(1);")).toEqual([
      'f',
    ]);
    expect(run('const lib = make();\nfunction f(a) { return lib.f(a); }\nf(1);')).toEqual([]);
  });
});

describe('slop.single_impl_interface', () => {
  const two = (a: string, b: string) => [
    { path: 'src/i.ts', source: a },
    { path: 'src/c.ts', source: b },
  ];

  it('needs the whole tree: a partial read reports nothing', () => {
    expect(singleImplInterfaces(triggering, { complete: false })).toEqual([]);
  });

  it('counts implements and extends across files, and both lists for both kinds', () => {
    const files = two('export interface I { x(): void }', 'class A implements I { x() {} }');
    expect(singleImplInterfaces(files, { complete: true }).map((f) => f.name)).toEqual(['I']);
    const multi = two(
      'export interface I { x(): void }',
      'class A implements I { x() {} }\nclass B implements Other, I { x() {} }',
    );
    expect(singleImplInterfaces(multi, { complete: true })).toEqual([]);
  });

  it('counts an anonymous class expression and a generic heritage', () => {
    const files = two(
      'export abstract class Base<T> { abstract run(): T }',
      'export class A extends Base<string> { run() { return "" } }\nconst B = class extends Base<number> { run() { return 1 } };',
    );
    expect(singleImplInterfaces(files, { complete: true })).toEqual([]);
    const one = two('export interface I<T> { v: T }', 'class A implements ns.I<string> { v = "" }');
    expect(singleImplInterfaces(one, { complete: true }).map((f) => f.name)).toEqual(['I']);
  });

  it('treats casts, generic literals and returned literals as implementations', () => {
    for (const use of [
      'const x = {} as I;',
      'const x = <I>{};',
      'const x = make<I>({ x() {} });',
      'const x = (): I => ({ x() {} });',
      'const xs: I[] = [];',
    ]) {
      const files = two(
        'export interface I { x(): void }',
        `class A implements I { x() {} }\n${use}`,
      );
      expect(singleImplInterfaces(files, { complete: true }), use).toEqual([]);
    }
  });

  it('skips interfaces in .d.ts files and inside namespaces', () => {
    const dts = [
      { path: 'src/types.d.ts', source: 'export interface I { x(): void }' },
      { path: 'src/c.ts', source: 'class A implements I { x() {} }' },
    ];
    expect(singleImplInterfaces(dts, { complete: true })).toEqual([]);
    const ns = two(
      'namespace N { export interface I { x(): void } }',
      'class A implements I { x() {} }',
    );
    expect(singleImplInterfaces(ns, { complete: true })).toEqual([]);
  });
});

describe('slop.stale_jsdoc_param', () => {
  const run = (source: string) => staleJsdocParams([{ path: 'src/a.ts', source }]);

  it('quotes the first stale tag and lists the real parameters', () => {
    const [found] = run('/**\n * @param a ok\n * @param zz gone\n */\nfunction f(a, b) {}');
    expect(found).toMatchObject({
      line: 3,
      stale: ['zz'],
      params: ['a', 'b'],
      tag: '@param zz gone',
    });
  });

  it('reads arg/argument synonyms, wrapped types and `name - text`', () => {
    expect(run('/** @arg {Map<string, {a: number}>} m */\nfunction f(n) {}')).toHaveLength(1);
    expect(run('/** @argument x - the x */\nconst f = function (y) {};')).toHaveLength(1);
    expect(run('/**\n * @param {{\n *   a: number\n * }} n\n */\nfunction f(n) {}')).toEqual([]);
  });

  it('reads methods, getters excluded, and arrow class fields', () => {
    expect(run('class A {\n  /** @param x */\n  static async m(y) {}\n}')).toHaveLength(1);
    expect(run('class A {\n  /** @param x */\n  m = (y) => y;\n}')).toHaveLength(1);
    expect(run('class A {\n  /** @param v */\n  set value(v) {}\n}')).toEqual([]);
  });

  it('says nothing when the next thing is not a function it can read', () => {
    expect(run('/** @param x */\nconst f = memo((y) => y);')).toEqual([]);
    expect(run('/** @param x */\nclass A { constructor(y) {} }')).toEqual([]);
    expect(run('/** @param x */\nexport type F = (y: string) => void;')).toEqual([]);
    expect(run('/** @param */\nfunction f(y) {}')).toEqual([]);
  });

  it('skips files that are declarations or bundles', () => {
    const src = '/** @param x */\nfunction f(y) {}';
    expect(staleJsdocParams([{ path: 'src/a.d.ts', source: src }])).toEqual([]);
    expect(staleJsdocParams([{ path: 'src/a.min.js', source: src }])).toEqual([]);
    expect(staleJsdocParams([{ path: 'fixtures/a.ts', source: src }])).toEqual([]);
    // Tests are read: a stale doc on a helper misleads all the same.
    expect(staleJsdocParams([{ path: 'tests/a.ts', source: src }])).toHaveLength(1);
  });
});

describe('signatures', () => {
  it('splits parameters with nested types, defaults, modifiers and patterns', () => {
    const text = maskSource(
      '(public readonly a: Map<string, () => void>, b = f(1, 2), { c, d: e }: T, ...rest: X[], @Inj() g?: Y,)',
    );
    const parsed = parseParams(text, 0);
    expect(parsed?.params.map((p) => [p.name, p.rest, p.hasDefault, p.decorated])).toEqual([
      ['a', false, false, false],
      ['b', false, true, false],
      [null, false, false, false],
      ['rest', true, false, false],
      ['g', false, false, true],
    ]);
    expect(parsed?.params[2]?.patternNames).toEqual(['c', 'd', 'e']);
  });

  it('finds the body after an object-literal or function return type', () => {
    const a = maskSource('function f(a): { x: number } { return g(a); }');
    expect(functionAt(a, 0)?.body.kind).toBe('block');
    expect(a.slice(functionAt(a, 0)!.body.start, functionAt(a, 0)!.body.end + 1)).toBe(
      '{ return g(a); }',
    );
    const b = maskSource('function f(a): () => void { return g; }');
    expect(b.slice(functionAt(b, 0)!.body.start)).toBe('{ return g; }');
    const c = maskSource('function f(a: string): string;');
    expect(functionAt(c, 0)?.body.kind).toBe('none');
  });

  it('drops a `this` parameter and reads a typed variable holding an arrow', () => {
    const t = maskSource('const f: (a: string) => void = (this: Window, a) => g(a);');
    expect(functionAt(t, 0)?.params.map((p) => p.name)).toEqual(['a']);
    expect(functionAt(maskSource('let x: number;\nconst y = (a) => a;'), 0)).toBeNull();
  });
});

describe('anti-slop.v2 checklist', () => {
  it('narrows the two categories the rules settle to languages the rules do not read', () => {
    const v1 = loadChecklist('anti_slop', undefined, { upTo: 1 });
    const v2 = loadChecklist('anti_slop');
    expect(v1.version).toBe('anti-slop.v1');
    expect(v2.version).toBe('anti-slop.v2');
    expect(v1.prompt).toContain('- **Delegation-only wrapper** —');
    expect(v1.prompt).toContain('- **Single-implementation interface** —');
    expect(v2.prompt).not.toContain('- **Delegation-only wrapper** —');
    expect(v2.prompt).not.toContain('- **Single-implementation interface** —');
    expect(v2.prompt).toContain('Delegation-only wrapper (not JavaScript/TypeScript)');
    expect(v2.prompt).toContain('slop.single_impl_interface');
    expect(v2.prompt).toContain('slop.delegation_wrapper');
    // Every other category is carried over word for word.
    for (const kept of ['Single-use helper', 'Speculative generalization', 'Cargo-cult pattern']) {
      expect(v2.prompt).toContain(`- **${kept}**`);
    }
  });

  it('is not read yet: the scanner stays on v1 until W18-10 switches it', () => {
    // The rules that replace the categories run in shadow; the model keeps
    // answering for them until findings from the rules are visible.
    expect(ANTI_SLOP_CHECKLIST_UP_TO).toBe(1);
    expect(loadChecklist('anti_slop', undefined, { upTo: ANTI_SLOP_CHECKLIST_UP_TO }).version).toBe(
      'anti-slop.v1',
    );
  });
});
