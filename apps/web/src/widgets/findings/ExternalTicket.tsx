import { useState } from 'react';
import { ErrorNote } from '../../components/index.js';
import { useApiMutation } from '../../api/useApiQuery.js';
import { ticketLabel } from './contracts.js';

// The external ticket on a finding (W20-18, UX_TODO X-08; decision 2026-10-20:
// "the ticket field as an optional URL"). A security engineer moving findings
// into Jira or Linear records the issue here, and "tracked until done" can point
// at it. http(s) only (the API refuses anything else); any member may set it;
// every change is in the audit log. It decides nothing about the finding.

const ACTION =
  'rounded-md border border-border px-2 py-1 text-xs hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';

/** The link itself, opening in a new tab. Null when there is nothing safe to link. */
export function TicketLink({
  url,
  testId,
  className = '',
}: {
  url: string | null | undefined;
  testId?: string;
  className?: string;
}) {
  const label = ticketLabel(url);
  if (!label || !url) return null;
  return (
    <a
      href={url}
      target="_blank"
      rel="noopener noreferrer"
      className={`underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent ${className}`}
      data-testid={testId}
      title={url}
      onClick={(e) => e.stopPropagation()}
    >
      {label}
      <span className="sr-only"> (external ticket, opens in a new tab)</span>
      <span aria-hidden="true"> ↗</span>
    </a>
  );
}

/** The drawer's field: show the link, and add, change or remove it. */
export function ExternalTicket({
  findingId,
  url,
  invalidate,
}: {
  findingId: number;
  url: string | null | undefined;
  invalidate: readonly (readonly unknown[])[];
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(url ?? '');
  const save = useApiMutation<{ url: string | null }, { external_ticket_url: string | null }>(
    { endpoint: '/findings/{id}/external-ticket', path: { id: findingId }, method: 'PUT' },
    { invalidate },
  );
  const trimmed = draft.trim();
  const looksOk = trimmed === '' || /^https?:\/\/\S+$/i.test(trimmed);

  return (
    <div className="flex flex-col gap-1 text-xs" data-testid="finding-ticket">
      <h3 className="text-xs tracking-wide text-fg-muted uppercase">External ticket</h3>
      {!editing ? (
        <p className="flex flex-wrap items-center gap-2">
          {url ? (
            <TicketLink url={url} testId="finding-ticket-link" />
          ) : (
            <span className="text-fg-muted">No ticket linked.</span>
          )}
          <button
            type="button"
            className={ACTION}
            data-testid="finding-ticket-edit"
            onClick={() => {
              setDraft(url ?? '');
              setEditing(true);
            }}
          >
            {url ? 'Change' : 'Link a ticket'}
          </button>
          {url ? (
            <button
              type="button"
              className={ACTION}
              data-testid="finding-ticket-remove"
              disabled={save.isPending}
              onClick={() => save.mutate({ url: null })}
            >
              Remove
            </button>
          ) : null}
        </p>
      ) : (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (!looksOk) return;
            save.mutate(
              { url: trimmed === '' ? null : trimmed },
              { onSuccess: () => setEditing(false) },
            );
          }}
        >
          <label className="flex min-w-0 flex-1 flex-col gap-1 text-fg-muted">
            Link to the issue (Jira, Linear, GitHub, ...)
            <input
              type="url"
              inputMode="url"
              className="panel w-full px-2 py-1 text-sm"
              data-testid="finding-ticket-input"
              placeholder="https://"
              maxLength={2048}
              value={draft}
              aria-invalid={!looksOk || undefined}
              aria-describedby="finding-ticket-hint"
              onChange={(e) => setDraft(e.target.value)}
            />
          </label>
          <button
            type="submit"
            className={ACTION}
            data-testid="finding-ticket-save"
            disabled={!looksOk || save.isPending}
          >
            {save.isPending ? 'Saving…' : 'Save'}
          </button>
          <button type="button" className={ACTION} onClick={() => setEditing(false)}>
            Cancel
          </button>
          <span id="finding-ticket-hint" className="w-full text-fg-faint">
            {looksOk
              ? 'An http or https link. Saving records who changed it in the audit log; it does not change the finding.'
              : 'Paste the full link, starting with https://.'}
          </span>
        </form>
      )}
      <ErrorNote error={save.error} testId="finding-ticket-error" />
    </div>
  );
}
