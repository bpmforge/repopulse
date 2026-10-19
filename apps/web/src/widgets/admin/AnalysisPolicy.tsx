import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ErrorNote, WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';

// Admin → Analysis (W7-08, UX_SPEC §4.i).
//
// W20-06 (UX_TODO AI-09, AI-10, AI-71, AI-72, AI-86): this page used to promise
// things the product does not do. "Tier 2 runs on your own LAN" stopped being
// true when hosted vendors arrived (W19-01); the Tier-2 "auto" box was saved but
// nothing ever read it; and the Tier-3 opt-in flipped its label to "diffs may be
// sent to Anthropic" although no Tier-3 transport exists. Each now says what is
// true, and the one switch that remains asks before it records a decision about
// where code may go.

const LIST = { endpoint: '/admin/analysis' } as const;

interface GatewayState {
  configured: boolean;
  provider_count: number;
  off_network: boolean;
  /** W20-06 (UX_TODO AI-86): the off-network connections, by the server's host rule. */
  off_network_names?: string[];
  reason: string | null;
}

/** "A", "A and B", "A, B and C". */
function andList(names: readonly string[]): string {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
}

interface RepoPolicy {
  id: number;
  name: string;
  tier2_auto: boolean;
  tier3_opt_in: boolean;
  egress: { calls: number; bytes: number; tokens_sent: number };
}

interface EgressRow {
  id: number;
  repo_id: number;
  model: string;
  bytes_sent: number;
  tokens_sent: number;
  tokens_received: number;
  content_sha256: string;
  sent_at: string;
}

function RepoRow({ repo }: { repo: RepoPolicy }) {
  const patch = useApiMutation<{ tier3_opt_in?: boolean; tier2_auto?: boolean }, unknown>(
    { endpoint: '/admin/analysis/repos/{id}', path: { id: repo.id }, method: 'PATCH' },
    { invalidate: [queryKeyFor(LIST)] },
  );
  const [confirming, setConfirming] = useState(false);

  return (
    <>
      <tr className="border-t border-border" data-testid={`analysis-repo-${repo.id}`}>
        <th scope="row" className="py-1 text-left font-normal">
          {repo.name}
        </th>
        {/* W20-06 (UX_TODO AI-71): the "auto" box saved tier2_auto, which no
            worker, scheduler or route reads. Ticking it turned nothing on. It is
            replaced by what actually starts a Tier-2 review. */}
        <td className="py-1 text-xs" data-testid={`tier2-${repo.id}`}>
          On request: start an AI pass or a schedule on the repository&apos;s Security tab.
          {repo.tier2_auto ? (
            <span className="block text-fg-muted">
              An earlier &quot;auto&quot; setting is saved but has no effect: automatic review of
              each pull request is not built yet.
            </span>
          ) : null}
        </td>
        <td className="py-1">
          <label className="flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={repo.tier3_opt_in}
              data-testid={`tier3-${repo.id}`}
              disabled={patch.isPending}
              onChange={(e) => {
                // W20-06 (UX_TODO AI-10): opting in is a decision about where
                // code may go, so it asks first; opting out never needs to.
                if (e.target.checked) setConfirming(true);
                else patch.mutate({ tier3_opt_in: false });
              }}
            />
            <span className="sr-only">Tier-3 opt-in for {repo.name}</span>
            {/* W20-06 (UX_TODO AI-72): no Tier-3 transport exists, so the label
                says what opting in does today: records a choice, sends nothing. */}
            {repo.tier3_opt_in ? 'opted in (nothing is sent yet)' : 'off'}
          </label>
          <ErrorNote error={patch.error} testId={`tier3-error-${repo.id}`} />
        </td>
        <td className="py-1 tabular-nums text-xs">
          {repo.egress.calls === 0
            ? // Never "0 bytes": nothing has left, and saying so plainly is the
              // reassurance an admin is actually looking for on this screen.
              'nothing sent'
            : `${repo.egress.calls} calls · ${Math.round(repo.egress.bytes / 1024)} KB`}
        </td>
      </tr>
      {confirming ? (
        <tr data-testid={`tier3-confirm-${repo.id}`}>
          <td colSpan={4} className="pb-2">
            <div className="flex flex-col gap-1 rounded-sm border border-warn/40 bg-warn/10 px-2 py-1.5 text-xs">
              <p>
                <strong>Opt {repo.name} in to Tier 3?</strong> Tier 3 would send this
                repository&apos;s diff, the pull-request description and the review checklist to
                Anthropic (the Claude API), outside your network. Each call would be recorded in the
                egress audit below before it is made. There is no spending cap for it yet.
              </p>
              <p>
                <strong>Tier 3 is not available yet.</strong> No Tier-3 connection exists, so opting
                in sends nothing today; it only records that this repository may use Tier 3 once it
                does. Hosted models added in Admin → Models are separate, and are used for every
                repository.
              </p>
              <div className="flex gap-1.5">
                <button
                  type="button"
                  data-testid={`tier3-confirm-do-${repo.id}`}
                  disabled={patch.isPending}
                  onClick={() =>
                    patch.mutate({ tier3_opt_in: true }, { onSuccess: () => setConfirming(false) })
                  }
                  className="rounded-md border border-warn px-2 py-1 text-xs hover:bg-warn/10 disabled:opacity-50"
                >
                  Opt in
                </button>
                <button
                  type="button"
                  data-testid={`tier3-confirm-cancel-${repo.id}`}
                  onClick={() => setConfirming(false)}
                  className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent"
                >
                  Cancel
                </button>
              </div>
            </div>
          </td>
        </tr>
      ) : null}
    </>
  );
}

