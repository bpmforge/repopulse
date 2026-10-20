import { describe, expect, it } from 'vitest';
import { AI_PASS_READABLE, dirInScope } from './ai-pass-sources.js';

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
