import { describe, expect, it } from 'vitest';
import { rangesAsPatch, runSpecialists, type AnalysisGateway } from '@repopulse/analysis';
import { buildFocus, functionSpans } from './ai-focus.js';

// W27-08: each AI area reads the functions it needs, cut from the code map and
// the scanners' measurements. Pure: no database, no model.

const FILE = [
  'import { db } from "./db";', //                         1
  '', //                                                   2
  '/** Adds two numbers. */', //                           3
  'export function add(a: number, b: number) {', //        4
  '  return a + b;', //                                     5
  '}', //                                                  6
  '', //                                                   7
  'export async function listUsers(req) {', //            8
  '  for (const id of req.query.ids) {', //                9
  '    await db.query("select * from u where id=" + id);', // 10
  '  }', //                                                11
  '}', //                                                  12
  '', //                                                   13
  'export function label(n: number) {', //                14
  '  if (n > 1) return "many";', //                        15
  '  return "one";', //                                    16
  '}', //                                                  17
].join('\n');

const defs = [
  { path: 'src/users.ts', startLine: 4, endLine: 6 },
  { path: 'src/users.ts', startLine: 8, endLine: 12 },
  { path: 'src/users.ts', startLine: 14, endLine: 14 }, // regex tier: start only
];

const healthFinding = {
  file: 'src/users.ts',
  dimension: 'code_health',
  ruleId: 'complexity.cyclomatic',
  scannerKey: 'code_health_tools',
  lineStart: 14,
  lineEnd: 17,
};

describe('functionSpans', () => {
  it('keeps real spans and runs a one-line span to the next definition or the end', () => {
    expect(
      functionSpans(
        [
          { startLine: 4, endLine: 6 },
          { startLine: 8, endLine: 8 },
          { startLine: 14, endLine: 14 },
        ],
        17,
      ),
    ).toEqual([
      [4, 6],
      [8, 13],
      [14, 17],
    ]);
  });
});

describe('buildFocus', () => {
  const [focused] = buildFocus([{ path: 'src/users.ts', content: FILE }], {
    defs,
    findings: [healthFinding],
  });
  const focus = focused!.focus!;

  it('performance reads only the function with a loop or query', () => {
    expect(focus.performance).toEqual([[5, 12]]);
  });

  it('security reads only the function handling input and queries', () => {
    expect(focus.security).toEqual([[5, 12]]);
  });

  it('code health reads what the tools measured', () => {
    expect(focus.code_health).toEqual([[11, 17]]);
  });

  it('the other areas read the whole file', () => {
    expect(focus.best_practices).toBeUndefined();
    expect(focus.test_coverage).toBeUndefined();
    expect(focus.ai_slop).toBeUndefined();
  });

  it('a security rule hit pulls in the function around it, signal or not', () => {
    const [f] = buildFocus([{ path: 'src/users.ts', content: FILE }], {
      defs,
      findings: [{ ...healthFinding, dimension: 'secrets', scannerKey: 'secrets', lineStart: 5 }],
    });
    expect(f!.focus!.security).toEqual(
      expect.arrayContaining([
        [5, 12],
        [4, 6],
      ]),
    );
  });

  it('with nothing measured anywhere, code health reads whole files; a file of others gets []', () => {
    const [none] = buildFocus([{ path: 'src/users.ts', content: FILE }], { defs, findings: [] });
    expect(none!.focus!.code_health).toBeUndefined();
    const [other] = buildFocus([{ path: 'src/other.ts', content: 'export const x = 1;\n' }], {
      defs: [],
      findings: [healthFinding],
    });
    expect(other!.focus).toEqual({ code_health: [] });
  });

  it('a file the map does not cover is read whole by performance and security', () => {
    const [f] = buildFocus([{ path: 'src/users.ts', content: FILE }], { defs: [], findings: [] });
    expect(f!.focus).toBeUndefined();
  });

  it('a file with lots of top-level code is read whole by performance and security', () => {
    const script = [
      'export function f() {',
      '  return 1;',
      '}',
      ...Array.from({ length: 25 }, (_, i) => `run(${i});`),
    ].join('\n');
    const [f] = buildFocus([{ path: 'scripts/x.ts', content: script }], {
      defs: [{ path: 'scripts/x.ts', startLine: 1, endLine: 3 }],
      findings: [],
    });
    expect(f!.focus?.performance).toBeUndefined();
    expect(f!.focus?.security).toBeUndefined();
  });
});

describe('a focused module, end to end through the runner', () => {
  it('sends performance only its slice, with real line numbers, and its findings validate', async () => {
    const files = buildFocus([{ path: 'src/users.ts', content: FILE }], {
      defs,
      findings: [healthFinding],
    });
    const prompts: { role: string; prompt: string }[] = [];
    const gateway = {
      async complete(prompt: string, opts: { meta: { role: string } }) {
        prompts.push({ role: opts.meta.role, prompt });
        const quote = 'await db.query("select * from u where id=" + id);';
        const text = prompt.includes(quote)
          ? JSON.stringify({
              findings: [
                {
                  dimension: opts.meta.role,
                  severity: 3,
                  confidence: 4,
                  file: 'src/users.ts',
                  line_range: [10, 10],
                  title: 'query in a loop',
                  evidence_quote: quote,
                  rationale: 'n+1',
                  suggested_fix: null,
                },
              ],
            })
          : '{"findings":[]}';
        return { text, model: 'm', tokensIn: 10, tokensOut: 5, route: null };
      },
    } as unknown as AnalysisGateway;
    const r = await runSpecialists(
      { kind: 'module', name: 'm', files },
      { gateway, prTitle: 't', meta: { repoId: '1', prNumber: 0, initiator: 't' } },
    );
    const perf = prompts.find((p) => p.role === 'performance')!.prompt;
    expect(perf).toContain('@@ -0,0 +5,8 @@');
    expect(perf).not.toContain('export function add');
    expect(perf).not.toContain('return "one"');
    const health = prompts.find((p) => p.role === 'code_health')!.prompt;
    expect(health).toContain('return "one"');
    expect(health).not.toContain('db.query');
    expect(r.findings.find((f) => f.specialist === 'performance')?.line_range).toEqual([10, 10]);
  });

  it('rangesAsPatch bridges small gaps and keeps line numbers', () => {
    const p = rangesAsPatch('a\nb\nc\nd\ne\nf\ng\nh\ni\nj\n', [
      [1, 2],
      [5, 6],
      [10, 12],
    ]);
    // 7-9 is a gap of 3 lines: bridged, one hunk to the end of the file.
    expect(p).toBe('@@ -0,0 +1,10 @@\n+a\n+b\n+c\n+d\n+e\n+f\n+g\n+h\n+i\n+j');
    expect(
      rangesAsPatch('a\nb\nc\nd\ne\nf\ng\nh\ni\n', [
        [9, 9],
        [1, 1],
      ]),
    ).toBe('@@ -0,0 +1,1 @@\n+a\n@@ -0,0 +9,1 @@\n+i');
  });
});
