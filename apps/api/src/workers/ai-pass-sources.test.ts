import { describe, expect, it } from 'vitest';
import { AI_PASS_READABLE, dirInScope, fitRanked, passScope } from './ai-pass-sources.js';

// W20-16 (UX_TODO AI-85): an AI pass walks only the named paths and reads
// the languages a model can review, not just the scanners' list.
describe('AI pass source scope', () => {
  it('enters only directories on the way to, or inside, a named path', () => {
    const paths = ['src/app', 'lib/util.ts'];
    expect(dirInScope('src', paths)).toBe(true);
    expect(dirInScope('src/app', paths)).toBe(true);
    expect(dirInScope('src/app/deep', paths)).toBe(true);
    expect(dirInScope('lib', paths)).toBe(true);
    expect(dirInScope('aaa', paths)).toBe(false);
    expect(dirInScope('src/application', paths)).toBe(false);
  });

  it('reads Vue, Swift, C++, shell, Terraform and YAML as well as TypeScript', () => {
    for (const name of ['a.vue', 'b.swift', 'c.cpp', 'd.sh', 'e.tf', 'f.yaml', 'g.ts', 'go.mod']) {
      expect(AI_PASS_READABLE.test(name), name).toBe(true);
    }
    for (const name of ['logo.png', 'notes.md', 'package-lock.json']) {
      expect(AI_PASS_READABLE.test(name), name).toBe(false);
    }
  });
});

describe('fitRanked (W25-01, a first look)', () => {
  const f = (path: string, bytes: number) => ({ path, source: 'x'.repeat(bytes) });
  it('reads in rank order, stops at the file cap, and passes over a file too big for what is left', () => {
    const files = [f('c.ts', 10), f('a.ts', 60), f('b.ts', 50), f('d.ts', 20)];
    const chosen = fitRanked(files, ['a.ts', 'b.ts', 'c.ts', 'd.ts'], { files: 3, bytes: 100 });
    // b.ts (50) does not fit after a.ts (60); c.ts and d.ts do.
    expect(chosen.map((x) => x.path)).toEqual(['a.ts', 'c.ts', 'd.ts']);
  });
});

describe('passScope (W25-16, test code left out of a folder review)', () => {
  const files = ['src/a.ts', 'src/a.test.ts', 'src/__tests__/b.ts', 'src/README.md', 'lib/c.ts'];
  const walk = (paths: string[], includeTests: boolean) => {
    const s = passScope(paths, includeTests);
    return { read: files.filter((f) => s.include(f, false)), leftOut: s.leftOut };
  };

  it('leaves test files out of a folder and lists the readable ones', () => {
    expect(walk(['src'], false)).toEqual({
      read: ['src/a.ts', 'src/README.md'],
      leftOut: ['src/a.test.ts', 'src/__tests__/b.ts'],
    });
  });

  it('reads them when asked, or when the person named a test path or file', () => {
    expect(walk(['src'], true).read).toEqual(files.filter((f) => f.startsWith('src/')));
    expect(walk(['src/__tests__'], false).read).toEqual(['src/__tests__/b.ts']);
    expect(walk(['src/a.ts', 'src/a.test.ts'], false).read).toEqual(['src/a.ts', 'src/a.test.ts']);
  });
});
