import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  ValidationFunnelPanel,
  openDependencyFindings,
  scopedCount,
} from './ValidationFunnelPanel.js';
import {
  VEX_JUSTIFICATION_LABEL,
  type ScannerStatus,
  type ValidationFunnel,
  type VexSummary,
} from './contracts.js';

// The dependency honesty funnel (W8-14, FR-SEC-15).
//
// Every test here is about a number that must NOT be printed, or one that must.
// The raw count is the credibility of the small count; an unmeasured funnel is
// not a clean one; and a ladder whose rungs do not add up has to say so.

const funnel = (over: Partial<ValidationFunnel> = {}): ValidationFunnel => ({
  raw: 47,
  deduped: 31,
  withAliases: 12,
  scoped: {
    prodDirect: 20,
    prodTransitive: 5,
    dev: 4,
    notInResolvedSet: 2,
    versionMismatch: 0,
    unreadable: 0,
  },
  usage: { imported: 10, notImported: 15, unknown: 6 },
  reachability: { symbolReachable: 1, provenUnreachable: 2, imported: 10, manifestOnly: 18 },
  proposed: {},
  dismissed: 0,
  ...over,
});

const vex = (over: Partial<VexSummary> = {}): VexSummary => ({
  statements: 0,
  not_affected: 0,
  affected: 0,
  fixed: 0,
  by_justification: {
    component_not_present: 0,
    vulnerable_code_not_present: 0,
    vulnerable_code_not_in_execute_path: 0,
    vulnerable_code_cannot_be_controlled_by_adversary: 0,
    inline_mitigations_already_exist: 0,
  },
  ...over,
});

/** The payload shape the Security tab really hands the panel. */
const scanners = (open: number, over: Partial<ScannerStatus> = {}): ScannerStatus[] => [
  {
    key: 'secrets',
    display_name: 'Secrets',
    registered: true,
    enabled: true,
    state: 'ok',
    last_run_at: null,
    last_run_status: null,
    error: null,
    scanner_version: null,
    open_findings: 4,
  },
  {
    key: 'dependency_cve',
    display_name: 'Dependencies',
    registered: true,
    enabled: true,
    state: 'ok',
    last_run_at: '2026-08-19T00:00:00.000Z',
    last_run_status: 'succeeded',
    error: null,
    scanner_version: 'syft@1.51.0 grype@0.117.0',
    open_findings: open,
    ...over,
  },
];

describe('the derivations the mount relies on', () => {
  it('counts only vulnerabilities a lockfile placed', () => {
    // 31 deduped − (2 unplaced + 0 unreadable).
    expect(scopedCount(funnel())).toBe(29);
  });

  it('returns null, not zero, when the dependency scanner has never looked', () => {
    // The rule the scanner table already follows: a zero from a scanner nobody
    // ran is a claim it has not earned.
    expect(openDependencyFindings(scanners(9, { state: 'never_run' }))).toBeNull();
    expect(openDependencyFindings(scanners(9, { state: 'not_enabled' }))).toBeNull();
    expect(openDependencyFindings([])).toBeNull();
    expect(openDependencyFindings(scanners(9))).toBe(9);
  });
});

describe('the funnel never hides the raw count', () => {
  it('shows raw beside deduped, and says what the gap was', () => {
    render(
      <ValidationFunnelPanel funnel={funnel()} recorded vex={vex()} scanners={scanners(31)} />,
    );
    expect(screen.getByTestId('funnel-raw').textContent).toContain('47');
    expect(screen.getByTestId('funnel-deduped').textContent).toContain('31');
    // The narrowing is explained, not just performed.
    expect(screen.getByTestId('funnel-deduped').textContent).toContain('16');
  });

  it('says UNMEASURED rather than printing zero when nothing recorded a funnel', () => {
    // The failure this guards: a row of zeroes on a security screen reads as
    // "clean", and a repository nobody has scanned is not clean.
    render(
      <ValidationFunnelPanel funnel={null} recorded={false} vex={vex()} scanners={scanners(0)} />,
    );
    expect(screen.getByTestId('funnel-unrecorded').textContent).toContain('unmeasured');
    expect(screen.queryByTestId('validation-funnel')).toBeNull();
  });

  it('keeps unscoped vulnerabilities visible instead of dropping them', () => {
    render(
      <ValidationFunnelPanel funnel={funnel()} recorded vex={vex()} scanners={scanners(31)} />,
    );
    const scoped = screen.getByTestId('funnel-scoped');
    expect(scoped.textContent).toContain('29');
    expect(scoped.textContent).toContain('still reported');
  });
});

