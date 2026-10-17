import { render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { createQueryClient } from '../../api/queryClient.js';
import { CoverageMap } from './CoverageMap.js';
import { RulePrecisionSummary, RulePrecisionTable } from './RulePrecision.js';
import {
  benchmarkText,
  triageText,
  type CoverageMapPayload,
  type RulePrecisionReport,
} from './contracts.js';

// Trust surfaces (W18-22). The cases that matter are the ones with nothing to
// show: no number may appear where nothing was measured, and an empty coverage
// section must read as "checked, none" or "not known", never as a clean bill.

const SOURCE: RulePrecisionReport['benchmark'] = {
  ticket: 'W18-17',
  engine: 'semgrep 1.181.0',
  excludedSuites: [{ suite: 'rule-fixtures', reason: 'Each rule was written against them.' }],
};

const REPORT: RulePrecisionReport = {
  benchmark: SOURCE,
  rules: [
    {
      ruleId: 'bpm-perf-await-in-loop',
      lifecycle: 'pack',
      lifecycleSource: 'rulepack',
      findings: 40,
      triage: { triaged: 30, falsePositives: 6, precision: 0.8 },
      benchmark: { tp: 1, fp: 4, fn: 0, precision: 0.2, suites: ['changes'], engine: 'yaml' },
    },
    {
      ruleId: 'slop.unused_export',
      lifecycle: 'candidate',
      lifecycleSource: 'shipped default',
      findings: 0,
      triage: { triaged: 0, falsePositives: 0, precision: null },
      benchmark: null,
    },
  ],
};

const MAP: CoverageMapPayload = {
  repoId: 7,
  languages: {
    evidence: 'known',
    checked: 'File extensions of 9 distinct paths.',
    items: [{ language: 'go', files: 4 }],
    present: [
      { language: 'go', files: 4, packs: [], fastLane: false },
      { language: 'typescript', files: 5, packs: ['bpm-baseline.v1.yaml'], fastLane: true },
    ],
  },
  skippedFiles: {
    evidence: 'unknown',
    checked: 'No whole-tree read has completed for this repository.',
    items: [],
  },
  scanners: {
    evidence: 'known',
    checked: '9 scanners in the catalogue.',
    items: [
      { key: 'iac', label: 'iac', reason: 'not_supported', detail: 'Not implemented.' },
      { key: 'secrets', label: 'Secrets', reason: 'disabled', detail: 'Turned off.' },
    ],
  },
  shadowRules: { evidence: 'known', checked: 'Rules running in shadow.', items: [] },
};

let bodies: Record<string, unknown>;

beforeEach(() => {
  bodies = {};
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input);
      const key = Object.keys(bodies).find((k) => url.includes(k));
      return Promise.resolve(
        new Response(JSON.stringify(key ? bodies[key] : {}), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
});

afterEach(() => vi.unstubAllGlobals());

function wrap(node: ReactNode) {
  return render(<QueryClientProvider client={createQueryClient()}>{node}</QueryClientProvider>);
}

describe('precision text', () => {
  it('never turns an untriaged rule into a percentage', () => {
    const t = triageText({ triaged: 0, falsePositives: 0, precision: null });
    expect(t).toMatchObject({ value: 'not measured yet', measured: false });
  });

  it('a rule that raised nothing on the corpus has no benchmark precision', () => {
    const t = benchmarkText(
      { tp: 0, fp: 0, fn: 2, precision: null, suites: ['changes'], engine: 'yaml' },
      SOURCE,
    );
    expect(t.value).toBe('not measured yet');
    expect(t.basis).toMatch(/missed 2 labelled cases/);
  });

  it('carries the sample size and source, and flags a small sample', () => {
    const t = benchmarkText(
      { tp: 1, fp: 1, fn: 0, precision: 0.5, suites: ['x'], engine: 'yaml' },
      SOURCE,
    );
    expect(t).toMatchObject({ value: '50%', small: true, measured: true });
    expect(t.basis).toBe('1 of 2 raised were real · W18-17 benchmark, semgrep 1.181.0');
    expect(
      benchmarkText(
        { tp: 1, fp: 0, fn: 0, precision: 1, suites: ['x'], engine: 'fast-lane' },
        SOURCE,
      ).basis,
    ).toBe('1 of 1 raised were real · W18-17 benchmark, in-process');
    expect(triageText({ triaged: 30, falsePositives: 6, precision: 0.8 })).toMatchObject({
      value: '80%',
      small: false,
    });
  });
});

describe('benchmarkText for a tool adapter', () => {
  it('says the rule is a third-party tool run in the scan image, not the YAML engine', () => {
    const t = benchmarkText(
      { tp: 2, fp: 0, fn: 0, precision: 1, suites: ['iac-adapters'], engine: 'adapter' },
      SOURCE,
    );
    expect(t.basis).toBe('2 of 2 raised were real · W18-17 benchmark, tool run in the scan image');
    expect(t.small).toBe(true);
  });
});

describe('RulePrecisionTable', () => {
  it('shows both sources side by side with lifecycle, and "not measured yet" where empty', async () => {
    bodies['/rules/precision'] = REPORT;
    wrap(<RulePrecisionTable />);
    const triage = await screen.findByTestId('precision-triage-bpm-perf-await-in-loop');
    expect(triage.textContent).toMatch(/80%/);
    expect(triage.textContent).toMatch(/24 of 30 triaged/);
    expect(screen.getByTestId('precision-bench-bpm-perf-await-in-loop').textContent).toMatch(
      /20%.*small sample.*1 of 5 raised/,
    );
    const shadow = screen.getByTestId('precision-row-slop.unused_export');
    expect(shadow.dataset.lifecycle).toBe('candidate');
    expect(shadow.textContent).toMatch(/shadow/);
    expect(screen.getByTestId('precision-triage-slop.unused_export').dataset.measured).toBe(
      'false',
    );
    expect(screen.getByTestId('precision-bench-slop.unused_export').textContent).toMatch(
      /not measured yet/,
    );
    expect(screen.getByTestId('rule-precision-frame').textContent).toMatch(
      /excluding rule-fixtures/,
    );
  });
});

describe('RulePrecisionSummary (finding drawer)', () => {
  it('shows the one rule’s lifecycle and both measurements', async () => {
    bodies['/rules/precision'] = { ...REPORT, rules: [REPORT.rules[0]] };
    wrap(<RulePrecisionSummary ruleId="bpm-perf-await-in-loop" />);
    expect((await screen.findByTestId('finding-rule-lifecycle')).textContent).toMatch(/rulepack/);
    expect(screen.getByTestId('finding-rule-triage').textContent).toMatch(/80%/);
    expect(screen.getByTestId('finding-rule-bench').textContent).toMatch(/20%/);
  });

  it('says it could not load rather than silently dropping the section', async () => {
    wrap(<RulePrecisionSummary ruleId="bpm-x" />);
    expect(await screen.findByTestId('finding-rule-precision-unavailable')).toBeTruthy();
  });
});

describe('CoverageMap', () => {
  it('renders every section with what it checked; unknown and none are distinct', async () => {
    bodies['/repos/7/coverage-map'] = MAP;
    wrap(<CoverageMap repoId={7} />);
    const languages = await screen.findByTestId('coverage-languages');
    expect(languages.dataset.evidence).toBe('known');
    expect(screen.getByTestId('coverage-language-go').textContent).toMatch(/4 files/);

    const skipped = screen.getByTestId('coverage-skipped');
    expect(skipped.dataset.evidence).toBe('unknown');
    expect(skipped.textContent).toMatch(/not known yet/);
    expect(skipped.textContent).not.toMatch(/none/);

    const shadow = screen.getByTestId('coverage-shadow');
    expect(shadow.textContent).toMatch(/— none/);
    expect(screen.getByTestId('coverage-shadow-checked').textContent).toMatch(/shadow/);

    expect(screen.getByTestId('coverage-scanner-iac').dataset.reason).toBe('not_supported');
    expect(screen.getByTestId('coverage-scanners-disabled').textContent).toMatch(
      /turned off here.*Secrets/,
    );
    // Actionable gaps come before facts about the release.
    const groups = [
      ...screen
        .getByTestId('coverage-scanners')
        .querySelectorAll('[data-testid^="coverage-scanners-"]'),
    ]
      .map((g) => g.getAttribute('data-testid'))
      .filter((id) => !id?.endsWith('-checked'));
    expect(groups).toEqual(['coverage-scanners-disabled', 'coverage-scanners-not_supported']);
  });

  it('no check marks and no grade anywhere on the panel (D15, N-9)', async () => {
    bodies['/repos/7/coverage-map'] = {
      ...MAP,
      languages: { ...MAP.languages, items: [] },
      scanners: { ...MAP.scanners, items: [] },
    };
    wrap(<CoverageMap repoId={7} />);
    const panel = await screen.findByTestId('coverage-languages');
    const text = panel.closest('[data-testid="coverage-map"]')?.textContent ?? '';
    expect(text).not.toMatch(/✓|all clear|grade|score/i);
  });

  it('a malformed payload is an error, not an empty panel', async () => {
    wrap(<CoverageMap repoId={7} />);
    await waitFor(() =>
      expect(screen.getByTestId('coverage-map').textContent).toMatch(/could not be read/),
    );
  });
});

describe('public benchmark accuracy (W18-40)', () => {
  it('says so when no public benchmark has been run, and shows no numbers', async () => {
    bodies['/rules/precision'] = REPORT;
    wrap(<RulePrecisionTable />);
    expect(await screen.findByTestId('public-benchmark-empty')).toBeTruthy();
    expect(screen.queryByTestId('public-benchmark-table')).toBeNull();
  });

  it('lists every CWE with its date, including the ones scored 0% detected', async () => {
    bodies['/rules/precision'] = {
      ...REPORT,
      benchmark: {
        ...SOURCE,
        publicSuites: [{ id: 'owasp-benchmark', title: 'OWASP Benchmark (Java) v1.2' }],
        measured: { date: '2026-10-16', commit: 'abc' },
        cwes: [
          {
            suite: 'owasp-benchmark',
            cwe: 89,
            tp: 60,
            fn: 40,
            fp: 5,
            tn: 95,
            tpr: 0.6,
            fpr: 0.05,
            youden: 0.55,
          },
          {
            suite: 'owasp-benchmark',
            cwe: 643,
            tp: 0,
            fn: 10,
            fp: 0,
            tn: 10,
            tpr: 0,
            fpr: 0,
            youden: 0,
          },
        ],
      },
    };
    wrap(<RulePrecisionTable />);
    const sql = await screen.findByTestId('public-benchmark-owasp-benchmark-89');
    expect(sql.textContent).toMatch(/OWASP Benchmark \(Java\) v1\.2/);
    expect(sql.textContent).toMatch(/60\.0% \(60 of 100\)/);
    expect(sql.textContent).toMatch(/5\.0% \(5 of 100\)/);
    expect(sql.textContent).toMatch(/0\.55/);
    const bad = screen.getByTestId('public-benchmark-owasp-benchmark-643');
    expect(bad.textContent).toMatch(/0\.0% \(0 of 10\)/);
    expect(screen.getByTestId('public-benchmark').textContent).toMatch(/2026-10-16/);
  });
});
