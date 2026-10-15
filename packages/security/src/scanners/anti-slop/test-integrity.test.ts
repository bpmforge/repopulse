import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { testIntegrity } from './test-integrity.js';
import { maskPython } from './source-graph.js';

// Test integrity (W18-03). Most of these are cases that must NOT fire: the
// rules accuse a test of checking nothing, and one wrong accusation about a
// test someone trusts costs more than the four right ones earn.

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../../fixtures/test-integrity',
);

/** A fixture tree under the names a runner would see (`x.case.ts` → `x.test.ts`). */
function readTree(dir: string): { path: string; source: string }[] {
  const out: { path: string; source: string }[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d)) {
      const full = path.join(d, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (/\.(ts|py)$/.test(entry)) {
        out.push({
          path: path
            .relative(dir, full)
            .replace(/\.case\.ts$/, '.test.ts')
            .replace(/(^|\/)case_/, '$1test_'),
          source: readFileSync(full, 'utf8'),
        });
      }
    }
  };
  walk(dir);
  return out;
}

const js = (source: string, file = 'src/cart.test.ts') => testIntegrity([{ path: file, source }]);
const py = (source: string, file = 'tests/test_cart.py') => testIntegrity([{ path: file, source }]);
const rules = (found: { ruleId: string }[]) => found.map((f) => f.ruleId);

describe('fixtures', () => {
  for (const rule of ['no_assertion', 'tautology', 'swallowed_failure', 'mocks_subject']) {
    it(`every triggering ${rule} fixture fires test.${rule}, and nothing else`, () => {
      const files = readTree(path.join(FIXTURES, 'triggering', rule));
      const tests = files.filter((f) => /\.test\.ts$|(^|\/)test_[^/]*\.py$/.test(f.path));
      expect(tests.length).toBeGreaterThanOrEqual(2); // one JS/TS, one Python
      const found = testIntegrity(files);
      for (const t of tests) {
        expect(found.filter((f) => f.file === t.path).length, t.path).toBeGreaterThan(0);
      }
      expect(new Set(rules(found))).toEqual(new Set([`test.${rule}`]));
    });
  }

  it('the clean tree, near misses included, produces nothing', () => {
    expect(testIntegrity(readTree(path.join(FIXTURES, 'clean')))).toEqual([]);
  });

  it('never reads a fixtures directory in a scanned repository', () => {
    const tree = readTree(path.join(FIXTURES, 'triggering', 'no_assertion')).map((f) => ({
      ...f,
      path: `packages/x/fixtures/${f.path}`,
    }));
    expect(testIntegrity(tree)).toEqual([]);
  });
});

