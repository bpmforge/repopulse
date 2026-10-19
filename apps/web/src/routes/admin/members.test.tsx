import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../api/queryClient.js';
import { MembersPage } from './members.js';

// Settings → Members can add a person (W20-01, UX_TODO ADM-01). CreateUser was
// built and tested in W15-04 but never mounted, so the only way to add an
// account was curl.

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ items: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('Members page (W20-01)', () => {
  it('shows the add-member form above the list', () => {
    render(
      <QueryClientProvider client={createQueryClient()}>
        <MembersPage />
      </QueryClientProvider>,
    );
    expect(screen.getByTestId('create-user-email')).toBeInTheDocument();
    expect(screen.getByTestId('create-user-submit')).toBeInTheDocument();
  });
});
