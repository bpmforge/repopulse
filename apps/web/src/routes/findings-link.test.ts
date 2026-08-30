import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// W16-49. Three screens linked to the Findings explorer with
// `search={{ open: <id> }}` — the param name from before W16-16 renamed it to
// `finding`. TanStack's validateSearch REPLACES the search object, so `open`
// was not merely ignored, it was stripped: clicking the most complex function,
// a top risk, or a node in an attack chain navigated to the explorer and opened
// nothing at all. The `as never` cast every one of them carries is exactly what
// stopped the compiler from saying so.
//
// A source assertion because the alternative is a router harness per screen,
// and the failure is a STRING mismatch between files rather than behaviour
// inside one.

const LINKING_FILES = [
  'apps/web/src/widgets/risk/TopRisksCard.tsx',
  'apps/web/src/routes/repos/$repoId/code-health.tsx',
  'apps/web/src/widgets/security/ChainsPanel.tsx',
  'apps/web/src/widgets/file/FileDetail.tsx',
  'apps/web/src/widgets/pr/PrDetail.tsx',
];

/**
 * The repo root, found by walking up from the working directory.
 *
 * `import.meta.url` is not a reliable anchor here: the web project runs under
 * jsdom and it resolved to a path that did not exist. plan.json only ever sits
 * at the root, so it is the marker.
 */
function repoRoot(): string {
  let dir = resolve(process.cwd());
  while (!existsSync(join(dir, 'plan.json'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error('repo root not found from ' + process.cwd());
    dir = parent;
  }
  return dir;
}

function read(rel: string): string {
  return readFileSync(join(repoRoot(), rel), 'utf8');
}

describe('links that open a finding (W16-49)', () => {
  // The name is taken from the EXPLORER's own validator rather than restated,
  // so renaming it there fails this test instead of silently orphaning links.
  const explorer = read('apps/web/src/routes/findings/index.tsx');
  const param = /const raw = search\.(\w+);/.exec(explorer)?.[1];

  it('the explorer still reads the param this test is about', () => {
    expect(param).toBe('finding');
  });

  it.each(LINKING_FILES)('%s uses that param, not a stale one', (file) => {
    const source = read(file);
    const searches = [...source.matchAll(/search=\{\{ (\w+):/g)].map((m) => m[1]);
    // Some of these files also carry `search={(prev) => ...}` spreads, which
    // this pattern does not match and does not need to: those preserve whatever
    // the URL already had.
    for (const key of searches) {
      expect(key, `${file} links with ?${key}=`).toBe(param);
    }
  });
});
