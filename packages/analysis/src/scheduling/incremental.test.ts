import { describe, expect, it } from 'vitest';
import { SPECIALISTS } from '../specialists/registry.js';
import {
  contentHash,
  needsCompare,
  newSideText,
  PATHS_MAX_CHAIN,
  planPathsScope,
  planReviewScope,
  quoteInText,
  quoteStillPresent,
  restrictDiff,
  reviewPromptVersion,
} from './incremental.js';

// W23-07: the pure decisions of an incremental PR re-review.

const prior = { runId: 7, headSha: 'aaaaaaa1', promptVersion: 'v', completeAndClean: true };
const base = {
  prior,
  newHeadSha: 'bbbbbbb2',
  promptVersion: 'v',
  comparison: { files: [{ path: 'src/a.ts', status: 'modified' }], truncated: false },
  prFiles: ['src/a.ts', 'src/b.ts'],
};

describe('planReviewScope', () => {
  it('is incremental over the files changed since the prior head, with the base run', () => {
    expect(planReviewScope(base)).toEqual({
      scope: 'incremental',
      reason: 'incremental',
      baseRunId: 7,
      sinceSha: 'aaaaaaa1',
      changed: ['src/a.ts'],
    });
  });

  it.each([
    ['no prior', { prior: null }, 'no_prior_review'],
    ['force', { force: true }, 'forced'],
    ['prompt version changed', { promptVersion: 'v2' }, 'prompt_version_changed'],
    ['same head', { newHeadSha: 'aaaaaaa1' }, 'same_head'],
    [
      'prior dropped a specialist',
      { prior: { ...prior, completeAndClean: false } },
      'prior_not_clean',
    ],
    ['compare unavailable', { comparison: null }, 'compare_unavailable'],
    ['compare truncated', { comparison: { files: [], truncated: true } }, 'compare_truncated'],
    [
      'nothing in the PR diff changed',
      { comparison: { files: [{ path: 'other.ts', status: 'modified' }], truncated: false } },
      'no_reviewable_change',
    ],
  ])('is full: %s', (_n, patch, reason) => {
    expect(planReviewScope({ ...base, ...patch })).toEqual({ scope: 'full', reason });
  });

  it('asks the forge only when the cheap checks pass', () => {
    expect(needsCompare(base)).toBe('compare');
    expect(needsCompare({ ...base, force: true })).toBe('forced');
    expect(needsCompare({ ...base, promptVersion: 'x' })).toBe('prompt_version_changed');
  });
});

describe('diff helpers', () => {
  it('restricts a diff to the changed paths', () => {
    const files = [{ path: 'a' }, { path: 'b' }, { path: 'c' }];
    expect(restrictDiff(files, ['b'])).toEqual([{ path: 'b' }]);
  });

  it('reads only the new side of a patch', () => {
    const patch = '@@ -1,3 +1,3 @@\n keep\n-old line\n+new line\n tail';
    expect(newSideText(patch)).toBe('keep\nnew line\ntail');
  });

  it('matches a quote on normalised text, and not a removed line', () => {
    const patch = '@@ -1,2 +1,2 @@\n-const  Secret = 1;\n+const   safe =\n+  2;';
    expect(quoteStillPresent('const safe = 2;', patch)).toBe(true);
    expect(quoteStillPresent('CONST SAFE =  2;', patch)).toBe(true);
    expect(quoteStillPresent('const Secret = 1;', patch)).toBe(false);
    expect(quoteStillPresent('anything', undefined)).toBe(false);
    expect(quoteStillPresent('   ', patch)).toBe(false);
  });

  it('stamps the prompt version from every specialist checklist version', () => {
    const v = reviewPromptVersion();
    for (const s of SPECIALISTS) expect(v).toContain(`${s.id}@${s.checklistVersion}`);
    expect(reviewPromptVersion([{ id: 'x', checklistVersion: 'v9' }])).toBe('x@v9');
  });
});

describe('planPathsScope (W25-07)', () => {
  const promptVersion = reviewPromptVersion();
  const hashes = { 'src/a.ts': contentHash('a'), 'src/b.ts': contentHash('b') };
  const prior = {
    runId: 4,
    commitSha: 'aaaa1111',
    promptVersion,
    fileHashes: hashes,
    completeAndClean: true,
    chain: 0,
  };
  const files = (b = 'b') => [
    { path: 'src/a.ts', hash: contentHash('a') },
    { path: 'src/b.ts', hash: contentHash(b) },
  ];

  it('sends only the files whose content changed', () => {
    const plan = planPathsScope({ prior, promptVersion, files: files('b2') });
    expect(plan).toEqual({
      scope: 'incremental',
      reason: 'incremental',
      baseRunId: 4,
      sinceSha: 'aaaa1111',
      changed: ['src/b.ts'],
      unchanged: ['src/a.ts'],
      removed: [],
      chain: 1,
    });
  });

  it('lists a new file as changed and a vanished one as removed', () => {
    const plan = planPathsScope({
      prior,
      promptVersion,
      files: [
        { path: 'src/a.ts', hash: contentHash('a') },
        { path: 'src/c.ts', hash: contentHash('c') },
      ],
    });
    expect(plan).toMatchObject({
      changed: ['src/c.ts'],
      unchanged: ['src/a.ts'],
      removed: ['src/b.ts'],
    });
  });

  it('is incremental with nothing changed when every hash matches', () => {
    expect(planPathsScope({ prior, promptVersion, files: files() })).toMatchObject({
      scope: 'incremental',
      changed: [],
    });
  });

  it.each([
    ['forced', { force: true }],
    ['no_prior_review', { prior: null }],
    ['prior_not_clean', { prior: { ...prior, completeAndClean: false } }],
    ['no_file_hashes', { prior: { ...prior, fileHashes: null } }],
    ['prompt_version_changed', { prior: { ...prior, promptVersion: 'security@v0' } }],
    ['drift_guard', { prior: { ...prior, chain: PATHS_MAX_CHAIN } }],
  ] as const)('reviews in full: %s', (reason, over) => {
    expect(planPathsScope({ prior, promptVersion, files: files('b2'), ...over })).toEqual({
      scope: 'full',
      reason,
    });
  });

  it('finds a quote in a file by the validator normalisation', () => {
    expect(quoteInText('return   DB.query(x)', 'function f() {\n  return db.query(x);\n}')).toBe(
      true,
    );
    expect(quoteInText('return db.query(y)', 'return db.query(x);')).toBe(false);
    expect(quoteInText('anything', undefined)).toBe(false);
    expect(quoteInText('   ', 'text')).toBe(false);
  });
});
