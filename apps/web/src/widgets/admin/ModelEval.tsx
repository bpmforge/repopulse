import { WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';

// Admin → Models → quality per model (W19-05).
//
// What each model measured on the labelled fixtures, per role, with the engine
// and date of the run. Anything unmeasured says "not yet run" — an empty cell
// would read as a score of nothing — and a run that hit provider errors says
// "incomplete" rather than showing a number about the network.

const EVAL = { endpoint: '/admin/model-eval' } as const;

interface RoleScore {
  cases: number;
  errored: number;
  precision: number | null;
  recall: number | null;
  state: 'scored' | 'incomplete';
}
interface EvalResult {
  engine: string;
  ranAt: string;
  complete: boolean;
  roles: Record<string, RoleScore | undefined>;
  triage: { agreement: number | null; total: number; missedReal: number } | null;
  errors: { role: string; caseId: string; error: string }[];
}
interface EvalModel {
  model: string;
  provider_name: string | null;
  configured: boolean;
  result: EvalResult | null;
}
interface EvalResponse {
  roles: { id: string; label: string }[];
  models: EvalModel[];
}

const pct = (n: number | null): string => (n === null ? '—' : `${Math.round(n * 100)}%`);

function Cell({ score }: { score: RoleScore | undefined }) {
  if (!score) return <span className="text-fg-faint">not yet run</span>;
  if (score.state === 'incomplete') {
    return (
      <span
        className="text-warn"
        title={`${score.errored} of ${score.cases} cases hit a provider error and were not scored`}
      >
        incomplete ({score.errored} error{score.errored === 1 ? '' : 's'})
      </span>
    );
  }
  return (
    <span>
      P {pct(score.precision)} · R {pct(score.recall)}
    </span>
  );
}

export function ModelEval() {
  const query = useApiQuery<EvalResponse>(EVAL);
  const models = query.data?.models ?? [];
  const roles = query.data?.roles ?? [];

  return (
    <WidgetFrame
      title="Quality per model"
      state={frameState({
        isLoading: query.isLoading,
        isError: query.isError,
        isEmpty: query.data !== undefined && models.length === 0,
      })}
      {...(query.error ? { errorMessage: query.error.message } : {})}
      onRetry={() => void query.refetch()}
      emptyMessage="No model configured and none measured yet."
    >
      <div className="flex flex-col gap-2" data-testid="model-eval">
        <p className="text-xs text-fg-muted">
          How each model did on labelled test cases, per role: <strong>P</strong>recision (of what
          it reported, how much was real) and <strong>R</strong>ecall (of the planted defects, how
          many it found). The cases are small and their labels have not been reviewed by a person —
          a rough guide, not a guarantee. A cell says <em>not yet run</em> when nothing was
          measured.
        </p>
        <div className="overflow-x-auto">
          <table className="table-plain w-full text-sm" data-testid="model-eval-table">
            <caption className="sr-only">Precision and recall per model and role</caption>
            <thead>
              <tr className="text-left text-xs text-fg-muted">
                <th scope="col">Model</th>
                {roles.map((r) => (
                  <th key={r.id} scope="col">
                    {r.label}
                  </th>
                ))}
                <th scope="col">Triage agreement</th>
                <th scope="col">Measured on</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => (
                <tr
                  key={`${m.model}-${m.provider_name ?? 'x'}`}
                  className="border-t border-border align-top"
                  data-testid={`model-eval-row-${m.model}`}
                >
                  <th scope="row" className="py-2 pr-3 text-left font-normal">
                    <span className="font-mono text-xs">{m.model}</span>
                    {m.configured ? (
                      <span className="block text-xs text-fg-muted">{m.provider_name}</span>
                    ) : (
                      <span className="block text-xs text-fg-faint">not configured here</span>
                    )}
                  </th>
                  {roles.map((r) => (
                    <td
                      key={r.id}
                      className="py-2 pr-3 text-xs"
                      data-testid={`model-eval-${m.model}-${r.id}`}
                    >
                      {m.result ? (
                        <Cell score={m.result.roles[r.id]} />
                      ) : (
                        <span className="text-fg-faint">not yet run</span>
                      )}
                    </td>
                  ))}
                  <td className="py-2 pr-3 text-xs">
                    {m.result?.triage ? (
                      <span>
                        {pct(m.result.triage.agreement)}
                        {m.result.triage.missedReal > 0
                          ? ` · ${m.result.triage.missedReal} real missed`
                          : ''}
                      </span>
                    ) : (
                      <span className="text-fg-faint">not yet run</span>
                    )}
                  </td>
                  <td className="py-2 text-xs text-fg-muted">
                    {m.result ? (
                      <>
                        {m.result.ranAt.slice(0, 10)}
                        <span className="block">{m.result.engine}</span>
                        {!m.result.complete ? (
                          <span
                            className="block text-warn"
                            data-testid={`model-eval-incomplete-${m.model}`}
                          >
                            incomplete — {m.result.errors.length} provider error
                            {m.result.errors.length === 1 ? '' : 's'}
                          </span>
                        ) : null}
                      </>
                    ) : (
                      '—'
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
