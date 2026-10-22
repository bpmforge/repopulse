import { render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../api/queryClient.js';
import { AboutPage } from './about.js';
import { RELEASE_ACCURACY, type ReleaseAccuracy } from '../about/accuracy.js';

// W20-23 (UX_TODO X-11; W20_DECISIONS_2 row 8): the About page any signed-in
// user can open — the installed version, and this release's numbers with
// where each one comes from.

let version: string;

beforeEach(() => {
  version = '0.1.0';
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      const url = String(input);
      const payload = url.includes('/about') ? { version } : {};
      return Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderAbout(accuracy: ReleaseAccuracy = RELEASE_ACCURACY) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <AboutPage accuracy={accuracy} />
    </QueryClientProvider>,
  );
}

describe('About (W20-23)', () => {
  it('shows the installed version from the API', async () => {
    renderAbout();
    expect(
      await screen.findByText('0.1.0', { selector: '[data-testid="about-version"]' }),
    ).toBeInTheDocument();
    expect(screen.queryByTestId('about-version-note')).toBeNull();
  });

  it('says so when the install is named differently from the numbers’ release', async () => {
    version = '2026.10.3';
    renderAbout();
    expect(await screen.findByTestId('about-version-note')).toHaveTextContent(
      'published with the code of release 0.1.0',
    );
  });

  it('lists every published suite with its numbers and their source, the low ones too', () => {
    renderAbout();
    const juliet = screen.getByTestId('about-row-juliet-java');
    expect(juliet).toHaveTextContent('NIST Juliet Test Suite for Java v1.3 (sample)');
    expect(juliet).toHaveTextContent('56.0%');
    expect(juliet).toHaveTextContent('26.9%');
    expect(juliet).toHaveTextContent('314 / 247 / 854');
    expect(juliet).toHaveTextContent('docs/benchmarks/report.json, bySuite → juliet-java');
    const owasp = screen.getByTestId('about-row-owasp-benchmark');
    expect(within(owasp).getByText('82.6%')).toBeInTheDocument();
    expect(screen.getByTestId('about-row-total')).toHaveTextContent('77.7%');
    expect(screen.getByTestId('about-accuracy')).toHaveTextContent(
      'Measured 2026-10-16 at commit e49421c6ccd6 with opengrep 1.27.1',
    );
    expect(screen.getByTestId('about-previous')).toHaveTextContent(
      'first release with published numbers',
    );
  });

  it('names the previous release once there is one', () => {
    renderAbout({
      ...RELEASE_ACCURACY,
      previous: {
        ...RELEASE_ACCURACY,
        release: '0.0.9',
        measured: { ...RELEASE_ACCURACY.measured, date: '2026-09-01' },
      },
    });
    expect(screen.getByTestId('about-previous')).toHaveTextContent(
      'Previous release (0.0.9) measured 2026-09-01.',
    );
  });
});
