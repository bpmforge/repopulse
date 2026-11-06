import { describe, expect, it } from 'vitest';
import { AI_PASS_READABLE, dirInScope, fitRanked } from './ai-pass-sources.js';

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
