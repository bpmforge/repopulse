import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ErrorNote, WidgetFrame, frameState } from '../../components/index.js';
import { useApiMutation, useApiQuery, queryKeyFor } from '../../api/useApiQuery.js';
import { localDateTime, windowLabel, type AiPause } from '../findings/aiContracts.js';

// Settings → Analysis: switch AI off for the whole workspace, and every scheduled
// pass in one list (W20-18, UX_TODO AI-77).
//
// Schedules could only be read and changed one repository at a time, and there
// was no single "turn AI off". Decision 2026-10-20: off means off. While AI is
// off no pass starts (by hand or on a schedule), no second opinion is asked and
// no verified fix is drafted, even one a person asks for. The API refuses each
// with a problem saying so; this panel is where it is switched.

const ACTION =
  'rounded-md border border-border px-2 py-1 text-xs hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';

interface ScheduleRow {
  repo: { id: number; org: string; name: string };
  enabled: boolean;
  frequency: 'daily' | 'weekly';
  scope: { kind: 'paths' | 'new_pull_requests'; paths: string[] };
  enabled_by: string | null;
  next_run_at: string | null;
  last_run_at: string | null;
  window: { start_hour: number; end_hour: number } | null;
  acknowledgement_stale: boolean;
}

interface SchedulesResponse {
  server_time_zone: string;
  ai_paused: AiPause;
  schedules: ScheduleRow[];
}

const LIST = { endpoint: '/ai-pass/schedules' } as const;

function DisableRow({ repoId }: { repoId: number }) {
  const off = useApiMutation<{ enabled: false }, unknown>(
    { endpoint: '/repos/{id}/ai-pass/schedule', path: { id: repoId }, method: 'PUT' },
    { invalidate: [queryKeyFor(LIST)] },
  );
  return (
    <>
      <button
        type="button"
        className={ACTION}
        data-testid={`ai-schedule-disable-${repoId}`}
        disabled={off.isPending}
        onClick={() => off.mutate({ enabled: false })}
      >
        {off.isPending ? 'Turning off…' : 'Turn off'}
      </button>
      <ErrorNote error={off.error} testId={`ai-schedule-disable-error-${repoId}`} />
    </>
  );
}

