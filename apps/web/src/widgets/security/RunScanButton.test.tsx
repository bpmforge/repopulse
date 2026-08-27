import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../api/queryClient.js';
import { RunScanButton } from './RunScanButton.js';

// W16-10 (F15). The three outcomes matter more than the button does.
//
// "Already running" is NOT a failure and must not be shown as one: pressing
// twice is the most likely thing a person does when the first press produced no
// visible change, and a red error at that moment teaches them the feature is
// broken when it is working exactly as intended.

let answer: { status: number; body: unknown };

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify(answer.body), {
          status: answer.status,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    ),
  );
}

function renderButton() {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <RunScanButton repoId="42" invalidate={[]} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  answer = { status: 202, body: { started: ['semgrep'], already_running: [], repo: 'acme/api' } };
  stubFetch();
});
afterEach(() => vi.unstubAllGlobals());

describe('Run scans now (W16-10)', () => {
  it('names what it started, and sets the expectation that it takes minutes', async () => {
    renderButton();
    await userEvent.click(screen.getByTestId('run-scan-button'));

    const result = await screen.findByTestId('run-scan-result');
    expect(result).toHaveTextContent('semgrep');
    // Without this, a scan that has not finished in ten seconds reads as
    // another thing that silently did nothing.
    expect(result).toHaveTextContent(/minutes, not seconds/i);
  });

  it('reports "already running" as news, not as an error', async () => {
    answer = { status: 202, body: { started: [], already_running: ['semgrep'], repo: 'acme/api' } };
    renderButton();
    await userEvent.click(screen.getByTestId('run-scan-button'));

    expect(await screen.findByTestId('run-scan-result')).toHaveTextContent(/already running/i);
    expect(screen.queryByTestId('run-scan-error')).toBeNull();
  });

  it('surfaces a refusal with the reason the API gave', async () => {
    // A spent forge budget and a disabled scanner are different problems; the
    // button is worth nothing if both read as "could not run".
    answer = {
      status: 409,
      body: {
        title: 'Nothing to run',
        detail: 'No scanner is enabled for this repository — enable one first.',
      },
    };
    renderButton();
    await userEvent.click(screen.getByTestId('run-scan-button'));

    expect(await screen.findByTestId('run-scan-error')).toHaveTextContent(/Nothing to run/i);
  });
});
