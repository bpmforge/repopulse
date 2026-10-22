import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DebtTargetsPanel } from './DebtTargets.js';
import { debtTargetToForm, debtTargetsFromForm } from './contracts.js';
import { targetLine } from '../../../routes/repos/$repoId/code-health.js';

// W20-24 (UX_TODO DSH-31; decision 2026-10-21): per-workspace debt-signal
// targets in Settings, none by default; Code Health shows target vs current.

describe('debt signal targets (W20-24, DSH-31)', () => {
  it('turns the form into stored units: blank is no target, percent to ratio', () => {
    expect(debtTargetsFromForm({ M13: '5', ch_complexity_p90: '12', M14: '' })).toEqual({
      targets: { M13: 0.05, ch_complexity_p90: 12 },
    });
    expect(debtTargetsFromForm({})).toEqual({ targets: {} });
    expect(debtTargetToForm('M13', 0.05)).toBe('5');
    expect(debtTargetToForm('ch_duplication_pct', 3)).toBe('3');
    expect(debtTargetToForm('M14', undefined)).toBe('');
  });

  it('refuses a negative, an over-100 percentage or a fractional count, saying which', () => {
    expect(debtTargetsFromForm({ M14: '-1' })).toEqual({
      problem: 'Revert rate: enter a number of 0 or more.',
    });
    expect(debtTargetsFromForm({ ch_duplication_pct: '120' })).toEqual({
      problem: 'Duplication: a percentage is at most 100.',
    });
    expect(debtTargetsFromForm({ ch_worst_fn_count: '2.5' })).toEqual({
      problem: 'Worst functions: enter a whole number.',
    });
  });

  it('saves what was typed and shows the problem instead of saving a bad value', () => {
    const onSave = vi.fn();
    render(<DebtTargetsPanel effective={{}} isDefaulted saving={false} onSave={onSave} />);
    expect(screen.getByText(/No targets are set/)).toBeTruthy();
    fireEvent.change(screen.getByTestId('debt-target-M13'), { target: { value: '150' } });
    fireEvent.click(screen.getByTestId('save-debt-targets'));
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByTestId('debt-targets-error').textContent).toMatch(/Rework 14d/);
    fireEvent.change(screen.getByTestId('debt-target-M13'), { target: { value: '4' } });
    fireEvent.click(screen.getByTestId('save-debt-targets'));
    expect(onSave).toHaveBeenCalledWith({ M13: 0.04 });
  });

  it('clears every target in one step once some are set', () => {
    const onSave = vi.fn();
    render(
      <DebtTargetsPanel
        effective={{ M14: 0.02 }}
        isDefaulted={false}
        saving={false}
        onSave={onSave}
      />,
    );
    expect((screen.getByTestId('debt-target-M14') as HTMLInputElement).value).toBe('2');
    fireEvent.click(screen.getByTestId('clear-debt-targets'));
    expect(onSave).toHaveBeenCalledWith({});
  });

  it('reads target vs current in the signal’s own unit', () => {
    expect(targetLine(0.03, 0.05, { ratio: true })).toEqual({
      text: 'within target (at most 5%)',
      met: true,
    });
    expect(targetLine(0.08, 0.05, { ratio: true })).toEqual({
      text: '3% over the target of 5%',
      met: false,
    });
    expect(targetLine(14, 10, { suffix: ' cyclomatic' })).toEqual({
      text: '4 cyclomatic over the target of 10 cyclomatic',
      met: false,
    });
    // No target, or nothing measured: no line at all.
    expect(targetLine(14, undefined)).toBeNull();
    expect(targetLine(null, 10)).toBeNull();
  });
});
