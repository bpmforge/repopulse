import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// D9a on the verified-patch path (W18-19, D16).
//
// D16 chose "Verified + CI pull" precisely so that a model-drafted fix reaches a
// developer WITHOUT Repo Pulse writing to their repository: no branch, no
// commit, no pull request, no comment. The runtime half of this guarantee is in
// packages/security/src/patches/run.integration.test.ts, which drives the job
// through a forge proxy that throws on any member but the file read. This is
// the static half: the code on the patch path must not even NAME a forge write,
// so one cannot be added in passing without this file changing too.

const repoRoot = new URL('../../../../', import.meta.url).pathname;

function patchPathSources(): { file: string; text: string }[] {
  const patchesDir = join(repoRoot, 'packages/security/src/patches');
  const files = [
    ...readdirSync(patchesDir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => join(patchesDir, f)),
    join(repoRoot, 'apps/api/src/routes/patches/index.ts'),
    join(repoRoot, 'apps/api/src/workers/patch-processor.ts'),
  ];
  return files.map((file) => ({
    file: file.slice(repoRoot.length),
    text: readFileSync(file, 'utf8'),
  }));
}

/** Code lines only: prose saying "no pull request is opened" is not a write. */
function codeLines(text: string): string[] {
  return text
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\/\*|\*)/.test(line))
    .map((line) => line.replace(/\/\/.*$/, ''));
}

const FORGE_WRITES = [
  /registerWebhook/,
  /create(PullRequest|Branch|Commit|Comment|Review|Ref|Issue|Tree|Blob)/i,
  /(update|createOrUpdate|delete|put)File/i,
  /\boctokit\b/i,
  /\bfetch\s*\(/,
  /method:\s*['"](POST|PUT|PATCH|DELETE)['"]/,
  /\/(pulls|issues)\/\d*\/?comments/,
  /\/git\/(refs|commits|trees|blobs)/,
];

describe('verified patches never write to the forge (D9a)', () => {
  const sources = patchPathSources();

  it('reads the files it claims to (the guard is not vacuous)', () => {
    expect(sources.length).toBeGreaterThanOrEqual(8);
    expect(sources.some((s) => s.text.includes('getFileContent'))).toBe(true);
  });

  for (const pattern of FORGE_WRITES) {
    it(`no code on the patch path matches ${pattern}`, () => {
      const hits = sources.flatMap((s) =>
        codeLines(s.text)
          .filter((line) => pattern.test(line))
          .map((line) => `${s.file}: ${line.trim()}`),
      );
      expect(hits).toEqual([]);
    });
  }

  it('the only forge members the patch path calls are reads', () => {
    const called = new Set<string>();
    for (const s of sources) {
      for (const line of codeLines(s.text)) {
        for (const m of line.matchAll(/provider\.([A-Za-z]+)/g)) called.add(m[1]!);
      }
    }
    expect([...called].sort()).toEqual(['capabilities', 'getFileContent']);
  });
});
