import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { apiFetch, buildUrl } from '../../api/client.js';
import { ErrorNote } from '../../components/index.js';

// Run it now (W16-10, F15).
//
// Repo → Security and Repo → Code Health both list scanners that have "never
// run", and until now neither screen offered any way to run one: everything was
// cron-driven, so the honest answer to "why is this empty?" was "come back on
// Sunday". For someone who installed RepoPulse an hour ago, a first run and a
// broken install look exactly the same.
//
// The button reports THREE outcomes, not two, because "already running" is not
// a failure and must not be shown as one — pressing twice is the most likely
// thing a person does when the first press produced no visible change.
//
// W17-20: the button now knows what the coverage table knows. While a scan is
// in flight it is locked with a label that says so, and it unlocks the moment
// the table reports a terminal state — so a second press cannot be queued
// behind a first that is still running, and "Starting…" cannot outlive the
// job. The server keeps its own guard (admin-only, deterministic jobId); this
// is the client half, not a replacement for it.

interface RunResult {
  started: string[];
  already_running: string[];
  repo: string;
}

export interface RunScanButtonProps {
  repoId: string;
  /** Refetched on success, so the coverage table stops saying "never". */
  invalidate: readonly (readonly unknown[])[];
  /** Scanner keys the coverage table reports in flight (useScanRun). */
  running?: readonly string[];
  /** A start was accepted and no worker has been seen to pick it up yet. */
  awaiting?: boolean;
  /** The wait for pickup timed out with nothing observed. */
  stalled?: boolean;
  /** Called when the API accepted the start, so the screen can follow it. */
  onStarted?: () => void;
  /**
   * W20-13 (UX_TODO FND-29): false for a signed-in non-admin, who used to
   * learn only after pressing that starting a scan needs the admin role.
   * Undefined (role not known yet) leaves the button as it was.
   */
  canRun?: boolean;
}

/** Fields read structurally, for the same reason as `requestIdOf` (W16-18). */
function statusOf(error: unknown): number | undefined {
  return (error as { status?: number } | null | undefined)?.status;
}
function detailOf(error: unknown): string | undefined {
  const detail = (error as { detail?: unknown } | null | undefined)?.detail;
  return typeof detail === 'string' && detail !== '' ? detail : undefined;
}

export function RunScanButton({
  repoId,
  invalidate,
  running = [],
  awaiting = false,
  stalled = false,
  onStarted,
  canRun,
}: RunScanButtonProps) {
  const queryClient = useQueryClient();
  const [result, setResult] = useState<RunResult | null>(null);
  const [finished, setFinished] = useState(false);

  const run = useMutation<RunResult, Error, void>({
    mutationFn: () =>
      apiFetch<RunResult>(buildUrl('/repos/{id}/scan', { path: { id: repoId } }), {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: async (r) => {
      setResult(r);
      setFinished(false);
      onStarted?.();
      for (const key of invalidate) await queryClient.invalidateQueries({ queryKey: key });
    },
  });

  const inFlight = running.length > 0;
  const pending = inFlight || awaiting;

  // When the job settles, "Started semgrep. Results appear here as each
  // finishes" is no longer true, and leaving it up is the spinner's cousin.
  const wasPending = useRef(false);
  useEffect(() => {
    if (wasPending.current && !pending) {
      setResult(null);
      setFinished(true);
    }
    wasPending.current = pending;
  }, [pending]);

  const label = run.isPending
    ? 'Starting…'
    : inFlight
      ? 'Scan running…'
      : awaiting
        ? 'Queued…'
        : 'Run scans now';

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="run-scan">
      <button
        type="button"
        data-testid="run-scan-button"
        // Locked for as long as there is anything to wait for, and for not one
        // moment longer: `pending` is derived from the table, so a terminal
        // state unlocks it without anyone remembering to.
        disabled={run.isPending || pending || canRun === false}
        aria-busy={run.isPending || pending ? 'true' : undefined}
        onClick={() => {
          setResult(null);
          setFinished(false);
          run.mutate();
        }}
        className="rounded-sm border border-border bg-surface-2 px-2.5 py-1 text-xs text-fg disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        {label}
      </button>

      {canRun === false && (
        <span className="text-xs text-fg-muted" data-testid="run-scan-admin-only">
          Starting a scan needs the admin role. Ask a workspace admin to run it.
        </span>
      )}
      {/* W16-18: carries the request id, so "I pressed Run and it failed" is
          findable in the log. */}
      <ErrorNote error={run.error} testId="run-scan-error" />
      {run.error && detailOf(run.error) && (
        // The API's `detail` is the half that says WHY — "no scanner is
        // enabled" and "Redis is not reachable" share a title shape and
        // nothing else. The title alone was all that reached the screen.
        <span className="text-xs text-fg-muted" data-testid="run-scan-error-detail">
          {detailOf(run.error)}
        </span>
      )}
      {run.error && statusOf(run.error) === 403 && (
        // A refusal on ROLE is not a failed scan and not a broken button. It
        // says who can press it, so the next step is a person, not a retry.
        <span className="text-xs text-fg-muted" data-testid="run-scan-forbidden">
          Starting a scan needs the admin role. Ask a workspace admin to run it, or to grant you the
          role — retrying will get the same answer.
        </span>
      )}

      {inFlight ? (
        <span className="text-xs text-fg-muted" data-testid="run-scan-running" role="status">
          Running now: {running.join(', ')}. The table refreshes every few seconds and this button
          unlocks when the scan settles.
        </span>
      ) : result ? (
        <span className="text-xs text-fg-muted" data-testid="run-scan-result" role="status">
          {result.started.length > 0 ? (
            <>
              Started {result.started.join(', ')}. Results appear here as each finishes — a scan
              takes minutes, not seconds.
            </>
          ) : (
            // Not an error, and deliberately not styled as one.
            <>Already running: {result.already_running.join(', ')}.</>
          )}
        </span>
      ) : finished ? (
        <span className="text-xs text-fg-muted" data-testid="run-scan-finished" role="status">
          The scan has settled — the table above is current.
        </span>
      ) : null}

      {stalled && (
        <span className="text-xs text-fg" data-testid="run-scan-stalled" role="status">
          ! The start was accepted, but no worker has picked it up in five minutes. The scan worker
          is probably not running: ask your administrator to start it. Pressing again will only
          queue it a second time.
        </span>
      )}
    </div>
  );
}
