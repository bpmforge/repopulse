import { WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';

// Admin → Analysis (W7-08, UX_SPEC §4.i).

const LIST = { endpoint: '/admin/analysis' } as const;

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

  return (
    <tr className="border-t border-border" data-testid={`analysis-repo-${repo.id}`}>
      <th scope="row" className="py-1 text-left font-normal">
        {repo.name}
      </th>
      <td className="py-1">
        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={repo.tier2_auto}
            data-testid={`tier2-${repo.id}`}
            onChange={(e) => patch.mutate({ tier2_auto: e.target.checked })}
          />
          <span className="sr-only">Automatic Tier-2 review for {repo.name}</span>
          auto
        </label>
      </td>
      <td className="py-1">
        <label className="flex items-center gap-1.5 text-xs">
          <input
            type="checkbox"
            checked={repo.tier3_opt_in}
            data-testid={`tier3-${repo.id}`}
            onChange={(e) => patch.mutate({ tier3_opt_in: e.target.checked })}
          />
          <span className="sr-only">Tier-3 opt-in for {repo.name}</span>
          {/* The consequence at the point of decision, the way the artifact
              intent control states its own. Someone ticking this is deciding
              that code may leave their network — that belongs next to the
              checkbox, not in a doc they will not read. */}
          {repo.tier3_opt_in ? 'diffs may be sent to Anthropic' : 'stays on your network'}
        </label>
      </td>
      <td className="py-1 tabular-nums text-xs">
        {repo.egress.calls === 0
          ? // Never "0 bytes": nothing has left, and saying so plainly is the
            // reassurance an admin is actually looking for on this screen.
            'nothing sent'
          : `${repo.egress.calls} calls · ${Math.round(repo.egress.bytes / 1024)} KB`}
      </td>
    </tr>
  );
}

export function AnalysisPolicy() {
  const { data, isLoading, isError, error, refetch } = useApiQuery<{
    repos: RepoPolicy[];
    egress_log: EgressRow[];
  }>(LIST);

  const repos = data?.repos ?? [];
  const log = data?.egress_log ?? [];

  return (
    <div className="flex flex-col gap-4" data-testid="analysis-policy">
      <WidgetFrame
        title="Per-repository analysis policy"
        state={frameState({ isLoading, isError, isEmpty: data !== undefined && repos.length === 0 })}
        {...(error ? { errorMessage: error.message } : {})}
        onRetry={() => void refetch()}
        emptyMessage="No repositories connected yet."
      >
        <table className="w-full text-sm">
          <caption className="sr-only">Tier-2 and Tier-3 analysis policy per repository</caption>
          <thead>
            <tr className="text-left text-xs text-fg-muted">
              <th scope="col">Repository</th>
              <th scope="col">Tier 2 (local)</th>
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
        <p className="mt-2 text-xs text-fg-muted">
          Tier 2 runs on your own LAN and nothing leaves your network. Tier 3 sends the diff, the
          pull-request description and the checklist to Anthropic — only for repositories opted in
          above, and every call is recorded below before it is made.
        </p>
      </WidgetFrame>

      <WidgetFrame
        title="Egress audit"
        state={frameState({ isLoading, isError, isEmpty: data !== undefined && log.length === 0 })}
        emptyMessage="No code has left this network. The log is written before each call, so an empty log means no call was made — not that one went unrecorded."
      >
        <table className="w-full text-sm">
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
      </WidgetFrame>
    </div>
  );
}
