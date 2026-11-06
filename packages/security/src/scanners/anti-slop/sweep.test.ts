import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DiffFile } from '@repopulse/analysis';
import { antiSlopSweep, isOutOfScopeSlop } from './run.js';

// What an anti-slop pass may close (W20-08, UX_TODO FND-58). Only a complete
// tree pass with the pack in hand sweeps; the judgement half never does.

function snapshot(files: string[]): string {
  const root = mkdtempSync(path.join(tmpdir(), 'w20-08-slop-'));
  for (const rel of files) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), '');
  }
  return root;
}

const pack = {
  scannedPaths: ['src/a.ts', 'src/broken.ts'],
  erroredPaths: ['src/broken.ts'],
  pathlessErrors: 0,
};

describe('antiSlopSweep (W20-08)', () => {
  const dir = snapshot(['src/a.ts', 'src/b.ts', 'src/broken.ts']);
  const deps = {
    files: [] as readonly DiffFile[],
    sources: [
      { path: 'src/a.ts', source: '' },
      { path: 'src/b.ts', source: '' },
    ],
    sourcesComplete: true,
    snapshotDir: dir,
    targetDir: dir,
    trigger: 'manual' as const,
  };

  it('a complete tree pass reviews what it read, minus what failed, and keeps judgements open', () => {
    const sweep = antiSlopSweep(deps, pack);
    expect(new Set(sweep.reviewedFiles)).toEqual(new Set(['src/a.ts', 'src/b.ts']));
    expect([...(sweep.fullSweep?.treeFiles ?? [])].sort()).toEqual([
      'src/a.ts',
      'src/b.ts',
      'src/broken.ts',
    ]);
    expect(sweep.fullSweep?.keepOpen({ ruleId: 'slop.judgment' })).toBe(true);
    expect(sweep.fullSweep?.keepOpen({ ruleId: 'slop.dead-export' })).toBe(false);
  });

  const ran = ['bpm-ch-empty-catch', 'bpm-ch-what-comment'];

  it.each([
    ['a PR pass', { trigger: 'pr_synced' as const }],
    ['a changed-files pass', { files: [{ path: 'src/a.ts' } as unknown as DiffFile] }],
  ])('%s sweeps nothing', (_label, over) => {
    expect(antiSlopSweep({ ...deps, ...over }, pack, ran)).toEqual({});
  });

  it('a pack that failed to load, or never ran, sweeps nothing', () => {
    expect(antiSlopSweep(deps, { ...pack, pathlessErrors: 1 }, ran)).toEqual({});
    expect(antiSlopSweep(deps, null, ran)).toEqual({});
    expect(antiSlopSweep({ ...deps, sourcesComplete: false }, null, ran)).toEqual({});
  });

  // 2026-10-30: a large repository's read is always capped, so nothing the
  // pack found ever closed. The pack read the snapshot, not the capped sources.
  it('a capped read closes only the pack rules that ran, on the files the pack scanned', () => {
    const sweep = antiSlopSweep({ ...deps, sourcesComplete: false }, pack, ran);
    // Not src/b.ts (the reader saw it, the pack did not), not the errored file.
    expect(sweep.reviewedFiles).toEqual(['src/a.ts']);
    expect(sweep.fullSweep?.treeFiles).toBeUndefined();
    const keep = sweep.fullSweep!.keepOpen;
    expect(keep({ ruleId: 'bpm-ch-empty-catch' })).toBe(false);
    expect(keep({ ruleId: 'slop.judgment' })).toBe(true);
    expect(keep({ ruleId: 'slop.dead-export' })).toBe(true);
    expect(keep({ ruleId: 'bpm-ch-removed-rule' })).toBe(true);
    expect(keep({ ruleId: null })).toBe(true);
  });

  it('a capped read with no rule ids, or no scanned paths, sweeps nothing', () => {
    const capped = { ...deps, sourcesComplete: false };
    expect(antiSlopSweep(capped, pack, [])).toEqual({});
    expect(antiSlopSweep(capped, { pathlessErrors: 0 }, ran)).toEqual({});
    expect(antiSlopSweep(capped, { ...pack, scannedPaths: ['src/broken.ts'] }, ran)).toEqual({});
  });
});

