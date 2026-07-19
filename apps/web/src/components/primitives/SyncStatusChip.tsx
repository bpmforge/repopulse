import type { SseConnection } from '../store/uiStore.js';

// SyncStatusChip (UX §2.2, DASHBOARD §6): the rail's live connection indicator.
// A status dot + text label — the label carries the state, the dot color is
// reinforcement only (UX §7). When a repo is mid-backfill it shows the phase +
// percent (FR-INGEST-8).

const CONN_LABEL: Record<SseConnection, string> = {
  connecting: 'Connecting…',
  open: 'Live',
  reconnecting: 'Reconnecting…',
  closed: 'Offline',
};

const CONN_DOT: Record<SseConnection, string> = {
  connecting: 'bg-warn',
  open: 'bg-ok',
  reconnecting: 'bg-warn',
  closed: 'bg-neutral',
};

export interface SyncStatusChipProps {
  connection: SseConnection;
  /** Optional active backfill: shown as "phase — n%". */
  progress?: { phase: string; pct: number } | undefined;
  className?: string;
}

export function SyncStatusChip({ connection, progress, className = '' }: SyncStatusChipProps) {
  const label = progress
    ? `${progress.phase} — ${Math.round(progress.pct)}%`
    : CONN_LABEL[connection];
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs text-fg-muted ${className}`}
      role="status"
      aria-label={`sync status: ${label}`}
      data-testid="sync-status-chip"
      data-connection={connection}
    >
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${progress ? 'bg-info' : CONN_DOT[connection]}`}
        aria-hidden="true"
      />
      <span className="truncate tabular-nums">{label}</span>
    </span>
  );
}
