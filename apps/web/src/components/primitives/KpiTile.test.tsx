import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { KpiTile } from './KpiTile.js';

// The tile's caption is the product's central rule in miniature: a delta that
// was never computed must not look like a delta of zero, and each absence has
// to name itself well enough that a reader knows what to do about it.
describe('KpiTile delta caption', () => {
  it('renders a measured delta, a measured zero and an absent delta distinguishably', () => {
    const { rerender } = render(<KpiTile label="Cycle time" value="4.1" unit="d" deltaPct={-5} />);
    expect(screen.getByTestId('trend-delta')).toHaveAttribute('data-trend', 'down');

    rerender(<KpiTile label="Cycle time" value="4.1" unit="d" deltaPct={0} />);
    const flat = screen.getByTestId('trend-delta');
    expect(flat).toHaveAttribute('data-trend', 'flat');
    expect(flat).not.toHaveAttribute('data-missing');
    // A real 0% is a measurement: it keeps its digits and says "unchanged".
    expect(flat).toHaveTextContent('0.0%');
    expect(flat).toHaveAccessibleName(/unchanged versus prior window/i);

    rerender(<KpiTile label="Cycle time" value="4.1" unit="d" deltaPct={null} />);
    const none = screen.getByTestId('trend-delta');
    expect(none).toHaveAttribute('data-trend', 'none');
    expect(none).toHaveTextContent(/no prior window/i);
    expect(none).not.toHaveTextContent('0');
  });

  it('says the metric is not compared when the caller omits a delta', () => {
    // Every My Focus tile omits deltaPct: those counts are never windowed
    // against a prior, so claiming "no prior window" there would be false.
    render(<KpiTile label="Open PRs" value="7" polarity="neutral" />);
    const caption = screen.getByTestId('trend-delta');
    expect(caption).toHaveAttribute('data-missing', 'not-compared');
    expect(caption).toHaveTextContent(/not compared to an earlier window/i);
    expect(caption).toHaveAccessibleName(/not compared to an earlier window/i);
  });

  it('explains an unmeasured value rather than blaming a missing prior window', () => {
    render(<KpiTile label="Median PR size" value={null} unit="lines" deltaPct={null} />);
    const caption = screen.getByTestId('trend-delta');
    expect(caption).toHaveAttribute('data-missing', 'not-measured');
    expect(caption).toHaveTextContent(/not measured/i);
  });

  it('keeps the caption quiet and never leaves a bare glyph in its place', () => {
    render(<KpiTile label="Open PRs" value="7" />);
    const caption = screen.getByTestId('trend-delta');
    expect(caption.className).toMatch(/text-fg-faint/);
    expect(caption.textContent?.trim()).not.toBe('—');
  });
});
