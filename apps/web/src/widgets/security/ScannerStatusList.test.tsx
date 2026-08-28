import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ScannerStatusList } from './ScannerStatusList.js';
import { SCANNER_STATE_LABEL, type ScannerStatus } from './contracts.js';

// The Security tab's honest half (W8-10, NFR-15).

const scanner = (over: Partial<ScannerStatus> = {}): ScannerStatus => ({
  key: 'secrets',
  display_name: 'Secrets',
  registered: true,
  enabled: true,
  state: 'ok',
  last_run_at: '2026-08-19T00:00:00.000Z',
  last_run_status: 'succeeded',
  error: null,
  scanner_version: 'secrets.v1',
  open_findings: 0,
  ...over,
});

describe('scanner coverage table', () => {
  it('shows a DASH, not a zero, for a scanner that has never looked', () => {
    // A zero is a claim. "0 open findings" from a scanner nobody enabled is
    // the sentence this whole screen exists to avoid printing.
    render(
      <ScannerStatusList
        scanners={[
          scanner({ key: 'off', state: 'not_enabled', enabled: false, open_findings: 0 }),
          scanner({ key: 'new', state: 'never_run', open_findings: 0 }),
        ]}
      />,
    );
    const off = screen.getByTestId('scanner-row-off');
    const never = screen.getByTestId('scanner-row-new');
    expect(off.textContent).toContain('—');
    expect(never.textContent).toContain('—');
    expect(off.textContent).toContain(SCANNER_STATE_LABEL.not_enabled);
    expect(never.textContent).toContain(SCANNER_STATE_LABEL.never_run);
  });

  it('shows a real zero for a scanner that RAN and found nothing', () => {
    render(<ScannerStatusList scanners={[scanner({ state: 'ok', open_findings: 0 })]} />);
    const row = screen.getByTestId('scanner-row-secrets');
    expect(row.textContent).toContain('0');
    expect(screen.getByTestId('scanner-state-secrets').textContent).toBe(SCANNER_STATE_LABEL.ok);
  });

  it('does not put a tick on a run that scanned nothing (W16-31)', () => {
    // The state W16-28 created rows for. "✓ ran clean" on a sweep with no
    // commits in range is a measurement claimed for work that did not happen,
    // and the sentence underneath was contradicting the label above it.
    render(
      <ScannerStatusList
        scanners={[
          scanner({
            state: 'nothing_scanned',
            open_findings: 0,
            error: 'No commits in range to sweep — nothing was scanned.',
          }),
        ]}
      />,
    );
    const label = screen.getByTestId('scanner-state-secrets').textContent ?? '';
    expect(label).toBe(SCANNER_STATE_LABEL.nothing_scanned);
    expect(label).not.toContain('✓');
    expect(label).not.toContain('clean');
    // A dash, like the other states where nobody looked: a zero here would be
    // the same claim in the count column.
    expect(screen.getByTestId('scanner-row-secrets').textContent).toContain('—');
    expect(screen.getByTestId('scanner-error-secrets').textContent).toContain(
      'nothing was scanned',
    );
  });

  it('says a partial run is partial — an unflagged one reads as clean', () => {
    render(<ScannerStatusList scanners={[scanner({ state: 'partial', open_findings: 3 })]} />);
    expect(screen.getByTestId('scanner-state-secrets').textContent).toContain('incomplete');
  });

  it('says what to DO about a missing scan image, not just that it failed (W16-11)', () => {
    // F16: a screen that states a tool is missing and stops there has told
    // someone their scan failed and left them to guess. The scanners run in a
    // sandbox image, and one command builds it.
    render(
      <ScannerStatusList
        scanners={[scanner({ state: 'error', error: 'spawn podman ENOENT' })]}
      />,
    );
    const fix = screen.getByTestId('scanner-fix-secrets');
    expect(fix.textContent).toContain('Containerfile.scan');
    expect(fix.textContent).toContain('RUNNING.md');
    // The scanner's own words are still there — the guidance is added, never
    // substituted for the error.
    expect(screen.getByTestId('scanner-error-secrets').textContent).toContain('spawn podman ENOENT');
  });

  it('recognises the shapes a missing image ACTUALLY produces (W16-11)', () => {
    // Observed by running the demo against SCAN_IMAGE pointed at an image that
    // does not exist. The first heuristic matched neither of these, so the rows
    // that most needed the build command were the ones that did not get it.
    for (const error of ['dependency_cruiser: exit 125', 'perf pack run failed: opengrep produced no output']) {
      const { unmount } = render(
        <ScannerStatusList scanners={[scanner({ state: 'error', error })]} />,
      );
      expect(screen.getByTestId('scanner-fix-secrets').textContent, error).toContain(
        'Containerfile.scan',
      );
      unmount();
    }
  });

  it('does NOT offer the image command for a failure that is not about tools', () => {
    render(
      <ScannerStatusList
        scanners={[scanner({ state: 'error', error: 'ciphertext too short' })]}
      />,
    );
    expect(screen.queryByTestId('scanner-fix-secrets')).toBeNull();
  });

  it('an unregistered scanner is "not in this build", not "(not installed)" (W16-11)', () => {
    // "(not installed)" read as a missing TOOL — something you could go and
    // install — and for these rows it never was.
    render(<ScannerStatusList scanners={[scanner({ registered: false })]} />);
    const row = screen.getByTestId('scanner-row-secrets');
    expect(row.textContent).toContain('not in this build');
    expect(row.textContent).not.toContain('not installed');
  });

  it('prints the failure verbatim, so "why is this red" needs no log search', () => {
    render(
      <ScannerStatusList
        scanners={[scanner({ state: 'error', error: 'archive request returned 404' })]}
      />,
    );
    expect(screen.getByTestId('scanner-error-secrets').textContent).toBe(
      'archive request returned 404',
    );
  });

  it('keeps a documented-but-absent scanner visible', () => {
    // Hiding it would make its absence look deliberate. The WORDING changed in
    // W16-11 — "(not installed)" implied a tool you could go and install, and
    // it never was one — but the row still has to be there.
    render(<ScannerStatusList scanners={[scanner({ key: 'iac', registered: false })]} />);
    expect(screen.getByTestId('scanner-row-iac').textContent).toContain('not in this build');
  });

  it('states each state in WORDS, never colour alone (UX_SPEC §7)', () => {
    for (const label of Object.values(SCANNER_STATE_LABEL)) {
      expect(label.replace(/[○·✓✕!]/g, '').trim().length).toBeGreaterThan(3);
    }
  });
});
