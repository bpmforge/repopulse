import { createFileRoute, Link } from '@tanstack/react-router';
import { WidgetFrame, frameState, PageHeader } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import { PlanItemCard } from '../../widgets/plans/PlanItemCard.js';
import { GeneratePlanButton } from '../../widgets/plans/GeneratePlanButton.js';
import { Agreements } from '../../widgets/agreements/Agreements.js';
import type { MeContext } from '../../widgets/org/contracts.js';
import {
  planProgress,
  planScopeLabel,
  repoIdsFromFilter,
  sameScope,
  type MetricNames,
  type Plan,
  type RepoNames,
} from '../../widgets/plans/contracts.js';

// Plans page (W5-07, UX_SPEC §4.h2). The rail has linked to /plans since W4-02
// with no route behind it.

export const Route = createFileRoute('/plans/')({ component: PlansPage });

const LIST = { endpoint: '/plans' } as const;

function PlansPage() {
  // THE WINDOW CONTROL IS RIGHT ABOVE THE GENERATE BUTTON (W16-50), and the
  // button was hardcoded to 30d — so picking 90d and pressing Generate produced
  // a 30-day plan labelled 30d: the control moved nothing and the result
  // quietly disagreed with it.
  const search = Route.useSearch();
  const { data: me } = useApiQuery<MeContext>({ endpoint: '/me/context' });
  const { data, isLoading, isError, error, refetch } = useApiQuery<{
    items: Plan[];
    truncated?: boolean;
  }>(LIST);

  // Metric NAMES for the exit criteria and evidence lines (W16-53). The route
  // serving this catalog says the UI should read it and never hardcode the
  // names — and until now nothing read it, so every plan item spoke in raw ids
  // ("Closes automatically when M6 stays at most 0.05") on the screen whose job
  // is getting a person to agree to the work.
  const { data: catalog } = useApiQuery<{ items: { id: string; name: string }[] }>({
    endpoint: '/metrics/catalog',
  });
  const metricNames: MetricNames = Object.fromEntries(
    (catalog?.items ?? []).map((m) => [m.id, m.name]),
  );

  // THE SCOPE IS THE TOPBAR'S REPO FILTER (W17-24), and it means exactly one
  // thing on this page: the repositories the next plan is generated for, and
  // the plans listed are those with exactly that scope. A finding's panel
  // links here with its repository in `?repos=`, so nobody copies an id. The
  // shell fetches the same /repos list for the picker; this read is the names.
  const scopeIds = repoIdsFromFilter(search.repos);
  const { data: repoList } = useApiQuery<{ items: { id: number; org: string; name: string }[] }>({
    endpoint: '/repos',
    query: { window: search.window },
  });
  const repoNames: RepoNames = Object.fromEntries(
    (repoList?.items ?? []).map((r) => [r.id, `${r.org}/${r.name}`]),
  );

  const allPlans = data?.items ?? [];
  // With no filter, every plan is listed, each under its own scope. With one,
  // only plans generated for EXACTLY that scope — a workspace-wide plan is not
  // a plan for the selected repository, and showing it under that heading
  // would say it was.
  const scoped =
    scopeIds.length === 0 ? allPlans : allPlans.filter((p) => sameScope(p.repo_ids, scopeIds));
  const hidden = allPlans.length - scoped.length;
  // CURRENT PLANS, THEN HISTORY (W20-09, UX_TODO DSH-58). A regeneration now
  // supersedes the earlier plan for its scope; the superseded ones are
  // archived and folded away below, so the list says which plan is current.
  const plans = scoped.filter((p) => p.status === 'active');
  const archived = scoped.filter((p) => p.status !== 'active');

  return (
    <div className="flex flex-col gap-4" data-testid="plans">
      <PageHeader
        title="Improvement plans"
        description="Ranked fixes for the thresholds this workspace is breaching, each with how it will be verified."
        actions={
          <GeneratePlanButton window={search.window} repoIds={scopeIds} repoNames={repoNames} />
        }
      />
      {scopeIds.length > 0 && (
        <p className="text-xs text-fg-muted" data-testid="plans-scope-note">
          Showing plans generated for exactly {planScopeLabel(scopeIds, repoNames)}
          {hidden > 0
            ? ` · ${hidden} plan${hidden === 1 ? '' : 's'} with another scope hidden`
            : ''}
          {' · '}
          <Link
            to="/plans"
            search={{ window: search.window }}
            className="text-accent hover:underline"
          >
            show every scope
          </Link>
        </p>
      )}

      <WidgetFrame
        title="Plans"
        state={frameState({
          isLoading,
          isError,
          isEmpty: data !== undefined && scoped.length === 0,
        })}
        {...(error ? { errorMessage: error.message, error } : {})}
        onRetry={() => void refetch()}
        emptyMessage={
          scopeIds.length > 0 && allPlans.length > 0
            ? `No plan has been generated for exactly ${planScopeLabel(scopeIds, repoNames)} yet. Generate one, or show every scope.`
            : 'No plans yet. Generate one from the current metrics — items are proposed only where a threshold is actually breached, so a healthy workspace produces an empty plan.'
        }
      >
        <div className="flex flex-col gap-4">
          {[...plans, ...archived].map((plan) => {
            const progress = planProgress(plan);
            // Regressed first, then rank. Something that came undone outranks
            // new advice: it is work already paid for that is being lost.
            const items = [...plan.items]
              .filter((i) => i.status !== 'dismissed')
              .sort((a, b) => {
                const ra = a.status === 'regressed' ? 0 : 1;
                const rb = b.status === 'regressed' ? 0 : 1;
                return ra - rb || a.rank - b.rank;
              });
            // Kept, not hidden for good (W20-05, UX_TODO DSH-14): a dismissal
            // is reversible, so the dismissed items stay one disclosure away.
            const dismissed = plan.items
              .filter((i) => i.status === 'dismissed')
              .sort((a, b) => a.rank - b.rank);

            const scopeLabel = planScopeLabel(plan.repo_ids, repoNames);
            const body = (
              <section key={plan.id} id={`plan-${plan.id}`} data-testid={`plan-${plan.id}`}>
                <div className="mb-2 flex flex-wrap items-baseline gap-2">
                  {/* The plan's OWN scope, from its row — never the filter's.
                      With its id and date (DSH-58): two plans for one scope
                      used to share one heading, and "Plan #N created" named an
                      id the list never showed. */}
                  <h2 className="text-sm font-medium" data-testid={`plan-scope-${plan.id}`}>
                    Plan #{plan.id} · {plan.window} · {scopeLabel}
                  </h2>
                  {/* W20-20 (UX_TODO DSH-50): the date is the header's fact;
                      the recommendation catalog version is only a tooltip. */}
                  <span
                    className="text-xs text-fg-muted"
                    data-testid={`plan-date-${plan.id}`}
                    title={`Recommendation catalog ${plan.catalog_version}`}
                  >
                    {plan.status === 'active' ? 'generated' : 'superseded plan from'}{' '}
                    {plan.created_at.slice(0, 10)}
                  </span>
                  {plan.created_from_report_id ? (
                    <Link
                      to="/print/reports/$reportId"
                      params={{ reportId: String(plan.created_from_report_id) }}
                      className="text-xs text-accent hover:underline"
                      data-testid={`plan-report-${plan.id}`}
                    >
                      from report #{plan.created_from_report_id}
                    </Link>
                  ) : null}
                  <span className="text-xs text-fg-muted" data-testid={`plan-progress-${plan.id}`}>
                    {progress.done}/{progress.total} verified
                  </span>
                  {progress.regressed > 0 && (
                    <span className="text-xs text-warn" data-testid={`plan-regressed-${plan.id}`}>
                      ⚠ {progress.regressed} regressed
                    </span>
                  )}
                </div>

                {/* Progress bar with its numbers beside it: a bar alone cannot
                    be read by a screen reader or a printout. */}
                <div
                  className="mb-2 h-2 w-full overflow-hidden rounded-full bg-surface-2"
                  role="progressbar"
                  aria-valuenow={progress.done}
                  aria-valuemin={0}
                  aria-valuemax={Math.max(progress.total, 1)}
                  aria-label={`${progress.done} of ${progress.total} items verified`}
                >
                  <div
                    className="h-full bg-ok"
                    style={{
                      width: `${progress.total > 0 ? (progress.done / progress.total) * 100 : 0}%`,
                    }}
                  />
                </div>

                {items.length > 0 ? (
                  <ul className="flex flex-col gap-2" data-testid={`plan-items-${plan.id}`}>
                    {items.map((item) => (
                      <PlanItemCard
                        key={item.id}
                        item={item}
                        metricNames={metricNames}
                        scopeLabel={scopeLabel}
                        repoIds={plan.repo_ids}
                      />
                    ))}
                  </ul>
                ) : (
                  <p className="text-sm text-fg-muted">
                    Nothing outstanding in this plan — every threshold in the catalog is currently
                    met.
                  </p>
                )}

                {dismissed.length > 0 && (
                  <details className="mt-2" data-testid={`plan-dismissed-${plan.id}`}>
                    <summary className="cursor-pointer text-xs text-fg-muted">
                      Dismissed ({dismissed.length})
                    </summary>
                    <ul className="mt-2 flex flex-col gap-2">
                      {dismissed.map((item) => (
                        <PlanItemCard
                          key={item.id}
                          item={item}
                          metricNames={metricNames}
                          scopeLabel={scopeLabel}
                          repoIds={plan.repo_ids}
                        />
                      ))}
                    </ul>
                  </details>
                )}
              </section>
            );
            if (plan.status === 'active') return body;
            // History, folded: still there, never mistaken for the current plan.
            return (
              <details key={plan.id} data-testid={`plan-archived-${plan.id}`}>
                <summary className="cursor-pointer text-xs text-fg-muted">
                  Superseded plan #{plan.id} · {plan.window} · {scopeLabel} ·{' '}
                  {plan.created_at.slice(0, 10)}
                </summary>
                <div className="mt-2">{body}</div>
              </details>
            );
          })}
          {data?.truncated ? (
            <p className="text-xs text-fg-muted" data-testid="plans-truncated">
              Older plans are not listed here.
            </p>
          ) : null}
        </div>
      </WidgetFrame>

      {/* W20-19 (UX_TODO ADM-15; decision 2026-10-20): every member reads the
          team's working agreements here, beside the plans that act on them;
          Overview links to this section. Admins manage them in Settings. */}
      <section id="agreements" className="flex flex-col gap-2" data-testid="plans-agreements">
        <Agreements readOnly />
        {me?.role === 'admin' && (
          <Link
            to="/admin/agreements"
            className="text-xs text-accent hover:underline"
            data-testid="plans-agreements-manage"
          >
            Add or change agreements in Settings → Agreements →
          </Link>
        )}
      </section>
    </div>
  );
}