export function AnalysisPolicy() {
  const { data, isLoading, isError, error, refetch } = useApiQuery<{
    gateway?: GatewayState;
    repos: RepoPolicy[];
    egress_log: EgressRow[];
  }>(LIST);

  const repos = data?.repos ?? [];
  const log = data?.egress_log ?? [];
  const gateway = data?.gateway;

  return (
    <div className="flex flex-col gap-4" data-testid="analysis-policy">
      {/* W16-08 (F8). The toggles below arm analysis; this says whether there is
          anything to arm. The worker has always logged it — to a terminal —
          while this screen showed checkboxes that looked ready. */}
      {gateway && !gateway.configured ? (
        <p
          className="rounded-sm border border-warn/40 bg-warn/10 px-3 py-2 text-xs text-fg"
          data-testid="gateway-unconfigured"
          role="status"
        >
          <strong>Tier 2 cannot run.</strong> {gateway.reason}{' '}
          {/* The fix is one tab over; link it rather than describe the path.
              Body colour, not the accent: teal on the amber tint is 4.4:1 in
              the light theme, under AA. The underline carries the affordance. */}
          <Link to="/admin/models" className="font-medium text-fg underline underline-offset-2">
            Configure a model →
          </Link>
        </p>
      ) : null}
      {gateway?.configured ? (
        <p className="text-xs text-fg-muted" data-testid="gateway-configured">
          Tier 2 runs on {gateway.provider_count} configured model
          {gateway.provider_count === 1 ? '' : 's'}
          {gateway.off_network ? (
            (gateway.off_network_names ?? []).length > 0 ? (
              <>
                . <strong>{andList(gateway.off_network_names ?? [])}</strong>{' '}
                {(gateway.off_network_names ?? []).length === 1 ? 'is' : 'are'} outside your
                network, so code sent to{' '}
                {(gateway.off_network_names ?? []).length === 1 ? 'it' : 'them'} leaves this
                machine.
              </>
            ) : (
              <>
                {' '}
                — <strong>at least one is outside your network</strong>, so code sent to it leaves
                this machine.
              </>
            )
          ) : (
            <>, all on your own network.</>
          )}
        </p>
      ) : null}
      <WidgetFrame
        title="Per-repository analysis policy"
        state={frameState({
          isLoading,
          isError,
          isEmpty: data !== undefined && repos.length === 0,
        })}
        {...(error ? { errorMessage: error.message, error } : {})}
        onRetry={() => void refetch()}
        emptyMessage="No repositories connected yet."
      >
        {/* W18-28: scrolls in its own region at phone width; padded cells
            no longer fit 390px, and the page must not scroll sideways. */}
        <div
          className="overflow-x-auto"
          tabIndex={0}
          role="region"
          aria-label="Per-repository analysis policy"
        >
          <table className="table-plain w-full text-sm">
            <caption className="sr-only">Tier-2 and Tier-3 analysis policy per repository</caption>
            <thead>
              <tr className="text-left text-xs text-fg-muted">
                <th scope="col">Repository</th>
                <th scope="col">Tier 2</th>
                <th scope="col">Tier 3 (Claude API)</th>
                <th scope="col">Sent off-network</th>
              </tr>
            </thead>
            <tbody data-testid="analysis-repo-rows">
              {repos.map((repo) => (
                <RepoRow key={repo.id} repo={repo} />
              ))}
            </tbody>
          </table>
        </div>
        {/* W20-06 (UX_TODO AI-09): Tier 2 can be a hosted vendor since W19-01,
            so "nothing leaves your network" is not ours to promise here. */}
        <p className="mt-2 text-xs text-fg-muted" data-testid="analysis-tiers-note">
          Tier 2 uses the models in Admin → Models, for every repository; see{' '}
          <Link to="/admin/models" className="text-fg underline underline-offset-2">
            Routing
          </Link>{' '}
          for which of them leave your network. Tier 3 (the Claude API) is not available yet: an
          opt-in above records the choice and sends nothing.
        </p>
      </WidgetFrame>

      <WidgetFrame
        title="Egress audit"
        state={frameState({ isLoading, isError, isEmpty: data !== undefined && log.length === 0 })}
        emptyMessage="No code has left this network. The log is written before each call, so an empty log means no call was made — not that one went unrecorded."
      >
        {/* W18-28: scrolls in its own region at phone width; padded cells
            no longer fit 390px, and the page must not scroll sideways. */}
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Egress audit log">
          <table className="table-plain w-full text-sm">
            <caption className="sr-only">Every Tier-3 call, newest first</caption>
            <thead>
              <tr className="text-left text-xs text-fg-muted">
                <th scope="col">When</th>
                <th scope="col">Model</th>
                <th scope="col">Bytes</th>
                <th scope="col">Tokens in/out</th>
                <th scope="col">Content digest</th>
              </tr>
            </thead>
            <tbody data-testid="egress-rows">
              {log.map((row) => (
                <tr key={row.id} className="border-t border-border">
                  <td className="py-1 text-xs">{row.sent_at.slice(0, 16).replace('T', ' ')}</td>
                  <td className="py-1 text-xs">{row.model}</td>
                  <td className="py-1 tabular-nums text-xs">{row.bytes_sent}</td>
                  <td className="py-1 tabular-nums text-xs">
                    {row.tokens_sent}/{row.tokens_received}
                  </td>
                  <td className="py-1 font-mono text-xs">{row.content_sha256.slice(0, 12)}…</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </WidgetFrame>
    </div>
  );
}
