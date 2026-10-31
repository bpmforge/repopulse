import { WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';

// Settings -> Models -> prompt-cache hit rate per model (W23-06).
//
// Each review request is a fixed prefix (checklist, output schema, rules) plus
// a per-chunk tail, so a provider's prompt cache can reuse the prefix. This
// shows whether it did: cache-read tokens over input tokens across the model's
// most recent runs. A provider that reports no cache figure is shown as "not
// reported" rather than 0%, which would read as "measured and not caching".

const CACHE = { endpoint: '/admin/models/cache' } as const;

interface CacheModel {
  model: string;
  runs: number;
  tokens_in: number;
  cache_read_tokens: number;
  hit_pct: number | null;
  reports_cache: boolean;
}
interface CacheResponse {
  window_runs: number;
  models: CacheModel[];
}

const tokens = (n: number): string =>
  n >= 1_000_000
    ? `${(n / 1_000_000).toFixed(1)}M`
    : n >= 1000
      ? `${Math.round(n / 1000)}k`
      : String(n);

/** "62.5%", or "not reported" when no run in the window carried a cache figure. */
export function hitLabel(m: Pick<CacheModel, 'hit_pct' | 'reports_cache'>): string {
  if (!m.reports_cache || m.hit_pct === null) return 'not reported';
  return `${m.hit_pct}%`;
}

export function ModelCache() {
  const query = useApiQuery<CacheResponse>(CACHE);
  const models = query.data?.models ?? [];
  return (
    <WidgetFrame
      title="Prompt cache per model"
      state={frameState({
        isLoading: query.isLoading,
        isError: query.isError,
        isEmpty: query.data !== undefined && models.length === 0,
      })}
      {...(query.error ? { errorMessage: query.error.message } : {})}
      onRetry={() => void query.refetch()}
      emptyMessage="No analysis has run yet, so there is no cache figure to show."
    >
      <div className="flex flex-col gap-2" data-testid="model-cache">
        <p className="text-xs text-fg-muted">
          Share of input tokens the model&rsquo;s server answered from its prompt cache, over the
          last {query.data?.window_runs ?? 50} runs of each model. A higher figure means the
          checklist was reused instead of re-read, so reviews start faster and cost less.
        </p>
        <div className="overflow-x-auto">
          <table
            className="table-plain w-full min-w-[28rem] text-sm"
            data-testid="model-cache-table"
          >
            <caption className="sr-only">Prompt cache hit rate per model</caption>
            <thead>
              <tr className="text-left text-xs text-fg-muted">
                <th scope="col">Model</th>
                <th scope="col" className="text-right">
                  Runs
                </th>
                <th scope="col" className="text-right">
                  Tokens in
                </th>
                <th scope="col" className="text-right">
                  From cache
                </th>
                <th scope="col" className="text-right">
                  Hit rate
                </th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr key={m.model} className="border-t border-border">
                  <td className="py-1 font-mono text-xs">{m.model}</td>
                  <td className="py-1 text-right tabular-nums text-xs">{m.runs}</td>
                  <td className="py-1 text-right tabular-nums text-xs">{tokens(m.tokens_in)}</td>
                  <td className="py-1 text-right tabular-nums text-xs">
                    {tokens(m.cache_read_tokens)}
                  </td>
                  <td
                    className="py-1 text-right tabular-nums text-xs"
                    data-testid={`model-cache-hit-${m.model}`}
                  >
                    {m.reports_cache ? (
                      hitLabel(m)
                    ) : (
                      <span className="text-fg-muted">{hitLabel(m)}</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </WidgetFrame>
  );
}
