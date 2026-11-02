import { WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';

// Settings → Models → quality per model (W19-05).
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

/**
 * How a model is measured today (W20-11, UX_TODO AI-16, AI_LAYER.md "W19-05 as
 * built"): a command run from a RepoPulse checkout, not a button. A newly added
 * model showed "not yet run" forever with no way forward; it now shows this.
 */
export const MEASURE_COMMAND =
  'npx tsx packages/security/src/eval/cli.ts --base-url <address> --model <model id>';

/** Precision and recall as TWO cells, so the numbers line up and can be compared down a column. */
function ScoreCells({ score, testId }: { score: RoleScore | undefined; testId: string }) {
  if (!score) {
    return (
      <td
        colSpan={2}
        className="border-l border-border px-3 py-1.5 text-right text-xs text-fg-faint"
        data-testid={testId}
      >
        not yet run
      </td>
    );
  }
  if (score.state === 'incomplete') {
    return (
      // W20-11 (UX_TODO AI-27): the explanation was a title tooltip, which
      // keyboard and touch users never see; it is text, and the errors are
      // listed under the row.
      <td
        colSpan={2}
        className="border-l border-border px-3 py-1.5 text-xs text-warn"
        data-testid={testId}
      >
        incomplete: {score.errored} of {score.cases} case{score.cases === 1 ? '' : 's'} hit a
        provider error (listed below)
      </td>
    );
  }
  return (
    <>
      <td
        className="border-l border-border px-3 py-1.5 text-right text-xs tabular-nums"
        data-testid={`${testId}-p`}
      >
        {pct(score.precision)}
      </td>
      <td className="py-1.5 pr-3 text-right text-xs tabular-nums" data-testid={`${testId}-r`}>
        {pct(score.recall)}
      </td>
    </>
  );
}

export function ModelEval() {
  const query = useApiQuery<EvalResponse>(EVAL);
  const models = query.data?.models ?? [];
  const roles = query.data?.roles ?? [];
  const unmeasured = models.filter((m) => m.configured && m.result === null).map((m) => m.model);

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
      <div className="flex flex-col gap-2" data-testid="model-eval" id="quality-per-model">
        <p className="text-xs text-fg-muted">
          How each model did on labelled test cases, per role. <strong>Precision (P)</strong>: of
          what it reported, how much was real. <strong>Recall (R)</strong>: of the planted defects,
          how many it found.
        </p>
        {/* W20-11 (UX_TODO AI-28): the table showed numbers and helped decide
            nothing. A short reading guide, and the way to act on it. */}
        <p className="text-xs text-fg-muted" data-testid="model-eval-guide">
          <strong>Reading it:</strong> each role has only four cases, so one case moves a number by
          25 points or more; read a gap smaller than that as a tie. For Security and Triage, low
          recall matters most (a missed real issue); for the other roles, low precision means noise
          to wade through. To use a model for a role, put it first in that role&rsquo;s chain in{' '}
          <a
            href="#model-routing"
            className="underline underline-offset-2"
            data-testid="model-eval-routing-link"
          >
            Routing
          </a>
          .
        </p>
        {/* W24-03 (UX review: "the quality table is cramped"). It had a column
            pair per ROLE: fourteen number columns plus the model, triage and
            date, so a model id wrapped over three lines and the numbers ran
            together. Turned on its side: a row per role and a column pair per
            MODEL. There are eight roles and usually one to three models, so it
            fits, and comparing models for one role is reading across a row. */}
        <div
          className="overflow-x-auto focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
          role="region"
          aria-label="Quality per model, scrolls sideways"
          tabIndex={0}
        >
          <table className="table-plain w-auto text-sm" data-testid="model-eval-table">
            <caption className="mb-2 text-left text-xs text-fg-muted">
              The cases are small and their labels have not been reviewed by a person: a rough
              guide, not a guarantee. &ldquo;Not yet run&rdquo; means nothing was measured.
            </caption>
            <thead>
              <tr className="text-left align-bottom text-xs text-fg-muted">
                <th scope="col" rowSpan={2} className="pr-6">
                  Role
                </th>
                {models.map((m) => (
                  <th
                    key={`${m.model}-${m.provider_name ?? 'x'}`}
                    scope="colgroup"
                    colSpan={2}
                    className="border-l border-border px-3 pb-1 font-normal"
                    data-testid={`model-eval-row-${m.model}`}
                  >
                    <span className="block font-mono text-xs font-semibold break-all text-fg">
                      {m.model}
                    </span>
                    {m.configured ? (
                      <span className="block">{m.provider_name}</span>
                    ) : (
                      <span className="block text-fg-faint">not configured here</span>
                    )}
                    {m.result ? (
                      <>
                        <span className="block whitespace-nowrap">
                          measured {m.result.ranAt.slice(0, 10)}
                        </span>
                        <span className="block max-w-xs">{m.result.engine}</span>
                      </>
                    ) : null}
                    {m.result && !m.result.complete ? (
                      <span
                        className="block text-warn"
                        data-testid={`model-eval-incomplete-${m.model}`}
                      >
                        incomplete — {m.result.errors.length} provider error
                        {m.result.errors.length === 1 ? '' : 's'}
                      </span>
                    ) : null}
                  </th>
                ))}
              </tr>
              <tr className="text-xs text-fg-muted">
                {models.flatMap((m) => [
                  <th
                    key={`${m.model}-${m.provider_name ?? 'x'}-p`}
                    scope="col"
                    className="border-l border-border px-3 text-right font-normal"
                  >
                    <abbr title="Precision: of what it reported, how much was real">P</abbr>
                  </th>,
                  <th
                    key={`${m.model}-${m.provider_name ?? 'x'}-r`}
                    scope="col"
                    className="pr-3 text-right font-normal"
                  >
                    <abbr title="Recall: of the planted defects, how many it found">R</abbr>
                  </th>,
                ])}
              </tr>
            </thead>
            <tbody>
              {roles.map((r) => (
                <tr
                  key={r.id}
                  className="border-t border-border align-top"
                  data-testid={`model-eval-role-${r.id}`}
                >
                  <th
                    scope="row"
                    className="py-1.5 pr-6 text-left text-xs font-normal whitespace-nowrap"
                  >
                    {r.label}
                  </th>
                  {models.map((m) => (
                    <ScoreCells
                      key={`${m.model}-${m.provider_name ?? 'x'}`}
                      score={m.result?.roles[r.id]}
                      testId={`model-eval-${m.model}-${r.id}`}
                    />
                  ))}
                </tr>
              ))}
              <tr
                className="border-t border-border align-top"
                data-testid="model-eval-role-triage-agreement"
              >
                <th
                  scope="row"
                  className="py-1.5 pr-6 text-left text-xs font-normal whitespace-nowrap"
                >
                  Triage agreement
                </th>
                {models.map((m) => (
                  <td
                    key={`${m.model}-${m.provider_name ?? 'x'}`}
                    colSpan={2}
                    className="border-l border-border px-3 py-1.5 text-right text-xs tabular-nums"
                    data-testid={`model-eval-${m.model}-triage`}
                  >
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
                ))}
              </tr>
            </tbody>
          </table>
        </div>
        {models
          .filter((m) => m.result && m.result.errors.length > 0)
          .map((m) => (
            <div
              key={`${m.model}-${m.provider_name ?? 'x'}`}
              className="text-xs"
              data-testid={`model-eval-errors-${m.model}`}
            >
              <details>
                <summary className="cursor-pointer text-warn">
                  Why {m.model} is incomplete: {m.result!.errors.length} provider error
                  {m.result!.errors.length === 1 ? '' : 's'}
                </summary>
                <ul className="mt-1 ml-4 list-disc text-fg-muted">
                  {m.result!.errors.map((e, i) => (
                    <li key={`${e.role}-${e.caseId}-${i}`}>
                      {roles.find((r) => r.id === e.role)?.label ?? e.role}, case{' '}
                      <span className="font-mono">{e.caseId}</span>:{' '}
                      <span className="font-mono break-words">{e.error}</span>
                    </li>
                  ))}
                </ul>
              </details>
            </div>
          ))}
        {unmeasured.length > 0 ? (
          <p className="text-xs text-fg-muted" data-testid="model-eval-how-to-measure">
            <strong>Not measured yet:</strong> {unmeasured.join(', ')}. Measuring is not run from
            this screen: from a RepoPulse checkout, run{' '}
            <code className="font-mono break-all">{MEASURE_COMMAND}</code>. Expect about an hour per
            model on a local model (the first measured run took 54 minutes). The results appear here
            once they are committed and RepoPulse is rebuilt.
          </p>
        ) : null}
      </div>
    </WidgetFrame>
  );
}
