import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClientProvider } from '@tanstack/react-query';
import { createQueryClient } from '../../api/queryClient.js';
import { RunScanButton, type RunScanButtonProps } from './RunScanButton.js';

// W16-10 (F15). The three outcomes matter more than the button does.
//
// "Already running" is NOT a failure and must not be shown as one: pressing
// twice is the most likely thing a person does when the first press produced no
// visible change, and a red error at that moment teaches them the feature is
// broken when it is working exactly as intended.
//
// W17-20 adds the lock: while the coverage table reports a scan in flight the
// button is disabled and says so, and it unlocks on any terminal state.

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

function renderButton(props: Partial<RunScanButtonProps> = {}) {
  const queryClient = createQueryClient();
  const view = render(
    <QueryClientProvider client={queryClient}>
      <RunScanButton repoId="42" invalidate={[]} {...props} />
    </QueryClientProvider>,
  );
  return {
    rerender: (next: Partial<RunScanButtonProps>) =>
      view.rerender(
        <QueryClientProvider client={queryClient}>
          <RunScanButton repoId="42" invalidate={[]} {...next} />
        </QueryClientProvider>,
      ),
  };
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
    // The detail is the half that says WHY (W17-20). The title alone was all
    // that used to reach the screen.
    expect(screen.getByTestId('run-scan-error-detail')).toHaveTextContent(/enable one first/i);
    // A refusal is terminal: the button is back, so fixing the cause and
    // trying again is one click.
    expect(screen.getByTestId('run-scan-button')).toBeEnabled();
  });
});

describe('Run scans now — rejected, locked, unlocked (W17-20)', () => {
  it('a 403 says who can press it, and that retrying will not help', async () => {
    answer = { status: 403, body: { title: 'Forbidden — admin role required', status: 403 } };
    renderButton();
    await userEvent.click(screen.getByTestId('run-scan-button'));

    expect(await screen.findByTestId('run-scan-error')).toHaveTextContent(/admin role/i);
    expect(screen.getByTestId('run-scan-forbidden')).toHaveTextContent(/ask a workspace admin/i);
    // Not a stuck spinner: the request is over.
    expect(screen.getByTestId('run-scan-button')).toHaveTextContent('Run scans now');
  });

  it('tells the API that a start was accepted, so the screen can follow it', async () => {
    const onStarted = vi.fn();
    renderButton({ onStarted });
    await userEvent.click(screen.getByTestId('run-scan-button'));
    await screen.findByTestId('run-scan-result');
    expect(onStarted).toHaveBeenCalledTimes(1);
  });

  it('is locked while the table reports a scan in flight, and does not POST', async () => {
    renderButton({ running: ['semgrep', 'secrets'] });
    const button = screen.getByTestId('run-scan-button');
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent(/scan running/i);
    expect(screen.getByTestId('run-scan-running')).toHaveTextContent('semgrep, secrets');

    // A disabled button ignores the click; the server's jobId guard is not
    // the only thing between a person and a duplicate.
    await userEvent.click(button);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('is locked while a start is queued and no worker has picked it up', () => {
    renderButton({ awaiting: true });
    const button = screen.getByTestId('run-scan-button');
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent(/queued/i);
  });

  it('unlocks on a terminal state and allows a retry — no spinner survives the job', async () => {
    const { rerender } = renderButton({ running: ['semgrep'] });
    expect(screen.getByTestId('run-scan-button')).toBeDisabled();

    // The table now says the run failed. Terminal: the lock must go with it,
    // the "results appear here as each finishes" sentence too.
    rerender({ running: [] });
    const button = screen.getByTestId('run-scan-button');
    expect(button).toBeEnabled();
    expect(button).toHaveTextContent('Run scans now');
    expect(screen.queryByTestId('run-scan-running')).toBeNull();
    expect(screen.getByTestId('run-scan-finished')).toHaveTextContent(/settled/i);

    // And the retry is a real second request.
    await userEvent.click(button);
    expect(await screen.findByTestId('run-scan-result')).toHaveTextContent('semgrep');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('says when nobody picked the job up, instead of "Queued…" for ever', () => {
    renderButton({ stalled: true });
    expect(screen.getByTestId('run-scan-stalled')).toHaveTextContent(/no worker has picked it up/i);
    // Stalled is terminal: the person may try again once the worker is up.
    expect(screen.getByTestId('run-scan-button')).toBeEnabled();
  });
});
