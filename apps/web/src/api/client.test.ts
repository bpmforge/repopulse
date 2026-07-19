import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, apiFetch, buildUrl } from './client.js';
import { queryKeyFor } from './useApiQuery.js';

describe('buildUrl', () => {
  it('substitutes path params and prefixes /api/v1', () => {
    expect(buildUrl('/repos/{id}', { path: { id: 42 } })).toBe('/api/v1/repos/42');
  });
  it('drops undefined/null/empty query params', () => {
    expect(
      buildUrl('/metrics/series', {
        query: { metric_key: 'M5', window: '30d', repo_id: undefined, person: '' },
      }),
    ).toBe('/api/v1/metrics/series?metric_key=M5&window=30d');
  });
  it('leaves an already-absolute /api/v1 path unprefixed', () => {
    expect(buildUrl('/api/v1/org/summary')).toBe('/api/v1/org/summary');
  });
});

describe('queryKeyFor', () => {
  it('mirrors endpoint + params for a stable cache key', () => {
    expect(queryKeyFor({ endpoint: '/org/summary', query: { window: '90d' } })).toEqual([
      '/org/summary',
      {},
      { window: '90d' },
    ]);
  });
});

describe('apiFetch', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('returns parsed JSON on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    await expect(apiFetch<{ ok: boolean }>('/api/v1/org/summary')).resolves.toEqual({ ok: true });
  });

  it('throws ApiError carrying the problem envelope request id on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              type: 'about:blank',
              title: 'Forbidden',
              status: 403,
              request_id: 'req-9',
            }),
            { status: 403 },
          ),
      ),
    );
    await expect(apiFetch('/api/v1/admin/members')).rejects.toMatchObject({
      name: 'ApiError',
      status: 403,
      requestId: 'req-9',
      message: 'Forbidden',
    });
  });

  it('synthesizes an envelope for a non-JSON error body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () => new Response('<html>502</html>', { status: 502, statusText: 'Bad Gateway' }),
      ),
    );
    const err = await apiFetch('/api/v1/org/summary').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(502);
  });
});
