import { useState } from 'react';
import { ErrorNote } from '../../components/index.js';
import { DiffView } from '../../components/code/index.js';
import { useApiMutation, useApiQuery, queryKeyFor } from '../../api/useApiQuery.js';
import { pausedLine, type AiPause } from './aiContracts.js';

// "Verified fix" in the finding drawer (W18-19, D16 "Verified + CI pull").
//
// A model drafts a patch; Repo Pulse applies it to the scanned commit and
// re-runs the file's rules; the patch appears here ONLY if the finding cleared
// and nothing new fired. The developer copies or downloads it and applies it
// themselves — nothing is written to the repository (D9a), which is why the
// actions are Copy and Download and there is no "open a PR".
//
// A rejected attempt shows nobody its diff. The API does not send the diff or
// the reason to a non-admin at all; an admin gets the reason, rendered here as
// a muted note so it reads as diagnostics rather than as a result. W20-06 (UX_TODO
// AI-13): the section used to vanish on a rejection, so a member who asked got
// no "it did not pass" and no way to ask again. It now says so, with Try again.
//
// W20-06 (UX_TODO AI-12): before the button, which connection drafts the fix and
// whether the file leaves the network. The `patch` role can be routed to a
// hosted vendor; "your configured model" did not say so.

export interface PatchView {
  id: number;
  status: 'pending' | 'verified' | 'rejected' | 'failed';
  commit_sha: string;
  tier: number;
  created_at: string;
  finished_at: string | null;
  diff?: string | null;
  filename?: string;
  model_id?: string | null;
  verification?: { rule_sets: string[]; runs: number };
  /** Present only for an admin. */
  reason?: string | null;
  reason_code?: string | null;
}

/** Where a draft would be sent: the server's routing for the `patch` role. */
export interface Drafter {
  local_only: boolean;
  leaves_network: boolean;
  destinations: {
    provider_name: string;
    host: string | null;
    leaves_network: boolean;
    models: string[];
  }[];
}

export interface PatchResponse {
  eligible: boolean;
  reason?: string;
  commit_sha?: string;
  patch: PatchView | null;
  drafter?: Drafter;
  /** W20-18 (UX_TODO AI-77): the workspace's "AI off" switch. */
  ai_paused?: AiPause;
}

/** "Drafted by X (model) · stays on your network", said before anyone asks. */
function DrafterNote({ drafter }: { drafter: Drafter | undefined }) {
  if (!drafter) return null;
  if (drafter.destinations.length === 0) {
    return (
      <p className="text-xs text-fg-muted" data-testid="verified-fix-drafter">
        No model is set up to draft fixes, so a request will fail and say so. An admin adds one in
        Settings → Models.
      </p>
    );
  }
  return (
    <p className="text-xs text-fg" data-testid="verified-fix-drafter">
      Drafted by{' '}
      {drafter.destinations.map((d, i) => (
        <span key={`${d.provider_name}-${i}`}>
          {i > 0 ? ', or if it is down, ' : ''}
          <span className="font-medium">{d.provider_name}</span>
          {d.models.length > 0 ? (
            <>
              {' '}
              (<span className="font-mono">{d.models.join(', ')}</span>)
            </>
          ) : null}
          {' · '}
          {d.leaves_network
            ? `leaves your network: the file is sent to ${d.host ?? 'an endpoint we could not read'}`
            : 'stays on your network'}
        </span>
      ))}
      .
    </p>
  );
}

/** The card every state of this section sits in (W26-02). */
const CARD = 'panel flex scroll-mt-4 flex-col gap-2 px-4 pt-3.5 pb-4';

/** Where a reader's diff view choice is kept (W26-02). */
export const DIFF_VIEW_KEY = 'repopulse.diffView';

const ACTION_BUTTON =
  'rounded-md border border-border px-2 py-1 text-xs hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';

/** Rule-set keys as a person would name them. */
const RULE_SET_LABEL: Record<string, string> = {
  semgrep_pack: 'security rules',
  logging_pack: 'logging rules',
  perf_pack: 'performance rules',
  anti_slop_fast_lane: 'code-health checks',
  anti_slop_pack: 'AI-slop rules',
};

/**
 * A failed attempt's reason code, in words a member can act on (W20-11, UX_TODO
 * AI-65). Members get the code, never the text: the text can quote a host or a
 * path, the code cannot. "You can try again" was the whole message, even when no
 * try could ever work.
 */
export const FAILED_PATCH_WORDS: Record<string, string> = {
  no_gateway: 'no model is set up to draft fixes. Ask an admin to add one in Settings → Models.',
  model_busy: 'the model was busy or down. Try again in a few minutes.',
  no_connection:
    'this repository has no working forge connection, so its file could not be read. Ask an admin to check it.',
  source_unavailable:
    'the file could not be read at the scanned commit (missing, binary or too large).',
  tier3_not_opted_in: 'this repository is not opted in to Tier 3. Ask an admin.',
  ai_paused: 'AI analysis was switched off for this workspace before it ran.',
};

