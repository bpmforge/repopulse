import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { commentedOutCode } from './commented-out-code.js';
import { deprecatedApis } from './deprecated-apis.js';
import { DEPRECATED_APIS, DEPRECATED_API_TABLE_VERSION } from './deprecated-apis.v1.js';
import { lex } from './leftovers-lex.js';
import { placeholderValues } from './placeholder-values.js';

// Leftover content (W18-07): placeholder values, commented-out code and
// deprecated APIs. `triggering` is a small repository where every rule must
// fire on exactly what is listed; `clean` holds the near-misses found while
// measuring the rules on real packages, and must produce nothing at all.

const FIXTURES = new URL('../../../fixtures/leftovers/', import.meta.url).pathname;

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
  it('slop.placeholder_value fires on every placeholder kind in triggering', () => {
    expect(placeholderValues(triggering).map((f) => [f.file, f.line, f.kind])).toEqual([
      ['app/settings.py', 10, 'your_placeholder'],
      ['app/settings.py', 11, 'example_endpoint'],
      ['app/settings.py', 12, 'weak_password'],
      ['app/settings.py', 13, 'replace_me'],
      ['src/client.ts', 9, 'your_placeholder'],
      ['src/client.ts', 10, 'angle_placeholder'],
      ['src/client.ts', 11, 'example_endpoint'],
      ['src/client.ts', 12, 'dummy_key'],
      ['src/client.ts', 13, 'replace_me'],
      ['src/client.ts', 16, 'weak_password'],
      ['src/client.ts', 18, 'lorem_ipsum'],
      ['src/client.ts', 27, 'example_endpoint'],
    ]);
  });

  it('slop.commented_out_code reports one finding per block, in JS/TS and Python', () => {
    expect(
      commentedOutCode(triggering).map((f) => [f.file, f.line, f.lineEnd, f.codeLines]),
    ).toEqual([
      ['app/settings.py', 15, 17, 3],
      ['src/client.ts', 21, 24, 4],
    ]);
  });

  it('slop.deprecated_api fires on every table entry exercised by triggering', () => {
    const found = deprecatedApis(triggering).map((f) => `${f.file}:${f.line} ${f.entry.id}`);
    expect(found.sort()).toEqual(
      [
        'app/settings.py:5 python.imp_module',
        'app/settings.py:7 python.distutils',
        'app/settings.py:8 python.pkg_resources',
        'app/settings.py:19 python.asyncio_get_event_loop',
        'app/settings.py:23 python.logging_warn',
        'app/settings.py:24 python.datetime_utcnow',
        'app/settings.py:28 python.collections_abc_alias',
        'cmd/main.go:10 go.ioutil',
        'src/client.ts:5 node.domain_module',
        'src/client.ts:6 npm.request',
        'src/client.ts:25 node.buffer_constructor',
        'src/client.ts:26 node.fs_exists',
        'src/client.ts:27 node.url_parse',
        'src/client.ts:28 node.crypto_create_cipher',
        'src/legacy.jsx:4 react.dom_render_import',
        'src/legacy.jsx:7 react.legacy_lifecycle',
        'src/legacy.jsx:8 react.find_dom_node',
        'src/legacy.jsx:11 react.legacy_lifecycle',
        'src/legacy.jsx:20 react.dom_render',
        'src/main/java/Legacy.java:4 java.boxing_constructor',
        'src/main/java/Legacy.java:8 java.thread_stop',
      ].sort(),
    );
  });

  it('every table entry is exercised by the triggering fixture', () => {
    const fired = new Set(deprecatedApis(triggering).map((f) => f.entry.id));
    expect(DEPRECATED_APIS.map((e) => e.id).filter((id) => !fired.has(id))).toEqual([]);
  });

  it('clean: no rule says anything about the near-misses', () => {
    expect(placeholderValues(clean)).toEqual([]);
    expect(commentedOutCode(clean)).toEqual([]);
    expect(deprecatedApis(clean)).toEqual([]);
  });
});

