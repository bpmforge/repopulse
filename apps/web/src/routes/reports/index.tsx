import { useEffect, useRef, useState } from 'react';
import { createFileRoute, Link } from '@tanstack/react-router';
import { ErrorNote, WidgetFrame, frameState, PageHeader } from '../../components/index.js';
import {
  SESSION_ENDPOINT,
  useApiQuery,
  useApiMutation,
  queryKeyFor,
} from '../../api/useApiQuery.js';
import type { MeContext } from '../../widgets/org/contracts.js';
import { MakePlanButton } from '../../widgets/plans/MakePlanButton.js';
import { repoIdsFromFilter } from '../../widgets/plans/contracts.js';
import { localDateTime, relativeTime } from '../../lib/time.js';
import { sectionTitle } from '../../lib/report-sections.js';

// Report Center (W5-04, UX_SPEC §4.h). The rail has linked to /reports since
// W4-02 with no route behind it.

export const Route = createFileRoute('/reports/')({ component: ReportCenter });

const LIST = { endpoint: '/reports' } as const;

export interface ReportRow {
  id: number;
  type: string;
  /**
   * The four the worker writes. Typed open (W17-26) because the screen must
   * treat anything it does not recognise as SETTLED: a status added later
   * (`cancelled`, say) that this code kept polling on would be the infinite
   * poll all over again, under a new name.
   */
  status: 'queued' | 'running' | 'ready' | 'failed' | (string & {});
  generated_at: string;
  /**
   * When the row was last queued (W20-19, UX_TODO ADM-61): equal to
   * generated_at until a Retry. Optional so an older API still renders.
   */
  queued_at?: string;
  error: string | null;
  has_pdf: boolean;
  /** The row says ready, the PDF on disk is gone (W17-26). */
  artifact_missing?: boolean;
  /** The pinned params: what the report covers (W20-09, UX_TODO ADM-05). */
  params?: {
    repoIds?: (string | number)[];
    windowDays?: number;
    annotation?: string;
  };
  /** Login of whoever pressed Generate (ADM-05). */
  generated_by?: string | null;
}

interface RepoItem {
  id: number;
  org: string;
  name: string;
}

