import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { listTreeFiles, readSnapshotSources } from './sources.js';

// Snapshot source reading (W9-06).

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(path.join(tmpdir(), 'w9-06-src-'));
  for (const [rel, contents] of Object.entries(files)) {
    const full = path.join(root, rel);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, contents);
  }
  return root;
}

describe('reading a snapshot tree', () => {
  it('returns relative paths, not the mount point', () => {
    // A stored finding must never carry the scratch directory into the UI.
    const root = tree({ 'src/a.ts': 'const a = 1;\n' });
    const result = readSnapshotSources(root);
    expect(result.files).toEqual([{ path: 'src/a.ts', source: 'const a = 1;\n' }]);
  });

  it('skips the directories nothing useful comes out of', () => {
    const root = tree({
      'src/a.ts': 'const a = 1;',
      'node_modules/pkg/index.js': 'module.exports = 1;',
      'dist/bundle.js': 'var x=1',
      '.git/config': '[core]',
    });
    expect(readSnapshotSources(root).files.map((f) => f.path)).toEqual(['src/a.ts']);
  });

  it('reads go.mod, the only map from a Go import path to a directory (W18-12)', () => {
    const root = tree({
      'go.mod': 'module example.com/app\n',
      'svc/go.mod': 'module x\n',
      'a.go': 'package a',
    });
    expect(readSnapshotSources(root).files.map((f) => f.path)).toEqual([
      'a.go',
      'go.mod',
      'svc/go.mod',
    ]);
  });

  it('skips files the scanners cannot read', () => {
    const root = tree({ 'src/a.ts': 'const a = 1;', 'README.md': '# hi', 'logo.png': 'binary' });
    expect(readSnapshotSources(root).files.map((f) => f.path)).toEqual(['src/a.ts']);
  });

  it('REPORTS what it skipped for size rather than swallowing it', () => {
    const root = tree({ 'src/big.ts': 'x'.repeat(2000), 'src/small.ts': 'const a = 1;' });
    const result = readSnapshotSources(root, { maxFileBytes: 100 });
    expect(result.files.map((f) => f.path)).toEqual(['src/small.ts']);
    expect(result.skipped).toBe(1);
  });

  it('REPORTS truncation, because a density needs its denominator', () => {
    // A slop density computed over 500 of 5,000 files is a number with no
    // denominator unless the caller can say so.
    const root = tree({
      'src/a.ts': 'const a = 1;',
      'src/b.ts': 'const b = 2;',
      'src/c.ts': 'const c = 3;',
    });
    const result = readSnapshotSources(root, { maxFiles: 2 });
    expect(result.files).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it('is deterministic in its ordering', () => {
    // Two runs over the same tree must read the same files in the same order,
    // or a truncated scan would cover a different subset each week.
    const root = tree({ 'src/b.ts': 'const b = 2;', 'src/a.ts': 'const a = 1;' });
    const first = readSnapshotSources(root).files.map((f) => f.path);
    const second = readSnapshotSources(root).files.map((f) => f.path);
    expect(first).toEqual(second);
    expect(first).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('survives a directory that vanished mid-walk', () => {
    // The snapshot is ephemeral by design and the sweeper may take it — a
    // scan should not fail over a race with its own cleanup.
    expect(() => readSnapshotSources(path.join(tmpdir(), 'w9-06-never-existed'))).not.toThrow();
  });
});

// W20-08 (UX_TODO FND-48): the tree a full run compares against, so a finding
// on a deleted file closes.
describe('listTreeFiles (W20-08)', () => {
  it('lists every file relative to the root, skipping .git', () => {
    const root = tree({ 'src/a.ts': 'x', 'b.bin': 'y', '.git/HEAD': 'ref' });
    expect(listTreeFiles(root).sort()).toEqual(['b.bin', 'src/a.ts']);
  });

  it('returns nothing rather than a partial list past the cap', () => {
    const root = tree({ 'a.ts': '', 'b.ts': '', 'c.ts': '' });
    expect(listTreeFiles(root, 2)).toEqual([]);
  });
});
