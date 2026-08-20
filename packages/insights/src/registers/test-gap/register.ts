import { and, eq, gte, sql } from 'drizzle-orm';
import { facts, type Database } from '@repopulse/shared';

// Test-gap register (W10-04, FR-REG-6, D13).
//
// The question: which files does this team change constantly WITHOUT touching
// a test in the same commit. Not "which files lack coverage" — that needs a
// coverage feed, which is PARKED (a forge-budget review has to happen first,
// Law 7), and nothing here reads or ingests one.
//
// Co-change is a weaker signal than coverage and it is honest about being one:
// a file can be perfectly covered by tests that live elsewhere and never move.
// What it does catch is the pattern that actually precedes incidents — a hot
// file whose changes ship without anyone editing a test, week after week.
//
// Pure warehouse SQL. No forge call, no model, no snapshot.

export const TEST_GAP_WINDOW_DAYS = 90;

export interface TestGapThresholds {
  /** Below this share of test-touching commits, a hot file is a gap. */
  minCoChangeRate: number;
  /** Files changed fewer times than this are too quiet to judge. */
  minCommits: number;
  /** Churn quantile a file must reach to count as hot. */
  hotQuantile: number;
}

export const TEST_GAP_DEFAULTS: TestGapThresholds = {
  // 0.2 rather than 0.5: plenty of legitimate commits are renames, config
  // changes or comment fixes. A file below one-in-five is not "sometimes
  // untested", it is a habit.
  minCoChangeRate: 0.2,
  minCommits: 5,
  hotQuantile: 0.75,
};

/**
 * Is this a test file?
 *
 * Per-ecosystem heuristics, listed rather than clever, because every one of
 * them is a convention some community actually uses:
 *
 *   JS/TS      *.test.ts, *.spec.js, __tests__/, test/, tests/
 *   Python     test_*.py, *_test.py, tests/, conftest.py
 *   Go         *_test.go
 *   Java/Kotlin  *Test.java, *Tests.kt, src/test/
 *   Ruby       *_spec.rb, spec/, test/
 *   Rust       tests/, benches/
 *   C#         *Tests.cs, *Test.cs
 *
 * A file that is BOTH a source file and a test — a Rust module with a
 * `#[cfg(test)]` block, a Go file with an inline example — reads as source
 * here. Counting it as a test would let a repo with no separate tests look
 * fully tested, which is the failure this register exists to catch.
 */
export function isTestPath(path: string): boolean {
  const lower = path.toLowerCase();
  const segments = lower.split('/');
  const name = segments[segments.length - 1] ?? '';

  const inTestDir = segments
    .slice(0, -1)
    .some((segment) => ['test', 'tests', '__tests__', 'spec', 'specs', 'testing'].includes(segment));
  if (inTestDir) return true;

  return (
    /\.(test|spec)\.[jt]sx?$/.test(name) ||
    /^test_.+\.py$/.test(name) ||
    /_test\.(py|go|rb|ts|js)$/.test(name) ||
    /^conftest\.py$/.test(name) ||
    /(test|tests)\.(java|kt|cs)$/.test(name) ||
    /_spec\.rb$/.test(name)
  );
}

/** Files the register never reports on: generated, vendored, or not code. */
export function isIgnoredPath(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.startsWith('node_modules/') ||
    lower.startsWith('vendor/') ||
    lower.includes('/node_modules/') ||
    lower.endsWith('.md') ||
    lower.endsWith('.json') ||
    lower.endsWith('.lock') ||
    lower.endsWith('.yaml') ||
    lower.endsWith('.yml') ||
    lower.endsWith('.svg') ||
    lower.endsWith('.snap')
  );
}

export interface FileChangeStats {
  path: string;
  /** Commits in the window that touched this file. */
  commits: number;
  /** Of those, how many also touched at least one test file. */
  commitsWithTests: number;
  /** Added + deleted lines over the window — the churn the hot rank uses. */
  churn: number;
}

export interface RepoTestState {
  files: FileChangeStats[];
  /** True when NO test file appears anywhere in the window. */
  hasNoTests: boolean;
  /** Total source files considered, the denominator for the basis label. */
  sourceFiles: number;
}

/**
 * Per-file change stats over the window.
 *
 * One query for the touches, folded in memory: the co-change question is
 * "did the SAME COMMIT touch a test", which needs the commit's whole file
 * list, and pushing the test-path heuristics into SQL would put a regex
 * dialect between the rules and the fixtures that prove them.
 */
