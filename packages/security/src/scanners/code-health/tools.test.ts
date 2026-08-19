import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseJscpdReport, parseLizardCsv, percentile, runCodeHealthTools } from './tools.js';
import { CANON_THRESHOLDS, resolveThresholds, verdictsForFunction } from './thresholds.js';

// code_health_tools (W9-02, CODE_HEALTH_SUITE.md §2, FR-CH-2).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.resolve(HERE, '../../../fixtures/code-health-tools');

describe('canon thresholds', () => {
  it('has the documented defaults', () => {
    expect(CANON_THRESHOLDS).toMatchObject({
      complexityWarn: 10,
      complexityCritical: 20,
      functionLines: 50,
      fileLines: 300,
      parameters: 4,
      duplicationPct: 5,
    });
  });

  it('treats an absent override as "use the canon value", never as zero', () => {
    // A 0 threshold would flag every function in the repository, which is the
    // failure mode where someone sets one field and the tool goes off.
    expect(resolveThresholds({ complexityWarn: 15 })).toMatchObject({
      complexityWarn: 15,
      functionLines: 50,
    });
    expect(resolveThresholds()).toEqual(CANON_THRESHOLDS);
  });

  it('fires ABOVE the threshold, never AT it', () => {
    const t = CANON_THRESHOLDS;
    expect(verdictsForFunction({ ccn: 10, length: 10, parameters: 2 }, t)).toEqual([]);
    expect(verdictsForFunction({ ccn: 11, length: 10, parameters: 2 }, t)).toHaveLength(1);
    expect(verdictsForFunction({ ccn: 1, length: 50, parameters: 2 }, t)).toEqual([]);
    expect(verdictsForFunction({ ccn: 1, length: 51, parameters: 2 }, t)).toHaveLength(1);
    expect(verdictsForFunction({ ccn: 1, length: 10, parameters: 4 }, t)).toEqual([]);
    expect(verdictsForFunction({ ccn: 1, length: 10, parameters: 5 }, t)).toHaveLength(1);
  });

  it('separates warn from critical complexity', () => {
    const t = CANON_THRESHOLDS;
    expect(verdictsForFunction({ ccn: 15, length: 1, parameters: 0 }, t)[0]?.severity).toBe(2);
    expect(verdictsForFunction({ ccn: 21, length: 1, parameters: 0 }, t)[0]?.severity).toBe(3);
  });

  it('never claims a security severity', () => {
    // Complexity is not exploitability. At severity 4 a long function would
    // outrank a real vulnerability in every list that sorts by severity.
    const worst = verdictsForFunction({ ccn: 500, length: 5000, parameters: 40 }, CANON_THRESHOLDS);
    for (const verdict of worst) expect(verdict.severity).toBeLessThanOrEqual(3);
  });
});

describe('parsing what the tools actually print', () => {
  it('reads lizard CSV, stripping the mount point', () => {
    const csv = '4,5,43,5,4,"f@1-4@/scan/x.js","/scan/x.js","f","f ( a )",1,4';
    const [fn] = parseLizardCsv(csv);
    expect(fn).toMatchObject({
      file: 'x.js',
      name: 'f',
      ccn: 5,
      parameters: 5,
      length: 4,
      startLine: 1,
      endLine: 4,
    });
  });

  it('skips a row whose metrics are not numbers, rather than storing NaN', () => {
    // A header line or a tool-format change; guessing would put "NaN > 10"
    // into a finding.
    expect(parseLizardCsv('NLOC,CCN,token,PARAM,length,location,file,name,long,1,2')).toEqual([]);
  });

  it('reads a jscpd report and its percentage', () => {
    const report = parseJscpdReport(
      JSON.stringify({
        statistics: { total: { percentage: 42.5 } },
        duplicates: [
          {
            firstFile: { name: '/scan/a.js', start: 1, end: 9 },
            secondFile: { name: '/scan/b.js', start: 3 },
            lines: 8,
          },
        ],
      }),
    );
    expect(report.percentage).toBe(42.5);
    expect(report.clones[0]).toMatchObject({ file: 'a.js', duplicateFile: 'b.js', lines: 8 });
  });

  it('survives an empty report', () => {
    expect(parseJscpdReport('{}')).toEqual({ percentage: 0, clones: [] });
  });

  it('p90 over an empty set is NULL, not zero', () => {
    // A 0 here would draw a flat healthy line on the complexity trend for a
    // repository nobody has measured.
    expect(percentile([], 90)).toBeNull();
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90)).toBe(9);
    expect(percentile([5], 90)).toBe(5);
  });
});

