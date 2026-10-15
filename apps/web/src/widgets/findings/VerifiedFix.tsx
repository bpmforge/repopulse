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
// A rejected attempt shows a developer nothing. The API does not send its diff
// or reason to a non-admin at all; an admin gets the reason, rendered here as
// a muted note so it reads as diagnostics rather than as a result.

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

export interface PatchResponse {
  eligible: boolean;
  reason?: string;
  commit_sha?: string;
  patch: PatchView | null;
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
  const request = useApiMutation<{ tier: 't2' }, { patch: PatchView }>(
    { endpoint: '/findings/{id}/patch', path: { id: findingId }, method: 'POST' },
    { invalidate: [queryKeyFor(descriptor)] },
  );
  const [copied, setCopied] = useState<'idle' | 'copied' | 'failed'>('idle');

  // Not eligible (a model finding, a repo-level finding, nothing scanned): say
  // nothing. The drawer is for the finding; an absent feature is not news.
  if (!data || data.eligible !== true) return null;
  const patch = data.patch;

  if (patch?.status === 'rejected') {
    if (!patch.reason) return null;
    return (
      <p className="text-xs text-fg-faint" data-testid="verified-fix-admin-reason">
        Admin only: a drafted fix was rejected by the re-scan — {patch.reason}
      </p>
    );
  }

  const heading = <h3 className="text-xs tracking-wide text-fg-muted uppercase">Verified fix</h3>;

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
        <pre
          className="mt-1 max-h-80 overflow-auto panel-inset p-2 font-mono text-xs"
          data-testid="verified-fix-diff"
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
    return (
      <div data-testid="verified-fix-pending">
        {heading}
        <p className="mt-1 text-xs text-fg-muted" role="status">
          Drafting a fix and re-scanning the file… This can take a minute.
        </p>
      </div>
    );
  }

  return (
    <div data-testid="verified-fix-request">
      {heading}
      {patch?.status === 'failed' ? (
        <p className="mt-1 text-xs text-fg-muted" data-testid="verified-fix-failed">
          The last attempt could not be made
          {patch.reason ? ` (${patch.reason})` : ''}. You can try again.
        </p>
      ) : (
        <p className="mt-1 text-xs text-fg-muted">
          Your configured model drafts a patch; Repo Pulse applies it to the scanned commit and
          re-runs the rules. You see it only if this finding clears and nothing new appears. Nothing
          is written to your repository.
        </p>
      )}
      <button
        type="button"
        className={`mt-2 ${ACTION_BUTTON}`}
        data-testid="verified-fix-draft"
        onClick={() => request.mutate({ tier: 't2' })}
      >
        {patch?.status === 'failed' ? 'Try again' : 'Draft a verified fix'}
      </button>
      <ErrorNote error={request.error} testId="verified-fix-error" className="mt-1" />
    </div>
  );
}
