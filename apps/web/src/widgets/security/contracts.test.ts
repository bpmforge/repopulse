import { describe, expect, it } from 'vitest';
import {
  dependencyEmptyCopy,
  hasMeasuredCount,
  ranSuccessfully,
  SCANNER_STATE_LABEL,
  type ScannerState,
  type ScannerStatus,
} from './contracts.js';

// W17-20. "No findings" is only good news after a run that could have found
// some; every sentence here exists to keep the other cases from borrowing it.

const scanner = (over: Partial<ScannerStatus> = {}): ScannerStatus => ({
  key: 'dependency_cve',
  display_name: 'Dependencies',
  registered: true,
  enabled: true,
  state: 'ok',
  last_run_at: '2026-09-01T00:00:00Z',
  last_run_status: 'succeeded',
  error: null,
  scanner_version: 'v1',
  validation_funnel: null,
  open_findings: 0,
  ...over,
});

describe('hasMeasuredCount', () => {
  it('only a finished run has a count worth printing', () => {
    const measured: ScannerState[] = ['ok', 'error', 'partial'];
    for (const state of Object.keys(SCANNER_STATE_LABEL) as ScannerState[]) {
      expect(hasMeasuredCount(state), state).toBe(measured.includes(state));
    }
  });
});

describe('ranSuccessfully', () => {
  it('is true for ok and partial, and for nothing that did not measure', () => {
    expect(ranSuccessfully({ state: 'ok' })).toBe(true);
    expect(ranSuccessfully({ state: 'partial' })).toBe(true);
    for (const state of [
      'never_run',
      'not_enabled',
      'running',
      'stale',
      'error',
      'nothing_scanned',
      'all_rejected',
    ] as const) {
      expect(ranSuccessfully({ state }), state).toBe(false);
    }
  });
});

describe('dependencyEmptyCopy', () => {
  it('a scanner that ran clean is the ONE case that is a measurement', () => {
    const copy = dependencyEmptyCopy(scanner({ state: 'ok', open_findings: 0 }));
    expect(copy).toMatch(/IS a measurement/);
    expect(copy).not.toMatch(/not a clean bill/i);
  });

  it('a scanner that ran and left findings does not claim a clean list', () => {
    // The cves array is empty in this build whatever the scanner found
    // (W8-06), so an "ok" row with open findings must send the reader to
    // where they are listed rather than say "none".
    const copy = dependencyEmptyCopy(scanner({ state: 'ok', open_findings: 3 }));
    expect(copy).toMatch(/3 open findings/);
    expect(copy).not.toMatch(/found no known/i);
  });

  it('every state that did not measure says it is not a clean bill of health', () => {
    for (const state of [
      'not_enabled',
      'never_run',
      'stale',
      'error',
      'nothing_scanned',
      'all_rejected',
    ] as const) {
      expect(dependencyEmptyCopy(scanner({ state })), state).toMatch(/not a clean bill of health/i);
    }
    expect(dependencyEmptyCopy(scanner({ state: 'partial' }))).toMatch(
      /not a clean bill of health/i,
    );
    expect(dependencyEmptyCopy(undefined)).toMatch(/not a clean bill of health/i);
    expect(dependencyEmptyCopy(scanner({ registered: false }))).toMatch(/not in this build/i);
  });

  it('never run, failed and running are three different sentences', () => {
    const neverRun = dependencyEmptyCopy(scanner({ state: 'never_run' }));
    const failed = dependencyEmptyCopy(scanner({ state: 'error' }));
    const running = dependencyEmptyCopy(scanner({ state: 'running' }));
    expect(neverRun).toMatch(/never run/i);
    expect(failed).toMatch(/failed/i);
    expect(running).toMatch(/running now/i);
    expect(new Set([neverRun, failed, running]).size).toBe(3);
  });
});
