import { readFile } from 'node:fs/promises';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateAndApply } from './diff.js';
import { antiSlopRunner } from './runners.js';
import {
  hitDedupKey,
  judgePatch,
  verifyPatch,
  type FileRuleRunner,
  type PatchTarget,
  type RuleHit,
} from './verify.js';

// Verification logic (W18-19). The rule runner here is a stub with two
// line-pattern rules — what is under test is the VERDICT (clears / moved /
// new finding / no-op / failed run), not the shipped packs, whose own fixtures
// cover what they match. The stub reads the file from the scratch dir, so the
// test also proves each state really is written where the sandbox would mount.

const FILE = 'src/run.js';

function lineRule(ruleId: string, needle: string) {
  return (file: string, source: string): RuleHit[] =>
    source.split('\n').flatMap((text, i) =>
      text.includes(needle)
        ? [
            {
              scannerKey: 'semgrep',
              ruleId,
              dimension: 'sast',
              file,
              lineStart: i + 1,
              evidenceQuote: `${file}:${i + 1} — ${ruleId}`,
              title: ruleId,
            },
          ]
        : [],
    );
}

const evalRule = lineRule('bpm-eval', 'eval(');
const htmlRule = lineRule('bpm-inner-html', 'innerHTML');

function stubRunner(opts: { fail?: 'before' | 'after' } = {}): FileRuleRunner & { seen: string[] } {
  const seen: string[] = [];
  return {
    key: 'stub_pack',
    scannerKeys: ['semgrep'],
    seen,
    async run(input) {
      const onDisk = await readFile(path.join(input.dir, input.file), 'utf8');
      seen.push(onDisk);
      const state = onDisk === input.source ? (seen.length === 1 ? 'before' : 'after') : 'mismatch';
      if (state === 'mismatch') throw new Error('the scratch file is not the state being scanned');
      if (opts.fail === state) return { status: 'failed', hits: [], reason: 'sandbox unavailable' };
      return {
        status: 'succeeded',
        hits: [...evalRule(input.file, onDisk), ...htmlRule(input.file, onDisk)],
      };
    },
  };
}

const BEFORE = [
  'function run(cmd) {',
  '  return eval(cmd);',
  '}',
  '',
  'function show(el, html) {',
  '  el.textContent = html;',
  '}',
  '',
].join('\n');

function targetFor(source: string): PatchTarget {
  const hit = evalRule(FILE, source)[0]!;
  return { dedupKey: hitDedupKey(hit), scannerKey: 'semgrep', ruleId: 'bpm-eval', file: FILE };
}

function diff(...hunk: string[]): string {
  return [`--- a/${FILE}`, `+++ b/${FILE}`, ...hunk].join('\n');
}

let root = '';
beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'rp-verify-test-'));
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function verify(after: string, runners: FileRuleRunner[] = [stubRunner()]) {
  return verifyPatch({ target: targetFor(BEFORE), before: BEFORE, after, runners, root });
}

