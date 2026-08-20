import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { HealthWhy } from './HealthWhy.js';
import type { RepoDetail } from './contracts.js';

// The "why?" breakdown (W4-04, FR-INSIGHTS-3).

type Health = RepoDetail['health'];
type Axis = Health['breakdown'][number];

const axis = (key: string, over: Partial<Axis> = {}): Axis => ({
  key,
  normalized: 62,
  weight: 0.2,
  contribution: 12.4,
  ...over,
});

function open(breakdown: Axis[], basis = 'Tier-1 only') {
  const health: Health = { score: 39, letter: 'D', basis, breakdown };
  render(<HealthWhy health={health} />);
  fireEvent.click(screen.getByTestId('health-why-toggle'));
  return screen.getByTestId('health-why-popover');
}

describe('health "why?" breakdown', () => {
  it('names each sub-score in words, never as the raw key', () => {
    // A basis reading "ReviewHygiene" is a basis nobody can read, which is the
    // unexplained grade FR-INSIGHTS-3 exists to forbid. These are the exact
    // strings that were on screen when the defect was reported.
    const panel = open([axis('reviewHygiene'), axis('ciHealth'), axis('supplyChain')]);
    expect(panel.textContent).toContain('Review');
    expect(panel.textContent).toContain('CI');
    expect(panel.textContent).toContain('Supply Chain');
    expect(panel.textContent).not.toContain('reviewHygiene');
    expect(panel.textContent).not.toContain('ReviewHygiene');
    expect(panel.textContent).not.toContain('ciHealth');
    expect(panel.textContent).not.toContain('CiHealth');
  });

  it('splits an unknown key into words rather than printing the identifier', () => {
    // Sub-scores get added faster than label maps get updated; the fallback is
    // the reason that never ships a raw identifier to a user.
    const panel = open([axis('crossRepoDrift')]);
    expect(panel.textContent).toMatch(/Cross repo drift/i);
    expect(panel.textContent).not.toContain('crossRepoDrift');
  });

  it('shows the contribution arithmetic so the score is checkable', () => {
    const panel = open([axis('security', { normalized: 62.4, weight: 0.25, contribution: 15.6 })]);
    expect(panel.textContent).toContain('62 x 0.25 = 15.6');
    expect(screen.getByTestId('health-basis')).toHaveTextContent('Tier-1 only');
  });

  it('opens inward from the right edge of the trigger', () => {
    // JSDOM has no layout, so this pins the anchoring decision rather than
    // proving containment: the panel ran off the viewport while it was
    // left-anchored under a right-aligned trigger.
    const panel = open([axis('security')]);
    expect(panel.className).toContain('right-0');
    expect(panel.className).not.toContain('left-0');
  });

  it('says no sub-scores were computed rather than showing an empty list', () => {
    const panel = open([]);
    expect(panel.textContent).toContain('No sub-scores computed yet for this window.');
  });
});
