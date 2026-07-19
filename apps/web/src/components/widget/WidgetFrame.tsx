import type { ReactNode } from 'react';
import type { WidgetState } from './types.js';

// WidgetFrame (UX §2.2 / §4 intro, DASHBOARD §4) wraps every widget with the
// loading/syncing/empty/error state machine, keyed off its query. Each state
// has a defined shape (UX §4):
//   loading = skeleton matching the final shape
//   syncing = skeleton + "backfilling — X% (phase)" chip (FR-INGEST-8)
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
}

export function WidgetFrame({
  title,
  state,
  children,
  definitionHref,
  errorMessage,
  requestId,
  onRetry,
  syncPhase,
  syncPct,
  emptyMessage = 'No data in this window.',
  emptyAction,
  drillDown,
  className = '',
  testId = 'widget-frame',
}: WidgetFrameProps) {
  return (
    <section
      className={`flex h-full flex-col rounded-md border border-border bg-surface ${className}`}
      data-testid={testId}
      data-state={state}
      aria-busy={state === 'loading' || state === 'syncing'}
    >
      <header className="flex items-center justify-between gap-2 border-b border-border px-3 py-2">
        <div className="flex items-center gap-1.5">
          <h3 className="text-sm font-medium text-fg">{title}</h3>
          {definitionHref && (
            <a
              href={definitionHref}
              className="text-fg-faint hover:text-fg"
              aria-label={`${title} definition`}
              title="Definition"
            >
              ⓘ
            </a>
          )}
        </div>
        {drillDown}
      </header>

      <div className="min-h-0 flex-1 p-3" data-testid={`widget-state-${state}`}>
        {state === 'loading' && <FrameSkeleton />}
        {state === 'syncing' && (
          <div className="flex flex-col gap-2">
            <span className="inline-flex w-fit items-center gap-1.5 rounded-sm bg-info/15 px-1.5 py-0.5 text-xs text-info">
              backfilling — {Math.round(syncPct ?? 0)}%{syncPhase ? ` (${syncPhase})` : ''}
            </span>
            <FrameSkeleton />
          </div>
        )}
        {state === 'empty' && (
          <div className="flex h-full flex-col items-start justify-center gap-2 text-sm text-fg-muted">
            <p>{emptyMessage}</p>
            {emptyAction}
          </div>
        )}
        {state === 'error' && (
          <div
            className="flex h-full flex-col items-start justify-center gap-2 text-sm"
            role="alert"
          >
            <p className="text-crit">{errorMessage ?? 'Something went wrong.'}</p>
            {requestId && <p className="font-mono text-xs text-fg-faint">request {requestId}</p>}
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
