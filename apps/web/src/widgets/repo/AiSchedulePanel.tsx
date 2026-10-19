import { useEffect, useState } from 'react';
import { ErrorNote } from '../../components/index.js';
import { useApiMutation, useApiQuery, queryKeyFor } from '../../api/useApiQuery.js';
import {
  PASS_CAPS,
  type AiPassScheduleBody,
  type AiPassScheduleResponse,
  type ScheduleCadence,
  type ScheduleScope,
} from '../findings/aiContracts.js';

// Scheduled AI passes, on the repository's AI Review tab (W19-12).
//
// Off until an admin turns it on. Turning it on - or letting a local-only
// schedule use hosted models - shows the server's own acknowledgement wording
// and will not save until it is ticked: a schedule sends this repository's code
// to a model with nobody pressing start. Every scheduled pass is an ordinary
// pass, listed with the others, and a due one that did not start is listed too,
// with the reason.

const day = (iso: string | null) => (iso ? iso.slice(0, 16).replace('T', ' ') : '');

function parsePaths(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
}

export function AiSchedulePanel({ repoId }: { repoId: string }) {
  const descriptor = { endpoint: '/repos/{id}/ai-pass/schedule', path: { id: repoId } } as const;
  const { data, isLoading, isError } = useApiQuery<AiPassScheduleResponse>(descriptor);
  const { data: me } = useApiQuery<{ role?: string }>({ endpoint: '/me/context' });
  const isAdmin = me?.role === 'admin';
  const save = useApiMutation<AiPassScheduleBody, AiPassScheduleResponse>(
    { endpoint: '/repos/{id}/ai-pass/schedule', path: { id: repoId }, method: 'PUT' },
    {
      invalidate: [
        queryKeyFor(descriptor),
        queryKeyFor({ endpoint: '/repos/{id}/ai-pass', path: { id: repoId } }),
      ],
    },
  );

  const saved = data?.schedule;
  const [enabled, setEnabled] = useState(false);
  const [scope, setScope] = useState<ScheduleScope>('new_commits');
  const [pathsText, setPathsText] = useState('');
  const [cadence, setCadence] = useState<ScheduleCadence>('weekly');
  const [cap, setCap] = useState('4');
  const [requireLocal, setRequireLocal] = useState(true);
  const [acked, setAcked] = useState(false);

  // The form starts from what is stored, and again after every save.
  useEffect(() => {
    if (!saved) return;
    setEnabled(saved.enabled);
    setScope(saved.scope);
    setPathsText(saved.paths.join('\n'));
    setCadence(saved.cadence);
    setCap(String(saved.monthly_cap));
    setRequireLocal(saved.require_local);
    setAcked(false);
  }, [saved]);

  if (isLoading) return <p className="text-sm text-fg-muted">Loading…</p>;
  if (isError || !saved || !data) {
    return (
      <p className="text-sm text-fg-muted" data-testid="ai-schedule-unavailable">
        The schedule could not be loaded. That says nothing about whether one is on.
      </p>
    );
  }

  const turningOn = enabled && !saved.enabled;
  const wideningEgress = enabled && saved.enabled && saved.require_local && !requireLocal;
  const needsAck = turningOn || wideningEgress;
  const capNumber = /^\d{1,2}$/.test(cap.trim()) ? Number(cap.trim()) : NaN;
  const capOk = capNumber >= 1 && capNumber <= 31;
  const paths = parsePaths(pathsText);
  const scopeOk = scope === 'new_commits' || paths.length > 0;
  const canSave = capOk && scopeOk && (!needsAck || acked) && !save.isPending;

  return (
    <div className="flex flex-col gap-3" data-testid="ai-schedule-panel">
      <p className="text-sm" data-testid="ai-schedule-state">
        {saved.enabled ? (
          <>
            <span className="font-medium">On.</span>{' '}
            {`A pass starts ${saved.cadence}, reviewing ${
              saved.scope === 'new_commits'
                ? `the commits ingested since the last scheduled pass (at most ${PASS_CAPS.commits})`
                : saved.paths.join(', ')
            }, ${saved.require_local ? 'on models on your network only' : 'on any configured model'}.`}
          </>
        ) : (
          <>
            <span className="font-medium">Off.</span> No AI pass starts unless someone presses
            start.
          </>
        )}
      </p>
      {saved.enabled ? (
        <ul className="flex flex-col gap-0.5 text-xs text-fg-muted">
          <li data-testid="ai-schedule-ack">
            Turned on by {saved.acknowledged_by ?? 'a former member'} on{' '}
            {day(saved.acknowledged_at)} (UTC), who acknowledged that code is sent without anyone
            pressing start.
          </li>
          <li data-testid="ai-schedule-next">
            {saved.last_scheduled_at
              ? `Last acted on ${day(saved.last_scheduled_at)}; next due from ${day(saved.next_due_at)} (UTC).`
              : 'Due at the next hourly check.'}
          </li>
          <li data-testid="ai-schedule-month">
            This month: {saved.started_this_month} of {saved.monthly_cap} scheduled pass
            {saved.monthly_cap === 1 ? '' : 'es'} started. A skipped one does not count.
          </li>
        </ul>
      ) : null}

      {isAdmin ? (
        <form
          className="flex flex-col gap-3 border-t border-border pt-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (!canSave) return;
            save.mutate({
              enabled,
              scope,
              paths: scope === 'paths' ? paths : [],
              cadence,
              monthly_cap: capNumber,
              require_local: requireLocal,
              ...(needsAck ? { acknowledge: data.acknowledgement.version } : {}),
            });
          }}
        >
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              data-testid="ai-schedule-enabled"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            Run AI passes on this repository on a schedule
          </label>

          <fieldset className="flex flex-col gap-1 text-xs text-fg-muted">
            <legend className="mb-1">What each scheduled pass reviews</legend>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name="ai-schedule-scope"
                data-testid="ai-schedule-scope-new_commits"
                checked={scope === 'new_commits'}
                onChange={() => setScope('new_commits')}
              />
              The commits ingested since the last scheduled pass (the newest {PASS_CAPS.commits} if
              there are more; the run says how many were left)
            </label>
            <label className="flex items-center gap-1">
              <input
                type="radio"
                name="ai-schedule-scope"
                data-testid="ai-schedule-scope-paths"
                checked={scope === 'paths'}
                onChange={() => setScope('paths')}
              />
              The same files or directories every time
            </label>
          </fieldset>
          {scope === 'paths' ? (
            <label className="flex flex-col gap-1 text-xs text-fg-muted">
              Files or directories (one per line, relative to the repository root)
              <textarea
                className="panel w-full max-w-xl px-2 py-1 font-mono text-sm"
                rows={3}
                data-testid="ai-schedule-paths"
                value={pathsText}
                onChange={(e) => setPathsText(e.target.value)}
                placeholder="src/payments"
              />
            </label>
          ) : null}

          <div className="flex flex-wrap gap-4">
            <label className="flex flex-col gap-1 text-xs text-fg-muted">
              How often
              <select
                className="panel w-32 px-2 py-1 text-sm"
                data-testid="ai-schedule-cadence"
                value={cadence}
                onChange={(e) => setCadence(e.target.value as ScheduleCadence)}
              >
                <option value="weekly">Weekly</option>
                <option value="daily">Daily</option>
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-fg-muted">
              Most scheduled passes a month (1 to 31)
              <input
                className="panel w-24 px-2 py-1 text-sm"
                inputMode="numeric"
                data-testid="ai-schedule-cap"
                value={cap}
                onChange={(e) => setCap(e.target.value)}
                aria-invalid={!capOk || undefined}
              />
            </label>
          </div>

          <label className="flex items-start gap-2 text-xs text-fg-muted">
            <input
              type="checkbox"
              className="mt-0.5"
              data-testid="ai-schedule-local"
              checked={requireLocal}
              onChange={(e) => setRequireLocal(e.target.checked)}
            />
            <span>
              Only on models on my network. If any role could reach a hosted model, the scheduled
              pass is skipped and the run names the connection.
            </span>
          </label>

          {needsAck ? (
            <label
              className="flex items-start gap-2 rounded-md border border-border p-2 text-sm"
              data-testid="ai-schedule-ack-box"
            >
              <input
                type="checkbox"
                className="mt-1"
                data-testid="ai-schedule-ack-check"
                checked={acked}
                onChange={(e) => setAcked(e.target.checked)}
              />
              <span>{data.acknowledgement.text}</span>
            </label>
          ) : null}

          <p className="text-xs text-fg-faint">
            Each scheduled pass is an ordinary pass: the same limits ({PASS_CAPS.calls} model calls,{' '}
            {PASS_CAPS.files} files, {PASS_CAPS.perDay} passes a day for the workspace), one at a
            time per repository, and it changes no finding and writes nothing to your repository.
          </p>
          <div>
            <button
              type="submit"
              className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              data-testid="ai-schedule-save"
              disabled={!canSave}
              aria-busy={save.isPending || undefined}
            >
              {save.isPending ? 'Saving…' : 'Save schedule'}
            </button>
          </div>
          <ErrorNote error={save.error} testId="ai-schedule-error" />
        </form>
      ) : (
        <p className="text-xs text-fg-muted" data-testid="ai-schedule-admin-only">
          An admin turns a schedule on or off.
        </p>
      )}
    </div>
  );
}
