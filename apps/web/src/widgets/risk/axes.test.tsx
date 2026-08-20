import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, afterEach } from 'vitest';
import { RiskAxesCard } from './RiskAxesCard.js';

// The axis card (W10-05, FR-INSIGHTS-3).

function renderWith(payload: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 })),
  );
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <RiskAxesCard repoId="1" />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

const axis = (over: Record<string, unknown> = {}) => ({
  axis: 'supplyChain',
  dimensions: ['dependency_health'],
  letter: 'B',
  score: 74.2,
  basis: '3 open findings, sub-score 74',
  top: [],
  ...over,
});

describe('risk axes card', () => {
  it('shows the letter beside its basis', async () => {
    renderWith({ axes: [axis()], letter_bands: {} });
    expect(await screen.findByTestId('axis-letter-supplyChain')).toHaveTextContent('B');
    expect(screen.getByTestId('axis-basis-supplyChain')).toHaveTextContent('sub-score 74');
  });

  it('shows a DASH and a reason where no sub-score exists, never a grade', async () => {
    renderWith({
      axes: [
        axis({
          letter: null,
          score: null,
          basis: 'not measured for this scope — no inputs available, which is not a grade',
        }),
      ],
      letter_bands: {},
    });
    expect(await screen.findByTestId('axis-letter-supplyChain')).toHaveTextContent('—');
    expect(screen.getByTestId('axis-basis-supplyChain')).toHaveTextContent(/not measured/);
  });

  it('labels an unmeasured axis for a screen reader as unmeasured, not as a grade', async () => {
    renderWith({ axes: [axis({ letter: null, score: null, basis: 'not measured' })], letter_bands: {} });
    expect(await screen.findByLabelText(/Supply Chain not measured/)).toBeInTheDocument();
  });
});
