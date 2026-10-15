import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HealthBadge, healthBand } from './HealthBadge.js';
import { SeverityBadge } from './SeverityBadge.js';
import { SyncStatusChip } from './SyncStatusChip.js';
import { Sparkline } from './Sparkline.js';
import { KpiTile } from './KpiTile.js';

describe('HealthBadge', () => {
  it('bands scores good/watch/attend at 75 and 50', () => {
    expect(healthBand(90)).toBe('good');
    expect(healthBand(75)).toBe('good');
    expect(healthBand(74)).toBe('watch');
    expect(healthBand(50)).toBe('watch');
    expect(healthBand(49)).toBe('attend');
  });

  it('always renders the number next to the band (color never alone) and rounds', () => {
    render(<HealthBadge score={82.4} />);
    const el = screen.getByTestId('health-badge');
    expect(el).toHaveAttribute('data-band', 'good');
    expect(el).toHaveTextContent('82');
    expect(el).toHaveAccessibleName(/health score 82 of 100, healthy/i);
  });

  it('renders an em dash for a null score', () => {
    render(<HealthBadge score={null} />);
    expect(screen.getByTestId('health-badge')).toHaveTextContent('—');
  });
});

describe('SeverityBadge', () => {
  it('labels with the severity word and exposes the level', () => {
    render(<SeverityBadge severity="critical" />);
    const el = screen.getByTestId('severity-badge');
    expect(el).toHaveAttribute('data-severity', 'critical');
    expect(el).toHaveTextContent(/critical/i);
  });
  it('shows a state word instead of the severity word when given one', () => {
    render(<SeverityBadge severity="low" label="passed" />);
    const el = screen.getByTestId('severity-badge');
    expect(el).toHaveAttribute('data-severity', 'low');
    expect(el).toHaveTextContent('passed');
    expect(el).not.toHaveTextContent(/low/i);
  });
});

describe('SyncStatusChip', () => {
  it('shows the connection label when idle', () => {
    render(<SyncStatusChip connection="open" />);
    expect(screen.getByTestId('sync-status-chip')).toHaveTextContent('Live');
  });
  it('shows phase + percent while backfilling', () => {
    render(<SyncStatusChip connection="open" progress={{ phase: 'history', pct: 42 }} />);
    expect(screen.getByTestId('sync-status-chip')).toHaveTextContent('history — 42%');
  });
});

describe('Sparkline', () => {
  it('is an aria-labelled img and degrades gracefully with <2 points', () => {
    const { rerender } = render(<Sparkline points={[1, 2, 3]} label="cycle time" />);
    expect(screen.getByTestId('sparkline')).toHaveAttribute('aria-label', 'cycle time');
    rerender(<Sparkline points={[1]} label="cycle time" />);
    expect(screen.getByTestId('sparkline')).toHaveAccessibleName(/not enough data/i);
  });
});

describe('KpiTile', () => {
  it('renders value + unit and an em dash when null', () => {
    const { rerender } = render(<KpiTile label="Cycle time" value="4.1" unit="d" deltaPct={-5} />);
    const tile = screen.getByTestId('kpi-tile');
    expect(tile).toHaveTextContent('4.1');
    expect(tile).toHaveTextContent('d');
    rerender(<KpiTile label="Cycle time" value={null} />);
    expect(screen.getByTestId('kpi-tile')).toHaveTextContent('—');
  });
});
