import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildChunkPrompt, loadChecklist } from './prompt.js';
import { specialistById } from '../specialists/registry.js';

// performance.v3 (W21-20): algorithmic complexity, and every algorithmic
// finding names the input that grows and the complexity before and after.
//
// The specialist stays on v2 until a live model eval shows v3 does at least as
// well (docs/MODEL_EVAL.md): a checklist change is a change to what customers
// are told, and it is measured before it is switched on.

const chunk = {
  text: [
    '@@ -1,2 +1,5 @@',
    ' const rows = await load();',
    '+for (const r of rows) {',
    '+  const owner = owners.find((o) => o.id === r.ownerId);',
    '+}',
  ].join('\n'),
  paths: ['src/join.ts'],
  tokens: 40,
};

const digest = (text: string): string =>
  createHash('sha256').update(text).digest('hex').slice(0, 16);

describe('performance.v3', () => {
  const v2 = loadChecklist('performance', 'v2');
  const v3 = loadChecklist('performance', 'v3');

  it('keeps every v2 item', () => {
    for (const item of [
      'N+1 queries',
      'O(n²) or worse over unbounded input',
      'Blocking work in an async path',
      'Unbounded `Promise.all`',
      'Missing pagination',
      'try/catch inside a hot loop',
      'Hot-path allocation chains',
    ]) {
      expect(v2, item).toContain(item);
      expect(v3, item).toContain(item);
    }
  });

  it('adds the algorithmic shapes a single-loop pattern cannot see', () => {
    for (const item of [
      'A lookup that scans a list, once per element of another collection',
      'A linear search over data that is already sorted',
      'Sorting inside a loop',
      'A repeated computation',
      'Copying on every append',
    ]) {
      expect(v3, item).toContain(item);
    }
    expect(v3).toMatch(/binary\s+search is O\(log n\)/);
  });

  it('makes every algorithmic finding name what grows and the complexity before and after', () => {
    expect(v3).toContain('Grows with:');
    expect(v3).toMatch(/O\(n·m\) → O\(n \+ m\)/);
  });

  it('forbids milliseconds and speedup figures, like v2', () => {
    expect(v3).toContain('Do not quote a speedup');
    expect(v3).toMatch(/never estimate milliseconds/);
    expect(v3).not.toMatch(/\d+x\b/);
  });

  it('does not report shapes over collections that are small by construction', () => {
    expect(v3).toMatch(/small by\s+construction/);
  });

  it('builds a stable prompt for performance.v3', () => {
    const prompt = buildChunkPrompt({
      dimension: 'performance',
      chunk: chunk as never,
      prTitle: 'Join owners',
      prBody: null,
      version: 'v3',
    });
    expect(prompt.checklistVersion).toBe('v3');
    expect(digest(prompt.text)).toMatchInlineSnapshot(`"7970a59008596b10"`);
  });

  it('is what the specialist runs: the live eval (2026-10-26) showed v3 at least as good as v2', () => {
    // qwen/qwen3.8-27b, seed 7, the 8 performance cases: v2 and v3 both 4 TP / 1 FP / 0 FN.
    // v3 adds the growth + complexity statement on every finding but one.
    expect(specialistById('performance').checklistVersion).toBe('v3');
  });
});
