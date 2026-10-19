import { ErrorNote } from '../../components/index.js';
import { useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';
import { InternalLink } from './InternalLink.js';
import type { GenerateResult } from './contracts.js';

// "Make a plan from this report" (W20-09, UX_TODO DSH-59).
//
// Story E11.1's hand-off — "so that the retro ends with actions" — had an API
// (`POST /plans` takes `from_report_id`) and no button anywhere. The plan uses
// the REPORT's window and repositories, not the topbar's, so the plan answers
// the same question the report did; the server records which report it came
// from. Generation is the same scope-locked call the Plans page makes, so a
// second press returns the plan the first one made.

export interface MakePlanButtonProps {
  reportId: number;
  windowDays: number;
  repoIds: readonly (number | string)[];
  className?: string;
}

export function MakePlanButton({ reportId, windowDays, repoIds, className }: MakePlanButtonProps) {
  const generate = useApiMutation<
    { window: string; repo_ids: number[]; from_report_id: number },
    GenerateResult
  >({ endpoint: '/plans', method: 'POST' }, { invalidate: [queryKeyFor({ endpoint: '/plans' })] });
  const ids = [...new Set(repoIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))].sort(
    (a, b) => a - b,
  );
  const result = generate.data;

  return (
    <span className={`inline-flex flex-wrap items-center gap-2 ${className ?? ''}`}>
      <button
        type="button"
        className="text-xs text-accent hover:underline disabled:opacity-50"
        data-testid={`report-make-plan-${reportId}`}
        disabled={generate.isPending}
        onClick={() =>
          generate.mutate({ window: `${windowDays}d`, repo_ids: ids, from_report_id: reportId })
        }
      >
        {generate.isPending ? 'Making plan…' : 'Make a plan'}
      </button>
      {result && (
        <InternalLink
          to="/plans"
          search={{
            window: `${windowDays}d`,
            ...(ids.length > 0 ? { repos: ids.join(',') } : {}),
          }}
          className="text-xs text-accent underline-offset-2 hover:underline"
          testId={`report-plan-link-${reportId}`}
        >
          {result.reused ? `Plan #${result.id} (unchanged)` : `Plan #${result.id}`} →
        </InternalLink>
      )}
      <ErrorNote error={generate.error} testId={`report-make-plan-error-${reportId}`} />
    </span>
  );
}
