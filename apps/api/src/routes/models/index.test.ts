import { describe, expect, it } from 'vitest';
import { cacheHitByModel } from './index.js';

// W23-06. The rate is cache-read tokens over input tokens across a model's most
// recent runs; a provider that reports nothing is 0% with reports_cache false.

describe('cache hit rate per model (W23-06)', () => {
  it('computes cacheRead / tokensIn per model', () => {
    const stats = cacheHitByModel([
      { model: 'qwen', promptTokens: 1000, cacheReadTokens: 750 },
      { model: 'qwen', promptTokens: 1000, cacheReadTokens: 250 },
      { model: 'sonnet', promptTokens: 400, cacheReadTokens: 0 },
    ]);
    expect(stats).toEqual([
      {
        model: 'qwen',
        runs: 2,
        tokens_in: 2000,
        cache_read_tokens: 1000,
        hit_pct: 50,
        reports_cache: true,
      },
      {
        model: 'sonnet',
        runs: 1,
        tokens_in: 400,
        cache_read_tokens: 0,
        hit_pct: 0,
        reports_cache: false,
      },
    ]);
  });

  it('uses only the most recent N runs (rows are newest-first)', () => {
    const rows = [
      { model: 'm', promptTokens: 100, cacheReadTokens: 100 },
      { model: 'm', promptTokens: 100, cacheReadTokens: 100 },
      { model: 'm', promptTokens: 100, cacheReadTokens: 0 },
    ];
    expect(cacheHitByModel(rows, 2)[0]).toMatchObject({ runs: 2, hit_pct: 100 });
  });

  it('reports null, not 0, when no input tokens were recorded', () => {
    expect(
      cacheHitByModel([{ model: 'm', promptTokens: 0, cacheReadTokens: 0 }])[0]?.hit_pct,
    ).toBeNull();
  });
});
