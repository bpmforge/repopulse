import { errorDetailOf, errorMessageOf, requestIdOf } from '../../api/client.js';

// The inline error for a WRITE (W16-18).
//
// WidgetFrame covers reads, and since this ticket it derives the request id
// from the error itself. Mutations had nothing equivalent: every write surface
// rendered `mutation.error.message` alone, so a person whose "Add provider" or
// "Run scans now" returned a 500 had nothing to quote and the operator had
// nothing to grep. Those are precisely the support cases — a failed read is
// usually visible again on reload, a failed write is a thing someone reports.
//
// The id is rendered selectable and monospaced because someone is going to copy
// it into a message.

export interface ErrorNoteProps {
  /** The mutation's error, as thrown. Nothing renders when it is absent. */
  error: unknown;
  testId?: string;
  className?: string;
  /**
   * Also show the problem's detail (W20-17). Opt-in because several surfaces
   * already render the detail beside the note themselves.
   */
  withDetail?: boolean;
}

export function ErrorNote({
  error,
  testId = 'error-note',
  className = '',
  withDetail = false,
}: ErrorNoteProps) {
  if (error === null || error === undefined) return null;

  const message = errorMessageOf(error) ?? 'Something went wrong.';
  const requestId = requestIdOf(error);
  // W20-17: the problem's detail too, when asked. It is usually the half that
  // says what to do ("rate is a fraction between 0 and 1").
  const detail = withDetail ? errorDetailOf(error) : undefined;

  return (
    <p className={`text-xs text-crit ${className}`} data-testid={testId} role="alert">
      {message}
      {detail && detail !== message ? (
        <span className="text-fg-muted" data-testid={`${testId}-detail`}>
          {' '}
          — {detail}
        </span>
      ) : null}
      {requestId ? (
        <>
          {' '}
          <span className="font-mono text-fg-faint" data-testid={`${testId}-request-id`}>
            (request {requestId})
          </span>
        </>
      ) : null}
    </p>
  );
}
