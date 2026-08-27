import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WidgetFrame } from './WidgetFrame.js';
import { ErrorNote } from '../primitives/ErrorNote.js';
import { ApiError } from '../../api/client.js';

// W16-18. Whether a user-visible failure can be found in the log afterwards.
//
// The audit that produced this ticket: 86 `<WidgetFrame>` error surfaces in the
// app, exactly ONE of which passed a request id — while the API had been
// putting `request_id` in every RFC 7807 problem body all along and ApiError
// had been parsing it. The id existed at every layer and reached the screen
// almost nowhere, so "it broke" was unfindable.
//
// The fix had to be in the component, not in 85 call sites, or the next screen
// anyone adds would reintroduce the gap.

function apiError(overrides: Partial<Record<string, unknown>> = {}) {
  return new ApiError({
    type: 'about:blank',
    title: 'Internal Server Error',
    status: 500,
    instance: '/api/v1/org/health-tiles',
    request_id: 'req-4f2a',
    ...overrides,
  } as never);
}

describe('WidgetFrame error state (W16-18)', () => {
  it('derives the request id from the error, with no call site remembering to', () => {
    render(<WidgetFrame title="Repo health" state="error" error={apiError()} />);

    expect(screen.getByTestId('error-request-id')).toHaveTextContent('req-4f2a');
    expect(screen.getByRole('alert')).toHaveTextContent('Internal Server Error');
  });

  it('still honours an explicit message and id, which some call sites pass', () => {
    render(
      <WidgetFrame
        title="Repo health"
        state="error"
        errorMessage="Custom message"
        requestId="req-explicit"
        error={apiError()}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Custom message');
    expect(screen.getByTestId('error-request-id')).toHaveTextContent('req-explicit');
  });

  it('renders no id line when the failure never reached the API', () => {
    // A network error has no request id because no request was answered.
    // Printing "request undefined" would be worse than printing nothing.
    render(<WidgetFrame title="Repo health" state="error" error={new Error('Failed to fetch')} />);

    expect(screen.queryByTestId('error-request-id')).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent('Failed to fetch');
  });

  it('falls back to a sentence rather than an empty red box', () => {
    render(<WidgetFrame title="Repo health" state="error" />);
    expect(screen.getByRole('alert')).toHaveTextContent(/something went wrong/i);
  });
});

describe('ErrorNote — the write surfaces (W16-18)', () => {
  // Mutations had no equivalent of WidgetFrame, so every write rendered
  // `error.message` alone. Those are the support cases: a failed read is
  // usually visible again on reload, a failed write is a thing someone reports.
  it('shows the message and the request id together', () => {
    render(<ErrorNote error={apiError({ title: 'Provider could not be saved' })} />);

    const note = screen.getByTestId('error-note');
    expect(note).toHaveTextContent('Provider could not be saved');
    expect(screen.getByTestId('error-note-request-id')).toHaveTextContent('req-4f2a');
  });

  it('renders nothing at all when there is no error', () => {
    // Not an empty bordered box: a mutation surface is on screen permanently,
    // and an always-present empty alert is noise a screen reader announces.
    render(<ErrorNote error={null} />);
    expect(screen.queryByTestId('error-note')).toBeNull();
  });
});