describe('slop.deprecated_api table', () => {
  it('is versioned, and every entry cites an official https source and a replacement', () => {
    expect(DEPRECATED_API_TABLE_VERSION).toBe('deprecated-apis.v1');
    const ids = DEPRECATED_APIS.map((e) => e.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of DEPRECATED_APIS) {
      expect(entry.source, entry.id).toMatch(
        /^https:\/\/(nodejs\.org|react\.dev|legacy\.reactjs\.org|docs\.python\.org|peps\.python\.org|setuptools\.pypa\.io|openjdk\.org|docs\.oracle\.com|pkg\.go\.dev|github\.com\/request)\//,
      );
      expect(entry.replacement.length, entry.id).toBeGreaterThan(3);
    }
  });

  it('reads the enclosing function across a multi-line signature', () => {
    const source = [
      'import asyncio',
      'class Protocol:',
      '    def __init__(',
      '        self,',
      '        loop=None,',
      '    ) -> None:',
      '        self.loop = loop or asyncio.get_event_loop()',
      'def main():',
      '    return asyncio.get_event_loop()',
    ].join('\n');
    expect(deprecatedApis([{ path: 'p.py', source }]).map((f) => f.line)).toEqual([9]);
  });

  it('a compatibility branch beside the replacement is deliberate', () => {
    const source = [
      'export const decode = (b64) =>',
      "  Buffer.from ? Buffer.from(b64, 'base64') : new Buffer(b64, 'base64');",
    ].join('\n');
    expect(deprecatedApis([{ path: 'a.js', source }])).toEqual([]);
  });

  it('skips vendored, compat and fixture paths', () => {
    const source = 'const b = new Buffer(4);';
    for (const p of ['vendor/x.js', 'lib/compat.js', 'fixtures/a.js', 'legacy/b.js', 'x.min.js']) {
      expect(deprecatedApis([{ path: p, source }]), p).toEqual([]);
    }
    expect(deprecatedApis([{ path: 'src/b.js', source }])).toHaveLength(1);
  });
});

describe('slop.placeholder_value', () => {
  const run = (source: string, file = 'src/a.ts') =>
    placeholderValues([{ path: file, source }]).map((f) => f.kind);

  it('reads values, not sentences', () => {
    expect(run("const k = 'YOUR_API_KEY';")).toEqual(['your_placeholder']);
    expect(run("throw new Error('Set YOUR_API_KEY first');")).toEqual([]);
    expect(run("const h = { Authorization: 'Bearer YOUR_TOKEN' };")).toEqual(['your_placeholder']);
  });

  it('lower-case your-… needs the whole value or a host, and is not a lookup key', () => {
    expect(run("const host = 'https://your-domain.com/api';")).toEqual(['your_placeholder']);
    expect(run("const v = form.get('your_email');")).toEqual([]);
    expect(run("const k = 'your-api-key';")).toEqual(['your_placeholder']);
  });

  it('x-filled values count only with a key prefix or a credential beside them', () => {
    expect(run("const token = 'xxxxxxxxxxxx';")).toEqual(['dummy_key']);
    expect(run("const mask = 'xxxxxxxxxxxx';")).toEqual([]);
    expect(run("call('ghp_xxxxxxxxxxxx');")).toEqual(['dummy_key']);
  });

  it('example.com is fine as a placeholder attribute, a schema id or a parse base', () => {
    expect(run('const el = <input placeholder="https://example.com" />;', 'src/a.tsx')).toEqual([]);
    expect(run("const s = { $id: 'https://example.com/s.json' };")).toEqual([]);
    expect(run("const p = new URL(rel, 'https://example.com').pathname;")).toEqual([]);
    expect(run("fetch('https://example.com/api/items');")).toEqual(['example_endpoint']);
  });

  it('a guessable password needs a password beside it and a digit or symbol', () => {
    expect(run("db.connect({ password: 'admin123' });")).toEqual(['weak_password']);
    expect(run("const PASSWORD = process.env.PW || 'P@ssw0rd';")).toEqual(['weak_password']);
    expect(run("const field = { password: 'password' };")).toEqual([]);
    expect(run("const user = { name: 'admin123' };")).toEqual([]);
  });

  it('skips tests, docs, examples, stories, templates and Python demo blocks', () => {
    const value = "export const k = 'YOUR_API_KEY';";
    for (const p of [
      'tests/a.ts',
      'src/__tests__/a.ts',
      'src/a.test.ts',
      'test-types/a.ts',
      'docs/a.ts',
      'examples/a.ts',
      'src/a.stories.tsx',
      'templates/a.ts',
      'config.example.ts',
      'app/test_settings.py',
    ]) {
      expect(run(value, p), p).toEqual([]);
    }
    expect(run('API = "x"\nif __name__ == "__main__":\n    print("YOUR_API_KEY")', 'a.py')).toEqual(
      [],
    );
  });

  it('ignores docstrings and comments', () => {
    expect(
      run('def f():\n    """Call https://api.example.com with YOUR_API_KEY."""\n', 'a.py'),
    ).toEqual([]);
    expect(run("// const k = 'YOUR_API_KEY';\nconst a = 1;")).toEqual([]);
  });
});