// The live half: both tools, in the sandbox, over the boundary fixture.
const scanImage = (() => {
  try {
    return execFileSync('podman', ['images', '--format', '{{.Repository}}:{{.Tag}}'], {
      stdio: 'pipe',
    })
      .toString()
      .split('\n')
      .map((s) => s.trim())
      .find((s) => s.startsWith('localhost/repopulse/scan:'));
  } catch {
    return undefined;
  }
})();

const describeIfScanImage = scanImage ? describe : describe.skip;

describeIfScanImage('lizard + jscpd, actually run (FR-CH-2)', () => {
  const budget = { wallClockMs: 240_000, forgeCalls: 0, llmTokens: 0, memoryMb: 2048 };

  it('every threshold edge lands on the right side', async () => {
    // The fixtures were written against the real tool's own measurements —
    // ccTen really measures 10, lenFiftyOne really measures 51 — so this pins
    // the boundary through the parser, the thresholds AND lizard itself.
    const result = await runCodeHealthTools({
      targetDir: FIXTURES,
      image: scanImage as string,
      budget,
    });

    expect(result.status, result.error ?? '').toBe('succeeded');

    // Asserted PER RULE, because the fixtures cross more than one threshold
    // each: the CC pair needs nine and ten parameters to reach its complexity,
    // so it legitimately trips the parameter rule too. Checking "does ccTen
    // appear anywhere" would have called that a bug.
    const flaggedBy = (rule: string): string[] =>
      result.findings.filter((f) => f.ruleId === rule).map((f) => f.title);

    expect(flaggedBy('complexity.cyclomatic').some((t) => t.includes('ccEleven'))).toBe(true);
    expect(flaggedBy('complexity.cyclomatic').some((t) => t.includes('ccTen'))).toBe(false);
    expect(flaggedBy('complexity.function_length').some((t) => t.includes('lenFiftyOne'))).toBe(
      true,
    );
    expect(flaggedBy('complexity.function_length').some((t) => t.endsWith('lenFifty'))).toBe(false);
    expect(flaggedBy('complexity.parameters').some((t) => t.includes('paramsFive'))).toBe(true);
    expect(flaggedBy('complexity.parameters').some((t) => t.endsWith('paramsFour'))).toBe(false);

    // Every finding states the number AND the threshold it crossed: a reader
    // who disagrees with the threshold can see exactly what to change.
    for (const finding of result.findings) {
      expect(finding.measured).toBeGreaterThan(finding.threshold);
    }
  }, 600_000);

  it('reports duplication and a posture percentage', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'w9-02-dup-'));
    const source = readFileSync(path.join(FIXTURES, 'boundary.js'), 'utf8');
    writeFileSync(path.join(dir, 'one.js'), source);
    writeFileSync(path.join(dir, 'two.js'), source);

    const result = await runCodeHealthTools({
      targetDir: dir,
      image: scanImage as string,
      budget,
    });
    expect(result.status, result.error ?? '').toBe('succeeded');
    expect(result.findings.some((f) => f.ruleId === 'duplication.clone')).toBe(true);
    expect(result.metrics.ch_duplication_pct).toBeGreaterThan(0);
    expect(result.metrics.ch_complexity_p90).not.toBeNull();
  }, 600_000);

  it('a broken tool run FAILS the scan rather than reporting a clean tree', async () => {
    // NFR-15: the isolation that matters is that a failure cannot present as
    // "no findings", which is what a scanner returning [] on error would do.
    const result = await runCodeHealthTools({
      targetDir: FIXTURES,
      image: 'localhost/repopulse/does-not-exist:never',
      budget: { ...budget, wallClockMs: 30_000 },
    });
    expect(result.status).toBe('failed');
    expect(result.findings).toEqual([]);
    expect(result.metrics.ch_complexity_p90).toBeNull();
  }, 120_000);
});
