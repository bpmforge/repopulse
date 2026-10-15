import { describe, expect, it } from 'vitest';
import {
  applyPatch,
  extractDiff,
  MAX_CHANGED_LINES,
  parseUnifiedDiff,
  PatchRejectedError,
  validateAndApply,
} from './diff.js';

// Diff validation for verified patches (W18-19). The model's diff is untrusted
// input: every property the verifier relies on is proven here or refused.

const FILE = 'src/run.js';
const SOURCE = [
  'const cp = require("child_process");',
  '',
  'function run(cmd) {',
  '  return eval(cmd);',
  '}',
  '',
  'module.exports = { run };',
  '',
].join('\n');

const GOOD = [
  `--- a/${FILE}`,
  `+++ b/${FILE}`,
  '@@ -3,3 +3,3 @@',
  ' function run(cmd) {',
  '-  return eval(cmd);',
  '+  return JSON.parse(cmd);',
  ' }',
].join('\n');

function code(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    if (err instanceof PatchRejectedError) return err.code;
    throw err;
  }
  return undefined;
}

describe('extractDiff', () => {
  it('reads the JSON shape the prompt asks for', () => {
    expect(extractDiff(JSON.stringify({ diff: GOOD }))).toBe(GOOD);
  });
  it('reads a fenced block and a bare diff too', () => {
    expect(extractDiff('Here you go:\n```diff\n' + GOOD + '\n```\n')).toBe(GOOD + '\n');
    expect(extractDiff(GOOD)).toBe(GOOD);
  });
});

describe('parseUnifiedDiff — shape gate', () => {
  it('accepts a single-file modification and ignores miscounted headers', () => {
    const miscounted = GOOD.replace('@@ -3,3 +3,3 @@', '@@ -3,9 +3,1 @@');
    const parsed = parseUnifiedDiff(miscounted);
    expect(parsed.oldPath).toBe(FILE);
    expect(parsed.hunks).toHaveLength(1);
    expect(parsed.hunks[0]!.lines.filter((l) => l.kind !== ' ')).toHaveLength(2);
  });

  it('refuses an empty diff, a diff with no changes, and garbage', () => {
    expect(code(() => parseUnifiedDiff('  \n'))).toBe('empty');
    expect(
      code(() =>
        parseUnifiedDiff([`--- a/${FILE}`, `+++ b/${FILE}`, '@@ -1,1 +1,1 @@', ' x'].join('\n')),
      ),
    ).toBe('no_change');
    expect(code(() => parseUnifiedDiff('please apply my fix'))).toBe('malformed');
    expect(code(() => parseUnifiedDiff(GOOD.replace(' function run', '*function run')))).toBe(
      'malformed',
    );
  });

  it('refuses a second file', () => {
    const two = `${GOOD}\n--- a/src/other.js\n+++ b/src/other.js\n@@ -1 +1 @@\n-a\n+b`;
    expect(code(() => parseUnifiedDiff(two))).toBe('multiple_files');
  });

  it('refuses creating, deleting, renaming or re-moding a file', () => {
    expect(code(() => parseUnifiedDiff(`--- /dev/null\n+++ b/${FILE}\n@@ -0,0 +1 @@\n+x`))).toBe(
      'file_mode',
    );
    expect(code(() => parseUnifiedDiff(`--- a/${FILE}\n+++ /dev/null\n@@ -1 +0,0 @@\n-x`))).toBe(
      'file_mode',
    );
    expect(
      code(() => parseUnifiedDiff(`--- a/${FILE}\n+++ b/src/moved.js\n@@ -1 +1 @@\n-a\n+b`)),
    ).toBe('file_mode');
    expect(code(() => parseUnifiedDiff(`diff --git a/x b/x\nnew file mode 100644\n${GOOD}`))).toBe(
      'file_mode',
    );
    expect(code(() => parseUnifiedDiff(`old mode 100644\nnew mode 100755\n${GOOD}`))).toBe(
      'file_mode',
    );
  });

  it('refuses a diff over the size or changed-line caps', () => {
    const lines = Array.from({ length: MAX_CHANGED_LINES + 1 }, (_, i) => `+line ${i}`);
    const big = [`--- a/${FILE}`, `+++ b/${FILE}`, '@@ -1,0 +1,201 @@', ...lines].join('\n');
    expect(code(() => parseUnifiedDiff(big))).toBe('too_large');
    expect(code(() => parseUnifiedDiff(`${GOOD}\n${'+x'.repeat(10_000)}`))).toBe('too_large');
  });

  it('does not mistake a removed "-- comment" line for a second file header', () => {
    const sql = [
      '--- a/db/q.sql',
      '+++ b/db/q.sql',
      '@@ -1,2 +1,2 @@',
      '--- old comment',
      '+-- new comment',
      ' select 1;',
    ].join('\n');
    const parsed = parseUnifiedDiff(sql);
    expect(parsed.hunks[0]!.lines.map((l) => l.kind)).toEqual(['-', '+', ' ']);
    expect(applyPatch('-- old comment\nselect 1;\n', parsed).after).toBe(
      '-- new comment\nselect 1;\n',
    );
  });
});

