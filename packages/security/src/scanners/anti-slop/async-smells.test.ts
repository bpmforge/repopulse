import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  asyncSmells,
  serialIndependentAwaits,
  SERIAL_AWAITS_RULE_ID,
  unboundedRetries,
  UNBOUNDED_RETRY_RULE_ID,
} from './async-smells.js';

// W18-08. The clean fixtures hold every false-positive class the corpus run
// turned up (stream reads, query runners, poll loops, event re-emits), so a
// change that brings one back fails here rather than in someone's findings.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../../../fixtures/fast-lane');
const fixture = (kind: 'triggering' | 'clean', name: string) =>
  readFileSync(path.join(FIXTURES, kind, name), 'utf8');

describe('perf.serial_independent_awaits', () => {
  it('fires on each run of independent awaited reads in the triggering fixture', () => {
    const found = serialIndependentAwaits(
      'src/pages.ts',
      fixture('triggering', 'serial-awaits.ts'),
    );
    expect(found.map((f) => [f.ruleId, f.line, f.lineEnd])).toEqual([
      [SERIAL_AWAITS_RULE_ID, 5, 7],
      [SERIAL_AWAITS_RULE_ID, 14, 16],
      [SERIAL_AWAITS_RULE_ID, 24, 25],
    ]);
    expect(found[0]?.evidence.split('\n')).toHaveLength(3);
    expect(found[2]?.evidence).toBe(
      'const orgs = await api.getOrgs(user.orgIds);\nconst teams = await api.listTeams(id);',
    );
  });

  it('stays silent on every near-miss in the clean fixture', () => {
    expect(serialIndependentAwaits('src/clean.ts', fixture('clean', 'serial-awaits.ts'))).toEqual(
      [],
    );
  });

  it('reads a multi-line initializer as one statement', () => {
    const src = [
      'async function f(api) {',
      '  const a = await api.getA({',
      '    id: 1,',
      '  });',
      '  const b = await api.getB()',
      '    .then((r) => r.items);',
      '}',
    ].join('\n');
    expect(serialIndependentAwaits('f.ts', src).map((f) => [f.line, f.lineEnd])).toEqual([[2, 5]]);
  });
});

describe('slop.unbounded_retry', () => {
  it('fires on each unbounded retry in the triggering fixture', () => {
    const found = unboundedRetries('src/net.ts', fixture('triggering', 'unbounded-retry.ts'));
    expect(found.map((f) => [f.ruleId, f.line])).toEqual([
      [UNBOUNDED_RETRY_RULE_ID, 5],
      [UNBOUNDED_RETRY_RULE_ID, 17],
      [UNBOUNDED_RETRY_RULE_ID, 29],
      [UNBOUNDED_RETRY_RULE_ID, 40],
    ]);
    expect(found[3]?.message).toContain('fetchToken calls itself again');
  });

  it('stays silent on every bounded retry and non-retry loop in the clean fixture', () => {
    expect(unboundedRetries('src/clean.ts', fixture('clean', 'unbounded-retry.ts'))).toEqual([]);
  });

  it('treats any backoff-named await as a bound (the shared definition)', () => {
    for (const pause of ['sleep(100)', 'delay(100)', 'this.backoff.wait()', 'setTimeout(r, 10)']) {
      const src = `async function f() { while (true) { try { return await g(); } catch { await ${pause}; } } }`;
      expect(unboundedRetries('f.ts', src)).toEqual([]);
    }
  });
});

describe('fast-lane scope', () => {
  it('skips tests, fixtures, declarations and generated bundles', () => {
    const source = fixture('triggering', 'unbounded-retry.ts');
    const longLine = `${'x'.repeat(1200)}\n${source}`;
    expect(
      asyncSmells([
        { path: 'src/net.test.ts', source },
        { path: 'fixtures/net.ts', source },
        { path: 'src/net.d.ts', source },
        { path: 'src/bundle.js', source: longLine },
        { path: 'src/out.js', source: `// src/net.ts\n${source}` },
        { path: 'README.md', source },
      ]),
    ).toEqual([]);
    expect(asyncSmells([{ path: 'src/net.ts', source }])).toHaveLength(4);
  });
});
