import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import { buildUrl } from '../../api/client.js';

// Settings → Audit log (W20-10, UX_TODO X-04).
//
// Role changes, member removal, identity merges, rule promotions, scanner
// toggles, routing changes and Tier-3 opt-ins were written only as `audit:`
// lines in the container log, so an admin could not answer "who changed this,
// and when" from the app. The API now persists them (audit_events); this reads
// them back, filtered by event, actor and date, with a CSV export.

export interface AuditEntry {
  id: number;
  event: string;
  actor_user_id: number | null;
  actor_login: string | null;
  ip: string | null;
  detail: Record<string, unknown>;
  occurred_at: string;
}

export interface AuditPage {
  items: AuditEntry[];
  next_before: number | null;
  events: string[];
}

const PAGE = 50;
const PAGE_MAX = 200;

/** Words for the event names an admin meets most; anything else shows as recorded. */
const EVENT_LABELS: Record<string, string> = {
  'admin.role.changed': 'Role changed',
  'admin.member.removed': 'Member removed',
  'auth.password_reset': 'Password reset by an admin',
  'auth.session.revoked': 'Signed out everywhere',
  'workspace.settings.updated': 'Workspace settings changed',
  'identity.merged': 'Identities merged',
  'identity.merge_undone': 'Identity merge undone',
  'identity.bot_flagged': 'Bot flag changed',
  'identity.linked': 'Identity linked to a member',
  'repo.tier3_opt_in_changed': 'Tier-3 opt-in changed',
  'scanner.enablement_changed': 'Scanner switched on or off',
  'llm_provider.created': 'Model connection added',
  'llm_provider.updated': 'Model connection changed',
  'llm_provider.deleted': 'Model connection removed',
  'llm_routing.updated': 'Model routing changed',
  'connection.credential_replaced': 'Forge token replaced',
  'connection.removed': 'Forge connection removed',
  'connection.webhooks_reregistered': 'Webhooks re-registered',
  'repo.tracking_paused': 'Repository paused',
  'repo.tracking_resumed': 'Repository resumed',
  'ci_token.created': 'CI token created',
  'ci_token.revoked': 'CI token revoked',
  'finding.status_changed': 'Finding status changed',
  // W20-18 (UX_TODO X-08, AI-14, AI-77).
  'finding.bulk_export': 'Findings exported',
  'finding.external_ticket_set': 'Finding ticket link changed',
  'ai_verdict.second_opinion_requested': 'Second opinion asked of another model',
  'ai.paused_changed': 'AI switched off or on',
  'ai_pass_schedule.disabled_all': 'Every AI schedule turned off',
  'ops.backup.taken': 'Backup taken',
};

export function eventLabel(event: string): string {
  return EVENT_LABELS[event] ?? event;
}

