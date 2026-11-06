import { Link } from '@tanstack/react-router';
import { SectionHeader, WidgetFrame, frameState } from '../../components/index.js';
import { useApiQuery } from '../../api/useApiQuery.js';
import { FindingSeverityBadge } from '../findings/FindingSeverity.js';
import { SHADOW_EXPLAINER, ShadowBadge } from '../findings/ShadowBadge.js';

// Sensitive changes (W18-29, over W18-21's radar).
//
// The radar flags a change that LOOSENS a protection — an auth check removed,
// validation relaxed, a work factor lowered, CORS widened, TLS verification
// off, a rate limit raised — for a human to look at. It is a change signal,
// not a verdict, and nothing automated ever clears one.
//
// The screen's hardest job is its blanks. The radar reads diffs as they ARRIVE
// and never history, so "nothing here" has four different causes — no
// repositories, radar switched off, nothing read yet, nothing loosened — and
// only the last one is good news. Each gets its own sentence.
//
// Shadow signals (rules still being measured) are never mixed into the review
// list: they sit in their own disclosure, closed by default, each one marked.

export interface RadarItem {
  id: number;
  repo: { id: number; org: string; name: string };
  severity: number;
  title: string;
  file: string | null;
  line: number | null;
  rule_id: string | null;
  status: string;
  pr_number: number | null;
  first_seen_at: string;
}

export interface RadarRule {
  rule_id: string;
  what: string;
  category: 'authz' | 'validation' | 'crypto' | 'transport' | 'rate_limit';
  lifecycle: 'candidate' | 'active' | 'deprecated';
  open_active: number;
  open_shadow: number;
}

export interface SensitiveChangesResponse {
  repos: { total: number; enabled: number; disabled: { id: number; org: string; name: string }[] };
  runs: {
    window_days: number;
    recent: number;
    failed: number;
    ever: number;
    last_finished_at: string | null;
  };
  rules: RadarRule[];
  totals: { active: number; shadow: number };
  active: RadarItem[];
  shadow: RadarItem[];
}

const CATEGORY_LABEL: Record<RadarRule['category'], string> = {
  authz: 'Authentication and authorization',
  validation: 'Input validation',
  crypto: 'Cryptography and signatures',
  transport: 'CORS, TLS and security headers',
  rate_limit: 'Rate limits',
};

const LIFECYCLE_LABEL: Record<RadarRule['lifecycle'], string> = {
  active: 'active',
  candidate: 'shadow',
  deprecated: 'retired',
};

const PREFIX = 'Needs human review: ';

/** The radar's scanner key, for the Findings drill-down (W20-13, FND-38). */
export const RADAR_SCANNER_KEY = 'sensitive_change';

/** Where the radar is switched on and off, said in words (FND-39). */
const RADAR_TOGGLE_WHERE =
  'An admin switches it back on in the repository’s Security tab, under Coverage, on the Sensitive-change radar row.';