/** Repository ids a row's params name, as numbers. */
export function reportRepoIds(r: ReportRow): number[] {
  return (r.params?.repoIds ?? []).map(Number).filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * The scope column (W20-09, UX_TODO ADM-05). Two "Repository Health" rows in
 * the history could not be told apart; now each says which repositories it
 * covers. Names when known, a count when not — never a guess.
 */
export function reportScopeLabel(r: ReportRow, names: Record<number, string>): string {
  const ids = reportRepoIds(r);
  if (ids.length === 0) return 'All repositories';
  if (ids.every((id) => names[id])) {
    return ids.length > 2
      ? `${names[ids[0]!]} +${ids.length - 1} more`
      : ids.map((id) => names[id]).join(', ');
  }
  return ids.length === 1 ? '1 repository' : `${ids.length} repositories`;
}

const TYPES = [
  { id: 'repo_health', label: 'Repository Health' },
  { id: 'org_exec', label: 'Organization Executive Summary' },
  { id: 'delivery_dora', label: 'Delivery / DORA' },
  { id: 'security_posture', label: 'Security Posture' },
  { id: 'code_health', label: 'Code Health' },
] as const;

/** Paired glyph + word, never colour alone (UX_SPEC §7). */
const STATUS: Record<string, string> = {
  queued: '◷ queued',
  running: '◐ running',
  ready: '✓ ready',
  failed: '✕ failed',
  cancelled: '⊘ cancelled',
};

/**
 * How long a queued/running row is polled before the screen stops asking
 * (W17-26). A print takes seconds (REPORTS.md §3 budgets 30s) and BullMQ
 * retries it once after 5s; a row still non-terminal after this long is a
 * worker that died mid-job or a queue nobody is draining, and polling it for
 * the life of the tab is the infinite poll this ticket closes. The row stays
 * on screen with a Refresh so a human can still ask.
 */
export const STALE_AFTER_MS = 15 * 60 * 1000;

export function isPending(r: ReportRow): boolean {
  return r.status === 'queued' || r.status === 'running';
}

export function isStalled(r: ReportRow, now: number = Date.now()): boolean {
  // From the last queueing, not the first request (ADM-61): a report from
  // last month retried a minute ago is not stalled.
  return isPending(r) && now - Date.parse(r.queued_at ?? r.generated_at) > STALE_AFTER_MS;
}

/**
 * When a Retry queued the row again, or null when it never was (W20-19,
 * UX_TODO ADM-61). A minute's slack: the two are written by one INSERT.
 */
export function retriedAt(r: ReportRow): string | null {
  if (!r.queued_at) return null;
  return Date.parse(r.queued_at) - Date.parse(r.generated_at) > 60_000 ? r.queued_at : null;
}

/** The poll interval for a list: 3s while any young job is in flight, else off. */
export function pollInterval(
  list: { items: ReportRow[] } | undefined,
  now: number = Date.now(),
): number | false {
  return list?.items.some((r) => isPending(r) && !isStalled(r, now)) ? 3000 : false;
}

/** A failed job, or a ready one whose PDF is gone, can be queued again. */
/** A report by type and date, for the compare labels (W20-22, UX_TODO ADM-25). */
export function reportLabel(r: Pick<ReportRow, 'type' | 'generated_at'>): string {
  const type = TYPES.find((t) => t.id === r.type)?.label ?? r.type;
  return `${type}, ${localDateTime(r.generated_at)}`;
}

/** Older first, whatever order they were ticked in (W20-22, UX_TODO ADM-25). */
export function compareOrder(a: ReportRow, b: ReportRow): [ReportRow, ReportRow] {
  return Date.parse(a.generated_at) <= Date.parse(b.generated_at) ? [a, b] : [b, a];
}

/** One page of history (W20-22, UX_TODO ADM-52). */
export const PAGE_SIZE = 50;

export interface HistoryFilter {
  type: string;
  since: string;
  until: string;
}

/** The list query for a filter and a cursor; empty fields are left out. */
export function historyQuery(f: HistoryFilter, cursor: string | null): Record<string, string> {
  return {
    limit: String(PAGE_SIZE),
    ...(f.type ? { type: f.type } : {}),
    ...(f.since ? { since: f.since } : {}),
    ...(f.until ? { until: f.until } : {}),
    ...(cursor ? { cursor } : {}),
  };
}

/** "Showing 51-100 of 230" (W20-22, UX_TODO ADM-52). */
export function historyRangeText(offset: number, shown: number, total: number | undefined): string {
  if (shown === 0) return '';
  const range = `${offset + 1}–${offset + shown}`;
  return total === undefined ? `Showing ${range}` : `Showing ${range} of ${total}`;
}

export function canRetry(r: ReportRow): boolean {
  return r.status === 'failed' || (r.status === 'ready' && r.artifact_missing === true);
}

function ReportCenter() {
  // THE SCOPE (W20-09, UX_TODO ADM-05). The form never sent `repo_ids`, so
  // "Repository Health" never said which repository it covered. It starts as
  // the topbar's repository filter, the scope the reader was already looking
  // at, and can be changed here. With one repository in that filter the
  // report starts as that repository's health; otherwise as the org summary,
  // which needs no choice before Generate means something.
  const search = Route.useSearch() as { repos?: unknown };
  // String() because the router parses a bare `?repos=4` as the number 4.
  const fromFilter = repoIdsFromFilter(
    search.repos === undefined ? undefined : String(search.repos),
  );
  const [scope, setScope] = useState<number[]>(fromFilter);
  const [type, setType] = useState<string>(fromFilter.length === 1 ? 'repo_health' : 'org_exec');
  const [windowDays, setWindowDays] = useState(30);
  const { data: repoList } = useApiQuery<{ items: RepoItem[] }>({ endpoint: '/repos' });
  const repos = repoList?.items ?? [];
  const repoNames: Record<number, string> = Object.fromEntries(
    repos.map((r) => [r.id, `${r.org}/${r.name}`]),
  );
  // Repository Health is about ONE repository (the assembler reads the
  // first); every other type takes a set, empty meaning all of them.
  const single = type === 'repo_health';
  const effectiveScope = single ? scope.slice(0, 1) : scope;
  const missingRepo = single && effectiveScope.length === 0;
  const { data: me } = useApiQuery<MeContext>({ endpoint: SESSION_ENDPOINT });

  // PAGED, FILTERED HISTORY (W20-22, UX_TODO ADM-52): the API answered the
  // newest 100 and no more. `cursors` is the stack of pages walked so far;
  // its last entry is the page on screen (null = the newest).
  const [filter, setFilter] = useState<HistoryFilter>({ type: '', since: '', until: '' });
  const [cursors, setCursors] = useState<(string | null)[]>([null]);
  const cursor = cursors[cursors.length - 1] ?? null;
  const changeFilter = (next: Partial<HistoryFilter>) => {
    setFilter((f) => ({ ...f, ...next }));
    setCursors([null]);
  };
  const { data, isLoading, isError, error, refetch } = useApiQuery<{
    items: ReportRow[];
    total?: number;
    next_cursor?: string | null;
  }>(
    { ...LIST, query: historyQuery(filter, cursor) },
    {
      // Generation is asynchronous and this list is how anyone knows it finished.
      // Polling rather than SSE because a report takes seconds, not minutes, and
      // a dedicated event channel for it would be more moving parts than the
      // problem deserves.
      //
      // WHILE THERE IS SOMETHING TO WAIT FOR, and not otherwise (W16-12). The
      // old flat 3000 asked every three seconds for the life of the tab, long
      // after every report had settled. Terminal is anything that is not
      // queued/running, and a job non-terminal for longer than STALE_AFTER_MS
      // counts as settled too (W17-26).
      refetchInterval: (list) => pollInterval(list),
      // AND WHILE THE TAB IS HIDDEN. TanStack pauses the interval on
      // `visibilityState: 'hidden'` and defaults this to false — right for a
      // dashboard nobody is looking at, wrong for work the user asked for and
      // then switched away from. A report generated in a backgrounded tab
      // finished server-side and the row read "running" indefinitely.
      //
      // Safe to leave on precisely because the interval above stops itself: this
      // is a poll while a report is generating, not a permanent background
      // request from a tab nobody is looking at.
      refetchIntervalInBackground: true,
    },
  );

  const [annotation, setAnnotation] = useState('');
  // Rows, not ids (W20-22, UX_TODO ADM-25): the pair keeps its labels and
  // dates when the page that held them is paged away.
  const [compare, setCompare] = useState<ReportRow[]>([]);

  const generate = useApiMutation<
    { type: string; window_days: number; annotation: string; repo_ids: number[] },
    { id: number }
  >({ endpoint: '/reports', method: 'POST' }, { invalidate: [queryKeyFor(LIST)] });

  const items = data?.items ?? [];

  return (
    <div className="flex flex-col gap-4" data-testid="report-center">
      <PageHeader
        title="Reports"
        description="Point-in-time reports, pinned to their window so a regenerated copy shows the same numbers."
      />
      <WidgetFrame title="Generate a report" state="ready">
        {/* W26-04 (UI-33): a small stacked form, not five controls on one
            line with a disclosure in the middle. */}
        <div className="form-narrow flex flex-col gap-3" data-testid="generate-form">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <label className="flex flex-col gap-1 text-xs text-fg-muted">
              Report
              <select
                className="w-full panel px-2 py-1 text-sm"
                data-testid="report-type"
                value={type}
                onChange={(e) => setType(e.target.value)}
              >
                {TYPES.map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col gap-1 text-xs text-fg-muted">
              Window
              <select
                className="w-full panel px-2 py-1 text-sm"
                data-testid="report-window"
                value={windowDays}
                onChange={(e) => setWindowDays(Number(e.target.value))}
              >
                {[7, 30, 90, 365].map((d) => (
                  <option key={d} value={d}>
                    {d} days
                  </option>
                ))}
              </select>
            </label>
          </div>
          {single ? (
            <label className="flex flex-col gap-1 text-xs text-fg-muted">
              Repository
              <select
                className="w-full panel px-2 py-1 text-sm"
                data-testid="report-repo"
                value={effectiveScope[0] ?? ''}
                onChange={(e) => setScope(e.target.value ? [Number(e.target.value)] : [])}
              >
                <option value="">Choose a repository…</option>
                {repos.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.org}/{r.name}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <details className="text-xs text-fg-muted" data-testid="report-repos">
              <summary className="cursor-pointer py-1" data-testid="report-repos-summary">
                Repositories:{' '}
                {scope.length === 0
                  ? 'all'
                  : reportScopeLabel({ params: { repoIds: scope } } as ReportRow, repoNames)}
              </summary>
              <fieldset className="mt-1 flex max-h-48 flex-col gap-1 overflow-auto panel p-2">
                <legend className="sr-only">Repositories in this report</legend>
                {repos.map((r) => (
                  <label key={r.id} className="flex items-center gap-2 text-sm text-fg">
                    <input
                      type="checkbox"
                      data-testid={`report-repo-${r.id}`}
                      checked={scope.includes(r.id)}
                      onChange={(e) =>
                        setScope((cur) =>
                          e.target.checked
                            ? [...cur, r.id].sort((a, b) => a - b)
                            : cur.filter((id) => id !== r.id),
                        )
                      }
                    />
                    {r.org}/{r.name}
                  </label>
                ))}
                <span className="text-xs text-fg-faint">None ticked = every repository.</span>
              </fieldset>
            </details>
          )}
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            Context (optional)
            <input
              className="w-full panel px-2 py-1 text-sm"
              data-testid="report-annotation"
              placeholder="e.g. this quarter includes the payments migration"
              value={annotation}
              onChange={(e) => setAnnotation(e.target.value)}
              aria-describedby="report-annotation-note"
            />
            {/* W20-19 (UX_TODO ADM-72): the note is printed in the report. */}
            <span id="report-annotation-note" className="text-fg-faint">
              Printed in the report; every member of the workspace can read it.
            </span>
          </label>
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              className="rounded-md btn-primary px-3 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              data-testid="generate-report"
              disabled={generate.isPending || missingRepo}
              title={missingRepo ? 'Choose the repository this report is about' : undefined}
              onClick={() =>
                generate.mutate(
                  { type, window_days: windowDays, annotation, repo_ids: effectiveScope },
                  { onSuccess: () => setAnnotation('') },
                )
              }
            >
              {generate.isPending ? 'Queuing…' : 'Generate'}
            </button>
            {/* W20-04 (UX_TODO ADM-08). A refused Generate showed nothing at all,
              so the button simply seemed broken; and a successful one gave no
              sign either until the row appeared in History. */}
            {generate.isSuccess && !generate.isPending ? (
              <span className="text-xs text-fg-muted" role="status" data-testid="generate-queued">
                Queued — it appears in History below and updates when it is ready.
              </span>
            ) : null}
          </div>
        </div>
        <ErrorNote error={generate.error} testId="generate-error" className="mt-2" />
        <p className="help-text mt-2">
          The window and the snapshot high-watermark are pinned when you press Generate, so
          regenerating this report later reproduces the same numbers.
        </p>
      </WidgetFrame>

      <WidgetFrame
        title="History"
        state={frameState({
          isLoading,
          isError,
          isEmpty: data !== undefined && items.length === 0,
        })}
        {...(error ? { errorMessage: error.message, error } : {})}
        onRetry={() => void refetch()}
        emptyMessage="No reports yet — generate one above."
      >
        {/* W20-17 (UX_TODO ADM-32): its own scroll region, so eight columns
            scroll inside the panel at 390 px instead of pushing <main> sideways. */}
        <div className="mb-2 flex flex-wrap items-end gap-3 text-xs" data-testid="history-filter">
          <label className="flex flex-col gap-1">
            <span className="text-fg-muted">Type</span>
            <select
              className="rounded-md border border-border bg-surface px-2 py-1"
              value={filter.type}
              onChange={(e) => changeFilter({ type: e.target.value })}
              data-testid="history-filter-type"
            >
              <option value="">All types</option>
              {TYPES.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.label}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-fg-muted">From</span>
            <input
              type="date"
              className="rounded-md border border-border bg-surface px-2 py-1"
              value={filter.since}
              onChange={(e) => changeFilter({ since: e.target.value })}
              data-testid="history-filter-since"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="text-fg-muted">To</span>
            <input
              type="date"
              className="rounded-md border border-border bg-surface px-2 py-1"
              value={filter.until}
              onChange={(e) => changeFilter({ until: e.target.value })}
              data-testid="history-filter-until"
            />
          </label>
        </div>
        <div
          className="overflow-x-auto"
          role="region"
          aria-label="Report history"
          tabIndex={0}
          data-testid="report-history-scroll"
        >
          <table className="table-plain w-full text-sm">
            <caption className="sr-only">Generated reports, newest first</caption>
            <thead>
              <tr className="text-left text-xs text-fg-muted">
                <th scope="col">Report</th>
                <th scope="col">Scope</th>
                <th scope="col">Window</th>
                <th scope="col">Generated</th>
                <th scope="col">By</th>
                <th scope="col">Status</th>
                <th scope="col">Compare</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody data-testid="report-rows">
              {items.map((r) => (
                <HistoryRow
                  key={r.id}
                  row={r}
                  repoNames={repoNames}
                  compared={compare.some((c) => c.id === r.id)}
                  onCompare={(checked) =>
                    setCompare((c) =>
                      checked ? [...c, r].slice(-2) : c.filter((x) => x.id !== r.id),
                    )
                  }
                  onRefresh={() => void refetch()}
                  isAdmin={me?.role === 'admin'}
                />
              ))}
            </tbody>
          </table>
        </div>
        {(data?.next_cursor || cursors.length > 1 || items.length > 0) && (
          <div
            className="mt-2 flex flex-wrap items-center gap-2 text-xs"
            data-testid="history-pager"
          >
            <span className="text-fg-muted" data-testid="history-range">
              {historyRangeText((cursors.length - 1) * PAGE_SIZE, items.length, data?.total)}
            </span>
            {cursors.length > 1 && (
              <button
                type="button"
                className="rounded-md border border-border px-2 py-1 hover:border-accent"
                onClick={() => setCursors((c) => c.slice(0, -1))}
                data-testid="history-newer"
              >
                Newer
              </button>
            )}
            {data?.next_cursor && (
              <button
                type="button"
                className="rounded-md border border-border px-2 py-1 hover:border-accent"
                onClick={() => setCursors((c) => [...c, data.next_cursor ?? null])}
                data-testid="history-older"
              >
                Older
              </button>
            )}
          </div>
        )}
      </WidgetFrame>

      {compare.length === 2 && <ReportDiff pair={compareOrder(compare[0]!, compare[1]!)} />}

      {/* Admin-only, like the API behind it (ADM-07). */}
      {me?.role === 'admin' && <SchedulesPanel />}
    </div>
  );
}

interface ScheduleRow {
  key: string;
  type: string;
  cadence: string;
  next: number | null;
  windowDays?: number | null;
}

const SCHEDULES = { endpoint: '/reports/schedules' } as const;

/**
 * Scheduled reports (W20-09, UX_TODO ADM-07). `GET/POST/DELETE
 * /reports/schedules` existed and no screen called them, so a monthly report
 * could only be scheduled with curl. In-app only: a scheduled report lands in
 * History like any other, with no delivery channel (N-4).
 */
export function SchedulesPanel() {
  const { data, isLoading, isError, error, refetch } = useApiQuery<{ items: ScheduleRow[] }>(
    SCHEDULES,
  );
  const [type, setType] = useState<string>('org_exec');
  const [cadence, setCadence] = useState<'monthly' | 'quarterly'>('monthly');
  const [windowDays, setWindowDays] = useState(30);
  const add = useApiMutation<{ type: string; cadence: string; window_days: number }, unknown>(
    { ...SCHEDULES, method: 'POST' },
    { invalidate: [queryKeyFor(SCHEDULES)] },
  );
  const items = data?.items ?? [];

  return (
    <WidgetFrame
      title="Schedules"
      state={frameState({ isLoading, isError, isEmpty: false })}
      {...(error ? { errorMessage: error.message, error } : {})}
      onRetry={() => void refetch()}
      testId="report-schedules"
    >
      <p className="mb-2 text-xs text-fg-muted">
        Scheduled reports cover every repository and run at 03:00 on the 1st of the month (or of
        each quarter), after the nightly snapshot. They appear in History when ready.
      </p>
      {items.length === 0 ? (
        <p className="text-sm text-fg-muted" data-testid="schedules-empty">
          Nothing is scheduled.
        </p>
      ) : (
        <table className="table-plain w-full text-sm" data-testid="schedule-rows">
          <caption className="sr-only">Scheduled reports</caption>
          <thead>
            <tr className="text-left text-xs text-fg-muted">
              <th scope="col">Report</th>
              <th scope="col">Cadence</th>
              <th scope="col">Window</th>
              <th scope="col">Next run</th>
              <th scope="col">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {items.map((s) => (
              <ScheduleItem key={s.key} schedule={s} />
            ))}
          </tbody>
        </table>
      )}
      <div className="mt-3 flex flex-wrap items-end gap-3" data-testid="schedule-form">
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Report
          <select
            className="panel px-2 py-1 text-sm"
            data-testid="schedule-type"
            value={type}
            onChange={(e) => setType(e.target.value)}
          >
            {TYPES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Cadence
          <select
            className="panel px-2 py-1 text-sm"
            data-testid="schedule-cadence"
            value={cadence}
            onChange={(e) => setCadence(e.target.value as 'monthly' | 'quarterly')}
          >
            <option value="monthly">Monthly</option>
            <option value="quarterly">Quarterly</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Window
          <select
            className="panel px-2 py-1 text-sm"
            data-testid="schedule-window"
            value={windowDays}
            onChange={(e) => setWindowDays(Number(e.target.value))}
          >
            {[7, 30, 90, 365].map((d) => (
              <option key={d} value={d}>
                {d} days
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="rounded-md btn-primary px-3 py-1.5 text-sm disabled:opacity-50"
          data-testid="schedule-add"
          disabled={add.isPending}
          onClick={() => add.mutate({ type, cadence, window_days: windowDays })}
        >
          {add.isPending ? 'Scheduling…' : 'Schedule'}
        </button>
      </div>
      <ErrorNote error={add.error} testId="schedule-error" className="mt-2" />
    </WidgetFrame>
  );
}

function ScheduleItem({ schedule: s }: { schedule: ScheduleRow }) {
  const remove = useApiMutation<void, unknown>(
    { endpoint: '/reports/schedules/{key}', path: { key: s.key }, method: 'DELETE' },
    { invalidate: [queryKeyFor(SCHEDULES)] },
  );
  return (
    <tr className="border-t border-border" data-testid={`schedule-${s.type}-${s.cadence}`}>
      <th scope="row" className="py-1 text-left font-normal">
        {TYPES.find((t) => t.id === s.type)?.label ?? s.type}
      </th>
      <td className="py-1">{s.cadence}</td>
      <td className="py-1">{s.windowDays ? `${s.windowDays} days` : '—'}</td>
      <td className="py-1 text-xs">
        {s.next === null ? '—' : new Date(s.next).toISOString().slice(0, 16).replace('T', ' ')}
      </td>
      <td className="py-1">
        <button
          type="button"
          className="text-xs text-crit hover:underline disabled:opacity-50"
          data-testid={`schedule-remove-${s.type}-${s.cadence}`}
          disabled={remove.isPending}
          onClick={() => remove.mutate(undefined)}
        >
          Remove
        </button>
        <ErrorNote error={remove.error} />
      </td>
    </tr>
  );
}

function HistoryRow({
  row: r,
  repoNames,
  compared,
  onCompare,
  onRefresh,
  isAdmin = false,
}: {
  row: ReportRow;
  repoNames: Record<number, string>;
  compared: boolean;
  onCompare: (checked: boolean) => void;
  onRefresh: () => void;
  /** Admins may delete a report (W20-19, UX_TODO ADM-72). */
  isAdmin?: boolean;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const remove = useApiMutation<undefined, { id: number; deleted: boolean }>(
    { endpoint: '/reports/{id}', path: { id: r.id }, method: 'DELETE' },
    { invalidate: [queryKeyFor(LIST)] },
  );
  const retried = retriedAt(r);
  // Same row, queued again (W17-26): the pinned params travel with the id, so
  // a retry measures the same moment the failed run was asked to measure.
  const retry = useApiMutation<Record<string, never>, { id: number; status: string }>(
    { endpoint: '/reports/{id}/retry', path: { id: r.id }, method: 'POST' },
    { invalidate: [queryKeyFor(LIST)] },
  );
  const stalled = isStalled(r);
  // REGENERATE WITH THE SAME SCOPE (W20-09, UX_TODO ADM-06): a NEW report for
  // the same type, repositories, window and note, measured now. Retry, above,
  // re-runs the same moment; this one is "last month's report, again".
  const regenerate = useApiMutation<
    { type: string; window_days: number; annotation: string; repo_ids: number[] },
    { id: number }
  >({ endpoint: '/reports', method: 'POST' }, { invalidate: [queryKeyFor(LIST)] });

  return (
    <tr className="border-t border-border" data-testid={`report-${r.id}`}>
      <th scope="row" className="py-1 text-left font-normal">
        {TYPES.find((t) => t.id === r.type)?.label ?? r.type}
      </th>
      <td className="py-1 text-xs" data-testid={`report-scope-${r.id}`}>
        {reportScopeLabel(r, repoNames)}
      </td>
      <td className="py-1 text-xs" data-testid={`report-window-${r.id}`}>
        {r.params?.windowDays ? `${r.params.windowDays}d` : '—'}
      </td>
      {/* W20-17 (UX_TODO ADM-26): local time with the zone named, plus "5 min
          ago"; it was a bare UTC slice that read as local time. */}
      <td className="py-1 text-xs" data-testid={`report-generated-${r.id}`}>
        <span title={r.generated_at}>{localDateTime(r.generated_at)}</span>
        <span className="block text-fg-faint">{relativeTime(r.generated_at)}</span>
        {/* W20-19 (UX_TODO ADM-61): a retry keeps the original date above. */}
        {retried && (
          <span
            className="block text-fg-faint"
            title={retried}
            data-testid={`report-retried-${r.id}`}
          >
            retried {relativeTime(retried)}
          </span>
        )}
      </td>
      <td className="py-1 text-xs" data-testid={`report-by-${r.id}`}>
        {r.generated_by ?? '—'}
      </td>
      <td className="py-1" data-testid={`report-status-${r.id}`}>
        {STATUS[r.status] ?? r.status}
        {/* The reason travels with the failure. A bare "failed" sends
            someone to logs they may not have access to. */}
        {r.error && <span className="ml-2 text-xs text-crit">{r.error.slice(0, 120)}</span>}
        {r.status === 'ready' && r.artifact_missing && (
          // Not "failed": the generation succeeded and the stored data may
          // still be viewable. What is gone is the file behind the download.
          <span className="ml-2 text-xs text-warn" data-testid={`report-artifact-missing-${r.id}`}>
            PDF no longer on disk — retry to regenerate it
          </span>
        )}
        {stalled && (
          // W20-17 (UX_TODO ADM-47): name the usual cause and where to check it.
          <span className="ml-2 text-xs text-fg-muted" data-testid={`report-stalled-${r.id}`}>
            no progress for over 15 minutes; polling paused. The background worker may not be
            running —{' '}
            <Link to="/admin" className="text-accent hover:underline">
              check System health
            </Link>
            .
          </span>
        )}
        {retry.isError && (
          <span className="ml-2 text-xs text-crit" data-testid={`report-retry-error-${r.id}`}>
            {retry.error.message}
          </span>
        )}
        {regenerate.isSuccess && (
          <span className="ml-2 text-xs text-fg-muted" role="status">
            Regenerated as #{regenerate.data.id}
          </span>
        )}
        <ErrorNote error={regenerate.error} testId={`report-regenerate-error-${r.id}`} />
      </td>
      <td className="py-1">
        <input
          type="checkbox"
          aria-label={`Compare ${reportLabel(r)}`}
          data-testid={`report-compare-${r.id}`}
          disabled={r.status !== 'ready'}
          checked={compared}
          onChange={(e) => onCompare(e.target.checked)}
        />
      </td>
      <td className="py-1">
        <div className="flex flex-wrap gap-2">
          {/* W20-17 (UX_TODO ADM-22): View only once there is something to
              view; a queued, running or failed row opened onto "no stored
              data". Its status, and Retry where it applies, say the rest. */}
          {r.status === 'ready' && (
            <Link
              to="/print/reports/$reportId"
              params={{ reportId: String(r.id) }}
              className="text-xs text-accent hover:underline"
              data-testid={`report-view-${r.id}`}
            >
              View
            </Link>
          )}
          {r.has_pdf && (
            // A plain link, not fetch(): the download streams through
            // the API behind the session check, and letting the
            // browser handle it keeps a multi-megabyte PDF out of JS
            // memory.
            <a
              href={`/api/v1/reports/${r.id}/download`}
              className="text-xs text-accent hover:underline"
              data-testid={`report-download-${r.id}`}
            >
              PDF
            </a>
          )}
          {canRetry(r) && (
            <button
              type="button"
              className="text-xs text-accent hover:underline disabled:opacity-50"
              data-testid={`report-retry-${r.id}`}
              disabled={retry.isPending}
              onClick={() => retry.mutate({})}
            >
              Retry
            </button>
          )}
          {r.status === 'ready' && (
            <>
              <button
                type="button"
                className="text-xs text-accent hover:underline disabled:opacity-50"
                data-testid={`report-regenerate-${r.id}`}
                disabled={regenerate.isPending}
                onClick={() =>
                  regenerate.mutate({
                    type: r.type,
                    window_days: r.params?.windowDays ?? 30,
                    annotation: r.params?.annotation ?? '',
                    repo_ids: reportRepoIds(r),
                  })
                }
              >
                Regenerate
              </button>
              <MakePlanButton
                reportId={r.id}
                windowDays={r.params?.windowDays ?? 30}
                repoIds={reportRepoIds(r)}
              />
            </>
          )}
          {stalled && (
            <button
              type="button"
              className="text-xs text-accent hover:underline"
              data-testid={`report-refresh-${r.id}`}
              onClick={onRefresh}
            >
              Refresh
            </button>
          )}
          {/* W20-19 (UX_TODO ADM-72): admins only; not while it is printing. */}
          {isAdmin &&
            r.status !== 'running' &&
            (confirmDelete ? (
              <span
                role="group"
                aria-label="Confirm delete"
                className="flex flex-wrap items-center gap-2"
                data-testid={`report-delete-confirm-${r.id}`}
              >
                <span className="text-xs text-fg-muted">
                  Delete this report and its PDF for everyone? This cannot be undone.
                </span>
                <button
                  type="button"
                  className="text-xs text-crit hover:underline disabled:opacity-50"
                  data-testid={`report-delete-do-${r.id}`}
                  disabled={remove.isPending}
                  // The confirmation is the one thing to answer (ADM-69's rule).
                  autoFocus
                  onClick={() => remove.mutate(undefined)}
                >
                  Delete
                </button>
                <button
                  type="button"
                  className="text-xs text-fg-muted hover:underline"
                  onClick={() => setConfirmDelete(false)}
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="text-xs text-crit hover:underline"
                data-testid={`report-delete-${r.id}`}
                onClick={() => setConfirmDelete(true)}
              >
                Delete…
              </button>
            ))}
        </div>
        <ErrorNote error={remove.error} testId={`report-delete-error-${r.id}`} withDetail />
      </td>
    </tr>
  );
}

interface DiffResponse {
  comparable: boolean;
  reason?: string;
  deltas: {
    sectionId: string;
    label: string;
    before: number | null;
    after: number | null;
    delta: number | null;
    onlyOneSide: boolean;
  }[];
}

/**
 * Diff of two stored reports (R-A9). Only possible because of the W5-03
 * determinism pin: two reports of the same scope differ where the numbers
 * moved, never because they were generated at different moments.
 */
function ReportDiff({ pair: [before, after] }: { pair: [ReportRow, ReportRow] }) {
  const { data, isLoading, isError, error } = useApiQuery<DiffResponse>({
    endpoint: '/reports/{id}/diff/{otherId}',
    path: { id: before.id, otherId: after.id },
  });
  // The diff renders below a table that can be long (W20-22, UX_TODO ADM-25):
  // bring it into view and move focus to it, once per pair.
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    el.focus({ preventScroll: true });
  }, [before.id, after.id]);

  return (
    <div ref={ref} tabIndex={-1} data-testid="report-diff" aria-label="Report comparison">
      <WidgetFrame
        title={`Comparing ${reportLabel(before)} → ${reportLabel(after)}`}
        state={frameState({
          isLoading,
          isError,
          isEmpty: data?.comparable === true && data.deltas.length === 0,
        })}
        {...(error ? { errorMessage: error.message, error } : {})}
        emptyMessage="These reports contain no comparable rows."
      >
        {data?.comparable === false ? (
          // Refusing is the honest answer: a diff across scopes would render a
          // change in what was measured as a change in the work.
          <p className="text-sm text-fg-muted" data-testid="diff-refused">
            {data.reason}
          </p>
        ) : (
          <table className="table-plain w-full text-sm" data-testid="diff-table">
            <caption className="sr-only">Per-row deltas between two reports</caption>
            <thead>
              <tr className="text-left text-xs text-fg-muted">
                <th scope="col">Section</th>
                <th scope="col">Row</th>
                <th scope="col">Before</th>
                <th scope="col">After</th>
                <th scope="col">Change</th>
              </tr>
            </thead>
            <tbody>
              {(data?.deltas ?? []).map((d, i) => (
                <tr key={`${d.sectionId}-${d.label}-${i}`} className="border-t border-border">
                  <td className="py-1 text-xs text-fg-muted">{sectionTitle(d.sectionId)}</td>
                  <th scope="row" className="py-1 text-left font-normal">
                    {d.label}
                  </th>
                  <td className="py-1 tabular-nums">{d.before ?? '—'}</td>
                  <td className="py-1 tabular-nums">{d.after ?? '—'}</td>
                  <td className="py-1 tabular-nums">
                    {d.delta === null
                      ? // Never rendered as a number: a row present on one side
                        // only has not moved, it has appeared or gone.
                        d.onlyOneSide
                        ? d.after === null
                          ? 'gone'
                          : 'new'
                        : '—'
                      : `${d.delta > 0 ? '▲' : d.delta < 0 ? '▼' : ''} ${Math.round(d.delta * 100) / 100}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </WidgetFrame>
    </div>
  );
}
