import { READABLE_SOURCES } from '../findings/aiContracts.js';
import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { ErrorNote } from '../../components/index.js';
import { useApiMutation, useApiQuery, queryKeyFor } from '../../api/useApiQuery.js';
import {
  PASS_CAPS,
  TRIAGE_PER_PASS,
  localDateTime,
  passLabel,
  pausedLine,
  specialistLabel,
  type AiPassRun,
  type AiPause,
  type PassMode,
  type PassStatus,
  type ScheduleResponse,
} from '../findings/aiContracts.js';
import { AiBadge } from '../findings/AiSuggestions.js';
import { ScheduledPasses } from './ScheduledPasses.js';

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

/**
 * W20-11 (UX_TODO AI-85, partial): the pass reads only these source types. The
 * panel promised it "never reads part of what you asked for", while a directory
 * of Vue or Terraform files was quietly reviewed as its TypeScript alone. Mirrors
 * READABLE in packages/security/src/snapshot/sources.ts.
 */
// The file types a pass reads live with the AI contracts (W20-16) so the
// schedule form can say the same thing without importing this panel.
export { READABLE_SOURCES } from '../findings/aiContracts.js';

/** Minutes after which a queued pass no worker took is called stalled (as "Run scans now" does). */
export const STALLED_AFTER_MIN = 5;

const LINK =
  'underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';

/**
 * The next step for a failed pass, by its reason code (W20-11, UX_TODO AI-35).
 * A failure said what went wrong and stopped: "no model configured" did not
 * link to Models, nor a local-only refusal to Routing. Members are told who can
 * act, since the fixes are admin pages.
 */
export function failureFix(
  run: Pick<AiPassRun, 'status' | 'reason_code' | 'reason'>,
  isAdmin: boolean,
): ReactNode {
  if (run.status !== 'failed') return null;
  const code = run.reason_code ?? '';
  const admin = (to: string, label: string, hash?: string) =>
    isAdmin ? (
      <Link to={to as never} {...(hash ? { hash } : {})} className={LINK}>
        {label}
      </Link>
    ) : (
      <span>Ask an admin to {label.charAt(0).toLowerCase() + label.slice(1)}.</span>
    );
  if (code === 'no_gateway') return admin('/admin/models', 'Set up a model in Admin → Models');
  if (code === 'specialists_unusable') {
    return admin(
      '/admin/models',
      'Compare models in Admin → Models → Quality per model',
      'quality-per-model',
    );
  }
  if (code === 'no_connection' || code === 'no_snapshot') {
    return admin('/admin/sync', 'Check the forge connection in Admin → Sync');
  }
  if (code === 'no_head_sha') return <span>Wait for the first sync of this repository.</span>;
  if (code === 'too_large' || code === 'no_files' || code === 'bad_range' || code === 'not_found') {
    return <span>Change what to review above, then start the pass again.</span>;
  }
  // A local-only refusal arrives as a plain error carrying its own sentence.
  if (/local[- ]only/i.test(run.reason ?? '')) {
    return admin('/admin/models', 'Change the routing in Admin → Models → Routing');
  }
  return admin(
    '/admin/models',
    'Test the model in Admin → Models (it may be down, still loading or out of memory)',
  );
}

/** Whole minutes since a timestamp, for a pass in flight. */
function minutesSince(iso: string | null, now: number): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : Math.max(0, Math.floor((now - t) / 60000));
}
const duration = (min: number): string =>
  min < 60 ? `${min} min` : `${Math.floor(min / 60)} h ${min % 60} min`;

