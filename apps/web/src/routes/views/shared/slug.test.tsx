import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../../api/queryClient.js';
import { SharedViewBody } from './$slug.js';
import { ShareLink } from '../$viewId.js';

// The share link leads somewhere (W20-01, UX_TODO DSH-01). Share produced
// `/views/shared/{slug}` and the web app had no route for it.

let answer: { status: number; body: unknown };
const urls: string[] = [];

beforeEach(() => {
  urls.length = 0;
  answer = { status: 200, body: { id: 3, name: 'Exec monthly', config: { layout: [] } } };
  vi.stubGlobal(
    'fetch',
    vi.fn((input: unknown) => {
      urls.push(String(input));
      return Promise.resolve(
        new Response(JSON.stringify(answer.body), {
          status: answer.status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

function renderShared(slug: string) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <SharedViewBody slug={slug} />
    </QueryClientProvider>,
  );
}

describe('shared view page (W20-01)', () => {
  it('reads the slug from the API and shows the view by name', async () => {
    renderShared('abc123');
    expect(await screen.findByText('Exec monthly')).toBeInTheDocument();
    expect(urls).toContain('/api/v1/views/shared/abc123');
  });

  it('explains a dead link instead of "Not Found"', async () => {
    answer = { status: 404, body: { status: 404, title: 'Not Found' } };
    renderShared('gone');
    expect(await screen.findByText(/This link no longer works/)).toBeInTheDocument();
  });
});

describe('share link (W20-01)', () => {
  it('is a full address that can be copied', () => {
    render(<ShareLink slug="abc123" />);
    expect(screen.getByTestId('share-url').textContent).toBe(
      `${window.location.origin}/views/shared/abc123`,
    );
    expect(screen.getByTestId('share-copy')).toBeInTheDocument();
  });
});
