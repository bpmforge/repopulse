import { useState } from 'react';
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

interface RunResult {
  started: string[];
  already_running: string[];
  repo: string;
}

export interface RunScanButtonProps {
  repoId: string;
  /** Refetched on success, so the coverage table stops saying "never". */
  invalidate: readonly (readonly unknown[])[];
}

export function RunScanButton({ repoId, invalidate }: RunScanButtonProps) {
  const queryClient = useQueryClient();
  const [result, setResult] = useState<RunResult | null>(null);

  const run = useMutation<RunResult, Error, void>({
    mutationFn: () =>
      apiFetch<RunResult>(buildUrl('/repos/{id}/scan', { path: { id: repoId } }), {
        method: 'POST',
        body: JSON.stringify({}),
      }),
    onSuccess: async (r) => {
      setResult(r);
      for (const key of invalidate) await queryClient.invalidateQueries({ queryKey: key });
    },
  });

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="run-scan">
      <button
        type="button"
        data-testid="run-scan-button"
        disabled={run.isPending}
        onClick={() => {
          setResult(null);
          run.mutate();
        }}
        className="rounded-sm border border-border bg-surface-2 px-2.5 py-1 text-xs text-fg disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
      >
        {run.isPending ? 'Starting…' : 'Run scans now'}
      </button>

      {/* W16-18: carries the request id, so "I pressed Run and it failed" is
          findable in the log. */}
      <ErrorNote error={run.error} testId="run-scan-error" />

      {result ? (
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
      ) : null}
    </div>
  );
}