describe('test.no_assertion', () => {
  it('reports each JS/TS test with no assertion, with its title, line and head as evidence', () => {
    const found = js(
      [
        "import { it } from 'vitest';",
        "it('adds', () => { add(1, 2); });",
        "it('checks', () => { expect(add(1, 2)).toBe(3); });",
        "it.concurrent.each([1, 2])('each %s', async (n) => {",
        '  add(n, n);',
        '});',
      ].join('\n'),
    );
    expect(found.map((f) => [f.ruleId, f.line, f.title])).toEqual([
      ['test.no_assertion', 2, 'Test with no assertion: adds'],
      ['test.no_assertion', 4, 'Test with no assertion: each %s'],
    ]);
    expect(found[0]?.evidence).toBe("it('adds', () => { add(1, 2); });");
  });

  it('follows helpers transitively, across test-support files, and by reference', () => {
    const files = [
      {
        path: 'test/helpers/assertions.ts',
        source: 'export function responseIsOk(r) { expect(r.ok).toBe(true); }',
      },
      {
        path: 'src/api.test.ts',
        source: [
          'const fetchAndCheck = async (url) => responseIsOk(await get(url));',
          'function run() { return fetchAndCheck("/a"); }',
          "it('works through two helpers', async () => { await run(); });",
          "it('passes the helper itself', run);",
        ].join('\n'),
      },
    ];
    expect(testIntegrity(files)).toEqual([]);
    // Without the support file the chain ends in nothing that asserts.
    expect(rules(testIntegrity(files.slice(1)))).toEqual([
      'test.no_assertion',
      'test.no_assertion',
    ]);
  });

  it('does not count production code that throws as a helper', () => {
    const found = testIntegrity([
      {
        path: 'src/money.ts',
        source: 'export function check(n) { if (n < 0) throw new Error(); }',
      },
      { path: 'src/money.test.ts', source: "it('formats', () => { format(1); });" },
    ]);
    expect(rules(found)).toEqual(['test.no_assertion']);
  });

  it('skips todo, skip, describe and other non-test calls', () => {
    expect(
      js(
        [
          "it.todo('later');",
          "it.skip('off', () => { run(); });",
          "test.describe('group', () => {});",
          "test.step('a step', async () => { run(); });",
          'test.extend({ page: async ({}, use) => { await use(1); } });',
          "const ok = /x/.test('x');",
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('a file defining its own `test` function is not calling a runner', () => {
    expect(js("function test(name, fn) { fn(); }\ntest('x', () => { run(); });")).toEqual([]);
  });

  it('honours a smoke title, a smoke comment, and an asserting hook', () => {
    expect(
      js(
        [
          "it('does not throw on empty input', () => { run([]); });",
          "it('renders without crashing', () => { render(); });",
          "it('handles nulls', () => {\n  // should not throw\n  run(null);\n});",
          "it('smoke', () => { run(); });",
        ].join('\n'),
      ),
    ).toEqual([]);
    expect(
      js("beforeEach(() => { expect.hasAssertions(); });\nit('runs', () => { run(); });"),
    ).toEqual([]);
  });

  it('reports Python test functions and methods, not helpers, nested defs or skipped tests', () => {
    const found = py(
      [
        'import pytest',
        '',
        'def test_runs():',
        '    run(1)',
        '',
        'def helper():',
        '    run(2)',
        '',
        '@pytest.mark.skipif(',
        '    True,',
        '    reason="no",',
        ')',
        'def test_skipped():',
        '    run(3)',
        '',
        'def test_outer():',
        '    def test_inner():',
        '        run(4)',
        '    assert test_inner() is None',
        '',
        'class TestThing:',
        '    def test_method(self):',
        '        """Docstring with a closing quote at column 0',
        '"""',
        '        run(5)',
        '',
        'class Plain:',
        '    def test_not_collected(self):',
        '        run(6)',
      ].join('\n'),
    );
    expect(found.map((f) => [f.line, f.title])).toEqual([
      [3, 'Test with no assertion: test_runs'],
      [22, 'Test with no assertion: test_method'],
    ]);
  });

  it('treats an inherited self-method it cannot see as possibly asserting', () => {
    const source = [
      'import unittest',
      'class FooTest(unittest.TestCase):',
      '    def test_a(self):',
      '        self.check_all(1)',
      '    def test_b(self):',
      '        self.setUp()',
    ].join('\n');
    expect(py(source).map((f) => f.title)).toEqual(['Test with no assertion: test_b']);
  });
});

describe('test.tautology', () => {
  it('reports self-comparison of a bare name, literal-vs-same-literal, and always-true literals', () => {
    const found = js(
      [
        'const x = make();',
        'expect(x).toBe(x);',
        "expect('a').toStrictEqual('a');",
        'expect(true).toBeTruthy();',
        'expect(undefined).toBeUndefined();',
        'assert.deepEqual(x, x);',
        't.true(true);',
      ].join('\n'),
    );
    expect(found.map((f) => f.line)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(found[0]?.message).toMatch(/x is compared with itself/);
  });

  it('leaves alone: calls, getters, negation, and different literals', () => {
    expect(
      js(
        [
          'expect(make()).toBe(make());',
          'expect(o.cached).toBe(o.cached);',
          'expect(x).not.toBe(x);',
          "expect('a b').toBe('ab');",
          'expect(0).toBeTruthy();',
          'expect(res).expect(200);',
          "it('x', () => { expect(a).toBe(b); });",
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('Python: literals, `is` on a bare name, a parenthesised tuple; not `==` on a name', () => {
    const found = py(
      [
        'def test_a():',
        '    assert True',
        '    assert 1 == 1',
        '    assert x is x',
        '    assert (x == 1, "msg")',
        '    assert x == x',
        '    assert 0 not in cat',
        '    assert obj.flags is obj.flags',
        '    assert "a b" == "ab"',
        '    self.assertTrue(1)',
        '    self.assertEqual(x, x)',
      ].join('\n'),
    );
    expect(found.map((f) => f.line)).toEqual([2, 3, 4, 5, 10]);
  });
});

describe('test.swallowed_failure', () => {
  it('JS: an assertion in a try whose catch is empty or only logs', () => {
    const found = js(
      [
        "it('a', () => {",
        '  try { expect(a).toBe(1); } catch {}',
        '  try { expect(b).toBe(1); } catch (e) { console.warn(e); logger.error({ e }); }',
        '  try { expect(c).toBe(1); } catch (e) { throw e; }',
        '  try { run(); } catch {}',
        '});',
      ].join('\n'),
    );
    expect(found.map((f) => [f.ruleId, f.line])).toEqual([
      ['test.swallowed_failure', 2],
      ['test.swallowed_failure', 3],
    ]);
    expect(found[0]?.evidence).toBe('} catch {}');
  });

  it('Python: only a handler that can catch AssertionError, and not the must-fail idiom', () => {
    const found = py(
      [
        'def test_a():',
        '    try:',
        '        assert a == 1',
        '    except AssertionError:',
        '        pass',
        '    try:',
        '        assert b == 1',
        '    except ValueError:',
        '        pass',
        '    try:',
        '        assert c == 1',
        '        pytest.fail("accepted")',
        '    except AssertionError:',
        '        pass',
        '    try:',
        '        assert d == 1',
        '    except AssertionError:',
        '        pass',
        '    else:',
        '        raise RuntimeError("no")',
      ].join('\n'),
    );
    expect(found.map((f) => [f.ruleId, f.line, f.evidence])).toEqual([
      ['test.swallowed_failure', 4, 'except AssertionError: pass'],
    ]);
  });
});

describe('test.mocks_subject', () => {
  const subject = { path: 'src/pricing.ts', source: 'export const priceFor = (s) => s.length;' };

  it('reports a wholesale vi.mock / jest.mock of the module the test is named for, when the test calls it', () => {
    for (const mocker of ['vi', 'jest']) {
      const found = testIntegrity([
        subject,
        {
          path: 'src/pricing.test.ts',
          source: `import { priceFor } from './pricing';\n${mocker}.mock('./pricing', () => ({ priceFor: () => 3 }));\nit('x', () => { expect(priceFor('a')).toBe(3); });`,
        },
      ]);
      expect(found.map((f) => [f.ruleId, f.line])).toEqual([['test.mocks_subject', 2]]);
    }
  });

  it('matches through __tests__/ and index files', () => {
    const found = testIntegrity([
      { path: 'src/pricing/index.ts', source: 'export const priceFor = 1;' },
      {
        path: 'src/__tests__/pricing.ts',
        source:
          "import { priceFor } from '../pricing';\nvi.mock('../pricing');\nit('x', () => { expect(priceFor()).toBe(1); });",
      },
    ]);
    expect(rules(found)).toEqual(['test.mocks_subject']);
  });

  it('stays silent for: partial mocks, spies, mocks only configured, and a second production import', () => {
    const cases = [
      "import { priceFor } from './pricing';\nvi.mock('./pricing', async (importOriginal) => ({ ...(await importOriginal()) }));\nit('x', () => { expect(priceFor('a')).toBe(1); });",
      "import { priceFor } from './pricing';\nvi.mock('./pricing', { spy: true });\nit('x', () => { expect(priceFor('a')).toBe(1); });",
      "import { priceFor } from './pricing';\nvi.mock('./pricing');\nit('x', () => { vi.mocked(priceFor).mockReturnValue(1); expect(priceFor).not.toHaveBeenCalled(); });",
      "import { priceFor } from './pricing';\nimport { checkout } from './checkout';\nvi.mock('./pricing');\nit('x', () => { priceFor('a'); expect(checkout()).toBe(1); });",
      "import { rateFor } from './rates';\nvi.mock('./rates');\nit('x', () => { expect(rateFor()).toBe(1); });",
    ];
    for (const source of cases) {
      expect(testIntegrity([subject, { path: 'src/pricing.test.ts', source }]), source).toEqual([]);
    }
  });

  it('Python: patching an attribute of the subject that the test then calls through the module', () => {
    const found = py(
      [
        'from unittest import mock',
        'import shop.billing as billing',
        '',
        '@mock.patch("shop.billing.charge")',
        'def test_charge(m):',
        '    assert billing.charge(1) == m.return_value',
        '',
        '@mock.patch("shop.billing.requests")',
        'def test_dependency(m):',
        '    billing.pay(1)',
        '    m.post.assert_called_once()',
        '',
        '@mock.patch("shop.billing.charge", wraps=billing.charge)',
        'def test_spy(m):',
        '    assert billing.charge(1) == 1',
        '',
        'def test_patch_dict():',
        '    with mock.patch.dict(sys.modules, {"shop.billing": mock.MagicMock()}):',
        '        assert billing',
      ].join('\n'),
      'tests/test_billing.py',
    );
    expect(found.map((f) => [f.ruleId, f.line])).toEqual([
      ['test.mocks_subject', 4],
      ['test.mocks_subject', 18],
    ]);
  });

  it('HTTP `client.patch(...)` is not a mock', () => {
    expect(
      py(
        'def test_update(client):\n    client.patch("billing.charge")\n    assert True is not None',
        'tests/test_billing.py',
      ),
    ).toEqual([]);
  });
});

describe('maskPython', () => {
  it('blanks comments and string contents, keeping offsets and newlines', () => {
    const src = 'x = "a#b"  # note\ny = """q\n\'z\'"""\n';
    const masked = maskPython(src);
    expect(masked.length).toBe(src.length);
    expect(masked).toBe('x = "   "        \ny = """ \n   """\n');
    expect(maskPython(src, true)).toBe('x = "   "        \ny =     \n      \n');
  });
});