export async function fileChangeStats(
  db: Database,
  repoId: number,
  windowStart: Date,
): Promise<RepoTestState> {
  const rows = await db
    .select({
      commitId: facts.commitFiles.commitId,
      path: facts.commitFiles.path,
      churn: sql<number>`(${facts.commitFiles.additions} + ${facts.commitFiles.deletions})::int`,
    })
    .from(facts.commitFiles)
    .innerJoin(facts.commits, eq(facts.commitFiles.commitId, facts.commits.id))
    .where(
      and(
        eq(facts.commits.repoId, repoId),
        gte(facts.commits.authoredAt, windowStart),
        // Merges carry no authorship signal about the code itself, and a merge
        // that touches 400 files would make every one of them look hot.
        eq(facts.commits.isMerge, false),
      ),
    );

  const byCommit = new Map<number, { path: string; churn: number }[]>();
  for (const row of rows) {
    const bucket = byCommit.get(row.commitId) ?? [];
    bucket.push({ path: row.path, churn: row.churn });
    byCommit.set(row.commitId, bucket);
  }

  const stats = new Map<string, FileChangeStats>();
  let anyTestFile = false;

  for (const files of byCommit.values()) {
    const touchedTest = files.some((file) => isTestPath(file.path));
    if (touchedTest) anyTestFile = true;

    for (const file of files) {
      if (isTestPath(file.path) || isIgnoredPath(file.path)) continue;
      const entry = stats.get(file.path) ?? {
        path: file.path,
        commits: 0,
        commitsWithTests: 0,
        churn: 0,
      };
      entry.commits += 1;
      if (touchedTest) entry.commitsWithTests += 1;
      entry.churn += file.churn;
      stats.set(file.path, entry);
    }
  }

  const files = [...stats.values()].sort((a, b) => b.churn - a.churn || a.path.localeCompare(b.path));
  return { files, hasNoTests: !anyTestFile, sourceFiles: files.length };
}

export interface TestGapFinding {
  dimension: 'test_gap';
  /** null on the repo-scoped no-tests finding. */
  file: string | null;
  ruleId: 'test_gap.hot_file' | 'test_gap.no_tests';
  severity: number;
  title: string;
  evidence: string;
  recommendation: string;
  coChangeRate: number | null;
  commits: number | null;
}

export interface TestGapResult {
  findings: TestGapFinding[];
  /** Detections that could not run, with the reason. Never a silent zero. */
  notRun: { ruleId: string; reason: string }[];
  hotThreshold: number | null;
}

/** Value at a quantile of a sorted-ascending series. */
export function quantile(values: readonly number[], q: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
  return sorted[rank]!;
}

export function testGapFindings(
  state: RepoTestState,
  thresholds: TestGapThresholds = TEST_GAP_DEFAULTS,
): TestGapResult {
  // A repo with no tests at all gets ONE finding, not one per file. Six
  // hundred findings that all say the same thing is not more information than
  // one that says it clearly, and it would bury every other dimension.
  if (state.hasNoTests) {
    if (state.sourceFiles === 0) {
      return {
        findings: [],
        notRun: [
          {
            ruleId: 'test_gap.no_tests',
            reason: 'no source-file changes in the window, so there is nothing to say about tests',
          },
        ],
        hotThreshold: null,
      };
    }
    return {
      findings: [
        {
          dimension: 'test_gap',
          file: null,
          ruleId: 'test_gap.no_tests',
          severity: 3,
          title: 'No test files changed anywhere in this repository',
          // BASIS LABELLED: what was measured, over what window, and what it
          // does not prove. A repo may have tests that simply never move.
          evidence: `Across ${state.sourceFiles} changed source files in the last ${TEST_GAP_WINDOW_DAYS} days, no commit touched a file matching any test convention. This is a statement about the last ${TEST_GAP_WINDOW_DAYS} days of history, not a coverage measurement — a repository with tests nobody edits looks the same from here.`,
          recommendation:
            'Confirm whether tests exist at all. If they do and simply never change, that is worth knowing too.',
          coChangeRate: null,
          commits: null,
        },
      ],
      notRun: [],
      hotThreshold: null,
    };
  }

  const eligible = state.files.filter((file) => file.commits >= thresholds.minCommits);
  const hotThreshold = quantile(
    eligible.map((file) => file.churn),
    thresholds.hotQuantile,
  );

  if (hotThreshold === null) {
    return {
      findings: [],
      notRun: [
        {
          ruleId: 'test_gap.hot_file',
          reason: `no file was changed at least ${thresholds.minCommits} times in the window, so there is no churn distribution to rank against`,
        },
      ],
      hotThreshold: null,
    };
  }

  const findings: TestGapFinding[] = [];
  for (const file of eligible) {
    if (file.churn < hotThreshold) continue;
    const rate = file.commitsWithTests / file.commits;
    if (rate >= thresholds.minCoChangeRate) continue;

    findings.push({
      dimension: 'test_gap',
      file: file.path,
      ruleId: 'test_gap.hot_file',
      // A file that NEVER ships with a test is a different case from one that
      // sometimes does, and the severity says which.
      severity: file.commitsWithTests === 0 ? 3 : 2,
      title:
        file.commitsWithTests === 0
          ? `Changed ${file.commits} times, never with a test: ${file.path}`
          : `${Math.round(rate * 100)}% of changes ship with a test: ${file.path}`,
      evidence: `${file.path} — ${file.commits} commits in ${TEST_GAP_WINDOW_DAYS} days, ${file.commitsWithTests} of them also touching a test file, ${file.churn} lines changed (top-quartile churn, threshold ${hotThreshold}).`,
      recommendation:
        'Add a test alongside the next change here. Co-change is not coverage — this file may be tested elsewhere — but a hot file whose tests never move is where regressions land.',
      coChangeRate: Math.round(rate * 100) / 100,
      commits: file.commits,
    });
  }

  return { findings, notRun: [], hotThreshold };
}