export function AiControls() {
  const { data, isLoading, isError, error, refetch } = useApiQuery<SchedulesResponse>(LIST);
  const pause = useApiMutation<{ paused: boolean }, unknown>(
    { endpoint: '/ai-pass/pause', method: 'PUT' },
    { invalidate: [queryKeyFor(LIST)] },
  );
  const disableAll = useApiMutation<Record<string, never>, { disabled: number }>(
    { endpoint: '/ai-pass/schedules/disable-all', method: 'POST' },
    { invalidate: [queryKeyFor(LIST)] },
  );
  const [confirmPause, setConfirmPause] = useState(false);
  const [confirmAll, setConfirmAll] = useState(false);

  const paused = data?.ai_paused?.paused === true;
  const enabled = (data?.schedules ?? []).filter((s) => s.enabled);
  const zone = data?.server_time_zone ?? '';
  const pausedWho = [
    data?.ai_paused?.paused_by ? `by ${data.ai_paused.paused_by}` : null,
    data?.ai_paused?.paused_at ? localDateTime(data.ai_paused.paused_at) : null,
  ]
    .filter(Boolean)
    .join(', ');

  return (
    <WidgetFrame
      title="AI switch and schedules"
      state={frameState({ isLoading, isError, isEmpty: false })}
      {...(error ? { errorMessage: error.message, error } : {})}
      onRetry={() => void refetch()}
      testId="ai-controls"
    >
      <div className="flex flex-col gap-4 text-sm">
        <div className="flex flex-col gap-2" data-testid="ai-switch">
          {paused ? (
            <p
              className="rounded-sm border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-fg"
              role="status"
              data-testid="ai-switch-off"
            >
              <strong>AI is off for this workspace</strong>
              {pausedWho ? ` (switched off ${pausedWho})` : ''}. No AI pass, scheduled pass, second
              opinion or verified-fix draft runs, including ones people ask for. Nothing is sent to
              any model.
            </p>
          ) : (
            <p className="text-xs text-fg-muted" data-testid="ai-switch-on">
              AI is on. Passes, schedules, second opinions and verified-fix drafts run within the
              limits on each screen.
            </p>
          )}
          {paused ? (
            <div>
              <button
                type="button"
                className={ACTION}
                data-testid="ai-switch-resume"
                disabled={pause.isPending}
                onClick={() => pause.mutate({ paused: false })}
              >
                Switch AI back on
              </button>
            </div>
          ) : confirmPause ? (
            <div
              className="flex flex-col gap-1 rounded-sm border border-warn/40 bg-warn/10 px-2 py-1.5 text-xs"
              data-testid="ai-switch-confirm"
            >
              <p>
                <strong>Switch AI off for the whole workspace?</strong> Every AI pass, scheduled
                pass, second opinion and verified-fix draft stops, including ones a person asks for.
                Work already queued is not sent. Schedules keep their settings and resume when AI is
                switched back on. Rule-based scanning is not affected.
              </p>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  className="rounded-md border border-warn px-2 py-1 text-xs hover:bg-warn/10 disabled:opacity-50"
                  data-testid="ai-switch-confirm-do"
                  disabled={pause.isPending}
                  onClick={() =>
                    pause.mutate({ paused: true }, { onSuccess: () => setConfirmPause(false) })
                  }
                >
                  Switch AI off
                </button>
                <button type="button" className={ACTION} onClick={() => setConfirmPause(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : (
            <div>
              <button
                type="button"
                className={ACTION}
                data-testid="ai-switch-pause"
                onClick={() => setConfirmPause(true)}
              >
                Switch AI off…
              </button>
            </div>
          )}
          <ErrorNote error={pause.error} testId="ai-switch-error" />
        </div>

        <div className="flex flex-col gap-2" data-testid="ai-schedules">
          <h4 className="text-xs tracking-wide text-fg-muted uppercase">Scheduled AI passes</h4>
          {data && (data.schedules ?? []).length === 0 ? (
            <p className="text-xs text-fg-muted" data-testid="ai-schedules-empty">
              No repository has a schedule. Nothing is sent to a model on a timer.
            </p>
          ) : (
            <div
              className="overflow-x-auto"
              tabIndex={0}
              role="region"
              aria-label="Scheduled AI passes"
            >
              <table className="table-plain w-full min-w-[36rem] text-sm">
                <caption className="sr-only">Every repository&rsquo;s scheduled AI pass</caption>
                <thead>
                  <tr className="text-left text-xs text-fg-muted">
                    <th scope="col">Repository</th>
                    <th scope="col">Schedule</th>
                    <th scope="col">Run window{zone ? ` (${zone})` : ''}</th>
                    <th scope="col">Enabled by</th>
                    <th scope="col">Next run</th>
                    <th scope="col">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody data-testid="ai-schedule-rows">
                  {(data?.schedules ?? []).map((s) => (
                    <tr
                      key={s.repo.id}
                      className="border-t border-border"
                      data-testid={`ai-schedule-${s.repo.id}`}
                    >
                      <th scope="row" className="py-1 text-left text-xs font-normal">
                        <Link
                          to="/repos/$repoId/ai-review"
                          params={{ repoId: String(s.repo.id) } as never}
                          hash="ai-review-pass"
                          className="underline underline-offset-2"
                        >
                          {s.repo.org}/{s.repo.name}
                        </Link>
                      </th>
                      <td className="py-1 text-xs">
                        {s.enabled ? (
                          <>
                            {s.frequency === 'daily' ? 'Daily' : 'Weekly'},{' '}
                            {s.scope.kind === 'paths'
                              ? `${s.scope.paths.length} path${s.scope.paths.length === 1 ? '' : 's'}`
                              : 'new pull requests'}
                            {s.acknowledgement_stale ? (
                              <span className="block text-fg">
                                Not running: the routing changed since it was acknowledged.
                              </span>
                            ) : null}
                          </>
                        ) : (
                          <span className="text-fg-muted">Off</span>
                        )}
                      </td>
                      <td className="py-1 text-xs">
                        {s.window ? windowLabel(s.window) : 'any time'}
                      </td>
                      <td className="py-1 text-xs">{s.enabled ? (s.enabled_by ?? '—') : '—'}</td>
                      <td className="py-1 text-xs">
                        {s.enabled
                          ? paused
                            ? 'paused (AI is off)'
                            : localDateTime(s.next_run_at)
                          : '—'}
                      </td>
                      <td className="py-1 text-xs">
                        {s.enabled ? <DisableRow repoId={s.repo.id} /> : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {enabled.length > 0 ? (
            confirmAll ? (
              <div
                className="flex flex-wrap items-center gap-1.5 text-xs"
                data-testid="ai-schedules-confirm"
              >
                <span>
                  Turn off all {enabled.length} schedule{enabled.length === 1 ? '' : 's'}? Their
                  settings are kept; each must be re-enabled on its repository.
                </span>
                <button
                  type="button"
                  className="rounded-md border border-warn px-2 py-1 text-xs hover:bg-warn/10 disabled:opacity-50"
                  data-testid="ai-schedules-disable-all-do"
                  disabled={disableAll.isPending}
                  onClick={() => disableAll.mutate({}, { onSuccess: () => setConfirmAll(false) })}
                >
                  Turn all off
                </button>
                <button type="button" className={ACTION} onClick={() => setConfirmAll(false)}>
                  Cancel
                </button>
              </div>
            ) : (
              <div>
                <button
                  type="button"
                  className={ACTION}
                  data-testid="ai-schedules-disable-all"
                  onClick={() => setConfirmAll(true)}
                >
                  Turn off every schedule…
                </button>
              </div>
            )
          ) : null}
          <ErrorNote error={disableAll.error} testId="ai-schedules-error" />
          {zone ? (
            <p className="text-xs text-fg-faint">
              Run windows and run times follow the server&rsquo;s time zone, {zone}; next-run times
              above are shown in your browser&rsquo;s.
            </p>
          ) : null}
        </div>
      </div>
    </WidgetFrame>
  );
}
