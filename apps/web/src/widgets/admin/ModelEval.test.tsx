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

describe('Admin → Models → quality per model (W19-05)', () => {
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
    expect(await screen.findByTestId('model-eval-qwen-security')).toHaveTextContent(
      'P 100% · R 50%',
    );
    // A role the run did not cover is not yet run, not blank.
    expect(screen.getByTestId('model-eval-qwen-performance')).toHaveTextContent('not yet run');
    const row = screen.getByTestId('model-eval-row-qwen');
    expect(row).toHaveTextContent('2026-10-18');
    expect(row).toHaveTextContent('localhost:1234');
    expect(row).toHaveTextContent('100%');
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
    expect(cell).toHaveTextContent('incomplete (2 errors)');
    expect(cell).not.toHaveTextContent('%');
    expect(screen.getByTestId('model-eval-incomplete-flaky')).toHaveTextContent(
      '2 provider errors',
    );
    expect(screen.getByTestId('model-eval-row-flaky')).toHaveTextContent('not configured here');
  });
});
