import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../api/queryClient.js';
import { GeneratePlanButton, type GeneratePlanButtonProps } from './GeneratePlanButton.js';

// W17-24. Mounting generates nothing; one press generates exactly once for
// exactly the scope the button named; a second press during the first is
// dropped; and the line under the button repeats the SERVER's scope and says
// when the answer was an existing plan rather than a new one.

let answer: { status: number; body: unknown };
let release: (() => void) | null = null;

function stubFetch(hold = false) {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          const respond = () =>
            resolve(
              new Response(JSON.stringify(answer.body), {
                status: answer.status,
                headers: { 'content-type': 'application/json' },
              }),
            );
          if (hold) release = respond;
          else respond();
        }),
    ),
  );
}

function renderButton(props: Partial<GeneratePlanButtonProps> = {}) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <GeneratePlanButton window="30d" repoIds={[12]} repoNames={{ 12: 'acme/payments' }} {...props} />
    </QueryClientProvider>,
  );
}

function posted(): { url: string; body: unknown }[] {
  const calls = (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls as [
    string,
    RequestInit,
  ][];
  return calls.map(([url, init]) => ({ url, body: JSON.parse(String(init.body)) }));
}

beforeEach(() => {
  release = null;
  answer = {
    status: 201,
    body: { id: 5, item_count: 2, reused: false, repo_ids: [12], window: '30d' },
  };
  stubFetch();
});
afterEach(() => vi.unstubAllGlobals());

describe('GeneratePlanButton (W17-24)', () => {
  it('mounting generates nothing and the button names the scope it WOULD generate', () => {
    renderButton();
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByTestId('generate-plan')).toHaveTextContent(
      'Generate 30d plan for acme/payments',
    );
  });

  it('names the whole workspace when no repository is selected', () => {
    renderButton({ repoIds: [] });
    expect(screen.getByTestId('generate-plan')).toHaveTextContent(
      'Generate 30d plan for the whole workspace',
    );
  });

  it('one press posts once, with exactly the repositories in the scope', async () => {
    renderButton({ repoIds: [12, 12] });
    await userEvent.click(screen.getByTestId('generate-plan'));
    await waitFor(() => expect(screen.getByTestId('generate-plan-result')).toBeInTheDocument());
    expect(posted()).toHaveLength(1);
    expect(posted()[0]?.url).toMatch(/\/plans$/);
    expect(posted()[0]?.body).toEqual({ window: '30d', repo_ids: [12] });
    expect(screen.getByTestId('generate-plan-result')).toHaveTextContent(
      'Plan #5 created for acme/payments: 2 items.',
    );
  });

  it('a second press while the first is in flight is dropped', async () => {
    stubFetch(true);
    renderButton();
    const button = screen.getByTestId('generate-plan');
    await userEvent.click(button);
    await waitFor(() => expect(button).toBeDisabled());
    expect(button).toHaveTextContent('Generating…');
    await userEvent.click(button);
    await userEvent.click(button);
    expect(posted()).toHaveLength(1);
    await act(async () => {
      release?.();
    });
    await waitFor(() => expect(button).not.toBeDisabled());
    expect(posted()).toHaveLength(1);
  });

  it('says when the server handed back an existing plan, in the server\'s scope', async () => {
    answer = {
      status: 200,
      body: { id: 5, item_count: 2, reused: true, repo_ids: [12], window: '30d' },
    };
    renderButton();
    await userEvent.click(screen.getByTestId('generate-plan'));
    await waitFor(() => expect(screen.getByTestId('generate-plan-result')).toBeInTheDocument());
    expect(screen.getByTestId('generate-plan-result')).toHaveTextContent(
      'Nothing changed — the 30d plan for acme/payments (#5) already has these 2 items.',
    );
  });

  it('shows a refusal beside the button', async () => {
    answer = {
      status: 404,
      body: { type: 'about:blank', title: 'Not Found', status: 404 },
    };
    renderButton();
    await userEvent.click(screen.getByTestId('generate-plan'));
    await waitFor(() => expect(screen.getByTestId('generate-plan-error')).toBeInTheDocument());
    expect(screen.queryByTestId('generate-plan-result')).not.toBeInTheDocument();
  });
});
