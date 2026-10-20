import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ErrorNote } from '../../components/index.js';
import { useApiMutation, useApiQuery, queryKeyFor } from '../../api/useApiQuery.js';
import {
  READABLE_SOURCES,
  localDateTime,
  pausedLine,
  windowLabel,
  type PassStatus,
  type ScheduleResponse,
} from '../findings/aiContracts.js';

// Scheduled AI passes, on the repository's Security tab (W19-12).
//
// OFF BY DEFAULT, AND SAID SO. Nothing runs on a schedule until an admin enables
// it here, and enabling needs two things on screen: the server's own statement of
// WHERE SOURCE WOULD BE SENT (the same host-based "leaves your network" definition
// the egress audit uses) and a ticked acknowledgement of it. If the routing later
// changes, the schedule stops and says why until it is acknowledged again.
//
// A scheduled pass changes no finding, dismisses nothing and writes nothing to the
// repository (D9a). Every refusal is a row in the list below, with its reason.

const ACTION =
  'rounded-md border border-border px-2 py-1 text-xs hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';

const WORD: Record<PassStatus, string> = {
  pending: 'queued',
  running: 'running',
  succeeded: 'finished',
  failed: 'failed',
  skipped: 'skipped',
};
const MARK: Record<PassStatus, string> = {
  pending: '…',
  running: '…',
  succeeded: '✓',
  failed: '✕',
  skipped: '–',
};

// W20-11 (UX_TODO AI-39): local time with its zone, not the raw UTC string.
const when = (iso: string | null): string => localDateTime(iso);

/** Times a failed pull-request review is tried again (PR_REVIEW_ATTEMPTS on the server). */
const PR_REVIEW_ATTEMPTS = 3;

const HOURS = Array.from({ length: 24 }, (_, h) => h);
const hourText = (h: number) => `${String(h).padStart(2, '0')}:00`;

function parsePaths(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
}

