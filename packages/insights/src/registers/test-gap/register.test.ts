import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  TEST_GAP_DEFAULTS,
  isIgnoredPath,
  isTestPath,
  quantile,
  testGapFindings,
  type FileChangeStats,
  type RepoTestState,
} from './register.js';
import { priceFinding } from '../../risk/price.js';

// Test-gap register (W10-04, FR-REG-6).

const file = (over: Partial<FileChangeStats> & { path: string }): FileChangeStats => ({
  commits: 10,
  commitsWithTests: 0,
  churn: 500,
  ...over,
});

const state = (files: FileChangeStats[], hasNoTests = false): RepoTestState => ({
  files,
  hasNoTests,
  sourceFiles: files.length,
});

describe('test-file classification', () => {
  it('recognises the convention of every ecosystem we claim to support', () => {
    for (const testFile of [
      'src/cart.test.ts',
      'src/cart.spec.js',
      'src/__tests__/cart.tsx',
      'test/helpers.js',
      'tests/api/test_login.py',
      'test_login.py',
      'login_test.py',
      'conftest.py',
      'server_test.go',
      'src/test/java/CartTest.java',
      'CartTests.kt',
      'spec/models/user_spec.rb',
      'PaymentTests.cs',
    ]) {
      expect(isTestPath(testFile), testFile).toBe(true);
    }
  });

  it('does not mistake source files for tests', () => {
    for (const source of [
      'src/cart.ts',
      'src/testing-utils.ts',
      'src/latest.py',
      'src/contest.go',
      'lib/protest.rb',
    ]) {
      expect(isTestPath(source), source).toBe(false);
    }
  });

  it('reads a source file with inline tests as SOURCE', () => {
    // A Rust module with a #[cfg(test)] block is not a test file. Counting it
    // as one would let a repo with no separate tests look fully tested.
    expect(isTestPath('src/parser.rs')).toBe(false);
  });

  it('ignores generated and non-code paths', () => {
    expect(isIgnoredPath('node_modules/x/index.js')).toBe(true);
    expect(isIgnoredPath('pnpm-lock.yaml')).toBe(true);
    expect(isIgnoredPath('src/cart.ts')).toBe(false);
  });
});

describe('hot files without test co-change', () => {
  const hotSet = (): FileChangeStats[] => [
    file({ path: 'src/hot-untested.ts', churn: 1000, commits: 20, commitsWithTests: 0 }),
    file({ path: 'src/hot-tested.ts', churn: 900, commits: 20, commitsWithTests: 18 }),
    file({ path: 'src/cold.ts', churn: 10, commits: 6, commitsWithTests: 0 }),
    file({ path: 'src/quiet.ts', churn: 800, commits: 2, commitsWithTests: 0 }),
  ];

  it('flags the hot file whose changes never ship with a test', () => {
    const { findings } = testGapFindings(state(hotSet()));
    expect(findings.map((f) => f.file)).toEqual(['src/hot-untested.ts']);
    expect(findings[0]!.severity).toBe(3);
  });

  it('leaves a hot file alone when its changes do ship with tests', () => {
    const { findings } = testGapFindings(state(hotSet()));
    expect(findings.map((f) => f.file)).not.toContain('src/hot-tested.ts');
  });

  it('does not report a COLD file, however untested', () => {
    const { findings } = testGapFindings(state(hotSet()));
    expect(findings.map((f) => f.file)).not.toContain('src/cold.ts');
  });

  it('ignores a file too rarely changed to judge', () => {
    // High churn in two commits is one big refactor, not a habit.
    const { findings } = testGapFindings(state(hotSet()));
    expect(findings.map((f) => f.file)).not.toContain('src/quiet.ts');
  });

  it('separates "never" from "sometimes" in severity and title', () => {
    const { findings } = testGapFindings(
      state([
        file({ path: 'src/never.ts', churn: 1000, commits: 20, commitsWithTests: 0 }),
        file({ path: 'src/rarely.ts', churn: 1000, commits: 20, commitsWithTests: 2 }),
      ]),
    );
    const never = findings.find((f) => f.file === 'src/never.ts')!;
    const rarely = findings.find((f) => f.file === 'src/rarely.ts')!;
    expect(never.severity).toBe(3);
    expect(rarely.severity).toBe(2);
    expect(rarely.title).toContain('10%');
  });

  it('gives every finding DISTINCT evidence', () => {
    // Identical evidence collides on the findings dedup key and fails the
    // whole write — the defect W10-02's integration test caught.
    const { findings } = testGapFindings(
      state([
        file({ path: 'src/a.ts', churn: 1000, commits: 20, commitsWithTests: 0 }),
        file({ path: 'src/b.ts', churn: 1000, commits: 20, commitsWithTests: 0 }),
      ]),
    );
    expect(new Set(findings.map((f) => f.evidence)).size).toBe(findings.length);
  });

  it('reports "no distribution to rank against" rather than a clean result', () => {
    // Every file below the commit floor: there is no churn distribution, and
    // silence here would read as "no test gaps".
    const result = testGapFindings(state([file({ path: 'src/a.ts', commits: 1 })]));
    expect(result.findings).toEqual([]);
    expect(result.notRun.map((n) => n.ruleId)).toEqual(['test_gap.hot_file']);
  });

  it('honours a tuned threshold rather than only its default', () => {
    const files = [file({ path: 'src/a.ts', churn: 1000, commits: 20, commitsWithTests: 6 })];
    // 30% co-change: above the 0.2 default, below a 0.5 tuning.
    expect(testGapFindings(state(files)).findings).toEqual([]);
    expect(
      testGapFindings(state(files), { ...TEST_GAP_DEFAULTS, minCoChangeRate: 0.5 }).findings,
    ).toHaveLength(1);
  });

  it('takes a quantile off a sorted series, and null off an empty one', () => {
    expect(quantile([1, 2, 3, 4], 0.75)).toBe(3);
    expect(quantile([], 0.75)).toBeNull();
  });
});