describe('slop.commented_out_code', () => {
  const run = (source: string, file = 'src/a.ts') => commentedOutCode([{ path: file, source }]);

  it('needs three code lines, two of them statements', () => {
    expect(run('// foo();\n// bar();\nconst a = 1;')).toEqual([]);
    expect(run('// }\n// )\n// foo();\nconst a = 1;')).toEqual([]);
    expect(run('// foo();\n// bar();\n// baz();\nconst a = 1;')).toHaveLength(1);
  });

  it('prose with code punctuation is not code', () => {
    const source = [
      '// The value is cached (see above) so the second call is cheap.',
      '// Callers should not rely on the order of keys.',
      '// If the cache is empty, we fetch.',
    ].join('\n');
    expect(run(source)).toEqual([]);
  });

  it('reads a /* */ block that disables code, but never a /** */ doc block', () => {
    const body = ['const a = load();', 'if (a) {', '  save(a);', '}'];
    expect(run(['/*', ...body, '*/'].join('\n'))).toHaveLength(1);
    expect(run(['/**', ...body.map((l) => ` * ${l}`), ' */'].join('\n'))).toEqual([]);
  });

  it('handles Python', () => {
    const source = [
      '# for row in rows:',
      '#     total += row.amount',
      '# print(total)',
      'x = 1',
    ].join('\n');
    expect(run(source, 'a.py').map((f) => [f.line, f.lineEnd])).toEqual([[1, 3]]);
  });

  it('does not backtrack catastrophically on a commented-out regular expression', () => {
    const regex = `// const re = /^(${'(\\\\x22)|'.repeat(40)}[a-z])+$/;`;
    const started = Date.now();
    run([regex, regex, regex, 'const a = 1;'].join('\n'));
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

describe('leftovers lexer', () => {
  it('tells comments, strings and code apart in Python', () => {
    const lexed = lex('a.py', 'x = "a # b"  # real comment\ns = """doc\n# not a comment\n"""')!;
    expect(lexed.comments.map((c) => [c.line, c.text, c.whole])).toEqual([
      [1, 'real comment', false],
    ]);
    expect(lexed.strings.map((s) => s.value)).toEqual(['a # b', 'doc\n# not a comment\n']);
  });

  it('reads a minified single-line bundle in linear time', () => {
    const line = Array.from({ length: 40_000 }, (_, i) => `a${i}='v${i}'`).join(';');
    const started = Date.now();
    const lexed = lex('bundle.js', line)!;
    expect(lexed.strings).toHaveLength(40_000);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
