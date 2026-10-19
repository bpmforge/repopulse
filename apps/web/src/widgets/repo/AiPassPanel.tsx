import { useState } from 'react';
import { ErrorNote } from '../../components/index.js';
import { useApiMutation, useApiQuery, queryKeyFor } from '../../api/useApiQuery.js';
import {
  PASS_CAPS,
  passLabel,
  type AiPassRun,
  type PassMode,
  type PassStatus,
} from '../findings/aiContracts.js';
import { AiBadge } from '../findings/AiSuggestions.js';

// The AI review pass, on the repository's Security tab (W19-10).
//
// An admin names the files or directories to review; a worker reads them from a
// snapshot, runs the planned specialists through the configured models and then
// triages rule-raised findings with evidence. Results appear on the findings
// themselves, labelled AI. Nothing here changes a finding, dismisses anything or
// writes to the repository (D9a).
//
// "Not yet run" is its own state: a repository nobody has run a pass on has not
// been reviewed, which is not the same as reviewed and clean.

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

const ACTIVE = (s: PassStatus) => s === 'pending' || s === 'running';

function parsePaths(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((p) => p.trim())
    .filter((p) => p !== '');
}

function RunRow({ run }: { run: AiPassRun }) {
  const funnel = run.triage_funnel;
  const verdicts = funnel?.verdicts ?? {};
  const usage = run.specialists?.usage ?? {};
  const raised = Object.entries(usage).filter(([, u]) => (u.findings ?? 0) > 0);
  const dropped = run.specialists?.droppedForBudget ?? [];
  return (
    <li
      className="flex flex-col gap-1 border-t border-border pt-2"
      data-testid={`ai-pass-${run.id}`}
    >
      <p className="text-sm">
        <span aria-hidden="true">{MARK[run.status]}</span>{' '}
        <span data-testid="ai-pass-status">{WORD[run.status]}</span>
        <span className="text-xs text-fg-muted">
          {' '}
          · {run.created_at.slice(0, 16).replace('T', ' ')}
          {run.trigger === 'schedule'
            ? ' · started by the schedule'
            : run.requested_by
              ? ` · started by ${run.requested_by}`
              : ''}
          {run.calls !== null ? ` · ${run.calls} model call${run.calls === 1 ? '' : 's'}` : ''}
        </span>
      </p>
      <p className="text-xs text-fg-faint" data-testid="ai-pass-scope">
        Reviewed{' '}
        <span className="font-mono">
          {passLabel({
            mode: run.mode ?? 'paths',
            pr_number: run.pr_number ?? null,
            base_ref: run.base_ref ?? null,
            head_ref: run.head_ref ?? null,
            paths: run.paths,
          })}
        </span>
        .
      </p>
      {run.reason ? (
        <p className="text-xs text-fg-muted" data-testid="ai-pass-reason">
          {run.reason}
        </p>
      ) : null}
      {run.status === 'succeeded' || run.status === 'skipped' ? (
        <ul className="flex flex-col gap-0.5 text-xs text-fg-muted">
          {raised.length > 0 ? (
            <li data-testid="ai-pass-raised">
              Specialists raised:{' '}
              {raised.map(([id, u]) => `${id.replace(/_/g, ' ')} ${u.findings}`).join(', ')}.
            </li>
          ) : (
            <li data-testid="ai-pass-raised">No specialist raised a finding in this pass.</li>
          )}
          {(run.specialists?.unreadable ?? []).length > 0 ? (
            <li data-testid="ai-pass-unreadable">
              Not reviewed, because the forge did not give a complete patch:{' '}
              {(run.specialists?.unreadable ?? []).slice(0, 5).join(', ')}
              {(run.specialists?.unreadable ?? []).length > 5 ? ', …' : ''}.
            </li>
          ) : null}
          {dropped.length > 0 ? (
            <li data-testid="ai-pass-dropped">
              Did not run, because the call limit was reached:{' '}
              {dropped.map((d) => d.replace(/_/g, ' ')).join(', ')}. This pass says nothing about
              those dimensions.
            </li>
          ) : null}
          {funnel ? (
            <li data-testid="ai-pass-triage">
              Triage: {funnel.triaged ?? 0} finding{funnel.triaged === 1 ? '' : 's'} reviewed
              {funnel.accepted !== undefined ? `, ${funnel.accepted} kept` : ''}
              {Object.keys(verdicts).length > 0
                ? ` (${Object.entries(verdicts)
                    .map(([v, n]) => `${n} ${v.replace(/_/g, ' ')}`)
                    .join(', ')})`
                : ''}
              . Suggestions are on the findings.
            </li>
          ) : run.triage_skipped ? (
            <li data-testid="ai-pass-triage-skipped">Triage did not run: {run.triage_skipped}</li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

export function AiPassPanel({ repoId }: { repoId: string }) {
  const descriptor = { endpoint: '/repos/{id}/ai-pass', path: { id: repoId } } as const;
  const { data, isLoading, isError } = useApiQuery<{ runs?: AiPassRun[] }>(descriptor, {
    // Follow a pass while it is in flight; a settled list does not change.
    refetchInterval: (d) => ((d?.runs ?? []).some((r) => ACTIVE(r.status)) ? 5000 : false),
  });
  const { data: me } = useApiQuery<{ role?: string }>({ endpoint: '/me/context' });
  const isAdmin = me?.role === 'admin';
  const [text, setText] = useState('');
  const [mode, setMode] = useState<PassMode>('paths');
  const [pr, setPr] = useState('');
  const [base, setBase] = useState('');
  const [head, setHead] = useState('');
  const start = useApiMutation<
    { paths: string[] } | { pull_request: number } | { base: string; head: string },
    unknown
  >(
    { endpoint: '/repos/{id}/ai-pass', path: { id: repoId }, method: 'POST' },
    { invalidate: [queryKeyFor(descriptor)] },
  );

  const runs = data?.runs ?? [];
  const active = runs.some((r) => ACTIVE(r.status));
  const paths = parsePaths(text);
  const prNumber = /^[1-9][0-9]{0,8}$/.test(pr.trim()) ? Number(pr.trim()) : null;
  const sha = /^[0-9a-fA-F]{7,64}$/;
  const rangeOk = sha.test(base.trim()) && sha.test(head.trim());
  const body =
    mode === 'paths'
      ? paths.length > 0
        ? { paths }
        : null
      : mode === 'pull_request'
        ? prNumber !== null
          ? { pull_request: prNumber }
          : null
        : rangeOk
          ? { base: base.trim(), head: head.trim() }
          : null;

  return (
    <div className="flex flex-col gap-3" data-testid="ai-pass-panel">
      <p className="flex flex-wrap items-center gap-2 text-xs text-fg-muted">
        <AiBadge />
        <span>
          Reads the files you name, or the diff of a pull request or a short range of commits,
          through the models you configured, asks specialist reviewers for findings and gives
          rule-raised findings on the reviewed lines an evidence-backed second opinion. Everything
          it produces is a suggestion on a finding. It changes no finding and writes nothing to your
          repository.
        </span>
      </p>
      <p className="text-xs text-fg-faint" data-testid="ai-pass-caps">
        Limits: at most {PASS_CAPS.paths} paths, {PASS_CAPS.files} files and{' '}
        {PASS_CAPS.bytes / 1000} KB read (of source, or of diff), {PASS_CAPS.calls} model calls per
        pass, and {PASS_CAPS.perDay} passes a day for the workspace. Over a limit the pass is
        refused with the reason; it never reads part of what you asked for and calls it all.
      </p>

      {isAdmin ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (body) start.mutate(body);
          }}
        >
          <fieldset className="flex flex-wrap gap-4 text-xs text-fg-muted">
            <legend className="mb-1">What to review</legend>
            {(
              [
                ['paths', 'Files or directories'],
                ['pull_request', 'A pull request’s diff'],
                ['commit_range', 'A range of commits'],
              ] as const
            ).map(([m, label]) => (
              <label key={m} className="flex items-center gap-1">
                <input
                  type="radio"
                  name="ai-pass-mode"
                  data-testid={`ai-pass-mode-${m}`}
                  checked={mode === m}
                  onChange={() => setMode(m)}
                />
                {label}
              </label>
            ))}
          </fieldset>
          {mode === 'paths' ? (
            <label className="flex flex-col gap-1 text-xs text-fg-muted">
              Files or directories to review (one per line, relative to the repository root)
              <textarea
                className="panel w-full max-w-xl px-2 py-1 font-mono text-sm"
                rows={3}
                data-testid="ai-pass-paths"
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="src/payments"
              />
            </label>
          ) : mode === 'pull_request' ? (
            <div className="flex flex-col gap-1">
              <label className="flex flex-col gap-1 text-xs text-fg-muted">
                Pull request number (one RepoPulse has already ingested)
                <input
                  className="panel w-40 px-2 py-1 text-sm"
                  inputMode="numeric"
                  data-testid="ai-pass-pr"
                  value={pr}
                  onChange={(e) => setPr(e.target.value)}
                  placeholder="123"
                />
              </label>
              <p className="text-xs text-fg-faint">
                Reviews the lines the pull request changes, as the forge reports them. Files whose
                patch the forge does not send in full are listed as not reviewed.
              </p>
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              <div className="flex flex-wrap gap-3">
                <label className="flex flex-col gap-1 text-xs text-fg-muted">
                  Base commit (not reviewed)
                  <input
                    className="panel w-56 px-2 py-1 font-mono text-sm"
                    data-testid="ai-pass-base"
                    value={base}
                    onChange={(e) => setBase(e.target.value)}
                    placeholder="a1b2c3d"
                  />
                </label>
                <label className="flex flex-col gap-1 text-xs text-fg-muted">
                  Head commit (reviewed)
                  <input
                    className="panel w-56 px-2 py-1 font-mono text-sm"
                    data-testid="ai-pass-head"
                    value={head}
                    onChange={(e) => setHead(e.target.value)}
                    placeholder="e4f5a6b"
                  />
                </label>
              </div>
              <p className="text-xs text-fg-faint">
                Reviews the commits RepoPulse has ingested after the base up to the head, oldest
                first, at most {PASS_CAPS.commits}, merges skipped. RepoPulse keeps no commit graph,
                so this is the time-ordered set, and each commit&rsquo;s diff is reviewed on its
                own: a line number is as of the commit that changed it.
              </p>
            </div>
          )}
          <div>
            <button
              type="submit"
              className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              data-testid="ai-pass-start"
              disabled={body === null || start.isPending || active}
              aria-busy={start.isPending || undefined}
            >
              {start.isPending ? 'Starting…' : active ? 'A pass is running' : 'Start an AI pass'}
            </button>
          </div>
          {/* The server's own reason: a daily limit, an unreachable queue, a bad path. */}
          <ErrorNote error={start.error} testId="ai-pass-error" />
        </form>
      ) : (
        <p className="text-xs text-fg-muted" data-testid="ai-pass-admin-only">
          An admin starts a pass.
        </p>
      )}

      {isLoading ? (
        <p className="text-sm text-fg-muted">Loading…</p>
      ) : isError ? (
        <p className="text-sm text-fg-muted" data-testid="ai-pass-unavailable">
          The pass list could not be loaded. That says nothing about the repository.
        </p>
      ) : runs.length === 0 ? (
        <p className="text-sm text-fg-muted" data-testid="ai-pass-not-run">
          Not yet run: no AI pass has been started for this repository, so no AI review exists here.
          That is an absence of review, not a clean result.
        </p>
      ) : (
        <ol className="flex flex-col gap-2" data-testid="ai-pass-runs">
          {runs.map((r) => (
            <RunRow key={r.id} run={r} />
          ))}
        </ol>
      )}
    </div>
  );
}