// W27-01, "pertinent code only": nothing is reported on tests, fixtures,
// generated or vendored code, so what earlier runs left there must close.
describe('non-production paths (W27-01)', () => {
  it('isOutOfScopeSlop: every slop rule on a non-production path; test integrity only off vendored code', () => {
    expect(isOutOfScopeSlop({ ruleId: 'slop.delegation_wrapper', file: 'tests/helpers.ts' })).toBe(
      true,
    );
    expect(isOutOfScopeSlop({ ruleId: 'slop.judgment', file: 'src/cart.test.ts' })).toBe(true);
    expect(isOutOfScopeSlop({ ruleId: 'slop.low_logic_density', file: 'vendor/x/y.ts' })).toBe(
      true,
    );
    expect(isOutOfScopeSlop({ ruleId: 'bpm-ch-empty-catch', file: 'src/api.generated.ts' })).toBe(
      true,
    );
    // A hollow test is a fact about a test: still reported on tests...
    expect(isOutOfScopeSlop({ ruleId: 'test.no_assertion', file: 'src/cart.test.ts' })).toBe(false);
    // ...but not on someone else's vendored tests.
    expect(
      isOutOfScopeSlop({ ruleId: 'test.no_assertion', file: 'node_modules/x/a.test.js' }),
    ).toBe(true);
    // Production look-alikes and file-less rows are in scope.
    for (const file of ['src/latest.go', 'contest.py', 'src/Testimonial.tsx', 'src/builder/x.ts']) {
      expect(isOutOfScopeSlop({ ruleId: 'slop.delegation_wrapper', file }), file).toBe(false);
    }
    expect(isOutOfScopeSlop({ ruleId: 'slop.duplicate_purpose', file: null })).toBe(false);
  });

  const dir = snapshot(['src/a.ts', 'src/b.ts', 'tests/helpers.ts', 'vendor/lib/x.ts']);
  const deps = {
    files: [] as readonly DiffFile[],
    sources: [{ path: 'src/a.ts', source: '' }],
    snapshotDir: dir,
    targetDir: dir,
    trigger: 'manual' as const,
  };
  const scanned = { scannedPaths: ['src/a.ts'], erroredPaths: [], pathlessErrors: 0 };

  it('a complete pass reviews every non-production file and closes only out-of-scope rows there', () => {
    const sweep = antiSlopSweep({ ...deps, sourcesComplete: true }, scanned);
    expect(new Set(sweep.reviewedFiles)).toEqual(
      new Set(['src/a.ts', 'tests/helpers.ts', 'vendor/lib/x.ts']),
    );
    const keep = sweep.fullSweep!.keepOpen;
    expect(keep({ ruleId: 'slop.judgment', file: 'tests/helpers.ts' })).toBe(false);
    expect(keep({ ruleId: 'slop.unused_export', file: 'vendor/lib/x.ts' })).toBe(false);
    // Not read this pass, and in scope on a test: left as it is.
    expect(keep({ ruleId: 'test.no_assertion', file: 'tests/helpers.ts' })).toBe(true);
    // Production rows behave as before.
    expect(keep({ ruleId: 'slop.judgment', file: 'src/a.ts' })).toBe(true);
    expect(keep({ ruleId: 'slop.unused_export', file: 'src/a.ts' })).toBe(false);
  });

  it('a capped pass also closes out-of-scope rows, whatever rule raised them', () => {
    const sweep = antiSlopSweep({ ...deps, sourcesComplete: false }, scanned, [
      'bpm-ch-empty-catch',
    ]);
    expect(new Set(sweep.reviewedFiles)).toEqual(
      new Set(['src/a.ts', 'tests/helpers.ts', 'vendor/lib/x.ts']),
    );
    const keep = sweep.fullSweep!.keepOpen;
    expect(keep({ ruleId: 'slop.unused_export', file: 'tests/helpers.ts' })).toBe(false);
    expect(keep({ ruleId: 'slop.judgment', file: 'vendor/lib/x.ts' })).toBe(false);
    expect(keep({ ruleId: 'test.no_assertion', file: 'tests/helpers.ts' })).toBe(true);
    // The capped rule for production files is unchanged.
    expect(keep({ ruleId: 'slop.unused_export', file: 'src/a.ts' })).toBe(true);
    expect(keep({ ruleId: 'bpm-ch-empty-catch', file: 'src/a.ts' })).toBe(false);
  });
});