describe('verifyPatch', () => {
  it('a correct fix is VERIFIED, and the scratch dir is gone afterwards', async () => {
    const { after } = validateAndApply({
      modelText: diff(
        '@@ -1,3 +1,3 @@',
        ' function run(cmd) {',
        '-  return eval(cmd);',
        '+  return JSON.parse(cmd);',
        ' }',
      ),
      file: FILE,
      source: BEFORE,
    });
    const result = await verify(after);
    expect(result.status).toBe('verified');
    expect(result.code).toBe('verified');
    // One run per runner per state, each with its own id.
    expect(result.runs.map((r) => r.state)).toEqual(['before', 'after']);
    expect(new Set(result.runs.map((r) => r.id)).size).toBe(2);
    // Shredded on the way out: nothing of the customer's file is left behind.
    expect(await readdir(root)).toEqual([]);
  });

  it('a fix that clears the target but introduces a new finding is REJECTED', async () => {
    const { after } = validateAndApply({
      modelText: diff(
        '@@ -1,7 +1,7 @@',
        ' function run(cmd) {',
        '-  return eval(cmd);',
        '+  return JSON.parse(cmd);',
        ' }',
        ' ',
        ' function show(el, html) {',
        '-  el.textContent = html;',
        '+  el.innerHTML = html;',
        ' }',
      ),
      file: FILE,
      source: BEFORE,
    });
    const result = await verify(after);
    expect(result.status).toBe('rejected');
    expect(result.code).toBe('new_finding');
    expect(result.reason).toContain('bpm-inner-html');
  });

  it('a no-op that only reformats the line is REJECTED (the finding is still there)', async () => {
    const { after } = validateAndApply({
      modelText: diff('@@ -2 +2 @@', '-  return eval(cmd);', '+  return eval( cmd );'),
      file: FILE,
      source: BEFORE,
    });
    const result = await verify(after);
    expect(result.status).toBe('rejected');
    expect(result.code).toBe('target_still_present');
  });

  it('a patch that only pushes the finding into another line bucket is REJECTED', async () => {
    // Twelve lines inserted above: the evidence and rule are the same, the
    // ten-line bucket in the dedup key changes, and the key "disappears".
    const padding = Array.from({ length: 12 }, (_, i) => `+// note ${i}`);
    const { after } = validateAndApply({
      modelText: diff('@@ -1,1 +1,13 @@', ...padding, ' function run(cmd) {'),
      file: FILE,
      source: BEFORE,
    });
    const result = await verify(after);
    expect(result.status).toBe('rejected');
    expect(result.code).toBe('target_moved');
  });

  it('a target the before-scan cannot reproduce is REJECTED, never verified', async () => {
    const result = await verifyPatch({
      target: { ...targetFor(BEFORE), dedupKey: 'stale-key-from-an-older-rulepack' },
      before: BEFORE,
      after: BEFORE.replace('eval(cmd)', 'JSON.parse(cmd)'),
      runners: [stubRunner()],
      root,
    });
    expect(result.status).toBe('rejected');
    expect(result.code).toBe('target_not_reproduced');
  });

  it('a rule run that fails on either state FAILS the attempt rather than passing it', async () => {
    const after = BEFORE.replace('eval(cmd)', 'JSON.parse(cmd)');
    for (const fail of ['before', 'after'] as const) {
      const result = await verify(after, [stubRunner({ fail })]);
      expect(result.status).toBe('failed');
      expect(result.code).toBe('rule_run_failed');
    }
  });

  it('a runner that throws is a failed run, not a clean one', async () => {
    const throwing: FileRuleRunner = {
      key: 'boom',
      scannerKeys: ['semgrep'],
      async run() {
        throw new Error('podman: image not found');
      },
    };
    const result = await verify(BEFORE.replace('eval(cmd)', 'JSON.parse(cmd)'), [
      stubRunner(),
      throwing,
    ]);
    expect(result.status).toBe('failed');
    expect(result.reason).toContain('podman: image not found');
  });
});

describe('judgePatch', () => {
  it('rejects a finding no runner can re-check', () => {
    const verdict = judgePatch({
      target: { dedupKey: 'k', scannerKey: 'secrets', ruleId: 'aws-key', file: FILE },
      runners: [stubRunner()],
      before: new Map(),
      after: new Map(),
    });
    expect(verdict).toMatchObject({ status: 'rejected', code: 'not_rerunnable' });
  });
});

describe('antiSlopRunner (fast lane) catches what models invent', () => {
  const tree = [
    { path: 'src/util.js', source: 'export function parse(x) {\n  return JSON.parse(x);\n}\n' },
    {
      path: 'src/run.js',
      source:
        "import { parse } from './util.js';\nexport function run(c) {\n  return parse(c);\n}\n",
    },
    { path: 'src/main.js', source: "import { run } from './run.js';\nrun('1');\n" },
  ];

  it('a patched import of a name the repository does not have is a NEW finding', async () => {
    const before = tree[1]!.source;
    const after = before.replace(
      "import { parse } from './util.js';",
      "import { parse, sanitize } from './util.js';",
    );
    const runner = antiSlopRunner();
    const run = (source: string) =>
      runner.run({
        dir: root,
        file: 'src/run.js',
        source,
        tree: tree.map((f) => (f.path === 'src/run.js' ? { ...f, source } : f)),
        treeComplete: true,
      });
    const [b, a] = [await run(before), await run(after)];
    expect(b.hits.filter((h) => h.ruleId === 'slop.phantom_symbol')).toHaveLength(0);
    expect(a.hits.filter((h) => h.ruleId === 'slop.phantom_symbol')).toHaveLength(1);
  });

  it('without a tree, the whole-tree rules say they did not run', async () => {
    const out = await antiSlopRunner().run({
      dir: root,
      file: 'src/run.js',
      source: tree[1]!.source,
      treeComplete: false,
    });
    expect(out.status).toBe('succeeded');
    expect(out.reason).toMatch(/whole-tree rules not run/);
  });
});
