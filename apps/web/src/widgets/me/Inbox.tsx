import { useEffect, useId, useRef, useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useApiMutation, useApiQuery, queryKeyFor } from '../../api/useApiQuery.js';
import { expiryWords } from '../admin/CiTokenExpiry.js';

// The in-app inbox (W20-10, UX_TODO X-03).
//
// Nothing told a human that something needed them: a leaked secret, a new KEV
// dependency or a critical finding waited until someone opened the right tab.
// Email and Slack are out of scope (D7), so the app is the only channel. This
// is a button in the top bar with an unread count — new high/critical, KEV and
// secrets findings and failed scans since this person last looked — opening a
// list that links to each one. "Mark all as seen" moves their own marker; it
// changes nothing for anyone else.

export const INBOX = { endpoint: '/me/inbox' } as const;

export interface InboxFinding {
  id: number;
  title: string;
  severity: number;
  dimension: string;
  kev: boolean;
  repo_id: number;
  repo: string;
  at: string;
}

export interface InboxScan {
  id: number;
  scanner: string;
  error: string | null;
  repo_id: number;
  repo: string;
  at: string;
}

/** W20-21 (UX_TODO AI-38): a scheduled pass you enabled that was skipped or failed. */
export interface InboxAiPass {
  id: number;
  status: string;
  reason: string | null;
  repo_id: number;
  repo: string;
  at: string;
}

/** W20-21 (UX_TODO AI-56): a member asked the admins for a pass (admins only). */
export interface InboxAiPassRequest {
  id: number;
  by: string | null;
  repo_id: number | null;
  repo: string | null;
  paths: string[];
  note: string | null;
  at: string;
}

/** W20-25 (UX_TODO ADM-50): a forge token expiring within 14 days (admins only). */
export interface InboxExpiringToken {
  connection_id: number;
  provider: string;
  base_url: string | null;
  owner: string | null;
  expires_at: string;
  days_left: number;
}

export interface InboxResponse {
  since: string;
  first_look: boolean;
  unread: number;
  findings_count: number;
  failed_scans_count: number;
  findings: InboxFinding[];
  failed_scans: InboxScan[];
  /** Absent from an API older than W20-21. */
  ai_passes?: InboxAiPass[];
  ai_pass_requests?: InboxAiPassRequest[];
  /** Absent from an API older than W20-25, and for members. */
  expiring_tokens?: InboxExpiringToken[];
}

/** Polled as well as refreshed by the sync stream: findings are not on the stream yet. */
const POLL_MS = 60_000;

/** Why this one is here, in words — never colour alone (UX_SPEC §7). */
export function findingReason(f: Pick<InboxFinding, 'severity' | 'dimension' | 'kev'>): string {
  if (f.dimension === 'secrets') return 'Secret';
  if (f.kev) return 'Known exploited';
  return f.severity >= 5 ? 'Critical' : 'High';
}

export function useInbox() {
  return useApiQuery<InboxResponse>(INBOX, { refetchInterval: POLL_MS });
}

