import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../api/queryClient.js';
import { Connections, connectErrorSentence } from './Connections.js';

// W20-04 (UX_TODO INS-05). A refused token showed "Credential validation
// failed: bad_scope" and nothing else; the API's detail, and the scopes to add,
// never reached the person holding the token.

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn((_input: unknown, init?: RequestInit) => {
      const write = (init?.method ?? 'GET') !== 'GET';
      const status = write ? 400 : 200;
      const body = write
        ? {
            type: 'about:blank',
            title: 'Credential validation failed: bad_scope',
            status: 400,
            detail: 'Credential lacks the read scopes needed to list repositories.',
            request_id: 'req-77',
          }
        : { items: [] };
      return Promise.resolve(
        new Response(JSON.stringify(body), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('forge connect errors (W20-04)', () => {
  it('shows a plain sentence with the scopes, the API detail and the request id', async () => {
    const user = userEvent.setup();
    render(
      <QueryClientProvider client={createQueryClient()}>
        <Connections />
      </QueryClientProvider>,
    );
    await user.type(screen.getByTestId('connection-credential'), 'ghp_example');
    await user.click(screen.getByTestId('connection-submit'));

    const error = await screen.findByTestId('connection-error');
    expect(error).toHaveTextContent(/Give it these scopes: repo and read:org/);
    expect(screen.getByTestId('connection-error-detail')).toHaveTextContent(
      /lacks the read scopes/,
    );
    expect(error).toHaveTextContent('req-77');
  });

  it('maps every kind the API names, per forge, and leaves anything else alone', () => {
    expect(connectErrorSentence('Credential validation failed: bad_token', 'github')).toMatch(
      /rejected this token/,
    );
    expect(connectErrorSentence('Credential validation failed: bad_scope', 'gitlab')).toMatch(
      /read_api/,
    );
    expect(connectErrorSentence('Credential validation failed: no_repos', 'gitea')).toMatch(
      /no repositories/,
    );
    expect(connectErrorSentence('Bad Request', 'github')).toBeNull();
  });
});
