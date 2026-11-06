import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// W27-01, "pertinent code only": tests, fixtures, generated, vendored and built
// code are not measured for complexity or duplication. The sandbox is stubbed
// so the test reads both the command the tools were given (the tool-level
// exclusion) and what the scanner does with output that still names such a
// file (the backstop).

const calls: { command: string[] }[] = [];
let stdout = '';

vi.mock('../../../sandbox/run.js', () => ({
  runInSandbox: vi.fn(async (opts: { command: string[] }) => {
    calls.push(opts);
    return { status: 'succeeded', exitCode: 0, stderr: '', durationMs: 1, rawStdout: stdout };
  }),
  stderrTail: (s: string) => s,
}));

const {
  isOutOfScopeCodeHealth,
  jscpdIgnoreArg,
  lizardExcludeArgs,
  pertinentClones,
  runCodeHealthTools,
} = await import('./tools.js');

/** One lizard CSV row: nloc,ccn,tokens,params,length,location,file,name,long,start,end. */
const row = (file: string, name: string, ccn: number, start = 1, end = 10): string =>
  `${end - start + 1},${ccn},100,1,${end - start + 1},"${name}@${start}-${end}@/scan/${file}","/scan/${file}","${name}","${name}()",${start},${end}`;

const clone = (a: string, b: string) => ({
  firstFile: { name: `/scan/${a}`, start: 1, end: 20 },
  secondFile: { name: `/scan/${b}`, start: 5 },
  lines: 20,
});

function output(lizard: string[], clones: ReturnType<typeof clone>[]): string {
  return [
    lizard.join('\n'),
    '===JSCPD===',
    JSON.stringify({ statistics: { total: { percentage: 3 } }, duplicates: clones }),
  ].join('\n');
}

const run = () =>
  runCodeHealthTools({
    targetDir: mkdtempSync(path.join(tmpdir(), 'w27-01-')),
    image: 'stub',
    budget: { wallClockMs: 1000 },
    adapters: [],
  });

describe('code health measures production code only (W27-01)', () => {
  beforeEach(() => {
    calls.length = 0;
  });

  it('tells lizard and jscpd to skip non-production paths before reading them', async () => {
    stdout = output([], []);
    await run();
    const script = calls[0]!.command.join(' ');
    expect(script).toContain(`lizard --csv '-x' '*/test/*'`);
    expect(script).toContain(`'-x' '*/vendor/*'`);
    expect(script).toContain(`'-x' '*_test.go'`);
    expect(script).toContain(`'-x' '*.test.ts'`);
    expect(script).toContain(`--ignore '${jscpdIgnoreArg()}'`);
    expect(jscpdIgnoreArg()).toContain('**/node_modules/**');
    expect(jscpdIgnoreArg()).toContain('**/*_test.go');
    // Never a production look-alike.
    expect(lizardExcludeArgs()).not.toContain('*/builder/*');
  });

  it("a test file's complexity is not reported, nor counted in the metrics", async () => {
    stdout = output(
      [
        row('context.go', 'Handle', 25),
        row('context_test.go', 'TestHandle', 40),
        row('tests/test_api.py', 'test_big', 30),
        row('api/test_helpers.py', 'helper', 30),
        row('vendor/x/y.go', 'Vendored', 50),
        row('web/dist/app.min.js', 'm', 60),
        row('latest.go', 'Latest', 12),
      ],
      [],
    );
    const result = await run();
    const files = new Set(result.findings.map((f) => f.file));
    expect([...files].sort()).toEqual(['context.go', 'latest.go']);
    // Worst-function count and p90 are over the two production functions only.
    expect(result.metrics.ch_worst_fn_count).toBe(1);
    expect(result.metrics.ch_complexity_p90).toBeLessThanOrEqual(25);
  });

  it('duplication: dropped when every side is non-production, kept (from the production side) otherwise', async () => {
    stdout = output(
      [],
      [
        clone('a_test.go', 'b_test.go'),
        clone('fixtures/one.js', 'vendor/two.js'),
        clone('src/a.ts', 'src/b.ts'),
        clone('tests/helpers.ts', 'src/util.ts'),
      ],
    );
    const result = await run();
    const clones = result.findings.filter((f) => f.ruleId === 'duplication.clone');
    expect(clones.map((f) => f.file).sort()).toEqual(['src/a.ts', 'src/util.ts']);
    const swapped = clones.find((f) => f.file === 'src/util.ts')!;
    expect(swapped.lineStart).toBe(5);
    expect(swapped.lineEnd).toBe(24);
    expect(swapped.message).toContain('tests/helpers.ts:1');
  });

  it('pertinentClones keeps a production-to-production clone untouched', () => {
    const c = {
      file: 'a.go',
      startLine: 1,
      endLine: 9,
      duplicateFile: 'b.go',
      duplicateStartLine: 3,
      lines: 9,
    };
    expect(pertinentClones([c])).toEqual([c]);
  });

  it('isOutOfScopeCodeHealth: our rules and code-quality adapters, never IaC adapters', () => {
    expect(isOutOfScopeCodeHealth({ ruleId: 'complexity.cyclomatic', file: 'a_test.go' })).toBe(
      true,
    );
    expect(isOutOfScopeCodeHealth({ ruleId: 'duplication.clone', file: 'vendor/a.go' })).toBe(true);
    expect(isOutOfScopeCodeHealth({ ruleId: 'tool.ruff.F401', file: 'tests/t.py' })).toBe(true);
    expect(
      isOutOfScopeCodeHealth({ ruleId: 'tool.hadolint.DL3008', file: 'build/Dockerfile' }),
    ).toBe(false);
    expect(isOutOfScopeCodeHealth({ ruleId: 'complexity.cyclomatic', file: 'latest.go' })).toBe(
      false,
    );
    expect(isOutOfScopeCodeHealth({ ruleId: 'complexity.cyclomatic', file: null })).toBe(false);
  });
});
