import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../api/queryClient.js';
import { ModelCache, hitLabel } from './ModelCache.js';

// W23-06. A model whose provider reports no cache figure says "not reported",
// never 0%; a reporting model shows its rate.

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

describe('hitLabel', () => {
  it('formats a rate and distinguishes not-reported from 0%', () => {
    expect(hitLabel({ hit_pct: 62.5, reports_cache: true })).toBe('62.5%');
    expect(hitLabel({ hit_pct: 0, reports_cache: false })).toBe('not reported');
    expect(hitLabel({ hit_pct: null, reports_cache: true })).toBe('not reported');
  });
});

describe('Settings -> Models -> prompt cache (W23-06)', () => {
  it('shows the hit rate per model', async () => {
    body = {
      window_runs: 50,
      models: [
        {
          model: 'qwen3.8-27b',
          runs: 12,
          tokens_in: 240_000,
          cache_read_tokens: 150_000,
          hit_pct: 62.5,
          reports_cache: true,
        },
        {
          model: 'gpt-x',
          runs: 3,
          tokens_in: 9000,
          cache_read_tokens: 0,
          hit_pct: 0,
          reports_cache: false,
        },
      ],
    };
    render(
      <QueryClientProvider client={createQueryClient()}>
        <ModelCache />
      </QueryClientProvider>,
    );
    expect((await screen.findByTestId('model-cache-hit-qwen3.8-27b')).textContent).toBe('62.5%');
    expect(screen.getByTestId('model-cache-hit-gpt-x').textContent).toBe('not reported');
  });
});
