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

  it('says a partial run is partial — an unflagged one reads as clean', () => {
    render(<ScannerStatusList scanners={[scanner({ state: 'partial', open_findings: 3 })]} />);
    expect(screen.getByTestId('scanner-state-secrets').textContent).toContain('incomplete');
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

  it('keeps a documented-but-not-installed scanner visible', () => {
    // Hiding it would make its absence look deliberate.
    render(<ScannerStatusList scanners={[scanner({ key: 'iac', registered: false })]} />);
    expect(screen.getByTestId('scanner-row-iac').textContent).toContain('not installed');
  });

  it('states each state in WORDS, never colour alone (UX_SPEC §7)', () => {
    for (const label of Object.values(SCANNER_STATE_LABEL)) {
      expect(label.replace(/[○·✓✕!]/g, '').trim().length).toBeGreaterThan(3);
    }
  });
});