describe('validateAndApply', () => {
  it('applies a correct diff and returns a canonical diff with real line numbers', () => {
    const applied = validateAndApply({ modelText: GOOD, file: FILE, source: SOURCE });
    expect(applied.after).toContain('return JSON.parse(cmd);');
    expect(applied.after).not.toContain('eval(');
    expect(applied.canonicalDiff).toContain('@@ -3,3 +3,3 @@');
    // The canonical diff is what a developer applies: it must apply exactly.
    expect(
      validateAndApply({ modelText: applied.canonicalDiff, file: FILE, source: SOURCE }).after,
    ).toBe(applied.after);
  });

  it('finds a hunk whose header names the wrong line, and corrects the header', () => {
    const offset = GOOD.replace('@@ -3,3 +3,3 @@', '@@ -40,3 +40,3 @@');
    const applied = validateAndApply({ modelText: offset, file: FILE, source: SOURCE });
    expect(applied.after).toContain('JSON.parse');
    expect(applied.canonicalDiff).toContain('@@ -3,3 +3,3 @@');
  });

  it('refuses a diff for a different file than the finding', () => {
    expect(
      code(() => validateAndApply({ modelText: GOOD, file: 'src/elsewhere.js', source: SOURCE })),
    ).toBe('wrong_file');
    // An "equivalent" path is not normalised into a match.
    expect(
      code(() =>
        validateAndApply({
          modelText: GOOD.replaceAll(`/${FILE}`, `/./${FILE}`),
          file: FILE,
          source: SOURCE,
        }),
      ),
    ).toBe('wrong_file');
  });

  it('refuses a diff whose context does not match the scanned file', () => {
    const stale = GOOD.replace(' function run(cmd) {', ' function execute(cmd) {');
    expect(code(() => validateAndApply({ modelText: stale, file: FILE, source: SOURCE }))).toBe(
      'does_not_apply',
    );
  });

  it('refuses a hunk that matches two places equally', () => {
    const twice = 'a\nx\nb\na\nx\nb\n';
    const diff = [`--- a/${FILE}`, `+++ b/${FILE}`, '@@ -2,3 +2,3 @@', ' x', '-b', '+c', ' a'].join(
      '\n',
    );
    // Old block "x b a" appears once (lines 2-4) — applies.
    expect(validateAndApply({ modelText: diff, file: FILE, source: twice }).after).toBe(
      'a\nx\nc\na\nx\nb\n',
    );
    // "x b" at lines 1 and 5, and the header points at line 3 — equidistant.
    // Picking either would be a guess about which copy the finding is in.
    const repeated = 'x\nb\nm\nm\nx\nb\n';
    const ambiguous = [`--- a/${FILE}`, `+++ b/${FILE}`, '@@ -3,2 +3,2 @@', ' x', '-b', '+c'].join(
      '\n',
    );
    expect(
      code(() => validateAndApply({ modelText: ambiguous, file: FILE, source: repeated })),
    ).toBe('does_not_apply');
  });

  it('refuses a diff that removes and re-adds the same line (a no-op)', () => {
    const noop = [
      `--- a/${FILE}`,
      `+++ b/${FILE}`,
      '@@ -4,1 +4,1 @@',
      '-  return eval(cmd);',
      '+  return eval(cmd);',
    ].join('\n');
    expect(code(() => validateAndApply({ modelText: noop, file: FILE, source: SOURCE }))).toBe(
      'no_change',
    );
  });

  it('keeps a file without a trailing newline that way', () => {
    const src = 'a\nb';
    const diff = [
      `--- a/${FILE}`,
      `+++ b/${FILE}`,
      '@@ -1,2 +1,2 @@',
      ' a',
      '-b',
      '+c',
      '\\ No newline at end of file',
    ].join('\n');
    expect(validateAndApply({ modelText: diff, file: FILE, source: src }).after).toBe('a\nc');
  });
});
