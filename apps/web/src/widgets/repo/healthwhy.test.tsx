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
    // W20-12 (DSH-19): plain words, not "Tier-1 only".
    expect(screen.getByTestId('health-basis')).toHaveTextContent('Based on delivery data only');
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

// W16-21. The panel said "Review 0 x 0.3 = 0.0" directly above a chart reading
// 40% review coverage, and both were correct: reviewHygiene ramps m5 between
// good 0.9 and bad 0.4, so 40% sits ON the bad anchor and normalises to zero.
// A reader had no way to tell "normalised to 0" from "no reviews happened" —
// and the two suggest completely different actions.
describe('the measurement behind the score (W16-21)', () => {
  const reviewAxis = axis('reviewHygiene', {
    normalized: 0,
    weight: 0.3,
    contribution: 0,
    inputs: [{ key: 'm5', raw: 0.4, good: 0.9, bad: 0.4, normalized: 0 }],
  });

  it('shows the raw measurement and both anchors beside the normalised value', () => {
    const panel = open([reviewAxis]);

    // The number the user can also see on the chart, named and with its unit
    // (W20-12, DSH-23) — "Review coverage 40%", never "m5 0.4".
    expect(panel).toHaveTextContent('Review coverage 40% → 0');
    expect(panel).not.toHaveTextContent('m5');
    // And why 40% became 0.
    expect(panel).toHaveTextContent(/target 90%/);
    expect(panel).toHaveTextContent(/worst 40%/);
  });

  it('still shows the checkable arithmetic', () => {
    // The raw line is additional, not a replacement: the contribution is what
    // actually moved the score.
    expect(open([reviewAxis])).toHaveTextContent('0 x 0.3 = 0.0');
  });

  it('renders nothing extra for an older payload with no inputs', () => {
    // Report data is persisted and re-read, and an API mid-upgrade may omit
    // them; the panel must not break or print "undefined".
    const panel = open([axis('activity')]);
    expect(panel).toHaveTextContent('62 x 0.2 = 12.4');
    expect(panel).not.toHaveTextContent('undefined');
    expect(panel).not.toHaveTextContent(/target/);
  });
});

describe('what the score leaves out, and closing (W20-12)', () => {
  it('lists unmeasured parts with their weight and says the weights were rescaled (DSH-80)', () => {
    const health: Health = {
      score: 88,
      letter: null,
      basis: 'Tier-1 only',
      breakdown: [axis('activity'), axis('ciHealth')],
      not_measured: [
        { key: 'security', weight: 0.2 },
        { key: 'codeHealth', weight: 0.15 },
      ],
      renormalized: true,
    };
    render(<HealthWhy health={health} />);
    fireEvent.click(screen.getByTestId('health-why-toggle'));
    expect(screen.getByTestId('health-missing')).toHaveTextContent(
      'Securitynot measured (would weigh 0.20)',
    );
    expect(screen.getByTestId('health-renormalized')).toHaveTextContent(
      'Weights rescaled because 2 parts are missing.',
    );
    expect(screen.getByTestId('health-basis')).toHaveTextContent(
      'Security, Code Health not measured',
    );
  });

  it('closes on Escape (DSH-23)', () => {
    open([axis('security')]);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('health-why-popover')).toBeNull();
  });
});
