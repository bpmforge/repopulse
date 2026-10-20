import { Link } from '@tanstack/react-router';
import { WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import type { TopActionItem, TopActionsCoverage, TopActionsResponse } from './contracts.js';
import { reposParam, withRepos } from '../scopeRepos.js';

// Next actions (W17-17) — the card that made the Org Overview about doing
// something rather than about reading headings.
//
// The baseline measured at 1440x900: the fold landed on the TITLES of Repo
// health and Needs attention, so the first actionable row on the landing screen
// was below it. Every tile above the fold reported state; none of them proposed
// a move. This card is placed first in orgWidgets for that reason, and stays
// short (h:2) so its rows — not just its heading — clear the fold.
//
// It RENDERS the W17-16 response and computes nothing. The ranking is the
// server's (deterministic, warehouse-only), the deep link is the server's
// `href`, and the empty-state sentence is summarizeCoverage's `summary` quoted
// verbatim. A second opinion about any of the three would be a second status
// system, which is the thing packages/insights/src/actions/coverage.ts exists
// to prevent.

interface Props {
  /** Global filters, preserved on the links that accept them. */
  search: Record<string, string>;
}

/** Word, not colour: the kind is legible in a greyscale screenshot (UX_SPEC §7). */
const KIND_LABEL: Record<TopActionItem['kind'], string> = {
  finding: 'Finding',
  plan_item: 'Plan',
};

/**
 * Plain words for a capability state.
 *
 * `failed` and `not_configured` are genuinely different situations — one thing
 * ran and broke, another never ran at all — and `coverage.summary` cannot tell
 * them apart: summaryFor() folds both into "N capabilities are failing or not
 * configured". A workspace with a broken scanner and a workspace with no model
 * configured produce a byte-identical sentence, so the notices are what make
 * the partial-failure and no-AI states distinguishable on screen.
 */
/** The Plans page's own effort words (W20-16, UX_TODO DSH-49). */
const EFFORT_LABEL: Record<string, string> = { S: 'Small', M: 'Medium', L: 'Large' };

const NOTICE_LABEL: Record<string, string> = {
  failed: 'failing',
  not_configured: 'not configured',
};

function noticeLabel(state: string): string {
  return NOTICE_LABEL[state] ?? state;
}

/**
 * One action row.
 *
 * The link is built from `target`, not by parsing `href` — but it must AGREE
 * with `href`, which is what the test asserts. `/findings` replaces its search
 * object in validateSearch (W16-49), so the global filters are deliberately not
 * merged in there: an unknown key is stripped rather than ignored, and passing
 * them would only look like it worked.
 */
function ActionRow({ action, search }: { action: TopActionItem; search: Record<string, string> }) {
  const className =
    'panel-inset panel-link flex flex-col gap-0.5 px-3 py-2.5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent';
  const body = (
    <>
      <span className="flex items-center gap-2">
        <span className="rounded-sm border border-border px-1.5 py-0.5 text-xs text-fg-muted">
          {KIND_LABEL[action.kind]}
        </span>
        <span className="truncate text-sm font-medium text-fg">{action.title}</span>
      </span>
      <span className="text-xs text-fg-muted">
        {action.reason}
        {action.repo_name ? ` · ${action.repo_name}` : ''}
        {action.effort ? ` · ${EFFORT_LABEL[action.effort] ?? action.effort} effort` : ''}
      </span>
    </>
  );

  return (
    <li>
      {action.target.kind === 'finding' ? (
        <Link
          to="/findings"
          search={{ finding: action.target.finding_id } as never}
          className={className}
          data-testid={`top-action-${action.id}`}
        >
          {body}
        </Link>
      ) : (
        <Link
          to="/plans"
          search={search as never}
          hash={`plan-item-${action.target.plan_item_id}`}
          className={className}
          data-testid={`top-action-${action.id}`}
        >
          {body}
        </Link>
      )}
    </li>
  );
}

/**
 * What an empty card says BESIDE the summary.
 *
 * `coverage.summary` is the frame's emptyMessage, quoted verbatim; this adds
 * the detail that summary cannot carry. Never "you're all clear" — the sentence
 * states what WAS measured and lets the reader judge the silence.
 */
function CoverageNote({ coverage }: { coverage: TopActionsCoverage }) {
  return (
    <div
      className="flex flex-col gap-2 text-fg-muted"
      data-testid="top-actions-coverage"
      data-basis={coverage.basis}
    >
      {coverage.notices.length > 0 && (
        <ul className="flex flex-col gap-1 text-xs" data-testid="top-actions-notices">
          {coverage.notices.map((n) => (
            <li key={`${n.repo_id}:${n.capability}`} data-state={n.state}>
              <span className="text-fg">{n.repo_name}</span>
              {' · '}
              {n.capability} {noticeLabel(n.state)}
              {n.detail ? ` — ${n.detail}` : ''}
            </li>
          ))}
        </ul>
      )}
      {coverage.unsupported.length > 0 && (
        <p className="text-xs" data-testid="top-actions-unsupported">
          Not available in this release: {coverage.unsupported.join(', ')}.
        </p>
      )}
    </div>
  );
}

export function TopActionsCard({ search }: Props) {
  // No window: collectTopActions ranks what is open now. The repositories,
  // though, are the view's (W20-09, UX_TODO DSH-02).
  const repos = reposParam(search);
  const { data, isLoading, isError, error, refetch } = useApiQuery<TopActionsResponse>({
    endpoint: '/org/top-actions',
    query: withRepos({}, repos),
  });

  const actions = data?.actions ?? [];
  const coverage = data?.coverage ?? null;

  return (
    <WidgetFrame
      // No count in the title. "Top 3" would be a number the card promises and
      // the warehouse may not have.
      title="Next actions"
      state={frameState({
        isLoading,
        isError,
        isEmpty: data !== undefined && actions.length === 0,
      })}
      {...(error ? { errorMessage: error.message, error } : {})}
      onRetry={() => void refetch()}
      // summarizeCoverage's own sentence, unedited. The fallback is only for a
      // response that somehow carries no coverage at all, and still refuses to
      // claim a clean result.
      emptyMessage={
        coverage?.summary ?? 'No actions right now, and no coverage state to explain it.'
      }
      {...(coverage ? { emptyAction: <CoverageNote coverage={coverage} /> } : {})}
      testId="top-actions-card"
      className="panel-hero"
    >
      {/* Three across from md: the rows are one line of title plus one of
          context, and stacked they pushed everything else below the fold. */}
      <ul className="grid grid-cols-1 gap-2 md:grid-cols-3" data-testid="top-actions">
        {actions.map((action) => (
          <ActionRow key={action.id} action={action} search={search} />
        ))}
      </ul>
    </WidgetFrame>
  );
}