/** The change itself; the "needs human review" prefix is the section heading here. */
function changeOf(title: string): string {
  const t = title.startsWith(PREFIX) ? title.slice(PREFIX.length) : title;
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function day(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '—';
}

/**
 * Why the list is blank, or null when it is not blank for a bad reason.
 * Ordered: the first cause that applies is the one that explains the blank.
 */
export function radarBlankReason(data: SensitiveChangesResponse): string | null {
  if (data.repos.total === 0) {
    return 'No repositories are selected or connected, so there are no changes for the radar to read.';
  }
  if (data.repos.enabled === 0) {
    return `The radar is switched off for ${
      data.repos.total === 1 ? 'this repository' : `all ${data.repos.total} selected repositories`
    }, so nothing is being checked. ${RADAR_TOGGLE_WHERE}`;
  }
  if (data.runs.ever === 0) {
    return 'The radar has not read a change yet. It checks each pull request and push as it arrives — never past history — so this fills in from the next push to a repository with the radar on.';
  }
  return null;
}

function ItemList({
  items,
  shadow,
  testId,
}: {
  items: RadarItem[];
  shadow: boolean;
  testId?: string;
}) {
  return (
    <ul
      className="flex flex-col"
      data-testid={testId ?? (shadow ? 'radar-shadow-list' : 'radar-active-list')}
    >
      {items.map((it) => (
        <li
          key={it.id}
          className="flex flex-col gap-1 border-t border-border py-2 first:border-t-0"
          data-testid={`radar-item-${it.id}`}
        >
          <div className="flex flex-wrap items-center gap-2">
            <FindingSeverityBadge severity={it.severity} />
            {shadow ? <ShadowBadge /> : null}
            <Link
              to="/findings"
              search={{ finding: it.id } as never}
              className="min-h-6 text-sm text-accent underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            >
              {changeOf(it.title)}
            </Link>
          </div>
          <p className="text-xs break-words text-fg-muted">
            {it.repo.name}
            {/* W20-21 (UX_TODO FND-70): the PR a reviewer may need to block. */}
            {it.pr_number !== null ? (
              <>
                {' · '}
                <Link
                  to="/repos/$repoId/prs/$number"
                  params={{ repoId: String(it.repo.id), number: String(it.pr_number) } as never}
                  className="text-accent underline-offset-2 hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  data-testid={`radar-pr-${it.id}`}
                >
                  PR #{it.pr_number}
                </Link>
              </>
            ) : (
              ' · pushed to a branch'
            )}
            {it.file ? (
              <>
                {' · '}
                <span className="font-mono break-all">
                  {it.file}
                  {it.line !== null ? `:${it.line}` : ''}
                </span>
              </>
            ) : null}
            {` · first seen ${day(it.first_seen_at)}`}
          </p>
        </li>
      ))}
    </ul>
  );
}

export function SensitiveChanges({ search }: { search: Record<string, string> }) {
  const { data, isLoading, isError, error, refetch } = useApiQuery<SensitiveChangesResponse>({
    endpoint: '/security/sensitive-changes',
    query: search.repos ? { repos: search.repos } : {},
  });

  const blank = data ? radarBlankReason(data) : null;
  const state = frameState({
    isLoading,
    isError,
    isEmpty: data !== undefined && (blank !== null || data.totals.active === 0),
  });

  const emptyMessage =
    blank ??
    (data && data.totals.shadow > 0
      ? `No signal from an active rule. ${data.totals.shadow} ${
          data.totals.shadow === 1 ? 'signal' : 'signals'
        } from rules still in shadow ${data.totals.shadow === 1 ? 'is' : 'are'} listed below, apart from this list.`
      : `Nothing loosened a protection: the radar read ${data?.runs.recent ?? 0} ${
          data?.runs.recent === 1 ? 'change' : 'changes'
        } in the last ${data?.runs.window_days ?? 30} days and raised no open signal.`);

  const toReview = (data?.active ?? []).filter((i) => i.status !== 'confirmed');
  const confirmed = (data?.active ?? []).filter((i) => i.status === 'confirmed');

  const grouped = new Map<RadarRule['category'], RadarRule[]>();
  for (const r of data?.rules ?? [])
    grouped.set(r.category, [...(grouped.get(r.category) ?? []), r]);

  return (
    <div className="flex flex-col gap-4" data-testid="sensitive-changes">
      {data && blank === null && (
        <p className="text-xs text-fg-muted" data-testid="radar-coverage" role="status">
          Radar on for {data.repos.enabled} of {data.repos.total}{' '}
          {data.repos.total === 1 ? 'repository' : 'repositories'} · {data.runs.recent}{' '}
          {data.runs.recent === 1 ? 'change' : 'changes'} read in the last {data.runs.window_days}{' '}
          days
          {data.runs.last_finished_at ? ` · last read ${day(data.runs.last_finished_at)}` : ''}
          {data.runs.failed > 0 ? ` · ${data.runs.failed} could not be read` : ''}
        </p>
      )}

      <WidgetFrame
        title={
          data && data.active.length > 0
            ? `Needs human review (${toReview.length})`
            : 'Needs human review'
        }
        state={state}
        onRetry={() => void refetch()}
        {...(error ? { errorMessage: error.message, error } : {})}
        emptyMessage={emptyMessage}
        testId={blank !== null ? 'radar-unavailable' : 'radar-active'}
      >
        {data && data.active.length > 0 && (
          <div className="flex flex-col gap-2">
            {/* W20-13 (UX_TODO FND-54): a change someone already confirmed is
                reviewed, and waits for a fix; it no longer reads as unreviewed
                with a small "· confirmed" suffix. */}
            {toReview.length > 0 ? (
              <ItemList items={toReview} shadow={false} />
            ) : (
              <p className="text-sm text-fg-muted" data-testid="radar-none-to-review">
                Every listed change has been reviewed; the confirmed ones are below.
              </p>
            )}
            {confirmed.length > 0 && (
              <div data-testid="radar-confirmed">
                <h3 className="section-label mt-2">
                  Confirmed, awaiting a fix ({confirmed.length})
                </h3>
                <ItemList items={confirmed} shadow={false} testId="radar-confirmed-list" />
              </div>
            )}
            {data.totals.active > data.active.length && (
              <p className="text-xs text-fg-muted" data-testid="radar-more">
                Showing the {data.active.length} most recent of {data.totals.active}.{' '}
                {/* W20-13 (UX_TODO FND-38): the rest, in Findings. */}
                <Link
                  to="/findings"
                  search={
                    {
                      scanner_key: RADAR_SCANNER_KEY,
                      ...(search.repos ? { repos: search.repos } : {}),
                    } as never
                  }
                  className="text-accent underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  data-testid="radar-see-all"
                >
                  See all {data.totals.active} in Findings
                </Link>
              </p>
            )}
          </div>
        )}
      </WidgetFrame>

      {data && data.repos.disabled.length > 0 && data.repos.enabled > 0 && (
        <p className="text-xs text-fg-muted" data-testid="radar-disabled-repos">
          Not checked: the radar is off for{' '}
          {data.repos.disabled.map((r, i) => (
            <span key={r.id}>
              {i > 0 ? ', ' : ''}
              <Link
                to="/repos/$repoId/security"
                params={{ repoId: String(r.id) } as never}
                search={{} as never}
                className="text-fg underline underline-offset-2"
              >
                {r.name}
              </Link>
            </span>
          ))}
          . {RADAR_TOGGLE_WHERE}
        </p>
      )}

      {data && data.totals.shadow > 0 && (
        // Closed by default: shadow signals are measured, not acted on, and
        // opening them is a choice the reader makes (W18-29).
        <details className="panel px-4 py-3" data-testid="radar-shadow">
          <summary className="min-h-6 cursor-pointer text-sm font-semibold text-fg">
            Shadow signals ({data.totals.shadow}) — rules still being measured
          </summary>
          <p className="mt-2 text-xs text-fg-muted">{SHADOW_EXPLAINER}</p>
          <div className="mt-2">
            <ItemList items={data.shadow} shadow />
          </div>
        </details>
      )}

      {data && data.rules.length > 0 && (
        <section className="panel flex flex-col gap-3 p-4" data-testid="radar-rules">
          <SectionHeader
            title="What the radar checks"
            description="Each rule looks at the removed and added lines of a change. A rule in shadow raises signals only into the shadow list until an admin promotes it."
          />
          <div className="grid gap-3 sm:grid-cols-2">
            {[...grouped.entries()].map(([category, rules]) => (
              <div key={category}>
                <h3 className="section-label">
                  {CATEGORY_LABEL[category]}
                </h3>
                <ul className="mt-1 flex flex-col gap-1 text-sm">
                  {rules.map((r) => (
                    <li key={r.rule_id} data-testid={`radar-rule-${r.rule_id}`}>
                      <span>{r.what.charAt(0).toUpperCase() + r.what.slice(1)}</span>
                      <span className="text-xs text-fg-muted">
                        {' '}
                        · {LIFECYCLE_LABEL[r.lifecycle]}
                        {r.open_active + r.open_shadow > 0
                          ? ` · ${r.open_active + r.open_shadow} open`
                          : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
