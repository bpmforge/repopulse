import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { ErrorNote, WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';
import { buildUrl } from '../../api/client.js';
import { localDateTime } from '../findings/aiContracts.js';
import { AiSpend, type Spend } from './AiSpend.js';
import { AiControls } from './AiControls.js';

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
  egress: { calls: number; bytes: number; tokens_sent: number; refused?: number };
}

interface EgressRow {
  id: number;
  repo_id: number;
  /** W20-11 (UX_TODO AI-29): which repository, where to, how it ended, and who. */
  repo?: string | null;
  model: string;
  bytes_sent: number;
  tokens_sent: number | null;
  tokens_received: number | null;
  outcome?: 'succeeded' | 'failed' | 'denied' | 'pending';
  host?: string | null;
  tier?: number | null;
  initiator?: string | null;
  /** W20-21 (UX_TODO AI-29): the analysis role, and the AI pass it belonged to. */
  role?: string | null;
  ai_pass_run_id?: number | null;
  content_sha256: string;
  sent_at: string;
}

const OUTCOME_WORD: Record<NonNullable<EgressRow['outcome']>, string> = {
  succeeded: 'sent, answered',
  failed: 'sent, failed',
  pending: 'sent, no outcome yet',
  denied: 'refused by policy, nothing sent',
};

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
            {/* W20-18 (UX_TODO AI-14): the opt-in now does one real thing:
                it lets an admin ask a hosted model for a second opinion. */}
            {repo.tier3_opt_in ? 'opted in (hosted second opinions allowed)' : 'off'}
          </label>
          <ErrorNote error={patch.error} testId={`tier3-error-${repo.id}`} />
        </td>
        <td className="py-1 tabular-nums text-xs" data-testid={`egress-sum-${repo.id}`}>
          {repo.egress.calls === 0
            ? // Never "0 bytes": nothing has left, and saying so plainly is the
              // reassurance an admin is actually looking for on this screen.
              'nothing sent'
            : `${repo.egress.calls} call${repo.egress.calls === 1 ? '' : 's'} · ${Math.round(repo.egress.bytes / 1024)} KB`}
          {(repo.egress.refused ?? 0) > 0 ? (
            <span className="block text-fg-muted">
              {repo.egress.refused} refused by policy (nothing sent)
            </span>
          ) : null}
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
              <p data-testid={`tier3-confirm-second-opinion-${repo.id}`}>
                <strong>What it allows today:</strong> an admin may ask a hosted model in Admin →
                Models, off your network, for a second opinion on an AI suggestion in this
                repository. That sends the finding, its rule and the stored lines of code around it
                (not the whole file), is recorded in the egress audit, and counts toward the daily
                AI-pass limit. The Tier-3 deep review itself is not available yet and sends nothing.
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
  // W20-11 (UX_TODO AI-80, partial): the log stopped at the 50 newest rows with
  // no filter; it now narrows by repository and pages back. The policy table
  // always reads the unfiltered first page (LIST), so it never changes under it.
  const [logRepo, setLogRepo] = useState('');
  const [cursors, setCursors] = useState<string[]>([]);
  // W20-21 (UX_TODO AI-80): "what left last month" needs a date range.
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const before = cursors[cursors.length - 1];
  const filtered = logRepo !== '' || before !== undefined || from !== '' || to !== '';
  const rangeQuery = {
    ...(logRepo ? { repo_id: logRepo } : {}),
    ...(from ? { from } : {}),
    ...(to ? { to } : {}),
  };
  const { data, isLoading, isError, error, refetch } = useApiQuery<{
    gateway?: GatewayState;
    /** W20-16 (UX_TODO AI-08): spend per month and model. */
    spend?: Spend;
    repos: RepoPolicy[];
    egress_log: EgressRow[];
    egress_total?: number;
    egress_next_cursor?: string | null;
  }>(LIST);
  const page = useApiQuery<{
    egress_log: EgressRow[];
    egress_total?: number;
    egress_next_cursor?: string | null;
  }>(
    {
      ...LIST,
      query: { ...rangeQuery, ...(before ? { before } : {}) },
    },
    { enabled: filtered },
  );
  const logSource = filtered ? page.data : data;

  const repos = data?.repos ?? [];
  const log = logSource?.egress_log ?? [];
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
          for which of them leave your network. Tier 3 (the Claude API deep review) is not available
          yet. A Tier-3 opt-in above does one thing today: it lets an admin ask a hosted model, off
          your network, for a second opinion on an AI suggestion in that repository.
        </p>
      </WidgetFrame>

      <AiControls />

      <AiSpend spend={data?.spend} />

      <WidgetFrame
        title="Egress audit"
        state={frameState({
          isLoading,
          isError,
          isEmpty: data !== undefined && !filtered && log.length === 0,
        })}
        emptyMessage="No code has left this network. The log is written before each call, so an empty log means no call was made — not that one went unrecorded."
      >
        <div className="mb-2 flex flex-wrap items-end gap-3 text-xs">
          <label className="flex flex-col gap-1 text-fg-muted">
            Repository
            <select
              className="panel px-2 py-1 text-sm"
              data-testid="egress-filter-repo"
              value={logRepo}
              onChange={(e) => {
                setLogRepo(e.target.value);
                setCursors([]);
              }}
            >
              <option value="">Every repository</option>
              {repos.map((r) => (
                <option key={r.id} value={String(r.id)}>
                  {r.name}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-fg-muted">
            From
            <input
              type="date"
              className="panel px-2 py-1 text-sm"
              data-testid="egress-filter-from"
              value={from}
              onChange={(e) => {
                setFrom(e.target.value);
                setCursors([]);
              }}
            />
          </label>
          <label className="flex flex-col gap-1 text-fg-muted">
            To (inclusive)
            <input
              type="date"
              className="panel px-2 py-1 text-sm"
              data-testid="egress-filter-to"
              value={to}
              onChange={(e) => {
                setTo(e.target.value);
                setCursors([]);
              }}
            />
          </label>
          <a
            href={buildUrl('/admin/analysis/egress.csv', { query: rangeQuery })}
            className="self-end underline underline-offset-2"
            data-testid="egress-export"
            download
          >
            Download CSV (these filters, up to 10,000 rows)
          </a>
          {logSource?.egress_total !== undefined ? (
            <span className="text-fg-muted" data-testid="egress-count">
              Showing {log.length} of {logSource.egress_total} request
              {logSource.egress_total === 1 ? '' : 's'}, newest first.
            </span>
          ) : null}
        </div>
        {filtered && log.length === 0 && !page.isLoading ? (
          <p className="text-xs text-fg-muted" data-testid="egress-filter-empty">
            Nothing matching these filters has been sent off your network.
          </p>
        ) : null}
        {/* W18-28: scrolls in its own region at phone width; padded cells
            no longer fit 390px, and the page must not scroll sideways. */}
        <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Egress audit log">
          <table className="table-plain w-full text-sm">
            {/* W20-11 (UX_TODO AI-29): hosted Tier-2 and scheduled-pass calls
                are audited too, so "Every Tier-3 call" was wrong. */}
            <caption className="sr-only">
              Every request that would leave your network, one row per request, newest first
            </caption>
            <thead>
              <tr className="text-left text-xs text-fg-muted">
                <th scope="col">When</th>
                <th scope="col">Repository</th>
                <th scope="col">Sent to</th>
                <th scope="col">For</th>
                <th scope="col">Outcome</th>
                <th scope="col">Bytes</th>
                <th scope="col">Tokens in/out</th>
                <th scope="col">Content digest</th>
              </tr>
            </thead>
            <tbody data-testid="egress-rows">
              {log.map((row) => (
                <tr
                  key={row.id}
                  className="border-t border-border"
                  data-testid={`egress-row-${row.id}`}
                >
                  <td className="py-1 text-xs">{localDateTime(row.sent_at)}</td>
                  <td className="py-1 text-xs">
                    {row.repo ?? `repository ${row.repo_id}`}
                    {row.initiator ? (
                      <span className="block text-fg-muted">by {row.initiator}</span>
                    ) : null}
                  </td>
                  <td className="py-1 text-xs">
                    <span className="font-mono">{row.host ?? 'unrecorded host'}</span>
                    <span className="block text-fg-muted">
                      {row.model}
                      {row.tier ? ` · Tier ${row.tier}` : ''}
                    </span>
                  </td>
                  <td className="py-1 text-xs" data-testid={`egress-for-${row.id}`}>
                    {row.role ? row.role.replace(/_/g, ' ') : '—'}
                    {row.ai_pass_run_id ? (
                      <span className="block text-fg-muted">AI pass {row.ai_pass_run_id}</span>
                    ) : null}
                  </td>
                  <td className="py-1 text-xs" data-testid={`egress-outcome-${row.id}`}>
                    {row.outcome ? OUTCOME_WORD[row.outcome] : '—'}
                  </td>
                  <td className="py-1 tabular-nums text-xs">{row.bytes_sent}</td>
                  <td className="py-1 tabular-nums text-xs">
                    {row.tokens_sent ?? '?'}/{row.tokens_received ?? '?'}
                  </td>
                  <td className="py-1 font-mono text-xs">{row.content_sha256.slice(0, 12)}…</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {logSource?.egress_next_cursor || cursors.length > 0 ? (
          <div className="mt-2 flex gap-3 text-xs" data-testid="egress-paging">
            {cursors.length > 0 ? (
              <button
                type="button"
                className="underline underline-offset-2"
                onClick={() => setCursors((c) => c.slice(0, -1))}
              >
                ← Newer
              </button>
            ) : null}
            {logSource?.egress_next_cursor ? (
              <button
                type="button"
                className="underline underline-offset-2"
                data-testid="egress-older"
                onClick={() => {
                  const next = logSource.egress_next_cursor;
                  if (next) setCursors((c) => [...c, next]);
                }}
              >
                Older →
              </button>
            ) : null}
          </div>
        ) : null}
        <p className="mt-2 text-xs text-fg-faint">
          &ldquo;?&rdquo; means the provider did not report token counts. &ldquo;For&rdquo; is the
          analysis role and, when the request was part of one, the AI pass; rows written before this
          was recorded show a dash.
        </p>
      </WidgetFrame>
    </div>
  );
}
