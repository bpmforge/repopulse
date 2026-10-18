import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildChunkPrompt, loadChecklist, CHECKLIST_VERSION } from './prompt.js';

// Checklist v2 (W9-05, CODE_HEALTH_SUITE.md, FR-CH-5).
//
// A checklist is a versioned asset: v1 stays exactly as it was, because a
// re-recorded v1 would make every finding produced under it stop meaning what
// it said. v2 is a new file, and these are its golden snapshots.

const chunk = {
  text: [
    '@@ -1,2 +1,4 @@',
    ' const rows = await db.all();',
    '+for (const r of rows) {',
    '+  await db.get(r.id);',
    '+}',
  ].join('\n'),
  paths: ['src/load.ts'],
  tokens: 40,
};

/** A digest, not the text: the point is that the prompt has not MOVED. */
function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex').slice(0, 16);
}

describe('v1 is untouched', () => {
  it('still loads, and is still the default', () => {
    // The version-bump discipline: adding v2 must not silently repoint every
    // existing run at a different set of questions.
    expect(CHECKLIST_VERSION).toBe('v1');
    expect(loadChecklist('performance', 'v1')).toContain('N+1 queries');
    expect(loadChecklist('code_health', 'v1').length).toBeGreaterThan(100);
  });
});

describe('performance.v2 completes the five static scans', () => {
  const v2 = loadChecklist('performance', 'v2');

  it('keeps the v1 items', () => {
    for (const item of ['N+1 queries', 'O(n²)', 'Blocking work in an async path']) {
      expect(v2, item).toContain(item);
    }
  });

  it('adds try/catch-in-hot-loop and allocation chains', () => {
    expect(v2).toContain('try/catch inside a hot loop');
    expect(v2).toContain('Hot-path allocation chains');
  });

  it('tells the model NOT to quote the speedup figure', () => {
    // The 5-20x number is real for older engines and much smaller for modern
    // ones. A finding that quotes it would be citing a benchmark nobody in
    // this product ran, on an engine version nobody checked — so the rule asks
    // for the STRUCTURE and says the hidden failure count is the durable
    // problem anyway.
    expect(v2).toContain('Do not quote a speedup figure');
    expect(v2).toContain('report it as STRUCTURE');
  });

  it('says silence is the right answer for most diffs', () => {
    expect(v2).toMatch(/Say nothing rather than guessing/);
  });
});

describe('code_health.v2 aligns with the slop rule ids (FR-CH-5)', () => {
  const v2 = loadChecklist('code_health', 'v2');

  it('names the pack and scanner rule ids it overlaps with', () => {
    for (const ruleId of [
      'bpm-ch-empty-catch',
      'bpm-ch-silent-fallback-return',
      'bpm-ch-what-comment',
      'slop.docstring_inflation',
    ]) {
      expect(v2, ruleId).toContain(ruleId);
    }
  });

  it('requires the rule id as a title PREFIX, and says why', () => {
    // Without the prefix the two layers produce two rows for one problem —
    // the dedup key is built from the title and evidence, so alignment is
    // what makes them collapse.
    // Matched across the line wrap: the markdown hard-wraps at 78 columns, so
    // a substring assertion on a phrase that spans a newline fails for a
    // formatting reason rather than a content one.
    expect(v2).toMatch(/begin\s+the title with that id/);
    expect(v2).toContain('one problem should be one row');
    expect(v2).toContain('This is not cosmetic');
  });
});

describe('golden prompt snapshots', () => {
  it('builds a stable prompt for performance.v2', () => {
    const prompt = buildChunkPrompt({
      dimension: 'performance',
      chunk: chunk as never,
      prTitle: 'Load rows',
      prBody: null,
      version: 'v2',
    });
    expect(prompt.checklistVersion).toBe('v2');
    // The digest changes only when the prompt does — which is the signal that
    // a version bump is due.
    expect(digest(prompt.text)).toMatchInlineSnapshot(`"286b7fb174929645"`);
  });

  it('builds a stable prompt for code_health.v2', () => {
    const prompt = buildChunkPrompt({
      dimension: 'code_health',
      chunk: chunk as never,
      prTitle: 'Load rows',
      prBody: null,
      version: 'v2',
    });
    expect(prompt.checklistVersion).toBe('v2');
    expect(digest(prompt.text)).toMatchInlineSnapshot(`"5bc704f1ceef06bf"`);
  });

  it('records the version it ran, so a finding is reproducible', () => {
    const v1 = buildChunkPrompt({
      dimension: 'performance',
      chunk: chunk as never,
      prTitle: 'x',
      prBody: null,
      version: 'v1',
    });
    const v2 = buildChunkPrompt({
      dimension: 'performance',
      chunk: chunk as never,
      prTitle: 'x',
      prBody: null,
      version: 'v2',
    });
    expect(v1.checklistVersion).toBe('v1');
    expect(v2.checklistVersion).toBe('v2');
    expect(v1.text).not.toBe(v2.text);
  });
});