export function Inbox() {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const { data } = useInbox();
  const seen = useApiMutation<undefined, { seen_at: string }>(
    { endpoint: '/me/inbox/seen', method: 'POST' },
    { invalidate: [queryKeyFor(INBOX)] },
  );
  const unread = data?.unread ?? 0;
  // Listed while true, whether or not it is new (W20-25, ADM-50).
  const tokens = data?.expiring_tokens ?? [];

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  return (
    <div className="relative">
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        data-testid="inbox-button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs text-fg hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        Inbox
        {unread > 0 ? (
          // W21-01: `text-surface`, not white. The dark theme's crit is a light
          // red (#ff645a) and white on it is 2.9:1; the surface colour is the
          // contrasting one in both themes (white on #b61e28, near-black on
          // #ff645a).
          <span
            className="rounded-full bg-crit px-1.5 text-[11px] font-medium text-surface tabular-nums"
            data-testid="inbox-count"
          >
            {unread > 99 ? '99+' : unread}
            <span className="sr-only"> new</span>
          </span>
        ) : null}
      </button>
      {open ? (
        <div
          id={panelId}
          role="dialog"
          aria-label="Inbox"
          data-testid="inbox-panel"
          className="panel absolute right-0 z-50 mt-1 flex max-h-[70vh] w-[min(26rem,calc(100vw-2rem))] flex-col gap-2 overflow-auto p-3 text-sm shadow-lg"
        >
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-sm font-medium">Needs you</h2>
            {data ? (
              <span className="text-xs text-fg-muted" data-testid="inbox-since">
                {data.first_look
                  ? 'from the last 7 days'
                  : `since ${new Date(data.since).toLocaleString()}`}
              </span>
            ) : null}
          </div>
          {data === undefined ? (
            <p className="text-xs text-fg-muted">Loading…</p>
          ) : unread === 0 && tokens.length === 0 ? (
            <p className="text-xs text-fg-muted" data-testid="inbox-empty">
              Nothing new: no high, critical, known-exploited or secrets findings, no failed scans
              and no AI pass news since you last looked.
            </p>
          ) : (
            <>
              {tokens.length > 0 ? (
                <section aria-label="Forge tokens expiring" className="flex flex-col gap-1">
                  <h3 className="text-xs text-fg-muted">Forge tokens to replace</h3>
                  <ul className="flex flex-col gap-1" data-testid="inbox-tokens">
                    {tokens.map((t) => (
                      <li key={t.connection_id}>
                        <Link
                          to={'/admin' as never}
                          onClick={() => setOpen(false)}
                          className="flex flex-col rounded-sm px-1 py-0.5 hover:bg-surface-2"
                          data-testid={`inbox-token-${t.connection_id}`}
                        >
                          <span>
                            <span className="mr-1.5 text-xs font-medium text-warn">Token</span>
                            {t.provider} connection{t.owner ? ` (${t.owner})` : ''}{' '}
                            {expiryWords(t.expires_at)}
                          </span>
                          <span className="text-xs text-fg-muted">
                            Syncing stops when it expires: replace it in Settings → Connections.
                          </span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {data.findings.length > 0 ? (
                <section aria-label="New findings" className="flex flex-col gap-1">
                  <h3 className="text-xs text-fg-muted">
                    {data.findings_count} new finding{data.findings_count === 1 ? '' : 's'}
                  </h3>
                  <ul className="flex flex-col gap-1" data-testid="inbox-findings">
                    {data.findings.map((f) => (
                      <li key={f.id}>
                        <Link
                          to={'/findings' as never}
                          search={{ finding: f.id } as never}
                          onClick={() => setOpen(false)}
                          className="flex flex-col rounded-sm px-1 py-0.5 hover:bg-surface-2"
                          data-testid={`inbox-finding-${f.id}`}
                        >
                          <span>
                            <span className="mr-1.5 text-xs font-medium text-crit">
                              {findingReason(f)}
                            </span>
                            {f.title}
                          </span>
                          <span className="text-xs text-fg-muted">{f.repo}</span>
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {(data.ai_passes ?? []).length > 0 ? (
                <section aria-label="Scheduled AI passes" className="flex flex-col gap-1">
                  <h3 className="text-xs text-fg-muted">Scheduled AI passes that did not run</h3>
                  <ul className="flex flex-col gap-1" data-testid="inbox-ai-passes">
                    {(data.ai_passes ?? []).map((p) => (
                      <li key={p.id}>
                        <Link
                          to={'/repos/$repoId/ai-review' as never}
                          params={{ repoId: String(p.repo_id) } as never}
                          hash="ai-review-pass"
                          onClick={() => setOpen(false)}
                          className="flex flex-col rounded-sm px-1 py-0.5 hover:bg-surface-2"
                          data-testid={`inbox-ai-pass-${p.id}`}
                        >
                          <span>
                            <span className="mr-1.5 text-xs font-medium text-warn">
                              {p.status === 'skipped' ? 'Pass skipped' : 'Pass failed'}
                            </span>
                            {p.repo}
                          </span>
                          {p.reason ? (
                            <span className="text-xs text-fg-muted">{p.reason}</span>
                          ) : null}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {(data.ai_pass_requests ?? []).length > 0 ? (
                <section aria-label="Requests for an AI pass" className="flex flex-col gap-1">
                  <h3 className="text-xs text-fg-muted">Asked for an AI pass</h3>
                  <ul className="flex flex-col gap-1" data-testid="inbox-ai-requests">
                    {(data.ai_pass_requests ?? []).map((r) => (
                      <li key={r.id}>
                        <Link
                          to={'/repos/$repoId/ai-review' as never}
                          params={{ repoId: String(r.repo_id ?? '') } as never}
                          hash="ai-review-pass"
                          onClick={() => setOpen(false)}
                          className="flex flex-col rounded-sm px-1 py-0.5 hover:bg-surface-2"
                          data-testid={`inbox-ai-request-${r.id}`}
                        >
                          <span>
                            <span className="mr-1.5 text-xs font-medium text-accent">Request</span>
                            {r.by ?? 'A member'} asked for a pass on {r.repo ?? 'a repository'}
                          </span>
                          {r.note || r.paths.length > 0 ? (
                            <span className="text-xs text-fg-muted">
                              {[r.paths.join(', '), r.note].filter(Boolean).join(' — ')}
                            </span>
                          ) : null}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              {data.failed_scans.length > 0 ? (
                <section aria-label="Failed scans" className="flex flex-col gap-1">
                  <h3 className="text-xs text-fg-muted">
                    {data.failed_scans_count} failed scan{data.failed_scans_count === 1 ? '' : 's'}
                  </h3>
                  <ul className="flex flex-col gap-1" data-testid="inbox-scans">
                    {data.failed_scans.map((r) => (
                      <li key={r.id}>
                        <Link
                          to={'/repos/$repoId/security' as never}
                          params={{ repoId: String(r.repo_id) } as never}
                          onClick={() => setOpen(false)}
                          className="flex flex-col rounded-sm px-1 py-0.5 hover:bg-surface-2"
                          data-testid={`inbox-scan-${r.id}`}
                        >
                          <span>
                            <span className="mr-1.5 text-xs font-medium text-warn">
                              Scan failed
                            </span>
                            {r.scanner} on {r.repo}
                          </span>
                          {r.error ? (
                            <span className="text-xs text-fg-muted">{r.error}</span>
                          ) : null}
                        </Link>
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
            </>
          )}
          <div className="flex justify-end">
            <button
              type="button"
              disabled={seen.isPending || unread === 0}
              data-testid="inbox-mark-seen"
              onClick={() => seen.mutate(undefined)}
              className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              Mark all as seen
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
