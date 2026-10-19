// A long error that a keyboard, touch or screen-reader user can still read
// (W20-14, UX_TODO ADM-16). Sync and the dead-letter queue cut errors to 60
// characters with the rest only in a `title` tooltip, which only a mouse can
// open. A native <details> needs no script and is announced as expandable.

export const ERROR_PREVIEW_CHARS = 60;

export function errorPreview(message: string, limit = ERROR_PREVIEW_CHARS): string {
  return message.length <= limit ? message : `${message.slice(0, limit).trimEnd()}…`;
}

export function ErrorDetails({
  message,
  at,
  testId,
}: {
  message: string;
  /** When it happened, shown inside the disclosure. */
  at?: string | null;
  testId?: string;
}) {
  if (message.length <= ERROR_PREVIEW_CHARS && !at) {
    return (
      <span className="text-crit" data-testid={testId}>
        {message}
      </span>
    );
  }
  return (
    <details className="max-w-md text-crit" data-testid={testId}>
      <summary className="cursor-pointer rounded-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent">
        {errorPreview(message)}
      </summary>
      <p className="mt-1 whitespace-pre-wrap break-words text-xs">{message}</p>
      {at ? <p className="mt-0.5 text-xs text-fg-muted">{new Date(at).toLocaleString()}</p> : null}
    </details>
  );
}
