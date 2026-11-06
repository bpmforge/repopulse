import type { ReactNode } from 'react';
import { errorMessageOf, requestIdOf } from '../../api/client.js';
import type { WidgetState } from './types.js';

// WidgetFrame (UX §2.2 / §4 intro, DASHBOARD §4) wraps every widget with the
// loading/syncing/empty/error state machine, keyed off its query. Each state
// has a defined shape (UX §4):
//   loading = skeleton matching the final shape
//   syncing = skeleton + "History still loading — X% (phase)" chip (FR-INGEST-8)
//   empty   = one-line explanation + next action
//   error   = message + request id + retry button
// No widget blocks another — each frame owns its own state (DASHBOARD §9).

/** Map a TanStack Query result to a frame state. `syncing` overrides loading. */
export function frameState(input: {
  isLoading: boolean;
  isError: boolean;
  isEmpty: boolean;
  isSyncing?: boolean;
}): WidgetState {
  if (input.isSyncing && (input.isLoading || input.isEmpty)) return 'syncing';
  if (input.isError) return 'error';
  if (input.isLoading) return 'loading';
  if (input.isEmpty) return 'empty';
  return 'ready';
}

export interface WidgetFrameProps {
  title: string;
  state: WidgetState;
  children?: ReactNode;
  /** Link to the metric/definition (FR-METRICS-15). */
  definitionHref?: string;
  /** error state. */
  errorMessage?: string;
  requestId?: string;
  /**
   * The query's error, as thrown (W16-18).
   *
   * Prefer this over the two props above: it derives BOTH the message and the
   * request id, so a screen cannot show a failure the operator then cannot find
   * in the log. That was the state of the app before this — 86 error surfaces,
   * exactly one of which passed a request id, while the API had been putting
   * one in every problem body all along and ApiError had been parsing it.
   *
   * The explicit props still win when given: a few call sites pass a literal
   * string rather than an error object.
   */
  error?: unknown;
  onRetry?: () => void;
  /** syncing state. */
  syncPhase?: string;
  syncPct?: number;
  /** empty state. */
  emptyMessage?: string;
  emptyAction?: ReactNode;
  /** drill-down affordance shown in the header. */
  drillDown?: ReactNode;
  className?: string;
  testId?: string;
  /** An in-page anchor target (W26-04: the Security summary links to panels). */
  id?: string;
}

export function WidgetFrame({
  title,
  state,
  children,
  definitionHref,
  errorMessage,
  requestId,
  error,
  onRetry,
  syncPhase,
  syncPct,
  emptyMessage = 'No data in this window.',
  emptyAction,
  drillDown,
  className = '',
  testId = 'widget-frame',
  id,
}: WidgetFrameProps) {
  return (
    <section
      {...(id ? { id } : {})}
      className={`panel flex h-full flex-col ${className}`}
      data-testid={testId}
      data-state={state}
      aria-busy={state === 'loading' || state === 'syncing'}
    >
      <header className="flex items-center justify-between gap-2 px-4 pt-3.5 pb-1">
        <div className="flex items-center gap-1.5">
          <h3 className="text-[15px] font-semibold text-fg">{title}</h3>
          {/* W20-17 (UX_TODO ADM-31): an outside docs page opens in a new tab
              rather than replacing the app; the glyph gets a real target and
              a focus ring; "definition" was wrong for INSTALL.md links. */}
          {definitionHref && (
            <a
              href={definitionHref}
              className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-fg-faint hover:text-fg focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              // W20-22 (UX_TODO ADM-31): "Help: <topic>", what the link is.
              aria-label={`Help: ${title}${/^https?:/.test(definitionHref) ? ' (opens in a new tab)' : ''}`}
              title={`Help: ${title}`}
              {...(/^https?:/.test(definitionHref)
                ? { target: '_blank', rel: 'noopener noreferrer' }
                : {})}
            >
              ⓘ
            </a>
          )}
        </div>
        {drillDown}
      </header>

      {/* W26-02: a column, so a card's closing link or button can sit at the
          bottom and cards side by side in one row line up their actions. */}
      <div
        className="flex min-h-0 flex-1 flex-col px-4 pt-2 pb-4"
        data-testid={`widget-state-${state}`}
      >
        {state === 'loading' && <FrameSkeleton />}
        {state === 'syncing' && (
          <div className="flex flex-col gap-2">
            <span className="inline-flex w-fit items-center gap-1.5 rounded-sm bg-info/15 px-1.5 py-0.5 text-xs text-info">
              {/* W20-22 (INS-35): plain words; "backfilling" is ours. */}
              History still loading — {Math.round(syncPct ?? 0)}%
              {syncPhase ? ` (${syncPhase})` : ''}
            </span>
            <FrameSkeleton />
          </div>
        )}
        {state === 'empty' && (
          <div className="flex flex-1 flex-col items-start gap-2 text-sm text-fg-muted">
            <p>{emptyMessage}</p>
            {emptyAction ? <div className="mt-auto pt-1">{emptyAction}</div> : null}
          </div>
        )}
        {state === 'error' && (
          <div
            className="flex h-full flex-col items-start justify-center gap-2 text-sm"
            role="alert"
          >
            <p className="text-crit">
              {errorMessage ?? errorMessageOf(error) ?? 'Something went wrong.'}
            </p>
            {/* The id is what makes a support conversation possible: without it
                "it broke" cannot be found in a log. Rendered selectable and in
                a monospace face because someone is going to copy it. */}
            {(requestId ?? requestIdOf(error)) && (
              <p className="font-mono text-xs text-fg-faint" data-testid="error-request-id">
                request {requestId ?? requestIdOf(error)}
              </p>
            )}
            {onRetry && (
              <button
                type="button"
                onClick={onRetry}
                className="rounded-sm border border-border px-2 py-1 text-xs text-fg-muted hover:text-fg"
                data-testid="widget-retry"
              >
                Retry
              </button>
            )}
          </div>
        )}
        {state === 'ready' && children}
      </div>
    </section>
  );
}

function FrameSkeleton() {
  return (
    <div className="flex flex-col gap-2" aria-hidden="true">
      {[0, 1, 2].map((i) => (
        <div key={i} className="h-4 w-full animate-pulse rounded-sm bg-surface-2" />
      ))}
    </div>
  );
}