/** The event's own fields, one line, for the table. Never a secret: the API never stores one. */
export function detailSummary(detail: Record<string, unknown>): string {
  return Object.entries(detail)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : String(v)}`)
    .join(' · ');
}

function formatWhen(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function AuditLog() {
  const [event, setEvent] = useState('');
  const [actor, setActor] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const query = { event, actor, from, to, limit };
  const { data, isLoading, isError, error, refetch } = useApiQuery<AuditPage>({
    endpoint: '/admin/audit',
    query,
  });
  const items = data?.items ?? [];
  const exportHref = buildUrl('/admin/audit', {
    query: { event, actor, from, to, format: 'csv', limit: 5000 },
  });
  const field =
    'rounded-md border border-border bg-surface-1 px-2 py-1 text-sm text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';

  return (
    <WidgetFrame
      title="Audit log"
      state={frameState({ isLoading, isError, isEmpty: false })}
      {...(error ? { errorMessage: error.message, error } : {})}
      onRetry={() => void refetch()}
    >
      <div className="flex flex-col gap-3" data-testid="audit-log">
        <p className="text-xs text-fg-muted">
          Who changed what in this workspace, newest first: roles, members, identities, rules,
          scanners, model routing, AI opt-ins, connections and settings. Failed sign-ins are in the
          server log only.
        </p>
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => e.preventDefault()}
          aria-label="Filter the audit log"
        >
          <label className="flex flex-col gap-0.5 text-xs text-fg-muted">
            Event
            <select
              className={field}
              value={event}
              data-testid="audit-filter-event"
              onChange={(e) => {
                setEvent(e.target.value);
                setLimit(PAGE);
              }}
            >
              <option value="">All events</option>
              {(data?.events ?? []).map((ev) => (
                <option key={ev} value={ev}>
                  {eventLabel(ev)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-0.5 text-xs text-fg-muted">
            Who
            <input
              className={field}
              value={actor}
              placeholder="login or user id"
              data-testid="audit-filter-actor"
              onChange={(e) => {
                setActor(e.target.value);
                setLimit(PAGE);
              }}
            />
          </label>
          <label className="flex flex-col gap-0.5 text-xs text-fg-muted">
            From
            <input
              type="date"
              className={field}
              value={from}
              data-testid="audit-filter-from"
              onChange={(e) => setFrom(e.target.value)}
            />
          </label>
          <label className="flex flex-col gap-0.5 text-xs text-fg-muted">
            To
            <input
              type="date"
              className={field}
              value={to}
              data-testid="audit-filter-to"
              onChange={(e) => setTo(e.target.value)}
            />
          </label>
          <a
            href={exportHref}
            download
            className="rounded-md border border-border px-2 py-1 text-sm text-fg hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            data-testid="audit-export"
          >
            Export CSV
          </a>
        </form>

        {data !== undefined && items.length === 0 ? (
          <p className="text-sm text-fg-muted" data-testid="audit-empty">
            {event || actor || from || to
              ? 'Nothing matches these filters.'
              : 'Nothing recorded yet. Changes made from now on appear here.'}
          </p>
        ) : (
          <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Audit entries">
            <table className="table-plain w-full text-sm">
              <caption className="sr-only">Audit entries, newest first</caption>
              <thead>
                <tr className="text-left text-xs text-fg-muted">
                  <th scope="col">When</th>
                  <th scope="col">Who</th>
                  <th scope="col">What</th>
                  <th scope="col">Details</th>
                </tr>
              </thead>
              <tbody data-testid="audit-rows">
                {items.map((r) => (
                  <tr key={r.id} className="border-t border-border" data-testid={`audit-${r.id}`}>
                    <td className="whitespace-nowrap py-1 tabular-nums">
                      <time dateTime={r.occurred_at}>{formatWhen(r.occurred_at)}</time>
                    </td>
                    <td className="py-1">
                      {r.actor_login ??
                        (r.actor_user_id === null ? (
                          <span className="text-fg-muted">the system</span>
                        ) : (
                          `user #${r.actor_user_id}`
                        ))}
                    </td>
                    <td className="py-1" title={r.event}>
                      {eventLabel(r.event)}
                    </td>
                    <td className="py-1 text-xs text-fg-muted">{detailSummary(r.detail)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {data?.next_before != null ? (
          limit < PAGE_MAX ? (
            <div>
              <button
                type="button"
                className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                data-testid="audit-more"
                onClick={() => setLimit((n) => Math.min(n + PAGE, PAGE_MAX))}
              >
                Show older entries
              </button>
            </div>
          ) : (
            <p className="text-xs text-fg-muted" data-testid="audit-more-export">
              Showing the newest {PAGE_MAX}. Narrow the dates, or export, to see older entries.
            </p>
          )
        ) : null}
      </div>
    </WidgetFrame>
  );
}

/**
 * "Last changed by X on date" (W20-10, UX_TODO X-04), for the screens whose
 * changes move numbers for everyone. Renders nothing until something has been
 * recorded, and nothing for a member (the audit log is admin-only).
 */
export function LastChanged({ events, testId }: { events: string[]; testId?: string }) {
  const { data } = useApiQuery<AuditPage>({
    endpoint: '/admin/audit',
    query: { event: events.join(','), limit: 1 },
  });
  const last = data?.items[0];
  if (!last) return null;
  return (
    <p className="text-xs text-fg-muted" data-testid={testId ?? 'last-changed'}>
      Last changed by{' '}
      {last.actor_login ??
        (last.actor_user_id === null ? 'the system' : `user #${last.actor_user_id}`)}{' '}
      on <time dateTime={last.occurred_at}>{formatWhen(last.occurred_at)}</time> (
      {eventLabel(last.event).toLowerCase()}).{' '}
      <Link to={'/admin/audit' as never} className="text-accent underline">
        Audit log
      </Link>
    </p>
  );
}