export function ScheduledPasses({ repoId, isAdmin }: { repoId: string; isAdmin: boolean }) {
  const descriptor = { endpoint: '/repos/{id}/ai-pass/schedule', path: { id: repoId } } as const;
  const { data, isLoading, isError } = useApiQuery<ScheduleResponse>(descriptor);
  const put = useApiMutation<unknown, unknown>(
    { endpoint: '/repos/{id}/ai-pass/schedule', path: { id: repoId }, method: 'PUT' },
    { invalidate: [queryKeyFor(descriptor)] },
  );
  const cap = useApiMutation<{ monthly_call_cap: number }, unknown>(
    { endpoint: '/ai-pass/settings', method: 'PUT' },
    { invalidate: [queryKeyFor(descriptor)] },
  );
  const [editing, setEditing] = useState(false);
  const [frequency, setFrequency] = useState<'daily' | 'weekly'>('weekly');
  const [scope, setScope] = useState<'paths' | 'new_pull_requests'>('paths');
  const [paths, setPaths] = useState('');
  const [ack, setAck] = useState(false);
  // W20-18 (UX_TODO AI-53): an optional run window, in the server's hours.
  const [windowOn, setWindowOn] = useState(false);
  const [winStart, setWinStart] = useState(1);
  const [winEnd, setWinEnd] = useState(6);
  const [capText, setCapText] = useState<string | null>(null);
  const [capSaved, setCapSaved] = useState(false);

  if (isLoading) return <p className="text-sm text-fg-muted">Loading…</p>;
  if (isError || !data || !data.egress) {
    return (
      <p className="text-sm text-fg-muted" data-testid="schedule-unavailable">
        Schedule information could not be loaded. That says nothing about whether one is on.
      </p>
    );
  }

  const { schedule, egress, monthly } = data;
  const on = schedule?.enabled === true;
  const pathList = parsePaths(paths);
  const scopeOk = scope === 'new_pull_requests' || pathList.length > 0;
  const windowOk = !windowOn || winStart !== winEnd;
  const canEnable = ack && scopeOk && windowOk && egress.destinations.length > 0;
  // W20-18 (UX_TODO AI-53; decision 2026-10-20): run windows are in the SERVER's
  // time zone, named wherever a window is shown.
  const zone = data.server_time_zone ?? 'the server’s time zone';
  const off = pausedLine(data.ai_paused, 'no scheduled pass runs');
  // W20-11 (UX_TODO AI-37): why Enable is greyed out, in words, tied to the button.
  const enableBlockers = [
    ...(egress.destinations.length === 0 ? ['set up a model first, in Admin → Models'] : []),
    ...(scopeOk ? [] : ['enter at least one path']),
    ...(windowOk ? [] : ['choose a run window whose start and end differ']),
    ...(ack || egress.destinations.length === 0
      ? []
      : ['tick the box above to acknowledge where source would be sent']),
  ];
  const capShown = capText ?? String(monthly.cap);
  const capNumber = /^\d{1,6}$/.test(capShown.trim()) ? Number(capShown.trim()) : null;
  const showForm = isAdmin && editing;

  const startEditing = () => {
    setFrequency(schedule?.frequency ?? 'weekly');
    setScope(schedule?.scope.kind ?? 'paths');
    setPaths((schedule?.scope.paths ?? []).join('\n'));
    setWindowOn(Boolean(schedule?.window));
    setWinStart(schedule?.window?.start_hour ?? 1);
    setWinEnd(schedule?.window?.end_hour ?? 6);
    setAck(false);
    setEditing(true);
  };

  return (
    <section
      className="flex flex-col gap-3 border-t border-border pt-3"
      data-testid="scheduled-passes"
      aria-labelledby="scheduled-passes-h"
    >
      <h3 id="scheduled-passes-h" className="text-sm font-medium">
        Scheduled passes
      </h3>
      {off ? (
        <p
          className="rounded-sm border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-fg"
          role="status"
          data-testid="schedule-paused"
        >
          {off} Schedules keep their settings and resume when it is switched back on.
        </p>
      ) : null}

      {on && schedule ? (
        <div className="flex flex-col gap-2" data-testid="schedule-on">
          <p className="text-sm">
            <span className="rounded-sm border border-ok/50 bg-ok/10 px-1.5 py-0.5 text-xs">
              <span aria-hidden="true">✓ </span>On
            </span>{' '}
            {schedule.frequency === 'daily' ? 'Daily' : 'Weekly'}, reviewing{' '}
            {schedule.scope.kind === 'paths' ? (
              <span className="font-mono">{schedule.scope.paths.join(', ')}</span>
            ) : (
              'new pull requests since the last run'
            )}
            .
          </p>
          <p className="text-xs text-fg-muted" data-testid="schedule-window">
            {schedule.window
              ? `Runs only between ${windowLabel(schedule.window)}, ${zone} (the server’s time zone).`
              : `Runs at any time of day. Times are kept in ${zone} (the server’s time zone).`}
          </p>
          <p className="text-xs text-fg-muted" data-testid="schedule-times">
            Next run {when(schedule.next_run_at)} · last run {when(schedule.last_run_at)} · enabled
            {schedule.enabled_by ? ` by ${schedule.enabled_by}` : ''} on {when(schedule.enabled_at)}
            .
          </p>
          {data.acknowledgement_stale ? (
            <p
              className="rounded-sm border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-fg"
              role="alert"
              data-testid="schedule-stale"
            >
              The models this workspace routes to have changed since this schedule was enabled, so
              it is <strong>not running</strong> and each due run is recorded as skipped. Review
              where source would be sent now and acknowledge it again to continue.
            </p>
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-fg-muted" data-testid="schedule-off">
          <span className="rounded-sm border border-border px-1.5 py-0.5 text-xs">Off</span> No pass
          runs on a schedule for this repository. Nothing is sent to a model unless someone starts a
          pass.
        </p>
      )}

      <p className="text-xs text-fg-muted" data-testid="schedule-cap">
        Monthly cap: {monthly.used} of {monthly.cap} model calls used this month (
        {monthly.remaining} left). Scheduled passes stop when it is used up; passes started by hand
        count toward it but are never blocked by it. At most {data.limits.passes_per_day} passes a
        day, each limited to 30 calls. What hosted calls cost is estimated under{' '}
        <Link to="/admin/analysis" className="text-accent hover:underline">
          Admin → Analysis → AI spend
        </Link>
        .
      </p>

      {isAdmin && !showForm ? (
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className={ACTION}
            data-testid="schedule-edit"
            onClick={startEditing}
          >
            {on
              ? data.acknowledgement_stale
                ? 'Review and re-acknowledge'
                : 'Change schedule'
              : 'Set up a schedule'}
          </button>
          {on ? (
            <button
              type="button"
              className={ACTION}
              data-testid="schedule-off-button"
              disabled={put.isPending}
              onClick={() => put.mutate({ enabled: false })}
            >
              Turn off
            </button>
          ) : null}
        </div>
      ) : null}
      {!isAdmin ? (
        <p className="text-xs text-fg-faint">An admin sets up and changes schedules.</p>
      ) : null}

      {showForm ? (
        <form
          className="flex flex-col gap-3 rounded-sm border border-border p-3"
          data-testid="schedule-form"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canEnable) return;
            put.mutate(
              {
                enabled: true,
                frequency,
                scope: { kind: scope, ...(scope === 'paths' ? { paths: pathList } : {}) },
                window: windowOn ? { start_hour: winStart, end_hour: winEnd } : null,
                acknowledged_egress: egress.digest,
              },
              { onSuccess: () => setEditing(false) } as never,
            );
          }}
        >
          <fieldset className="flex flex-wrap gap-4 text-xs text-fg-muted">
            <legend className="mb-1">How often</legend>
            {(
              [
                ['weekly', 'Weekly'],
                ['daily', 'Daily'],
              ] as const
            ).map(([f, label]) => (
              <label key={f} className="flex items-center gap-1">
                <input
                  type="radio"
                  name="schedule-frequency"
                  data-testid={`schedule-frequency-${f}`}
                  checked={frequency === f}
                  onChange={() => setFrequency(f)}
                />
                {label}
              </label>
            ))}
            <span className="text-fg-faint">
              The first run is one interval from now, never at once.
            </span>
          </fieldset>

          <fieldset className="flex flex-wrap gap-4 text-xs text-fg-muted">
            <legend className="mb-1">What to review</legend>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name="schedule-scope"
                data-testid="schedule-scope-paths"
                checked={scope === 'paths'}
                onChange={() => setScope('paths')}
              />
              Files or directories
            </label>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name="schedule-scope"
                data-testid="schedule-scope-prs"
                checked={scope === 'new_pull_requests'}
                onChange={() => setScope('new_pull_requests')}
              />
              The diff of new pull requests since the last run
            </label>
          </fieldset>
          <fieldset
            className="flex flex-col gap-2 text-xs text-fg-muted"
            data-testid="schedule-window-fields"
          >
            <legend className="mb-1">When it may run</legend>
            <div className="flex flex-wrap gap-4">
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  name="schedule-window"
                  data-testid="schedule-window-any"
                  checked={!windowOn}
                  onChange={() => setWindowOn(false)}
                />
                At any time
              </label>
              <label className="flex items-center gap-1">
                <input
                  type="radio"
                  name="schedule-window"
                  data-testid="schedule-window-between"
                  checked={windowOn}
                  onChange={() => setWindowOn(true)}
                />
                Only in a window, for example outside working hours
              </label>
            </div>
            {windowOn ? (
              <div className="flex flex-wrap items-end gap-2">
                <label className="flex flex-col gap-1">
                  From
                  <select
                    className="panel px-2 py-1 text-sm"
                    data-testid="schedule-window-start"
                    value={winStart}
                    onChange={(e) => setWinStart(Number(e.target.value))}
                  >
                    {HOURS.map((h) => (
                      <option key={h} value={h}>
                        {hourText(h)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="flex flex-col gap-1">
                  Until
                  <select
                    className="panel px-2 py-1 text-sm"
                    data-testid="schedule-window-end"
                    value={winEnd}
                    onChange={(e) => setWinEnd(Number(e.target.value))}
                  >
                    {HOURS.map((h) => (
                      <option key={h} value={h}>
                        {hourText(h)}
                      </option>
                    ))}
                  </select>
                </label>
                <span className="text-fg" data-testid="schedule-window-zone">
                  {zone} (the server&rsquo;s time zone)
                </span>
              </div>
            ) : null}
            <span className="text-fg-faint">
              Times are the server&rsquo;s, in {zone}, not your browser&rsquo;s. A run that falls
              due outside the window waits for the window to open; an end before the start runs past
              midnight.
            </span>
          </fieldset>

          {scope === 'paths' ? (
            <label className="flex flex-col gap-1 text-xs text-fg-muted">
              Paths (one per line, relative to the repository root)
              <textarea
                className="panel w-full max-w-xl px-2 py-1 font-mono text-sm"
                rows={3}
                data-testid="schedule-paths"
                value={paths}
                onChange={(e) => setPaths(e.target.value)}
                placeholder="src/payments"
              />
              {/* W20-11 (UX_TODO AI-84): what a paths schedule re-reads, said
                  as plainly as the pull-request rule below. */}
              {/* W20-16 (UX_TODO AI-85): what a paths run reads, here too. */}
              <span className="text-fg-faint" data-testid="schedule-paths-languages">
                Reads {READABLE_SOURCES} files only, each up to 512 KB; each run says how many files
                it skipped.
              </span>
              <span className="text-fg-faint" data-testid="schedule-paths-rerun">
                Each run reads these paths again in full, up to 30 model calls. A run is skipped
                when no new commit has been ingested since the last one; a new commit anywhere in
                the repository makes the next run read these paths again.
              </span>
            </label>
          ) : (
            <p className="text-xs text-fg-faint">
              One open, non-draft pull request per run, oldest first, only if it changed since the
              last run; if more are waiting it looks again within the hour. A pull request is
              reviewed again only when its head changes, or when its review failed (tried up to{' '}
              {PR_REVIEW_ATTEMPTS} times).
            </p>
          )}

          {/* What leaves the network: the server's statement, then the consent. */}
          <div
            className={`rounded-sm border px-3 py-2 text-sm ${egress.destinations.length === 0 ? 'border-warn/40 bg-warn/10' : egress.leaves_network ? 'border-warn/40 bg-warn/10' : 'border-ok/40 bg-ok/10'}`}
            data-testid="schedule-egress"
            data-leaves={egress.leaves_network ? 'true' : 'false'}
          >
            <h4 className="text-xs tracking-wide text-fg-muted uppercase">
              Where source would be sent
            </h4>
            <p className="mt-1" data-testid="schedule-egress-sentence">
              {egress.sentence}
            </p>
            {egress.destinations.length > 0 ? (
              <ul className="mt-2 flex flex-col gap-1 text-xs">
                {egress.destinations.map((d) => (
                  <li key={d.provider_id} data-testid={`schedule-dest-${d.provider_id}`}>
                    <span className="font-medium">{d.provider_name}</span>{' '}
                    <span className="font-mono">{d.host ?? 'unknown host'}</span> —{' '}
                    {d.leaves_network ? 'off your network' : 'on your network'} · may receive source
                    for{' '}
                    {d.roles.length >= 7
                      ? 'every kind of analysis'
                      : d.roles.map((r) => r.replace(/_/g, ' ')).join(', ')}
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="mt-2 text-xs text-fg-muted">
              Sent: {egress.sends}. Every request is recorded in the egress audit.
              {egress.local_only
                ? ' Local-only is on: a schedule will not run through a link that leaves your network.'
                : ''}
            </p>
          </div>

          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              data-testid="schedule-ack"
              checked={ack}
              disabled={egress.destinations.length === 0}
              onChange={(e) => setAck(e.target.checked)}
            />
            <span>
              I understand that source from this repository will be sent to the destinations above,
              automatically and on this schedule, and that it uses model calls up to the cap.
            </span>
          </label>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              className={ACTION}
              data-testid="schedule-enable"
              disabled={!canEnable || put.isPending}
              aria-busy={put.isPending || undefined}
              aria-describedby={enableBlockers.length > 0 ? 'schedule-enable-hint' : undefined}
            >
              {put.isPending ? 'Saving…' : on ? 'Save and acknowledge' : 'Enable schedule'}
            </button>
            <button
              type="button"
              className="text-xs text-fg-muted underline underline-offset-2"
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </div>
          {enableBlockers.length > 0 ? (
            <p
              id="schedule-enable-hint"
              className="text-xs text-fg-muted"
              data-testid="schedule-enable-hint"
            >
              To enable: {enableBlockers.join('; ')}.
            </p>
          ) : null}
          <ErrorNote error={put.error} testId="schedule-error" />
        </form>
      ) : (
        <ErrorNote error={put.error} testId="schedule-error" />
      )}

      {isAdmin ? (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (capNumber !== null && capNumber <= 100000) {
              setCapSaved(false);
              cap.mutate({ monthly_call_cap: capNumber }, { onSuccess: () => setCapSaved(true) });
            }
          }}
        >
          {/* W20-11 (UX_TODO AI-36): one number for the whole workspace, edited
              here on one repository's tab, so the label says so; and a save
              says it saved. */}
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            Workspace monthly cap (model calls, all repositories)
            <input
              className="panel w-36 px-2 py-1 text-sm"
              inputMode="numeric"
              data-testid="schedule-cap-input"
              value={capShown}
              onChange={(e) => {
                setCapSaved(false);
                setCapText(e.target.value);
              }}
            />
          </label>
          <button
            type="submit"
            className={ACTION}
            data-testid="schedule-cap-save"
            disabled={
              capNumber === null || capNumber > 100000 || capNumber === monthly.cap || cap.isPending
            }
          >
            Save cap
          </button>
          <span className="text-xs text-fg-faint">
            Applies to every repository in this workspace. 0 stops every scheduled pass.
          </span>
          {capSaved ? (
            <span role="status" className="text-xs text-fg-muted" data-testid="schedule-cap-saved">
              Saved.
            </span>
          ) : null}
          <ErrorNote error={cap.error} testId="schedule-cap-error" />
        </form>
      ) : null}

      <div>
        <h4 className="text-xs tracking-wide text-fg-muted uppercase">Last scheduled runs</h4>
        {data.runs.length === 0 ? (
          <p className="mt-1 text-xs text-fg-muted" data-testid="schedule-runs-empty">
            None yet.{' '}
            {on
              ? 'The first run happens at the next-run time above.'
              : 'Nothing has run on a schedule.'}
          </p>
        ) : (
          <ol className="mt-1 flex flex-col gap-1" data-testid="schedule-runs">
            {data.runs.map((r) => (
              <li key={r.id} className="text-xs" data-testid={`schedule-run-${r.id}`}>
                <span aria-hidden="true">{MARK[r.status]}</span>{' '}
                <span className="text-sm">{WORD[r.status]}</span>
                <span className="text-fg-muted">
                  {' '}
                  · {when(r.created_at)}
                  {r.calls ? ` · ${r.calls} call${r.calls === 1 ? '' : 's'}` : ''}
                </span>
                {r.reason ? (
                  <span className="block text-fg-muted" data-testid="schedule-run-reason">
                    {r.reason}
                  </span>
                ) : null}
                {r.status === 'failed' && r.mode === 'pull_request' && r.pr_number ? (
                  <span className="block text-fg" data-testid="schedule-run-retry">
                    PR #{r.pr_number}: review failed. A later scheduled run tries it again, up to{' '}
                    {PR_REVIEW_ATTEMPTS} times for the same head.
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
        )}
      </div>
    </section>
  );
}
