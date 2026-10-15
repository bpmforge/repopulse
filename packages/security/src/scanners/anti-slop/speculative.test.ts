import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  ORPHAN_FLAG_RULE_ID,
  SPECULATIVE_PARAM_RULE_ID,
  speculativeGenerality,
} from './speculative.js';

// W18-08. Speculative parameters and orphan flags are only claimed where the
// snapshot shows every reader; the clean fixture is the list of places it
// does not (exports, callbacks, strings, spreads, computed defaults).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../../../fixtures/fast-lane');
const fixture = (kind: 'triggering' | 'clean', name: string) =>
  readFileSync(path.join(FIXTURES, kind, name), 'utf8');

describe('slop.speculative_param', () => {
  it('fires on each defaulted parameter no caller passes', () => {
    const found = speculativeGenerality([
      { path: 'src/report.ts', source: fixture('triggering', 'speculative.ts') },
    ]).filter((f) => f.ruleId === SPECULATIVE_PARAM_RULE_ID);
    expect(found.map((f) => [f.line, f.name])).toEqual([
      [5, 'sendReport(retries)'],
      [10, 'formatName(options object)'],
      [10, 'formatName(separator)'],
    ]);
    expect(found[0]?.message).toContain('none of its 2 calls');
  });

  it('stays silent on every near-miss in the clean fixture', () => {
    const found = speculativeGenerality([
      { path: 'src/clean.ts', source: fixture('clean', 'speculative.ts') },
    ]);
    expect(found).toEqual([]);
  });

  it('a call in another statement form still counts: spread result, await, nested', () => {
    const src = [
      'function opts(a, b = 1) { return { a, b }; }',
      'async function go() {',
      '  const x = { ...opts(1) };',
      '  return [await Promise.resolve(opts(2, 3)), x];',
      '}',
      'go();',
    ].join('\n');
    expect(speculativeGenerality([{ path: 'src/o.ts', source: src }])).toEqual([]);
  });
});

describe('slop.orphan_flag', () => {
  it('fires on hard-coded flags read in exactly one place', () => {
    const found = speculativeGenerality([
      { path: 'src/flags.ts', source: fixture('triggering', 'speculative.ts') },
    ]).filter((f) => f.ruleId === ORPHAN_FLAG_RULE_ID);
    expect(found.map((f) => [f.line, f.name])).toEqual([
      [20, 'ENABLE_NEW_CHECKOUT'],
      [23, 'BETA_EXPORT_ENABLED'],
    ]);
    expect(found[1]?.message).toContain('hard-coded to false');
  });

  it('counts reads across the whole snapshot, tests included', () => {
    const flag = { path: 'src/flags.ts', source: 'export const USE_FAST_PATH = true;' };
    const reader = { path: 'src/a.ts', source: 'if (USE_FAST_PATH) go();' };
    expect(speculativeGenerality([flag, reader]).map((f) => f.name)).toEqual(['USE_FAST_PATH']);
    // A second reader — even a test pinning the flag — makes it a real switch.
    const test = { path: 'src/a.test.ts', source: 'expect(USE_FAST_PATH).toBe(true);' };
    expect(speculativeGenerality([flag, reader, test])).toEqual([]);
  });

  it('stays silent on the clean fixture', () => {
    expect(
      speculativeGenerality([{ path: 'src/clean.ts', source: fixture('clean', 'speculative.ts') }]),
    ).toEqual([]);
  });
});