describe('the ladder narrows only by what actually narrows', () => {
  it('adds up: deduped − suppressed = open, with affected annotating the open row', () => {
    // THE BUG THIS TEST EXISTS FOR. Rendering affected/not_affected/fixed/
    // under_investigation as four siblings under "of those 31" double-counts
    // every confirmed vulnerability, because an `affected` statement labels a
    // row that is still open rather than removing it.
    render(
      <ValidationFunnelPanel
        funnel={funnel()}
        recorded
        vex={vex({ statements: 4, not_affected: 3, affected: 1 })}
        scanners={scanners(28)}
      />,
    );
    expect(screen.getByTestId('funnel-suppressed').textContent).toContain('3');
    const open = screen.getByTestId('funnel-open').textContent ?? '';
    expect(open).toContain('28');
    // 1 confirmed real, 27 nobody has looked at.
    expect(open).toContain('1 of these');
    expect(open).toContain('27');
    expect(screen.queryByTestId('funnel-does-not-reconcile')).toBeNull();
  });

  it('SAYS SO when the statements and the last scan disagree', () => {
    // A statement written after the last scan, or one covering a package the
    // tree no longer has. Both real; both better read than smoothed over.
    render(
      <ValidationFunnelPanel
        funnel={funnel()}
        recorded
        vex={vex({ statements: 5, not_affected: 5 })}
        scanners={scanners(31)}
      />,
    );
    const note = screen.getByTestId('funnel-does-not-reconcile').textContent ?? '';
    expect(note).toContain('do not close');
    expect(note).toContain('26');
    expect(note).toContain('31');
  });

  it('shows a dash for the open count when the scanner has never run', () => {
    render(
      <ValidationFunnelPanel
        funnel={funnel()}
        recorded
        vex={vex()}
        scanners={scanners(0, { state: 'never_run' })}
      />,
    );
    const open = screen.getByTestId('funnel-open').textContent ?? '';
    expect(open).toContain('—');
    expect(open).toContain('has not run here');
    // And no arithmetic complaint, because there is no arithmetic to do.
    expect(screen.queryByTestId('funnel-does-not-reconcile')).toBeNull();
  });

  it('says plainly when nothing has been dismissed', () => {
    render(
      <ValidationFunnelPanel funnel={funnel()} recorded vex={vex()} scanners={scanners(31)} />,
    );
    expect(screen.getByTestId('funnel-suppressed').textContent).toContain('still reported');
    expect(screen.getByTestId('vex-no-justifications')).toBeTruthy();
  });
});

describe('per-justification breakdown', () => {
  it('lists ALL FIVE justifications, zeroes included', () => {
    // An absent row reads as a reason nobody may give. The point of a fixed
    // enum is that a reader sees the whole menu the triager chose from.
    render(
      <ValidationFunnelPanel
        funnel={funnel()}
        recorded
        vex={vex({
          statements: 2,
          not_affected: 2,
          by_justification: {
            component_not_present: 0,
            vulnerable_code_not_present: 0,
            vulnerable_code_not_in_execute_path: 2,
            vulnerable_code_cannot_be_controlled_by_adversary: 0,
            inline_mitigations_already_exist: 0,
          },
        })}
        scanners={scanners(29)}
      />,
    );
    for (const key of Object.keys(VEX_JUSTIFICATION_LABEL)) {
      expect(screen.getByTestId(`vex-justification-${key}`)).toBeTruthy();
    }
    expect(
      screen.getByTestId('vex-justification-vulnerable_code_not_in_execute_path').textContent,
    ).toContain('2');
  });

  it('states each justification in words a reader can disagree with', () => {
    for (const label of Object.values(VEX_JUSTIFICATION_LABEL)) {
      expect(label.length).toBeGreaterThan(10);
      // The enum token itself is not an explanation.
      expect(label).not.toMatch(/_/);
    }
  });
});

describe('machine proposals are never counted as decisions', () => {
  it('reports them separately and says nobody confirmed them', () => {
    render(
      <ValidationFunnelPanel
        funnel={funnel({ proposed: { vulnerable_code_not_in_execute_path: 9 } })}
        recorded
        vex={vex()}
        scanners={scanners(31)}
      />,
    );
    const proposed = screen.getByTestId('funnel-proposed').textContent ?? '';
    expect(proposed).toContain('9');
    expect(proposed).toContain('nobody has confirmed');
    // And they have NOT moved into the suppressed rung.
    expect(screen.getByTestId('funnel-suppressed').textContent).toContain('0');
  });
});
