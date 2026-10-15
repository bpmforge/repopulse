import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { exceptionFlows } from './exception-flow.js';
import { repositoriesOverCrud } from './repository-crud.js';

// Golden sets for the W18-09 in-process rules. Each triggering fixture marks
// the line a rule must report with a `// expect: <rule>` (or `# expect:`)
// comment on the line before it; the clean fixtures are near-misses that must
// stay silent. Exact match both ways: a finding one line off, a duplicate, or
// one nobody announced fails.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../../../fixtures/fast-lane');

/** The fixture tree as a snapshot would hand it over — outside a fixtures dir. */
function load(dir: string): { path: string; source: string }[] {
  return readdirSync(dir).map((name) => ({
    path: `src/${name}`,
    source: readFileSync(path.join(dir, name), 'utf8'),
  }));
}

function announced(files: { path: string; source: string }[]): string[] {
  const out: string[] = [];
  for (const file of files) {
    file.source.split('\n').forEach((line, index) => {
      const m = /(?:\/\/|#)\s*expect:\s*(slop\.\S+)/.exec(line);
      if (m) out.push(`${m[1]}:${file.path}:${index + 2}`);
    });
  }
  return out.sort();
}

function found(files: { path: string; source: string }[]): string[] {
  return [...exceptionFlows(files), ...repositoriesOverCrud(files)]
    .map((f) => `${f.ruleId}:${f.file}:${f.line}`)
    .sort();
}

describe('fast-lane golden sets (W18-09)', () => {
  it('fires exactly where the triggering fixtures say', () => {
    const files = load(path.join(FIXTURES, 'triggering'));
    const expected = announced(files);
    // Both rules, both languages, are exercised.
    for (const marker of [
      'slop.exception_control_flow:src/orders.ts',
      'slop.exception_control_flow:src/billing.py',
      'slop.repository_over_crud:src/user.repository.ts',
      'slop.repository_over_crud:src/repositories.py',
    ]) {
      expect(
        expected.some((e) => e.startsWith(marker)),
        marker,
      ).toBe(true);
    }
    expect(found(files)).toEqual(expected);
  });

  it('stays silent on the clean near-misses', () => {
    const files = load(path.join(FIXTURES, 'clean'));
    expect(announced(files)).toEqual([]);
    expect(found(files)).toEqual([]);
  });

  it('skips the fixtures themselves when a snapshot contains them', () => {
    // Scanning RepoPulse's own tree must not report its trigger cases.
    const files = load(path.join(FIXTURES, 'triggering')).map((f) => ({
      ...f,
      path: `packages/security/fixtures/fast-lane/triggering/${f.path.slice(4)}`,
    }));
    expect(found(files)).toEqual([]);
  });
});
