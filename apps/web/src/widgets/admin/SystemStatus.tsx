import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { Button, WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';

// Settings → system health (W17-08, consumes W17-07's /admin/system).
//
// The question this answers is the one /setup/status cannot: not "have I
// finished configuring this?" but "is what I configured still running?" A fully
// configured install with a dead worker passes every setup check and ingests
// nothing, and before this the only evidence was a container log.

export type ComponentState = 'ready' | 'degraded' | 'unavailable' | 'unknown' | 'setup_needed';

export interface SystemComponent {
  id: string;
  label: string;
  state: ComponentState;
  reason: string;
  lastSuccessAt: string | null;
  action: { label: string; href: string } | null;
}

export interface SystemStatusResponse {
  checkedAt: string;
  overall: ComponentState;
  components: SystemComponent[];
  /** W20-10 (UX_TODO ADM-13). Optional: an older API omits it. */
  about?: {
    version: string;
    lastBackupAt: string | null;
    backupKeyFingerprint: string | null;
  };
}

/**
 * Colour AND words, never colour alone (W17-12 / WCAG 1.4.1). The state name is
 * rendered next to the dot, so the meaning survives greyscale, colour blindness
 * and a screenshot pasted into a ticket.
 */
const PRESENTATION: Record<ComponentState, { dot: string; text: string; label: string }> = {
  ready: { dot: 'bg-ok', text: 'text-fg-muted', label: 'Ready' },
  degraded: { dot: 'bg-warn', text: 'text-warn', label: 'Degraded' },
  unavailable: { dot: 'bg-crit', text: 'text-crit', label: 'Not working' },
  unknown: { dot: 'bg-fg-muted', text: 'text-fg-muted', label: 'Unknown' },
  // Info blue, not the accent (W18-28): the teal accent sits next to the
  // green `ok` dot and the two read as the same state in the dark theme.
  setup_needed: { dot: 'bg-info', text: 'text-fg-muted', label: 'Setup needed' },
};

/** Modest interval: this is a status panel, not a live console. */
const POLL_MS = 30_000;

function relative(iso: string | null): string {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return 'unknown';
  const mins = Math.round(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function SystemStatus() {
  const [showDetail, setShowDetail] = useState(false);
  const { data, isLoading, isError, error, refetch, isFetching } =
    useApiQuery<SystemStatusResponse>(
      { endpoint: '/admin/system' },
      // refetchInterval keeps a single request in flight per interval: React
      // Query will not stack a second one while the first is still pending,
      // which is what "avoid overlapping requests" needs here.
      { refetchInterval: POLL_MS },
    );

  // A FAILED request must not leave a stale green panel on screen. If the poll
  // starts failing, the frame goes to its error state and the last-known
  // components are not rendered underneath it — an operator reading "Ready"
  // from a response that no longer arrives is exactly the lie this widget was
  // built to stop.
  const state = frameState({ isLoading, isError, isEmpty: (data?.components.length ?? 0) === 0 });

  return (
    <WidgetFrame
      title="System health"
      state={state}
      error={error}
      onRetry={() => void refetch()}
      emptyMessage="The status endpoint returned no components."
      testId="system-status"
    >
      {data ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-fg-muted">
              Checked {relative(data.checkedAt)}
              {isFetching ? ' · refreshing' : ''}
              {/* W20-10 (UX_TODO ADM-13): which release, before following an
                  upgrade, and when the last backup was recorded. */}
              {data.about ? (
                <span data-testid="system-status-about">
                  {' '}
                  · RepoPulse <span className="font-mono">{data.about.version}</span> · last backup{' '}
                  {relative(data.about.lastBackupAt)}
                </span>
              ) : null}
            </p>
            <Button size="sm" onClick={() => void refetch()} data-testid="system-status-refresh">
              Refresh
            </Button>
          </div>

          <ul className="flex flex-col gap-2" data-testid="system-status-list">
            {data.components.map((c) => {
              const p = PRESENTATION[c.state];
              return (
                <li
                  key={c.id}
                  className="flex flex-col gap-1 rounded-lg border border-border p-3 sm:flex-row sm:items-start sm:justify-between sm:gap-4"
                  data-testid={`system-component-${c.id}`}
                >
                  <div className="min-w-0">
                    <p className="flex items-center gap-2 text-sm font-medium">
                      <span
                        className={`inline-block h-2 w-2 shrink-0 rounded-full ${p.dot}`}
                        aria-hidden="true"
                      />
                      <span>{c.label}</span>
                      <span
                        className={`text-xs font-normal ${p.text}`}
                        data-testid={`system-state-${c.id}`}
                      >
                        {p.label}
                      </span>
                    </p>
                    <p className="mt-1 text-xs text-fg-muted">{c.reason}</p>
                  </div>
                  <div className="flex shrink-0 items-center gap-3 text-xs">
                    <span className="text-fg-muted" title={c.lastSuccessAt ?? 'never'}>
                      {c.lastSuccessAt ? relative(c.lastSuccessAt) : '—'}
                    </span>
                    {c.action ? (
                      <Link
                        to={c.action.href as never}
                        className="text-accent underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                        data-testid={`system-action-${c.id}`}
                      >
                        {c.action.label}
                      </Link>
                    ) : null}
                  </div>
                </li>
              );
            })}
          </ul>

          {/* Technical detail stays available but out of the way — an operator
              reading plain language first is the point, and the raw payload is
              what they paste into an issue when it is not enough. */}
          <div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowDetail((v) => !v)}
              aria-expanded={showDetail}
              className="px-0"
              data-testid="system-status-diagnostics-toggle"
            >
              {showDetail ? 'Hide diagnostics' : 'Show diagnostics'}
            </Button>
            {showDetail ? (
              <pre
                className="mt-2 max-h-64 overflow-auto rounded-md border border-border p-2 text-[11px] leading-relaxed"
                data-testid="system-status-diagnostics"
              >
                {JSON.stringify(data, null, 2)}
              </pre>
            ) : null}
          </div>
        </div>
      ) : null}
    </WidgetFrame>
  );
}