function RunRow({
  run,
  isAdmin,
  repoId,
  onRerun,
  invalidate,
}: {
  run: AiPassRun;
  isAdmin: boolean;
  repoId: string;
  /** Starts the same scope again; absent while a pass runs or for a member. */
  onRerun?: (() => void) | undefined;
  invalidate: readonly (readonly unknown[])[];
}) {
  // W20-21 (UX_TODO AI-33): a queued or running pass can be stopped.
  const cancel = useApiMutation<Record<string, never>, unknown>(
    {
      endpoint: '/repos/{id}/ai-pass/{runId}/cancel',
      path: { id: repoId, runId: run.id },
      method: 'POST',
    },
    { invalidate },
  );
  const funnel = run.triage_funnel;
  const verdicts = funnel?.verdicts ?? {};
  const usage = run.specialists?.usage ?? {};
  const raised = Object.entries(usage).filter(([, u]) => (u.findings ?? 0) > 0);
  const dropped = run.specialists?.droppedForBudget ?? [];
  // W20-06 (UX_TODO AI-59): answers that could not be used were stored but never
  // shown, so a pass where every specialist failed read "✓ finished, no finding".
  const failures = run.specialists?.failures ?? [];
  const failedBy = new Map<string, string[]>();
  for (const f of failures) {
    failedBy.set(f.specialist, [...(failedBy.get(f.specialist) ?? []), ...f.paths]);
  }
  const rejectedCount = run.specialists?.rejected ?? 0;
  const now = Date.now();
  const elapsed = minutesSince(run.started_at, now);
  const waiting = minutesSince(run.created_at, now);
  const fix = failureFix(run, isAdmin);
  // W20-11 (UX_TODO AI-60): findings a failed pass's specialists had already
  // written are real findings on the repository; the row now says so.
  const savedBeforeFailure = raised.reduce((n, [, u]) => n + (u.findings ?? 0), 0);
  const filesRead = run.specialists?.filesRead;
  const filesSkipped = run.specialists?.filesSkipped;
  const skippedTop = funnel?.skipped?.below_top_n ?? 0;
  const skippedBudget = funnel?.skipped?.budget_exhausted ?? 0;
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
          {run.trigger === 'scheduled' ? ' · scheduled' : ''} · {localDateTime(run.created_at)}
          {run.requested_by ? ` · started by ${run.requested_by}` : ''}
          {run.calls !== null ? ` · ${run.calls} model call${run.calls === 1 ? '' : 's'}` : ''}
        </span>
      </p>
      {/* W20-11 (UX_TODO AI-64, partial): a pass no worker picks up sat at
          "queued…" forever, and a long one on a slow local model showed nothing
          moving. Calls so far are not recorded until the pass ends. */}
      {run.status === 'running' && elapsed !== null ? (
        <p className="text-xs text-fg-muted" data-testid="ai-pass-elapsed">
          {/* W20-21 (AI-64): calls are now counted as they happen. */}
          Running for {duration(elapsed)}
          {run.calls !== null && run.calls !== undefined
            ? `, ${run.calls} of at most ${PASS_CAPS.calls} model calls so far`
            : ''}
          . A pass on a local model can take several minutes.
        </p>
      ) : null}
      {isAdmin && ACTIVE(run.status) ? (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <button
            type="button"
            className="rounded-md border border-border px-2 py-0.5 hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            data-testid="ai-pass-cancel"
            disabled={cancel.isPending}
            onClick={() => cancel.mutate({})}
          >
            {cancel.isPending ? 'Cancelling…' : 'Cancel this pass'}
          </button>
          <span className="text-fg-faint">
            Stops before its next model call; findings already saved stay.
          </span>
          <ErrorNote error={cancel.error} testId="ai-pass-cancel-error" />
        </div>
      ) : null}
      {run.status === 'pending' && waiting !== null && waiting >= STALLED_AFTER_MIN ? (
        <p className="text-xs text-fg" role="alert" data-testid="ai-pass-stalled">
          Queued for {duration(waiting)} and no worker has picked it up.{' '}
          {isAdmin
            ? 'Check that the worker is running (Settings → System health).'
            : 'Ask an admin to check the worker.'}
        </p>
      ) : null}
      <p className="text-xs text-fg-faint" data-testid="ai-pass-scope">
        Reviewed{' '}
        <span>
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
      {fix ? (
        <p className="text-xs text-fg" data-testid="ai-pass-fix">
          Next step: {fix}
        </p>
      ) : null}
      {run.status === 'failed' && savedBeforeFailure > 0 ? (
        <p className="text-xs text-fg" data-testid="ai-pass-saved-before-failure">
          {savedBeforeFailure} finding{savedBeforeFailure === 1 ? ' was' : 's were'} saved before it
          failed ({raised.map(([id, u]) => `${specialistLabel(id)} ${u.findings}`).join(', ')}).
          They are on the findings list like any other.
        </p>
      ) : null}
      {failedBy.size > 0 ? (
        <div className="text-xs text-fg" data-testid="ai-pass-failures">
          <p>
            <span className="font-semibold">Could not use the answer of:</span> the model&apos;s
            reply was malformed even after a retry. This pass says nothing about these.
          </p>
          <ul className="ml-4 list-disc">
            {[...failedBy.entries()].map(([id, paths]) => (
              <li key={id}>
                {specialistLabel(id)}: {[...new Set(paths)].slice(0, 5).join(', ')}
                {new Set(paths).size > 5 ? ', …' : ''}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {rejectedCount > 0 ? (
        <p className="text-xs text-fg-muted" data-testid="ai-pass-rejected">
          {rejectedCount} suggested finding{rejectedCount === 1 ? ' was' : 's were'} discarded
          because the evidence did not match the source.
        </p>
      ) : null}
      {run.status === 'succeeded' || run.status === 'skipped' ? (
        <ul className="flex flex-col gap-0.5 text-xs text-fg-muted">
          {raised.length > 0 ? (
            <li data-testid="ai-pass-raised">
              Specialists raised:{' '}
              {raised.map(([id, u]) => `${specialistLabel(id)} ${u.findings}`).join(', ')}.{' '}
              {/* W20-21 (UX_TODO AI-32): straight to what this pass raised. */}
              <Link
                to="/findings"
                search={{ repos: repoId, ai_pass_run_id: String(run.id), status: 'any' } as never}
                className={LINK}
                data-testid="ai-pass-raised-link"
              >
                Show the findings this pass raised
              </Link>
            </li>
          ) : failedBy.size > 0 ? (
            <li data-testid="ai-pass-raised">
              No usable answer raised a finding; see above for the specialists that could not be
              used.
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
              {dropped.map(specialistLabel).join(', ')}. This pass says nothing about those
              dimensions.
            </li>
          ) : null}
          {typeof filesRead === 'number' && (run.mode ?? 'paths') === 'paths' ? (
            <li data-testid="ai-pass-files-read">
              {filesRead} file{filesRead === 1 ? '' : 's'} read
              {filesSkipped && filesSkipped.unsupported + filesSkipped.tooLarge > 0 ? (
                <>
                  ; {filesSkipped.unsupported + filesSkipped.tooLarge} skipped (
                  {[
                    filesSkipped.unsupported > 0
                      ? `${filesSkipped.unsupported} of a type the pass does not read`
                      : null,
                    filesSkipped.tooLarge > 0 ? `${filesSkipped.tooLarge} over 512 KB` : null,
                  ]
                    .filter(Boolean)
                    .join(', ')}
                  )
                </>
              ) : null}
              . Only {READABLE_SOURCES} files are read.
            </li>
          ) : null}
          {funnel ? (
            <li data-testid="ai-pass-triage">
              {/* W20-11 (UX_TODO AI-82, AI-50): the funnel the processor stores,
                  so a pass over 80 findings does not read as all 80 triaged, and
                  "kept" said in words. */}
              Triage: {funnel.triaged ?? 0}
              {funnel.candidates !== undefined ? ` of ${funnel.candidates} eligible` : ''} finding
              {(funnel.candidates ?? funnel.triaged) === 1 ? '' : 's'} reviewed
              {funnel.accepted !== undefined ? `, ${funnel.accepted} gave a usable answer` : ''}
              {Object.keys(verdicts).length > 0
                ? ` (${Object.entries(verdicts)
                    .map(([v, n]) => `${n} ${v.replace(/_/g, ' ')}`)
                    .join(', ')})`
                : ''}
              .
              {skippedTop > 0
                ? ` ${skippedTop} not looked at, because a pass triages at most ${TRIAGE_PER_PASS}.`
                : ''}
              {skippedBudget > 0 ? ` ${skippedBudget} dropped when the call budget ran out.` : ''}{' '}
              Suggestions are on the findings:{' '}
              <Link
                to="/findings"
                search={{ repos: repoId } as never}
                className={LINK}
                data-testid="ai-pass-findings-link"
              >
                open this repository&rsquo;s findings
              </Link>
              .
              {skippedTop + skippedBudget > 0 && onRerun ? (
                <>
                  {' '}
                  <button
                    type="button"
                    className={LINK}
                    data-testid="ai-pass-rerun"
                    onClick={onRerun}
                  >
                    Run again to triage the next {TRIAGE_PER_PASS}
                  </button>
                </>
              ) : null}
            </li>
          ) : run.triage_skipped ? (
            <li data-testid="ai-pass-triage-skipped">Triage did not run: {run.triage_skipped}</li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

/**
 * Where the code would go, said BEFORE a pass is started (W20-06, UX_TODO AI-11).
 *
 * The scheduled form already showed the server's destinations and asked for an
 * acknowledgement; the manual Start, the more common path, showed nothing. This
 * reads the same server statement (the schedule route's `egress`, built from the
 * stored routing and each endpoint's host by the egress audit's rule), so the
 * two can never disagree. Shared query key: no second request.
 */
export function PassDestinations({ repoId }: { repoId: string }) {
  const { data, isLoading, isError } = useApiQuery<ScheduleResponse>({
    endpoint: '/repos/{id}/ai-pass/schedule',
    path: { id: repoId },
  });
  if (isLoading) return null;
  const egress = data?.egress;
  if (isError || !egress) {
    return (
      <p className="text-xs text-fg-muted" data-testid="ai-pass-egress-unknown">
        Where the code would be sent could not be loaded. Check Admin → Models → Routing before
        starting.
      </p>
    );
  }
  return (
    <div
      className={`rounded-sm border px-2 py-1.5 text-xs ${egress.leaves_network || egress.destinations.length === 0 ? 'border-warn/40 bg-warn/10' : 'border-ok/40 bg-ok/10'}`}
      data-testid="ai-pass-egress"
      data-leaves={egress.leaves_network ? 'true' : 'false'}
    >
      <p data-testid="ai-pass-egress-sentence">
        <span className="font-semibold">Where the code goes:</span> {egress.sentence}
      </p>
      {egress.destinations.length > 0 ? (
        <ul className="mt-1 flex flex-col gap-0.5">
          {egress.destinations.map((d) => (
            <li key={d.provider_id} data-testid={`ai-pass-dest-${d.provider_id}`}>
              <span className="font-medium">{d.provider_name}</span>{' '}
              <span className="font-mono">{d.host ?? 'unknown host'}</span> —{' '}
              {d.leaves_network ? 'off your network' : 'on your network'}
              {d.models && d.models.length > 0 ? (
                <>
                  {' '}
                  · model <span className="font-mono">{d.models.join(', ')}</span>
                </>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="mt-1 text-fg-muted">Sent: {egress.sends}.</p>
    </div>
  );
}

/** GET /repos/:id/ai-pass/pickers (W20-21, UX_TODO AI-31). */
export interface PassPickers {
  prs: { number: number; title: string; state: string }[];
  commits: { sha: string; message: string; at: string }[];
  files: string[];
  files_truncated: boolean;
}

/** Files plus every directory above them, so a directory can be picked too. */
export function pickerPaths(files: readonly string[]): string[] {
  const out = new Set<string>();
  for (const f of files) {
    out.add(f);
    const parts = f.split('/');
    for (let i = 1; i < parts.length; i++) out.add(parts.slice(0, i).join('/'));
  }
  return [...out].sort();
}

/**
 * A member's way to ask for a pass (W20-21, UX_TODO AI-56). Members read only
 * "An admin starts a pass."; now they see who the admins are and can send them
 * a request, which lands in the admins' inbox. Nothing goes to a model.
 */
function AskAnAdmin({ repoId, admins }: { repoId: string; admins: string[] }) {
  const [note, setNote] = useState('');
  const ask = useApiMutation<{ note: string }, { asked: boolean; admins: string[] }>({
    endpoint: '/repos/{id}/ai-pass/ask',
    path: { id: repoId },
    method: 'POST',
  });
  return (
    <div className="flex flex-col gap-1 text-xs text-fg-muted" data-testid="ai-pass-admin-only">
      <p>
        An admin starts a pass
        {admins.length > 0 ? ` (admins here: ${admins.join(', ')})` : ''}.
      </p>
      {ask.isSuccess ? (
        <p role="status" data-testid="ai-pass-asked">
          Asked. The admins see your request in their inbox.
        </p>
      ) : (
        <form
          className="flex flex-wrap items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            ask.mutate({ note: note.trim() });
          }}
        >
          <label className="flex flex-col gap-1">
            What should it look at, and why? (optional)
            <input
              className="panel w-80 px-2 py-1 text-sm"
              data-testid="ai-pass-ask-note"
              value={note}
              maxLength={500}
              onChange={(e) => setNote(e.target.value)}
            />
          </label>
          <button
            type="submit"
            className="rounded-md border border-border px-2 py-1 hover:border-accent disabled:opacity-50"
            data-testid="ai-pass-ask"
            disabled={ask.isPending}
          >
            {ask.isPending ? 'Asking…' : 'Ask an admin for a pass'}
          </button>
        </form>
      )}
      <ErrorNote error={ask.error} testId="ai-pass-ask-error" />
    </div>
  );
}

export function AiPassPanel({
  repoId,
  initialPaths,
}: {
  repoId: string;
  /** W20-11 (UX_TODO AI-44): a finding's "start a pass" link prefills its file. */
  initialPaths?: string | undefined;
}) {
  // W20-11 (UX_TODO AI-81): the API leaves out scheduled skips (which used to
  // push every real pass out of the ten newest, so a reviewed repository could
  // read "not yet run") and returns older passes on request.
  const [limit, setLimit] = useState(10);
  const descriptor = {
    endpoint: '/repos/{id}/ai-pass',
    path: { id: repoId },
    ...(limit !== 10 ? { query: { limit } } : {}),
  } as const;
  const { data, isLoading, isError } = useApiQuery<{
    runs?: AiPassRun[];
    more?: boolean;
    /** W20-18 (UX_TODO AI-77). */
    ai_paused?: AiPause;
    /** W20-21 (UX_TODO AI-56): who can start a pass. */
    admins?: string[];
  }>(descriptor, {
    // Follow a pass while it is in flight; a settled list does not change.
    refetchInterval: (d) => ((d?.runs ?? []).some((r) => ACTIVE(r.status)) ? 5000 : false),
  });
  const { data: me } = useApiQuery<{ role?: string }>({ endpoint: '/me/context' });
  const isAdmin = me?.role === 'admin';
  const [text, setText] = useState(initialPaths ?? '');
  const [mode, setMode] = useState<PassMode>('paths');
  const [pr, setPr] = useState('');
  const [base, setBase] = useState('');
  const [head, setHead] = useState('');
  const [addPath, setAddPath] = useState('');
  // W20-21 (UX_TODO AI-31): what to pick from, from what RepoPulse ingested.
  const { data: pickers } = useApiQuery<PassPickers>(
    { endpoint: '/repos/{id}/ai-pass/pickers', path: { id: repoId } },
    { enabled: isAdmin },
  );
  const start = useApiMutation<
    { paths: string[] } | { pull_request: number } | { base: string; head: string },
    unknown
  >(
    { endpoint: '/repos/{id}/ai-pass', path: { id: repoId }, method: 'POST' },
    { invalidate: [queryKeyFor(descriptor)] },
  );

  const all = data?.runs ?? [];
  const active = all.some((r) => ACTIVE(r.status));
  // A scheduled pass that was REFUSED has no review to show; it is listed, with its
  // reason, under Scheduled passes. Every pass that actually started stays here.
  const runs = all.filter((r) => !(r.trigger === 'scheduled' && r.status === 'skipped'));
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
  // W20-11 (UX_TODO AI-30): why Start is greyed out, in words, tied to the
  // button (the wizard's pattern from W19-13).
  const off = pausedLine(data?.ai_paused, 'no AI pass can start');
  const startBlocker = off
    ? 'AI analysis is switched off for this workspace'
    : active
      ? 'wait for the running pass to end; this list follows it'
      : body !== null
        ? null
        : mode === 'paths'
          ? 'enter at least one file or directory'
          : mode === 'pull_request'
            ? 'enter a pull request number'
            : 'enter a base and a head commit SHA (7 to 64 hexadecimal characters each)';
  const rerun = (r: AiPassRun) => {
    const m = r.mode ?? 'paths';
    if (m === 'paths' && r.paths.length > 0) start.mutate({ paths: r.paths });
    else if (m === 'pull_request' && r.pr_number) start.mutate({ pull_request: r.pr_number });
    else if (m === 'commit_range' && r.base_ref && r.head_ref)
      start.mutate({ base: r.base_ref, head: r.head_ref });
  };
  const newest = runs[0];

  return (
    <div className="flex flex-col gap-3" data-testid="ai-pass-panel" id="ai-review-pass">
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
        pass, and {PASS_CAPS.perDay} passes a day for the workspace (passes that ran, failed ones
        included; a scheduled run that was skipped does not count). Over a limit the pass is refused
        with the reason; it never reads part of what you asked for and calls it all.
      </p>
      {off ? (
        <p
          className="rounded-sm border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-fg"
          role="status"
          data-testid="ai-pass-paused"
        >
          {off}
        </p>
      ) : null}

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
            <>
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
                <span className="text-fg-faint" data-testid="ai-pass-languages">
                  Reads {READABLE_SOURCES} files only, each up to 512 KB. Other files in these paths
                  are not reviewed.
                </span>
              </label>
              {pickers && (pickers.files ?? []).length > 0 ? (
                <div className="flex flex-wrap items-end gap-2 text-xs text-fg-muted">
                  <label className="flex flex-col gap-1">
                    Add a file or directory changed in an ingested commit
                    <input
                      className="panel w-80 px-2 py-1 font-mono text-sm"
                      list="ai-pass-file-options"
                      data-testid="ai-pass-file-picker"
                      value={addPath}
                      onChange={(e) => setAddPath(e.target.value)}
                      placeholder="Type to search"
                    />
                  </label>
                  <datalist id="ai-pass-file-options">
                    {pickerPaths(pickers.files).map((f) => (
                      <option key={f} value={f} />
                    ))}
                  </datalist>
                  <button
                    type="button"
                    className="rounded-md border border-border px-2 py-1 hover:border-accent disabled:opacity-50"
                    data-testid="ai-pass-file-add"
                    disabled={addPath.trim() === ''}
                    onClick={() => {
                      const next = [...new Set([...parsePaths(text), addPath.trim()])];
                      setText(next.join('\n'));
                      setAddPath('');
                    }}
                  >
                    Add
                  </button>
                  {pickers.files_truncated ? (
                    <span className="text-fg-faint">
                      Showing the first {pickers.files.length} paths; type any other path above.
                    </span>
                  ) : null}
                </div>
              ) : null}
            </>
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
              {pickers && (pickers.prs ?? []).length > 0 ? (
                <label className="flex flex-col gap-1 text-xs text-fg-muted">
                  Or pick one
                  <select
                    className="panel max-w-xl px-2 py-1 text-sm"
                    data-testid="ai-pass-pr-picker"
                    value={pr}
                    onChange={(e) => setPr(e.target.value)}
                  >
                    <option value="">Recent pull requests…</option>
                    {pickers.prs.map((p) => (
                      <option key={p.number} value={String(p.number)}>
                        #{p.number} {p.title} ({p.state})
                      </option>
                    ))}
                  </select>
                </label>
              ) : null}
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
                    list="ai-pass-commit-options"
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
                    list="ai-pass-commit-options"
                    value={head}
                    onChange={(e) => setHead(e.target.value)}
                    placeholder="e4f5a6b"
                  />
                </label>
              </div>
              {pickers && (pickers.commits ?? []).length > 0 ? (
                <datalist id="ai-pass-commit-options" data-testid="ai-pass-commit-options">
                  {pickers.commits.map((c) => (
                    <option key={c.sha} value={c.sha}>
                      {`${c.sha.slice(0, 7)} ${c.at.slice(0, 10)} ${c.message}`}
                    </option>
                  ))}
                </datalist>
              ) : null}
              <p className="text-xs text-fg-faint">
                Reviews the commits RepoPulse has ingested after the base up to the head, oldest
                first, at most {PASS_CAPS.commits}, merges skipped. RepoPulse keeps no commit graph,
                so this is the time-ordered set, and each commit&rsquo;s diff is reviewed on its
                own: a line number is as of the commit that changed it.
              </p>
            </div>
          )}
          <PassDestinations repoId={repoId} />
          <div>
            <button
              type="submit"
              className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              data-testid="ai-pass-start"
              disabled={body === null || start.isPending || active || off !== null}
              aria-busy={start.isPending || undefined}
              aria-describedby={startBlocker ? 'ai-pass-start-hint' : undefined}
            >
              {start.isPending ? 'Starting…' : active ? 'A pass is running' : 'Start an AI pass'}
            </button>
          </div>
          {startBlocker ? (
            <p
              id="ai-pass-start-hint"
              className="text-xs text-fg-muted"
              data-testid="ai-pass-start-hint"
            >
              To start: {startBlocker}.
            </p>
          ) : null}
          {/* The server's own reason: a daily limit, an unreachable queue, a bad path. */}
          <ErrorNote error={start.error} testId="ai-pass-error" />
        </form>
      ) : (
        <AskAnAdmin repoId={repoId} admins={data?.admins ?? []} />
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
        <>
          {/* W20-11 (UX_TODO AI-34): status changes arrive by polling; a screen
              reader is told when the newest pass moves on. */}
          <p className="sr-only" role="status" data-testid="ai-pass-live">
            {newest ? `Newest AI pass: ${WORD[newest.status]}.` : ''}
          </p>
          <ol className="flex flex-col gap-2" data-testid="ai-pass-runs">
            {runs.map((r) => (
              <RunRow
                key={r.id}
                run={r}
                isAdmin={isAdmin}
                repoId={repoId}
                onRerun={isAdmin && !active && !start.isPending ? () => rerun(r) : undefined}
                invalidate={[queryKeyFor(descriptor)]}
              />
            ))}
          </ol>
          {data?.more && limit < 50 ? (
            <button
              type="button"
              className={`self-start text-xs ${LINK}`}
              data-testid="ai-pass-older"
              onClick={() => setLimit((n) => Math.min(50, n + 20))}
            >
              Show older passes
            </button>
          ) : null}
        </>
      )}

      <ScheduledPasses repoId={repoId} isAdmin={isAdmin} />
    </div>
  );
}
