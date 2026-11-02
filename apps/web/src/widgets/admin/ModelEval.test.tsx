import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../api/queryClient.js';
import { ModelEval } from './ModelEval.js';

// W19-05. The honesty cases: unmeasured says "not yet run", an incomplete run
// says incomplete (never a number), and the engine and date are on the page.

const ROLES = [
  { id: 'security', label: 'Security' },
  { id: 'performance', label: 'Performance' },
];
let body: unknown;

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ),
  );
});
afterEach(() => vi.unstubAllGlobals());

const renderIt = () =>
  render(
    <QueryClientProvider client={createQueryClient()}>
      <ModelEval />
    </QueryClientProvider>,
  );

describe('Settings → Models → quality per model (W19-05)', () => {
  it('says not yet run for a configured model nobody has measured', async () => {
    body = {
      roles: ROLES,
      models: [{ model: 'my-model', provider_name: 'LAN', configured: true, result: null }],
    };
    renderIt();
    expect(await screen.findByTestId('model-eval-my-model-security')).toHaveTextContent(
      'not yet run',
    );
    expect(screen.getByTestId('model-eval-row-my-model')).toHaveTextContent('LAN');
    // W20-11 (UX_TODO AI-16, partial; AI-28): how to measure it, and how to read the table.
    expect(screen.getByTestId('model-eval-how-to-measure')).toHaveTextContent(
      /my-model.*npx tsx packages\/security\/src\/eval\/cli\.ts/,
    );
    expect(screen.getByTestId('model-eval-guide')).toHaveTextContent(
      /read a gap smaller than that as a tie/,
    );
    expect(screen.getByTestId('model-eval-routing-link')).toHaveAttribute('href', '#model-routing');
  });

  it('shows precision and recall, the engine and the date for a measured model', async () => {
    body = {
      roles: ROLES,
      models: [
        {
          model: 'qwen',
          provider_name: 'LAN',
          configured: true,
          result: {
            engine: 'OpenAI-compatible endpoint at localhost:1234',
            ranAt: '2026-10-18T01:02:03.000Z',
            complete: true,
            roles: {
              security: { cases: 4, errored: 0, precision: 1, recall: 0.5, state: 'scored' },
            },
            triage: { agreement: 1, total: 12, missedReal: 0 },
            errors: [],
          },
        },
      ],
    };
    renderIt();
    // Precision and recall are separate cells, so the numbers line up down a column.
    expect(await screen.findByTestId('model-eval-qwen-security-p')).toHaveTextContent('100%');
    expect(screen.getByTestId('model-eval-qwen-security-r')).toHaveTextContent('50%');
    // W24-03: a row per role, a P and an R sub-header per MODEL.
    expect(
      screen.getAllByRole('columnheader', { name: 'P' }).length,
      'a P and an R sub-header per model',
    ).toBe(1);
    expect(screen.getAllByRole('rowheader').map((h) => h.textContent)).toEqual([
      ...ROLES.map((r) => r.label),
      'Triage agreement',
    ]);
    // The table can scroll sideways, so its region is labelled and reachable by keyboard.
    const region = screen.getByRole('region', { name: /Quality per model/ });
    expect(region).toHaveAttribute('tabindex', '0');
    // The caveat is a visible caption, not screen-reader-only.
    const caption = screen.getByTestId('model-eval-table').querySelector('caption')!;
    expect(caption.className).not.toContain('sr-only');
    expect(caption).toHaveTextContent(/not been reviewed by a person/);
    expect(caption).toHaveTextContent(/not a guarantee/);
    // A role the run did not cover is not yet run, not blank.
    expect(screen.getByTestId('model-eval-qwen-performance')).toHaveTextContent('not yet run');
    const row = screen.getByTestId('model-eval-row-qwen');
    expect(row).toHaveTextContent('2026-10-18');
    expect(row).toHaveTextContent('localhost:1234');
    expect(screen.getByTestId('model-eval-qwen-triage')).toHaveTextContent('100%');
  });

  it('shows an incomplete run as incomplete, with no number, and says how many provider errors', async () => {
    body = {
      roles: ROLES,
      models: [
        {
          model: 'flaky',
          provider_name: null,
          configured: false,
          result: {
            engine: 'e',
            ranAt: '2026-10-18T00:00:00.000Z',
            complete: false,
            roles: {
              security: {
                cases: 4,
                errored: 2,
                precision: null,
                recall: null,
                state: 'incomplete',
              },
            },
            triage: null,
            errors: [
              { role: 'security', caseId: 'a', error: 'x' },
              { role: 'security', caseId: 'b', error: 'y' },
            ],
          },
        },
      ],
    };
    renderIt();
    const cell = await screen.findByTestId('model-eval-flaky-security');
    expect(cell).toHaveTextContent('incomplete: 2 of 4 cases hit a provider error (listed below)');
    expect(cell).not.toHaveTextContent('%');
    expect(screen.getByTestId('model-eval-incomplete-flaky')).toHaveTextContent(
      '2 provider errors',
    );
    expect(screen.getByTestId('model-eval-row-flaky')).toHaveTextContent('not configured here');
    // W20-11 (UX_TODO AI-27): the errors themselves, as text, not a tooltip.
    const errors = screen.getByTestId('model-eval-errors-flaky');
    expect(errors.querySelector('details')).toBeTruthy();
    expect(errors).toHaveTextContent('Security, case a: x');
    expect(cell.getAttribute('title')).toBeNull();
  });
});
