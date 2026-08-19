import { describe, expect, it } from 'vitest';
import { computeLdr, docstringInflation, ldrFindings, LDR_FLOOR } from './ldr.js';

// Logic density (W9-03, CODE_HEALTH_SUITE.md §1, FR-CH-3).

/** A file with exactly `logic` logic lines and `overhead` overhead lines. */
function build(logic: number, overhead: number): string {
  const lines: string[] = [];
  for (let i = 0; i < overhead; i++) lines.push(`// overhead line ${i}`);
  for (let i = 0; i < logic; i++) lines.push(`const value${i} = ${i} + 1;`);
  return lines.join('\n');
}

describe('the LDR boundary', () => {
  it('counts logic and overhead separately', () => {
    const ldr = computeLdr(
      ['import fs from "node:fs";', '', '// a comment', 'type T = string;', 'const a = 1;'].join(
        '\n',
      ),
    );
    expect(ldr).toMatchObject({ logic: 1, imports: 1, blank: 1, comment: 1, typeOnly: 1 });
    expect(ldr.overhead).toBe(4);
    expect(ldr.ratio).toBeCloseTo(0.2, 5);
  });

  it('fires BELOW the floor and not at or above it', () => {
    // 0.29 and 0.31 either side of 0.3, built from real line counts rather
    // than asserted arithmetic: 29 logic / 71 overhead is 0.29 exactly.
    const below = build(29, 71);
    const above = build(31, 69);
    expect(computeLdr(below).ratio).toBeCloseTo(0.29, 5);
    expect(computeLdr(above).ratio).toBeCloseTo(0.31, 5);

    expect(ldrFindings([{ path: 'below.ts', source: below }])).toHaveLength(1);
    expect(ldrFindings([{ path: 'above.ts', source: above }])).toEqual([]);

    // Exactly at the floor is NOT below it.
    const atFloor = build(30, 70);
    expect(computeLdr(atFloor).ratio).toBeCloseTo(LDR_FLOOR, 5);
    expect(ldrFindings([{ path: 'at.ts', source: atFloor }])).toEqual([]);
  });

  it('is NULL for an empty file, not zero', () => {
    // A ratio over nothing is not a low ratio, and 0 would report every empty
    // file as maximally sloppy.
    expect(computeLdr('').ratio).toBeNull();
    expect(ldrFindings([{ path: 'empty.ts', source: '' }])).toEqual([]);
  });

  it('does not let a block comment marker inside a string swallow the file', () => {
    // The bug this guards: a regex over the whole file treats the `/*` in a
    // string literal as the start of a comment and returns an LDR near zero —
    // which looks exactly like a finding.
    const source = ['const pattern = "/*";', 'const a = 1;', 'const b = 2;'].join('\n');
    expect(computeLdr(source).comment).toBe(0);
    expect(computeLdr(source).logic).toBe(3);
  });

  it('counts a real block comment as overhead, to its end', () => {
    const source = ['/**', ' * Doc.', ' */', 'const a = 1;'].join('\n');
    expect(computeLdr(source)).toMatchObject({ comment: 3, logic: 1 });
  });

  it('reports the counts, so the arithmetic can be argued with', () => {
    const [finding] = ldrFindings([{ path: 'x.ts', source: build(5, 95) }]);
    expect(finding?.message).toContain('5 lines of logic');
    expect(finding?.message).toContain('95 of overhead');
    expect(finding?.breakdown.comment).toBe(95);
  });
});

describe('docstring inflation, per exported symbol', () => {
  it('fires when the doc is more than 3x the implementation', () => {
    // Ten doc lines over a three-line function. The ratio has to genuinely
    // EXCEED 3 — an earlier version of this test used a seven-line block and
    // expected a finding at 2.33, which would have meant the threshold was
    // not doing what it says.
    const source = [
      '/**',
      ' * Fetches a user.',
      ' *',
      ' * @param id the id of the user',
      ' * @returns the user record',
      ' * @throws never, in practice',
      ' * @example getUser(1)',
      ' * @see the user table',
      ' * @since v1',
      ' */',
      'export function getUser(id) {',
      '  return db.get(id);',
      '}',
    ].join('\n');
    const [finding] = docstringInflation('user.ts', source);
    expect(finding?.symbol).toBe('getUser');
    expect(finding?.docLines).toBe(10);
    expect(finding?.implLines).toBe(3);
    expect(finding?.ratio).toBeCloseTo(3.33, 1);
  });

  it('does NOT fire on a doc block proportionate to real work', () => {
    const source = [
      '/**',
      ' * Reconciles the ledger.',
      ' */',
      'export function reconcile(rows) {',
      ...Array.from({ length: 20 }, (_, i) => `  const step${i} = rows[${i}];`),
      '  return rows;',
      '}',
    ].join('\n');
    expect(docstringInflation('ledger.ts', source)).toEqual([]);
  });

  it('does not fire on a FILE HEADER that documents nothing', () => {
    // A header comment is not inflation, and a rule that says so would train
    // people to delete the most useful comments in the codebase.
    const source = ['/**', ' * This module explains itself.', ' */', '', '// not an export'].join(
      '\n',
    );
    expect(docstringInflation('header.ts', source)).toEqual([]);
  });

  it('measures PER SYMBOL, not per file', () => {
    // The failure has a shape: a twelve-line block over a three-line wrapper,
    // in a file that also contains the function doing the actual work. A
    // file-level average washes that out.
    const source = [
      '/**',
      ' * A wrapper.',
      ' *',
      ' * @param a the first thing',
      ' * @param b the second thing',
      ' * @returns the combined thing',
      ' * @example wrap(1, 2)',
      ' * @see inner',
      ' * @since v1',
      ' */',
      'export function wrap(a, b) {',
      '  return inner(a, b);',
      '}',
      '',
      '/** Does the work. */',
      'export function inner(a, b) {',
      ...Array.from({ length: 15 }, (_, i) => `  const s${i} = ${i};`),
      '  return a + b;',
      '}',
    ].join('\n');
    const findings = docstringInflation('mixed.ts', source);
    expect(findings.map((f) => f.symbol)).toEqual(['wrap']);
  });
});
