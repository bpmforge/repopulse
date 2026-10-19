import { useState } from 'react';
import { ErrorNote } from '../../components/index.js';
import { useApiMutation, useApiQuery, queryKeyFor } from '../../api/useApiQuery.js';

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
}

/** "Drafted by X (model) · stays on your network", said before anyone asks. */
function DrafterNote({ drafter }: { drafter: Drafter | undefined }) {
  if (!drafter) return null;
  if (drafter.destinations.length === 0) {
    return (
      <p className="mt-1 text-xs text-fg-muted" data-testid="verified-fix-drafter">
        No model is set up to draft fixes, so a request will fail and say so. An admin adds one in
        Admin → Models.
      </p>
    );
  }
  return (
    <p className="mt-1 text-xs text-fg" data-testid="verified-fix-drafter">
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

const ACTION_BUTTON =
  'rounded-md border border-border px-2 py-1 text-xs hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';

/** Rule-set keys as a person would name them. */
const RULE_SET_LABEL: Record<string, string> = {
  semgrep_pack: 'security rules',
  logging_pack: 'logging rules',
  perf_pack: 'performance rules',
  anti_slop_fast_lane: 'code-health checks',
};

function lineClass(line: string): string {
  if (line.startsWith('+++') || line.startsWith('---')) return 'text-fg-muted';
  if (line.startsWith('@@')) return 'text-info';
  // Paired with the +/- mark the line already carries — never colour alone (UX_SPEC §7).
  if (line.startsWith('+')) return 'text-ok';
  if (line.startsWith('-')) return 'text-crit';
  return '';
}

/**
 * A failed attempt's reason code, in words a member can act on (W20-11, UX_TODO
 * AI-65). Members get the code, never the text: the text can quote a host or a
 * path, the code cannot. "You can try again" was the whole message, even when no
 * try could ever work.
 */
export const FAILED_PATCH_WORDS: Record<string, string> = {
  no_gateway: 'no model is set up to draft fixes. Ask an admin to add one in Admin → Models.',
  model_busy: 'the model was busy or down. Try again in a few minutes.',
  no_connection:
    'this repository has no working forge connection, so its file could not be read. Ask an admin to check it.',
  source_unavailable:
    'the file could not be read at the scanned commit (missing, binary or too large).',
  tier3_not_opted_in: 'this repository is not opted in to Tier 3. Ask an admin.',
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

  // Not eligible (a model finding, a repo-level finding, nothing scanned): say
  // nothing. The drawer is for the finding; an absent feature is not news.
  if (!data || data.eligible !== true) return null;
  const patch = data.patch;

  const heading = <h3 className="text-xs tracking-wide text-fg-muted uppercase">Verified fix</h3>;

  if (patch?.status === 'rejected' && !request.isPending) {
    return (
      <div data-testid="verified-fix-rejected">
        {heading}
        <p className="mt-1 text-xs text-fg-muted">
          A drafted fix did not pass the re-scan: applied to commit{' '}
          <span className="font-mono">{patch.commit_sha.slice(0, 7)}</span>, it did not clear this
          finding or it raised a new one. It is not shown, because Repo Pulse does not stand behind
          it. You can ask the model again.
        </p>
        {patch.reason ? (
          <p className="mt-1 text-xs text-fg-faint" data-testid="verified-fix-admin-reason">
            Admin only: {patch.reason}
          </p>
        ) : null}
        {/* W20-11 (UX_TODO AI-66): the API sends an admin the rejected diff, so
            whoever decides whether the model or the rule needs attention can
            see what failed. Collapsed, and labelled as not to be applied. */}
        {patch.diff ? (
          <details className="mt-1 text-xs" data-testid="verified-fix-rejected-diff">
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
        <button
          type="button"
          className={`mt-2 ${ACTION_BUTTON}`}
          data-testid="verified-fix-retry"
          onClick={() => request.mutate({ tier: 't2', retry: true })}
        >
          Try again
        </button>
        <ErrorNote error={request.error} testId="verified-fix-error" className="mt-1" />
      </div>
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
      <div data-testid="verified-fix">
        {heading}
        <p className="mt-1 text-xs text-fg-muted" data-testid="verified-fix-note">
          Re-scanned: this patch was applied to commit{' '}
          <span className="font-mono">{patch.commit_sha.slice(0, 7)}</span>
          {ruleSets.length > 0 ? ` and the ${ruleSets.join(', ')} were run again` : ''}. The finding
          clears and no new finding appears in the file. Review it like any change — nothing has
          been written to your repository.
        </p>
        {/* W20-11 (UX_TODO AI-45): "verified" proves the rules stop firing on
            this file, nothing more; said next to the diff, where it is read. */}
        <p className="mt-1 text-xs text-fg" data-testid="verified-fix-limits">
          <strong>Not tested:</strong> the code was not built and no tests were run, so this change
          may alter behaviour. Run your tests before merging it.
        </p>
        {/* W20-11 (UX_TODO AI-46): a scrolling block must be reachable from the
            keyboard (axe scrollable-region-focusable), as W19-12 did for citations. */}
        <pre
          className="mt-1 max-h-80 overflow-auto panel-inset p-2 font-mono text-xs focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          data-testid="verified-fix-diff"
          tabIndex={0}
          role="region"
          aria-label="Verified patch diff"
        >
          {diff.split('\n').map((line, i) => (
            <span key={i} className={`block ${lineClass(line)}`}>
              {line === '' ? ' ' : line}
            </span>
          ))}
        </pre>
        <div className="mt-2 flex flex-wrap items-center gap-2">
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
          {patch.model_id && (
            <span className="text-xs text-fg-faint">drafted by {patch.model_id}</span>
          )}
        </div>
      </div>
    );
  }

  if (patch?.status === 'pending' || request.isPending) {
    // W20-11 (UX_TODO AI-64): a draft no worker takes used to say "this can take
    // a minute" forever.
    const started = patch ? new Date(patch.created_at).getTime() : Number.NaN;
    const waited = Number.isNaN(started) ? 0 : Math.floor((Date.now() - started) / 60000);
    return (
      <div data-testid="verified-fix-pending">
        {heading}
        <p className="mt-1 text-xs text-fg-muted" role="status">
          Drafting a fix and re-scanning the file… This can take a minute.
        </p>
        {waited >= STALLED_AFTER_MIN ? (
          <p className="mt-1 text-xs text-fg" role="alert" data-testid="verified-fix-stalled">
            It has waited {waited} minutes and no worker has picked it up. Ask an admin to check
            that the worker is running.
          </p>
        ) : null}
      </div>
    );
  }

  const noModel = data.drafter !== undefined && data.drafter.destinations.length === 0;
  const failedWords = patch?.reason_code ? FAILED_PATCH_WORDS[patch.reason_code] : undefined;

  return (
    <div data-testid="verified-fix-request">
      {heading}
      {patch?.status === 'failed' ? (
        <p className="mt-1 text-xs text-fg-muted" data-testid="verified-fix-failed">
          The last attempt could not be made
          {failedWords ? `: ${failedWords}` : patch.reason ? ` (${patch.reason})` : '.'}
          {patch.reason && failedWords ? (
            <span className="block text-fg-faint">Admin only: {patch.reason}</span>
          ) : null}
          {noModel ? '' : ' You can try again.'}
        </p>
      ) : (
        <p className="mt-1 text-xs text-fg-muted">
          Your configured model drafts a patch; Repo Pulse applies it to the scanned commit and
          re-runs the rules. You see it only if this finding clears and nothing new appears. Nothing
          is written to your repository.
        </p>
      )}
      <DrafterNote drafter={data.drafter} />
      {/* W20-11 (UX_TODO AI-65): with no model at all, a request can only fail,
          so there is no button to press; the note above says who can fix it. */}
      {noModel ? null : (
        <button
          type="button"
          className={`mt-2 ${ACTION_BUTTON}`}
          data-testid="verified-fix-draft"
          onClick={() => request.mutate({ tier: 't2' })}
        >
          {patch?.status === 'failed' ? 'Try again' : 'Draft a verified fix'}
        </button>
      )}
      <ErrorNote error={request.error} testId="verified-fix-error" className="mt-1" />
    </div>
  );
}