describe('a repository with no tests at all', () => {
  it('produces EXACTLY ONE repo-scoped finding, not per-file noise', () => {
    const files = Array.from({ length: 40 }, (_, i) =>
      file({ path: `src/mod${i}.ts`, churn: 900, commits: 12 }),
    );
    const { findings } = testGapFindings(state(files, true));
    expect(findings).toHaveLength(1);
    expect(findings[0]!.file).toBeNull();
    expect(findings[0]!.ruleId).toBe('test_gap.no_tests');
  });

  it('labels its basis, including what it does NOT prove', () => {
    const { findings } = testGapFindings(state([file({ path: 'src/a.ts' })], true));
    expect(findings[0]!.evidence).toContain('not a coverage measurement');
    expect(findings[0]!.evidence).toContain('90 days');
  });

  it('says nothing at all about a repo with no changes in the window', () => {
    const result = testGapFindings(state([], true));
    expect(result.findings).toEqual([]);
    expect(result.notRun[0]!.reason).toContain('nothing to say');
  });
});

describe('D12 pricing (FR-REG-7)', () => {
  it('prices a test_gap finding and serves a reproducible decomposition', () => {
    const priced = priceFinding({
      dimension: 'test_gap',
      severity: 3,
      confidence: 4,
      hotspotPercentile: 0.9,
    });
    expect(
      Math.round(100 * priced.riskFactors.H * priced.riskFactors.L * priced.riskFactors.X * 100) /
        100,
    ).toBe(priced.effectiveRisk);
    expect(priced.band).toBeTruthy();
  });

  it('prices a hot file above the same finding in a cold one', () => {
    const hot = priceFinding({
      dimension: 'test_gap',
      severity: 3,
      confidence: 4,
      hotspotPercentile: 0.95,
    });
    const cold = priceFinding({
      dimension: 'test_gap',
      severity: 3,
      confidence: 4,
      hotspotPercentile: 0.05,
    });
    expect(hot.effectiveRisk).toBeGreaterThan(cold.effectiveRisk);
    // The cold one still SCORES — a floor, not a disappearance.
    expect(cold.effectiveRisk).toBeGreaterThan(0);
  });
});

describe('coverage ingestion is provably absent (acceptance item 3)', () => {
  // Coverage x churn is PARKED: it needs a forge-budget review first (Law 7).
  // Asserted rather than promised, because the parked decision is only real if
  // nothing quietly implements it.
  const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

  /** git grep exits 1 when it finds nothing, which is this test's pass case. */
  function gitGrep(pattern: string): string {
    try {
      // --untracked so a file added in this working tree and not yet
      // committed is still searched; without it the gate would pass on a
      // coverage parser that simply had not been committed yet.
      return execFileSync(
        'git',
        [
          'grep',
          '-lIE',
          '--untracked',
          pattern,
          '--',
          'packages',
          'apps',
          // This file names the formats in order to search for them.
          ':(exclude)packages/insights/src/registers/test-gap/register.test.ts',
          // W21-05: lists of popular package NAMES (PyPI ships `codecov`), the
          // targets typosquats imitate. Data, not a parser.
          ':(exclude)packages/security/rulepacks/slopsquat/popular',
        ],
        {
          cwd: repoRoot,
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      ).trim();
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (status === 1) return '';
      throw error;
    }
  }

  it('ships no coverage parser, uploader or ingestion path', () => {
    expect(gitGrep('(lcov|cobertura|coverage-final|clover\\.xml|jacoco|codecov)')).toBe('');
  });

  it('proves the grep can find things, so an empty result means something', () => {
    // A search that would return empty either way is not an assertion.
    expect(gitGrep('test_gap\\.hot_file')).not.toBe('');
  });
});
