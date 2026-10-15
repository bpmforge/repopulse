import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { findYamlTool, runYamlPacks, yamlPacks } from './engines.js';

// Trigger and clean fixtures for the rule changes that came out of the
// W18-17 benchmark: SQL built before the call, `"..." + x + "..."` chains,
// exec through a promisified alias, the base36-and-cut Math.random token, and
// the retry/backoff exemption for await-in-loop and try-catch-in-loop.
//
// It runs the local engine through the benchmark's own wrapper, so it checks
// exactly what `bench` measures: every pack file, one invocation, the tree
// copied out as a repository root. The scan-image golden sets
// (semgrep.test.ts, perf-pack.test.ts) need podman and are skipped on most
// machines; this one needs only a semgrep or opengrep on PATH.

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../../fixtures/rule-gaps');

const tool = findYamlTool();
const describeIfEngine = tool ? describe : describe.skip;

function scan(tree: 'triggering' | 'clean'): string[] {
  if (!tool) throw new Error('unreachable: describe is skipped without an engine');
  const run = runYamlPacks(
    tool,
    [{ suite: 'rule-gaps', id: tree, dir: path.join(FIXTURES, tree) }],
    yamlPacks(),
  );
  expect(run.errors).toEqual([]);
  return run.findings.map((f) => `${f.ruleId} ${f.file}:${f.lineStart}`).sort();
}

describeIfEngine('W18-17 rule gaps: trigger and clean fixtures', () => {
  it('fires on every triggering shape, at the line a reader would fix', () => {
    expect(scan('triggering')).toEqual(
      [
        // Promisified exec, CommonJS destructuring and the module object, then ESM.
        'bpm-js-child-process-concat exec.js:11',
        'bpm-js-child-process-concat exec.js:16',
        'bpm-js-child-process-concat exec.mjs:8',
        // The idiom with .slice/.substring, glued to a timestamp or a prefix.
        'bpm-js-math-random-token random.js:3',
        'bpm-js-math-random-token random.js:4',
        'bpm-js-math-random-token random.js:5',
        // Reported at the call that runs the SQL, not where it was built.
        'bpm-js-sql-string-concat sql.js:5',
        'bpm-js-sql-string-concat sql.js:10',
        'bpm-js-sql-string-concat sql.js:14',
        'bpm-js-sql-string-concat sql.js:18',
        'bpm-js-sql-string-concat sql.js:23',
        // Not retries: no early exit on success (saveAll, paced), or a
        // counted loop that returns the first match (a search).
        'bpm-perf-await-in-loop retry.ts:11',
        'bpm-perf-await-in-loop retry.ts:13',
        'bpm-perf-await-in-loop retry.ts:21',
        'bpm-perf-await-in-loop retry.ts:23',
        'bpm-perf-await-in-loop retry.ts:30',
        'bpm-ch-try-catch-in-loop retry.ts:9',
        'bpm-ch-try-catch-in-loop retry.ts:19',
      ].sort(),
    );
  }, 120_000);

  it('stays quiet on every near-miss, including the retry loops', () => {
    // Before the change, clean/retry.ts alone drew ten findings from the two
    // loop rules. The other clean files are the shapes the widened SQL, exec
    // and token patterns could plausibly have caught by accident.
    expect(scan('clean')).toEqual([]);
  }, 120_000);
});
