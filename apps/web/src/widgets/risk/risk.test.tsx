import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { RiskBandChip } from '../../components/risk/RiskBandChip.js';
import { RiskDecompositionPopover } from '../../components/risk/RiskDecompositionPopover.js';
import { RISK_BAND_LABEL, type RiskFactors } from './contracts.js';

// Risk primitives (W9-11, RISK_MODEL.md §2/§3, FR-RISK-5).

const factors: RiskFactors = {
  H: 0.8,
  L: 0.7,
  X: 0.625,
  inputs: { dimension: 'sast', severity: 4, epss: null, hotspot_percentile: 0.5 },
  model_version: 'risk_model.v1',
};

describe('the band chip', () => {
  it('shows a VERB, in words, not colour alone', () => {
    render(<RiskBandChip band="act" />);
    expect(screen.getByTestId('risk-band-chip').textContent).toBe(RISK_BAND_LABEL.act);
    expect(RISK_BAND_LABEL.act).toMatch(/act/);
  });

  it('says NOT YET PRICED rather than implying low risk', () => {
    // An unpriced finding has not been judged harmless — the nightly job has
    // simply not reached it.
    render(<RiskBandChip band={null} />);
    expect(screen.getByTestId('risk-band-chip').textContent).toMatch(/not yet priced/);
    expect(screen.getByTestId('risk-band-chip').getAttribute('data-band')).toBe('unpriced');
  });
});

describe('the decomposition popover', () => {
  it('shows raw severity beside the risk number, always', () => {
    // RISK_MODEL §2 honesty rule: the composite never appears alone.
    render(<RiskDecompositionPopover factors={factors} effectiveRisk={35} severity={4} />);
    expect(screen.getByTestId('risk-score').textContent).toBe('35.00');
    expect(screen.getByTestId('risk-severity').textContent).toBe('sev 4');
  });

  it('multiplies the SERVED factors, so the arithmetic matches the engine', () => {
    render(<RiskDecompositionPopover factors={factors} effectiveRisk={35} severity={4} />);
    fireEvent.click(screen.getByTestId('risk-why'));
    const popover = screen.getByTestId('risk-popover');
    // 100 × 0.8 × 0.7 × 0.625 = 35.00 — the same number the API stored.
    expect(popover.textContent).toContain('35.00');
    expect(popover.textContent).toContain('risk_model.v1');
  });

  it('prints a null input as "not measured" rather than omitting the row', () => {
    // An absent row would read as though the factor did not apply.
    render(<RiskDecompositionPopover factors={factors} effectiveRisk={35} severity={4} />);
    fireEvent.click(screen.getByTestId('risk-why'));
    expect(screen.getByTestId('risk-popover').textContent).toContain('not measured');
  });

  it('offers no "why" when there is nothing to show', () => {
    render(<RiskDecompositionPopover factors={null} effectiveRisk={null} severity={2} />);
    expect(screen.queryByTestId('risk-why')).toBeNull();
    expect(screen.getByTestId('risk-score').textContent).toBe('not priced');
  });
});