/** Minutes after which a draft no worker took is called stalled. */
const STALLED_AFTER_MIN = 5;

/** Hands the browser a file to save. Nothing leaves the browser for this. */
function downloadPatch(diff: string, filename: string): void {
  const url = URL.createObjectURL(new Blob([diff], { type: 'text/x-diff' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

export function VerifiedFix({ findingId }: { findingId: number }) {
  const descriptor = { endpoint: '/findings/{id}/patch', path: { id: findingId } } as const;
  const { data } = useApiQuery<PatchResponse>(descriptor, {
    // Poll only while a draft is in flight; a decided answer does not change.
    refetchInterval: (d) => (d?.patch?.status === 'pending' ? 3000 : false),
  });
  const request = useApiMutation<{ tier: 't2'; retry?: boolean }, { patch: PatchView }>(
    { endpoint: '/findings/{id}/patch', path: { id: findingId }, method: 'POST' },
    { invalidate: [queryKeyFor(descriptor)] },
  );
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');

  // W26-02: its own card in the finding's card list, titled for what a reader
  // wants from it (the change to make), whatever state the draft is in.
  const heading = <h3 className="text-[15px] font-semibold text-fg">Suggested change</h3>;
  // W20-18 (UX_TODO AI-77; decision 2026-10-20: off means off). With AI off a
  // person cannot ask for a draft either; said here, and no button is offered.
  const off = pausedLine(data?.ai_paused, 'no fix can be drafted');
  const pausedNote = off ? (
    <p className="text-xs text-fg-muted" data-testid="verified-fix-paused">
      {off}
    </p>
  ) : null;

  if (!data) return null;
  // Not eligible (a secret, a dependency CVE, a model finding, nothing scanned).
  // W20-16 (UX_TODO AI-69): say why in one muted line, so a developer can tell
  // why one finding offers a fix and another does not.
  if (data.eligible !== true) {
    return data.reason ? (
      <section id="finding-verified-fix" className={CARD} data-testid="verified-fix-ineligible">
        {heading}
        <p className="text-xs text-fg-faint">No verified fix for this finding: {data.reason}</p>
      </section>
    ) : null;
  }
  const patch = data.patch;

  if (patch?.status === 'rejected' && !request.isPending) {
    return (
      <section id="finding-verified-fix" className={CARD} data-testid="verified-fix-rejected">
        {heading}
        <p className="text-xs text-fg-muted">
          A drafted fix did not pass the re-scan: applied to commit{' '}
          <span className="font-mono">{patch.commit_sha.slice(0, 7)}</span>, it did not clear this
          finding or it raised a new one. It is not shown, because Repo Pulse does not stand behind
          it. You can ask the model again.
        </p>
        {patch.reason ? (
          <p className="text-xs text-fg-faint" data-testid="verified-fix-admin-reason">
            Admin only: {patch.reason}
          </p>
        ) : null}
        {/* W20-11 (UX_TODO AI-66): the API sends an admin the rejected diff, so
            whoever decides whether the model or the rule needs attention can
            see what failed. Collapsed, and labelled as not to be applied. */}
        {patch.diff ? (
          <details className="text-xs" data-testid="verified-fix-rejected-diff">
            <summary className="cursor-pointer text-fg-muted">
              Admin only: show the rejected diff (do not apply it)
            </summary>
            <pre
              className="mt-1 max-h-80 overflow-auto panel-inset p-2 font-mono text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              tabIndex={0}
              role="region"
              aria-label="Rejected diff"
            >
              {patch.diff}
            </pre>
          </details>
        ) : null}
        <DrafterNote drafter={data.drafter} />
        {pausedNote ?? (
          <button
            type="button"
            className={`self-start ${ACTION_BUTTON}`}
            data-testid="verified-fix-retry"
            onClick={() => request.mutate({ tier: 't2', retry: true })}
          >
            Try again
          </button>
        )}
        <ErrorNote error={request.error} testId="verified-fix-error" className="mt-1" />
      </section>
    );
  }

  if (patch?.status === 'verified' && patch.diff) {
    const diff = patch.diff;
    const ruleSets = (patch.verification?.rule_sets ?? []).map((k) => RULE_SET_LABEL[k] ?? k);
    const copy = () => {
      const clipboard = navigator.clipboard;
      if (!clipboard) {
        setCopied('failed');
        return;
      }
      void clipboard
        .writeText(diff)
        .then(() => setCopied('copied'))
        .catch(() => setCopied('failed'));
    };
    return (
      <section id="finding-verified-fix" className={CARD} data-testid="verified-fix">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="flex min-w-0 flex-[1_1_24rem] flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              {heading}
              <span
                className="inline-flex items-center gap-1 rounded-sm bg-ok/15 px-1.5 py-0.5 text-xs font-medium text-ok"
                data-testid="verified-fix-badge"
              >
                <span aria-hidden="true">✓</span>
                <span>Verified fix</span>
              </span>
            </div>
            <p className="text-xs text-fg-muted" data-testid="verified-fix-note">
              Re-scanned: this patch was applied to commit{' '}
              <span className="font-mono">{patch.commit_sha.slice(0, 7)}</span>
              {ruleSets.length > 0 ? ` and the ${ruleSets.join(', ')} were run again` : ''}. The
              finding clears and no new finding appears in the file. Review it like any change —
              nothing has been written to your repository.
            </p>
          </div>
          <div className="flex flex-none flex-wrap items-center gap-2">
            <button
              type="button"
              className={ACTION_BUTTON}
              data-testid="verified-fix-copy"
              onClick={copy}
            >
              {copied === 'copied'
                ? 'Copied'
                : copied === 'failed'
                  ? 'Copy failed — select the text instead'
                  : 'Copy patch'}
            </button>
            <button
              type="button"
              className={ACTION_BUTTON}
              data-testid="verified-fix-download"
              onClick={() => downloadPatch(diff, patch.filename ?? `finding-${findingId}.patch`)}
            >
              Download .patch
            </button>
          </div>
        </div>
        {/* W20-11 (UX_TODO AI-45): "verified" proves the rules stop firing on
            this file, nothing more; said next to the diff, where it is read. */}
        <p className="text-xs text-fg" data-testid="verified-fix-limits">
          <strong>Not tested:</strong> the code was not built and no tests were run, so this change
          may alter behaviour. Run your tests before merging it.
        </p>
        {/* W26-02: the shared diff view, so a reader picks unified, split or
            the raw patch, with changed words marked; the choice is kept per
            browser. Its scrolling body is a focusable region (W20-11, AI-46). */}
        <DiffView
          diff={diff}
          testId="verified-fix-diff"
          storageKey={DIFF_VIEW_KEY}
          copyButton={false}
        />
        <p className="text-xs text-fg-muted" data-testid="verified-fix-apply">
          {patch.model_id ? <>Drafted by {patch.model_id}. </> : null}
          Apply it from the repository root with{' '}
          <code className="font-mono">
            git apply {patch.filename ?? `finding-${findingId}.patch`}
          </code>
          . It was made against commit{' '}
          <span className="font-mono">{patch.commit_sha.slice(0, 7)}</span>; if your branch has
          moved on since, it may need a rebase or a small edit.
        </p>
      </section>
    );
  }

  if (patch?.status === 'pending' || request.isPending) {
    // W20-11 (UX_TODO AI-64): a draft no worker takes used to say "this can take
    // a minute" forever.
    const started = patch ? new Date(patch.created_at).getTime() : Number.NaN;
    const waited = Number.isNaN(started) ? 0 : Math.floor((Date.now() - started) / 60000);
    return (
      <section id="finding-verified-fix" className={CARD} data-testid="verified-fix-pending">
        {heading}
        <p className="text-xs text-fg-muted" role="status">
          Drafting a fix and re-scanning the file… This can take a minute.
        </p>
        {waited >= STALLED_AFTER_MIN ? (
          <p className="text-xs text-fg" role="alert" data-testid="verified-fix-stalled">
            It has waited {waited} minutes and no worker has picked it up. Ask an admin to check
            that the worker is running.
          </p>
        ) : null}
      </section>
    );
  }

  const noModel = data.drafter !== undefined && data.drafter.destinations.length === 0;
  const failedWords = patch?.reason_code ? FAILED_PATCH_WORDS[patch.reason_code] : undefined;

  return (
    <section id="finding-verified-fix" className={CARD} data-testid="verified-fix-request">
      {heading}
      {patch?.status === 'failed' ? (
        <p className="text-xs text-fg-muted" data-testid="verified-fix-failed">
          The last attempt could not be made
          {failedWords ? `: ${failedWords}` : patch.reason ? ` (${patch.reason})` : '.'}
          {patch.reason && failedWords ? (
            <span className="block text-fg-faint">Admin only: {patch.reason}</span>
          ) : null}
          {noModel || off ? '' : ' You can try again.'}
        </p>
      ) : (
        <p className="text-xs text-fg-muted">
          Your configured model drafts a patch; Repo Pulse applies it to the scanned commit and
          re-runs the rules. You see it only if this finding clears and nothing new appears. Nothing
          is written to your repository.
        </p>
      )}
      <DrafterNote drafter={data.drafter} />
      {pausedNote}
      {/* W20-11 (UX_TODO AI-65): with no model at all, a request can only fail,
          so there is no button to press; the note above says who can fix it. */}
      {noModel || off ? null : (
        <button
          type="button"
          className={`self-start ${ACTION_BUTTON}`}
          data-testid="verified-fix-draft"
          onClick={() => request.mutate({ tier: 't2' })}
        >
          {patch?.status === 'failed' ? 'Try again' : 'Draft a verified fix'}
        </button>
      )}
      <ErrorNote error={request.error} testId="verified-fix-error" className="mt-1" />
    </section>
  );
}
