import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { TrendDelta } from './TrendDelta.js';

describe('TrendDelta', () => {
  it('renders an up arrow + magnitude and an accessible label', () => {
    render(<TrendDelta deltaPct={12} polarity="up-good" />);
    const el = screen.getByTestId('trend-delta');
    expect(el).toHaveAttribute('data-trend', 'up');
    expect(el).toHaveTextContent('▲');
    expect(el).toHaveTextContent('12%');
    expect(el).toHaveAccessibleName(/up 12% versus prior window/i);
  });

  it('names the reason (not 0%, not a bare dash) when there is no prior window', () => {
    render(<TrendDelta deltaPct={null} />);
    const el = screen.getByTestId('trend-delta');
    expect(el).toHaveAttribute('data-trend', 'none');
    expect(el).toHaveAttribute('data-missing', 'no-prior-window');
    expect(el).toHaveTextContent(/no prior window to compare/i);
    expect(el).toHaveAccessibleName(/no prior window/i);
  });

  it('distinguishes the absences a dash used to flatten together', () => {
    const { rerender } = render(<TrendDelta deltaPct={null} missingReason="not-compared" />);
    expect(screen.getByTestId('trend-delta')).toHaveTextContent(/not compared to an earlier/i);
    rerender(<TrendDelta deltaPct={null} missingReason="not-measured" />);
    expect(screen.getByTestId('trend-delta')).toHaveTextContent(/not measured/i);
  });

  it('reads a measured zero as a measurement, keeping digits on screen', () => {
    render(<TrendDelta deltaPct={0} />);
    const el = screen.getByTestId('trend-delta');
    expect(el).toHaveAttribute('data-trend', 'flat');
    expect(el).toHaveTextContent('0.0%');
    expect(el).toHaveAccessibleName(/unchanged versus prior window/i);
  });

  it('encodes tone by polarity: a rise is critical when down-is-good', () => {
    const { rerender } = render(<TrendDelta deltaPct={8} polarity="down-good" />);
    expect(screen.getByTestId('trend-delta').className).toMatch(/crit/);
    rerender(<TrendDelta deltaPct={-8} polarity="down-good" />);
    expect(screen.getByTestId('trend-delta').className).toMatch(/ok/);
  });
});
