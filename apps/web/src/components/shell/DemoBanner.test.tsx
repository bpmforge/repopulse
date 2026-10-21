import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { DemoBanner } from './DemoBanner.js';

// W13-02. The banner is the only thing separating "a screenshot of RepoPulse"
// from "a screenshot of three invented repositories", so what it must NOT do
// matters as much as what it must.

const useApiQuery = vi.hoisted(() => vi.fn());
vi.mock('../../api/useApiQuery.js', () => ({ useApiQuery }));

function renderWith(data: unknown) {
  useApiQuery.mockReturnValue({ data });
  return render(<DemoBanner />);
}

describe('demo banner', () => {
  it('says plainly that the data is fake when the API reports demo mode', () => {
    renderWith({ demo: true });
    const banner = screen.getByTestId('demo-banner');
    expect(banner.textContent).toMatch(/Demo mode/i);
    // Not colour alone (UX_SPEC §7): the words have to carry it.
    expect(banner.textContent).toMatch(/not.*real organization|fake/i);
  });

  it('renders NOTHING when the API says demo is false', () => {
    renderWith({ demo: false });
    expect(screen.queryByTestId('demo-banner')).toBeNull();
  });

  it('renders nothing when the field is ABSENT, rather than guessing', () => {
    // An older API that does not send the field at all must not produce a
    // banner — and equally must not be treated as "demo unknown, show it
    // anyway", which would put a fake-data warning over real numbers.
    renderWith({});
    expect(screen.queryByTestId('demo-banner')).toBeNull();
  });

  it('renders nothing before the context has loaded', () => {
    renderWith(undefined);
    expect(screen.queryByTestId('demo-banner')).toBeNull();
  });
});
