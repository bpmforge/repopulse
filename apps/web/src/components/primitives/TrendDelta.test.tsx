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

  it('shows a muted em dash (not 0%) when there is no prior window', () => {
    render(<TrendDelta deltaPct={null} />);
    const el = screen.getByTestId('trend-delta');
    expect(el).toHaveAttribute('data-trend', 'none');
    expect(el).toHaveTextContent('—');
    expect(el).toHaveAccessibleName(/no prior window/i);
  });

  it('encodes tone by polarity: a rise is critical when down-is-good', () => {
    const { rerender } = render(<TrendDelta deltaPct={8} polarity="down-good" />);
    expect(screen.getByTestId('trend-delta').className).toMatch(/crit/);
    rerender(<TrendDelta deltaPct={-8} polarity="down-good" />);
    expect(screen.getByTestId('trend-delta').className).toMatch(/ok/);
  });
});
