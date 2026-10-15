import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent } from 'react';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { ErrorNote, WidgetFrame, frameState, PageHeader } from '../../components/index.js';
import { useApiQuery, useApiMutation, queryKeyFor } from '../../api/useApiQuery.js';
import { FindingDetail } from '../../widgets/findings/FindingDetail.js';
import { TriageQueue } from '../../widgets/findings/TriageQueue.js';
import { useOverlayLayout } from '../../widgets/findings/layout.js';
import {
  ALL_DIMENSIONS as DIMENSIONS,
  DIMENSIONS_AWAITING_PRODUCER,
  awaitingProducer,
  SEVERITY_LABEL,
  locationOf,
  VERIFY_LABEL,
  type Finding,
  type FindingFacets,
  type FindingPage,
  type FindingStats,
  type RuleFacet,
  type ShadowMode,
} from '../../widgets/findings/contracts.js';
import { FindingSeverityBadge } from '../../widgets/findings/FindingSeverity.js';
import { ShadowBadge } from '../../widgets/findings/ShadowBadge.js';

// Findings Explorer (W6-04, UX_SPEC §4.e, FR-WEB-9).
//
// The last of four rail destinations that linked nowhere since W4-02.

/**
 * `?finding=` — the open finding, in the URL (W16-16, F14).
 *
 * For a triage tool the workflow is "look at this one", and there was no way
 * to send someone that one: the open row lived in component state, so a
 * pasted URL always landed on the list. FR-WEB-2 already requires a pasted URL
 * to restore the identical screen.
 *
 * Lenient, like the root's own validateSearch: a junk value opens nothing
 * rather than white-screening the whole explorer.
 */
function validateFindingsSearch(search: Record<string, unknown>): { finding?: number } {
  const raw = search.finding;
  const id = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  return Number.isInteger(id) && id > 0 ? { finding: id } : {};
}

export const Route = createFileRoute('/findings/')({
  validateSearch: validateFindingsSearch,
  component: FindingsExplorer,
});

const LIST = { endpoint: '/findings' } as const;

const STATUSES = ['open', 'confirmed', 'dismissed', 'resolved', 'wont_fix'] as const;

/**
 * The shadow facet's choices (W18-29). Active-only is the default and the API's
 * own default: a rule in shadow is still being measured, and its guesses must
 * not sit in the triage list looking like the proven rules' findings.
 */
const SHADOW_OPTIONS: { value: ShadowMode; label: string }[] = [
  { value: 'exclude', label: 'Active rules only' },
  { value: 'only', label: 'Shadow rules only' },
  { value: 'include', label: 'Active and shadow' },
];

/**
 * The rule facet, grouped by the scanner that raised it, in the order the
 * facet endpoint returned (rule id). A rule with no scanner key came from the
 * model review and is grouped under its own heading rather than dropped.
 */
function groupRules(rules: readonly RuleFacet[]): [string, RuleFacet[]][] {
  const groups = new Map<string, RuleFacet[]>();
  for (const r of rules) {
    const key = r.scanner_key ?? 'other';
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.entries()];
}

/** "3 active · 2 shadow" — the counts that decide whether a choice is worth making. */
function ruleCounts(r: RuleFacet): string {
  const parts = [];
  if (r.active > 0) parts.push(`${r.active} active`);
  if (r.shadow > 0) parts.push(`${r.shadow} shadow`);
  return parts.join(' · ');
}

/** POST /findings/bulk — applied ids and the ones the lifecycle refused. */
interface BulkResult {
  applied: number[];
  skipped: { id: number; reason: string }[];
}

/** The HTTP status behind a failed by-id fetch, if the error carries one. */
function statusOf(error: unknown): number | undefined {
  return (error as { status?: number } | null | undefined)?.status;
}

function FindingsExplorer() {
  const [dimension, setDimension] = useState('');
  const [status, setStatus] = useState('open');
  const [severityMin, setSeverityMin] = useState('');
  const [verifyStatus, setVerifyStatus] = useState('');
  // W8-10 scanner facets. A secrets finding was storable and countable before
  // this and not FILTERABLE — the API dropped an unknown dimension silently,
  // so asking for the thing you wanted showed you everything instead.
  const [scannerKey, setScannerKey] = useState('');
  const [inChain, setInChain] = useState(false);
  // W18-29: the shadow facet and the rule facet.
  const [shadowMode, setShadowMode] = useState<ShadowMode>('exclude');
  const [ruleId, setRuleId] = useState('');
  const [selected, setSelected] = useState<number[]>([]);
  // THE URL IS THE STATE, not a mirror of it (W16-16). Reading it back rather
  // than keeping a copy in useState is what makes the back button and a pasted
  // link behave the same as a click.
  const navigate = useNavigate({ from: Route.fullPath });
  const openId = Route.useSearch().finding ?? null;
  /**
   * The row control that opened the current finding, so closing can hand
   * focus back to it (W17-22). Set on click, read once on close. Held as an
   * id rather than an element because the row may have re-rendered — or been
   * paged out — in between.
   */
  const returnFocusTo = useRef<number | null>(null);
  /**
   * Open, switch, or close — three navigations with two history behaviours.
   *
   * Opening from the list and closing back to it are PUSHED: each is a place
   * someone may want Back or Forward to return to, and a reload lands on the
   * same one. Switching row to row while one is open REPLACES: triage is a
   * queue, and pushing an entry per row would make Back walk every finding
   * someone glanced at instead of leaving the screen (W16-16).
   */
  const setOpenId = (id: number | null) => {
    if (id === openId) return;
    const switching = id !== null && openId !== null;
    void navigate({
      // The other global filters ride along — dropping them would make opening
      // a finding silently reset the window and repo pickers (DASHBOARD §1).
      search: (prev: Record<string, unknown>) => ({
        ...prev,
        ...(id === null ? { finding: undefined } : { finding: id }),
      }),
      replace: switching,
    });
  };
  const openFromRow = (id: number) => {
    returnFocusTo.current = id;
    setOpenId(id);
  };
  const close = () => {
    returnFocusTo.current = returnFocusTo.current ?? openId;
    setOpenId(null);
  };

  /**
   * Two presentations, one state (W17-22). Wide: the panel below the list.
   * Narrow: an overlay dialog over it, because a 390px column has no room for
   * both. Which one is drawn never changes what `?finding=` means.
   */
  const overlay = useOverlayLayout();

  /**
   * Scroll the detail panel into view when one opens (W16-05, F14).
   *
   * The panel renders BELOW the table, so on a laptop the actions — the note
   * field, the dismiss reason, Confirm and Dismiss — land under the fold and
   * clicking a finding looks like it did nothing. Triage is the workflow this
   * screen exists for, and it began with a click that appeared to fail.
   *
   * `block: 'nearest'` rather than 'start': when the panel is already visible,
   * moving the page anyway would yank the row the person just clicked out from
   * under the cursor.
   *
   * In overlay mode the dialog takes FOCUS instead: a keyboard user must land
   * inside the thing now covering the list, and Escape must be heard from it.
   */
  const detailRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (openId === null) {
      // Closed: hand focus back to the row that opened it, if the row is
      // still on the page. Paged away or filtered out, there is nothing
      // honest to focus and the browser's default is left alone.
      const id = returnFocusTo.current;
      returnFocusTo.current = null;
      if (id === null) return;
      document.querySelector<HTMLElement>(`[data-testid="finding-open-${id}"]`)?.focus();
      return;
    }
    if (overlay) detailRef.current?.focus();
    else detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [openId, overlay]);
  const [note, setNote] = useState('');
  const [triage, setTriage] = useState(false);

  // The global repository filter, at last read by a screen (W16-50). The API
  // has supported repo_id since W6-04; the topbar has serialized `?repos=`
  // since W4-02; nothing joined them.
  const repos = Route.useSearch().repos;

  const filterQuery = {
    ...(repos ? { repo_id: repos } : {}),
    ...(dimension ? { dimension } : {}),
    ...(status ? { status } : {}),
    ...(severityMin ? { severity_min: severityMin } : {}),
    ...(verifyStatus ? { verify_status: verifyStatus } : {}),
    ...(scannerKey ? { scanner_key: scannerKey } : {}),
    ...(inChain ? { in_chain: 'true' } : {}),
    ...(ruleId ? { rule_id: ruleId } : {}),
    // Sent only off the default, so the default list keeps the query key (and
    // the cache entry) every other screen of this list already shares.
    ...(shadowMode !== 'exclude' ? { experimental: shadowMode } : {}),
  } as const;

  /**
   * Keyset paging (W17-22). The API has returned `next_cursor` since W6-04 and
   * the explorer showed the first fifty and no way to the fifty-first. The
   * cursors walked so far are a stack: Next pushes the page's `next_cursor`,
   * Previous pops. Held against the filters that produced them — a filter
   * change is a new list, and a cursor into the old one would be a 400.
   *
   * Deliberately NOT in the URL: a cursor is opaque and encodes a position in
   * a list that reorders as findings are triaged. The finding is what a link
   * carries; the by-id fetch below covers a selection the page no longer holds.
   */
  const filterKey = JSON.stringify(filterQuery);
  const [paging, setPaging] = useState<{ key: string; cursors: string[] }>({
    key: filterKey,
    cursors: [],
  });
  const cursors = paging.key === filterKey ? paging.cursors : [];
  const cursor = cursors[cursors.length - 1];

  const listDescriptor = {
    endpoint: '/findings',
    query: { ...filterQuery, ...(cursor ? { cursor } : {}) },
  } as const;

  const { data, isLoading, isError, error, refetch } = useApiQuery<FindingPage>(listDescriptor);
  const { data: stats } = useApiQuery<FindingStats>({ endpoint: '/findings/stats' });
  // The scanner facet is driven by the REGISTRY, not a hard-coded list: a
  // scanner added in a later wave becomes filterable without touching this
  // screen (SECURITY_SUITE §5).
  const { data: scanners } = useApiQuery<{ items: { key: string; display_name: string }[] }>({
    endpoint: '/scanners',
  });
  // W18-29: rules come from what findings carry, so a fast-lane rule with no
  // registry row is filterable the day it raises its first finding.
  const { data: facets } = useApiQuery<FindingFacets>({ endpoint: '/findings/facets' });
  const scannerName = (key: string) =>
    scanners?.items.find((s) => s.key === key)?.display_name ??
    (key === 'other' ? 'Model review' : key);
  const shadowHidden = data?.shadow_hidden ?? 0;

  /**
   * What the last bulk action did, kept after the selection clears (W17-23).
   * The API applies what it can and reports the rest per id, and a bar that
   * simply emptied read as "all forty done" when three were already resolved.
   */
  const [bulkResult, setBulkResult] = useState<BulkResult | null>(null);
  const bulk = useApiMutation<{ ids: number[]; status: string; note: string }, BulkResult>(
    { endpoint: '/findings/bulk', method: 'POST' },
    {
      invalidate: [
        queryKeyFor(listDescriptor),
        queryKeyFor(LIST),
        queryKeyFor({ endpoint: '/findings/stats' }),
      ],
    },
  );

  const items = data?.items ?? [];

  /**
   * The open finding, fetched by id when the LIST does not hold it (W16-32).
   *
   * The filters are component state, so a link resolves against the
   * RECIPIENT'S view — a link to a dismissed finding, opened by someone whose
   * Status is the default "open", found nothing. Enabled only in that case, so
   * an ordinary click costs no extra request: the row is already in hand.
   * Since W17-22 the same fetch covers a selection on a page other than the
   * one showing.
   */
  const inList = openId !== null ? items.find((f) => f.id === openId) : undefined;
  const fetched = useApiQuery<Finding>(
    { endpoint: '/findings/{id}', path: { id: String(openId ?? '') } },
    { enabled: openId !== null && !inList && !isLoading },
  );
  // NEVER THE PREVIOUS ONE (W17-22, acceptance 4). useApiQuery keeps the last
  // answer on screen while the next loads, which is right for a chart under a
  // changing window and wrong here: #99's evidence under a URL that says #100
  // is the previous selection shown for an id this workspace may not be
  // allowed to see. Placeholder data is a loading state, not a finding.
  const fetchedNow = fetched.isPlaceholderData ? undefined : fetched.data;
  const openFinding = inList ?? (openId !== null ? fetchedNow : undefined);
  const fetchStatus = statusOf(fetched.error);
  const fetchPending =
    openId !== null &&
    openFinding === undefined &&
    !fetched.isError &&
    (isLoading || fetched.isPending || fetched.isPlaceholderData);

  /** A row is one wide click target; only the checkbox is exempt (W17-22). */
  const onRowClick = (f: Finding) => (e: MouseEvent<HTMLTableRowElement>) => {
    if ((e.target as HTMLElement).closest('input, a')) return;
    openFromRow(f.id);
  };
  const onRowKey = (f: Finding) => (e: KeyboardEvent<HTMLTableRowElement>) => {
    if (e.target !== e.currentTarget) return;
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    openFromRow(f.id);
  };

  const detail =
    openId === null ? null : openFinding ? (
      <FindingDetail
        finding={openFinding}
        onClose={close}
        invalidate={[queryKeyFor(listDescriptor), queryKeyFor({ endpoint: '/findings/stats' })]}
      />
    ) : fetchPending ? (
      <div className="text-sm text-fg-muted" data-testid="finding-loading">
        Opening finding #{openId}…
      </div>
    ) : fetchStatus === 403 ? (
      // Distinct from not-found: the finding exists and this account may not
      // read it. Nothing of it is shown, and retrying will not change that.
      <div className="panel p-3 text-sm text-fg-muted" data-testid="finding-forbidden">
        You are not permitted to view finding #{openId}. Ask a workspace admin if you think you
        should be.
      </div>
    ) : fetched.isError && fetchStatus !== 404 ? (
      <div className="panel p-3 text-sm text-fg-muted" data-testid="finding-load-failed">
        Finding #{openId} could not be loaded ({fetched.error.message}).{' '}
        <button
          type="button"
          className="text-accent underline underline-offset-2"
          onClick={() => void fetched.refetch()}
        >
          Retry
        </button>
      </div>
    ) : (
      // NOT SILENCE (W16-16), and now only for a finding that genuinely is
      // not there (W16-32). The by-id fetch covers the filters case, so
      // reaching here means the id does not exist in this workspace —
      // deleted, mistyped, or somebody else's (which the API answers with the
      // same 404, so a link cannot probe for ids).
      <div className="panel p-3 text-sm text-fg-muted" data-testid="finding-not-in-view">
        Finding #{openId} is not in this workspace. It may have been deleted, or the link may be for
        a different RepoPulse install.
      </div>
    );

  return (
    <div className="flex flex-col gap-4" data-testid="findings">
      {/* W18-28: titled after the rail entry ("Reviews") that leads here, with
          the triage action beside the title instead of floating alone. */}
      <PageHeader
        title="Reviews"
        description="Findings from every scanner and model review, across repositories."
        actions={
          <>
            <Link
              to="/sensitive-changes"
              search={(prev: Record<string, unknown>) => ({ repos: prev.repos }) as never}
              className="rounded-md border border-border px-3 py-1.5 text-sm hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              data-testid="link-sensitive-changes"
            >
              Sensitive changes
            </Link>
            <button
              type="button"
              className="rounded-md border border-accent bg-accent/10 px-3 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              data-testid="start-triage"
              disabled={items.length === 0}
              onClick={() => setTriage(true)}
            >
              Triage queue ({items.length})
            </button>
          </>
        }
      />

      <div className="flex flex-wrap items-end gap-3" data-testid="finding-filters">
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Dimension
          <select
            className="panel px-2 py-1 text-sm"
            data-testid="filter-dimension"
            value={dimension}
            onChange={(e) => setDimension(e.target.value)}
          >
            <option value="">Any</option>
            {DIMENSIONS.map((d) => (
              <option key={d} value={d}>
                {/* Marked in the option itself, so the cost of choosing it is
                    visible BEFORE the click rather than as an empty table
                    afterwards (W9-14). */}
                {d.replace('_', ' ')}
                {awaitingProducer(d) ? ' — not yet produced' : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Status
          <select
            className="panel px-2 py-1 text-sm"
            data-testid="filter-status"
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          >
            <option value="">Any</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s.replace('_', ' ')}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Min severity
          <select
            className="panel px-2 py-1 text-sm"
            data-testid="filter-severity"
            value={severityMin}
            onChange={(e) => setSeverityMin(e.target.value)}
          >
            <option value="">Any</option>
            {[5, 4, 3, 2].map((s) => (
              <option key={s} value={s}>
                {SEVERITY_LABEL[s]} and above
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Scanner
          <select
            className="panel px-2 py-1 text-sm"
            data-testid="filter-scanner"
            value={scannerKey}
            onChange={(e) => setScannerKey(e.target.value)}
          >
            <option value="">Any source</option>
            {(scanners?.items ?? []).map((s) => (
              <option key={s.key} value={s.key}>
                {s.display_name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs text-fg-muted">
          <input
            type="checkbox"
            data-testid="filter-in-chain"
            checked={inChain}
            onChange={(e) => setInChain(e.target.checked)}
          />
          In an attack chain
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Rule
          <select
            className="panel max-w-[18rem] px-2 py-1 text-sm"
            data-testid="filter-rule"
            value={ruleId}
            onChange={(e) => setRuleId(e.target.value)}
          >
            <option value="">Any rule</option>
            {groupRules(facets?.rules ?? []).map(([scanner, rules]) => (
              <optgroup key={scanner} label={scannerName(scanner)}>
                {rules.map((r) => (
                  <option key={r.rule_id} value={r.rule_id}>
                    {r.rule_id} ({ruleCounts(r)})
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Rule stage
          <select
            className="panel px-2 py-1 text-sm"
            data-testid="filter-shadow"
            value={shadowMode}
            onChange={(e) => setShadowMode(e.target.value as ShadowMode)}
          >
            {SHADOW_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
                {o.value === 'only' && facets ? ` (${facets.shadow_total})` : ''}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Verification
          <select
            className="panel px-2 py-1 text-sm"
            data-testid="filter-verify"
            value={verifyStatus}
            onChange={(e) => setVerifyStatus(e.target.value)}
          >
            <option value="">Any</option>
            <option value="confirmed">Verified by a second model</option>
            <option value="unverified">Not independently verified</option>
            <option value="contradicted">Contradicted on review</option>
          </select>
        </label>
      </div>

      {/* ACROSS THE WORKSPACE, and it now says so (W16-50). The moment the
          repository filter started working, this card read "3 findings total"
          beside a list saying "No findings match these filters" — two numbers
          about apparently the same thing, disagreeing. It is not filtered and
          should not be: a false-positive RATE is a measure of the analysis, and
          computing it over the three findings in one repository would be noise
          reported as a quality signal. */}
      <WidgetFrame title="Analysis quality (whole workspace)" state="ready">
        <div className="flex flex-wrap gap-6 text-sm" data-testid="fp-widget">
          <div>
            <p className="text-[28px] leading-none tabular-nums">
              {/* null, not 0: nothing reviewed yet must not read as a flawless
                  model (FR-INSIGHTS-1). */}
              {stats?.false_positive_rate === null || stats?.false_positive_rate === undefined
                ? '—'
                : `${Math.round(stats.false_positive_rate * 100)}%`}
            </p>
            <p className="text-xs text-fg-muted">
              {stats?.false_positive_rate === null
                ? 'no findings triaged yet'
                : 'dismissed as false positive'}
            </p>
          </div>
          <div>
            <p className="text-[28px] leading-none tabular-nums">{stats?.total ?? 0}</p>
            <p className="text-xs text-fg-muted">findings total, all repositories</p>
          </div>
        </div>
      </WidgetFrame>

      {selected.length > 0 && (
        <WidgetFrame title={`${selected.length} selected`} state="ready">
          <div className="flex flex-wrap items-end gap-2" data-testid="bulk-bar">
            <label className="flex flex-col gap-1 text-xs text-fg-muted">
              Note (required)
              <input
                className="w-72 panel px-2 py-1 text-sm"
                data-testid="bulk-note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </label>
            {(['confirmed', 'dismissed'] as const).map((target) => {
              // Only the button that was pressed waits (W17-23); the other
              // stays live rather than the whole bar greying out.
              const pending = bulk.isPending && bulk.variables?.status === target;
              return (
                <button
                  key={target}
                  type="button"
                  className="rounded-md border border-border px-2 py-1 text-xs hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                  data-testid={`bulk-${target}`}
                  disabled={pending || note.trim() === ''}
                  aria-busy={pending || undefined}
                  onClick={() =>
                    bulk.mutate(
                      { ids: selected, status: target, note },
                      {
                        onSuccess: (result) => {
                          setSelected([]);
                          setNote('');
                          setBulkResult(result);
                        },
                      },
                    )
                  }
                >
                  {pending ? `Marking ${target}…` : `Mark ${target}`}
                </button>
              );
            })}
          </div>
          <ErrorNote error={bulk.error} testId="bulk-error" className="mt-2" />
        </WidgetFrame>
      )}

      {bulkResult && (
        <p className="text-xs text-fg-muted" data-testid="bulk-result" role="status">
          Applied to {bulkResult.applied.length}
          {bulkResult.skipped.length > 0
            ? `, skipped ${bulkResult.skipped.length} (${bulkResult.skipped
                .map((s) => `#${s.id}: ${s.reason}`)
                .join('; ')})`
            : ''}
          .
        </p>
      )}

      {/* NEVER HIDDEN SILENTLY (W18-29). The default leaves shadow findings out,
          and says so whenever that changed what the list shows. */}
      {shadowMode === 'exclude' && shadowHidden > 0 && (
        <p
          className="flex flex-wrap items-center gap-2 text-xs text-fg-muted"
          data-testid="shadow-hidden-note"
          role="status"
        >
          <ShadowBadge />
          <span>
            {shadowHidden} {shadowHidden === 1 ? 'finding' : 'findings'} from rules still in shadow{' '}
            {shadowHidden === 1 ? 'matches' : 'match'} these filters and{' '}
            {shadowHidden === 1 ? 'is' : 'are'} not listed.
          </span>
          <button
            type="button"
            className="min-h-6 text-fg underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            data-testid="shadow-show"
            onClick={() => setShadowMode('include')}
          >
            Show them, marked
          </button>
        </p>
      )}

      <WidgetFrame
        title={shadowMode === 'only' ? 'Shadow findings' : 'Findings'}
        state={frameState({
          isLoading,
          isError,
          isEmpty: data !== undefined && items.length === 0,
        })}
        {...(error ? { errorMessage: error.message, error } : {})}
        onRetry={() => void refetch()}
        // A dimension nothing writes yet is not a clean repository, and the
        // generic line ("findings appear once an analysis run completes") reads
        // as though one more run would fix it. Name the actual reason instead.
        emptyMessage={
          awaitingProducer(dimension)
            ? `Nothing writes ${dimension.replace('_', ' ')} findings yet, so this filter cannot return anything. ${DIMENSIONS_AWAITING_PRODUCER[dimension]}`
            : shadowMode === 'only'
              ? 'No shadow findings match these filters. Shadow findings come from rules still being measured; an admin promotes or retires them under Settings → Rules.'
              : shadowHidden > 0
                ? 'No findings from active rules match these filters. The ones that do match come from rules still in shadow (see above).'
                : 'No findings match these filters. Findings appear once an analysis run completes for a repository.'
        }
      >
        {/* W17-31: the table scrolls inside its own wrapper. Six columns of
            min-content pushed <main> 272px past a 390px viewport (and 134px
            past 768), so the whole Reviews screen scrolled sideways — visible
            in the RP-01 baseline shot as a file column cut off mid-word. */}
        <div className="overflow-x-auto">
          <table className="table-plain w-full min-w-[48rem] text-sm">
            <caption className="sr-only">Findings across every analysed repository</caption>
            <thead>
              <tr className="text-left text-xs text-fg-muted">
                <th scope="col">
                  <span className="sr-only">Select</span>
                </th>
                <th scope="col">Severity</th>
                <th scope="col">Finding</th>
                <th scope="col">Repository</th>
                <th scope="col">File</th>
                <th scope="col">Status</th>
                <th scope="col">Verification</th>
              </tr>
            </thead>
            <tbody data-testid="finding-rows">
              {items.map((f) => (
                // THE WHOLE ROW OPENS IT (W17-22). The baseline capture clicked a
                // row at 1440px and the URL did not change: the only control was
                // the title text, and on a wide table most of a row is not the
                // title. The button stays as the accessible control; the row is
                // the pointer target around it. `aria-current` marks the open one
                // so the list says which row the panel belongs to.
                <tr
                  key={f.id}
                  className={`cursor-pointer border-t border-border ${f.id === openId ? 'bg-accent/5' : ''}`}
                  data-testid={`finding-${f.id}`}
                  aria-current={f.id === openId ? 'true' : undefined}
                  onClick={onRowClick(f)}
                  onKeyDown={onRowKey(f)}
                >
                  <td className="py-1">
                    <input
                      type="checkbox"
                      aria-label={`Select finding ${f.id}`}
                      data-testid={`finding-select-${f.id}`}
                      checked={selected.includes(f.id)}
                      onChange={(e) =>
                        setSelected((s) =>
                          e.target.checked ? [...s, f.id] : s.filter((i) => i !== f.id),
                        )
                      }
                    />
                  </td>
                  {/* Paired mark + word — never colour alone (UX_SPEC §7). */}
                  <td className="py-1 whitespace-nowrap">
                    <FindingSeverityBadge severity={f.severity} />
                  </td>
                  <th scope="row" className="py-1 text-left font-normal">
                    <button
                      type="button"
                      className="text-accent hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                      data-testid={`finding-open-${f.id}`}
                      aria-expanded={f.id === openId}
                      onClick={(e) => {
                        // The row handler would open it too; one navigation.
                        e.stopPropagation();
                        openFromRow(f.id);
                      }}
                    >
                      {f.title}
                    </button>
                    {/* Marked in the row, whatever the facet: a mixed list must
                        never leave the reader to guess which rows are proven. */}
                    {f.experimental ? <ShadowBadge className="ml-2" /> : null}
                  </th>
                  <td className="py-1 text-xs">{f.repo.name}</td>
                  <td className="py-1 font-mono text-xs" data-testid={`finding-file-${f.id}`}>
                    {locationOf(f)}
                  </td>
                  <td className="py-1 text-xs">{f.status.replace('_', ' ')}</td>
                  <td
                    className="py-1 text-xs whitespace-nowrap"
                    data-testid={`finding-verify-${f.id}`}
                  >
                    {VERIFY_LABEL[f.verify_status]}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {(cursors.length > 0 || data?.next_cursor) && (
          <div className="mt-2 flex items-center gap-2 text-xs" data-testid="findings-paging">
            <button
              type="button"
              className="rounded-md border border-border px-2 py-1 hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              data-testid="findings-prev-page"
              disabled={cursors.length === 0}
              onClick={() => setPaging({ key: filterKey, cursors: cursors.slice(0, -1) })}
            >
              Previous page
            </button>
            <span className="text-fg-muted">Page {cursors.length + 1}</span>
            <button
              type="button"
              className="rounded-md border border-border px-2 py-1 hover:border-accent disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              data-testid="findings-next-page"
              disabled={!data?.next_cursor}
              onClick={() => {
                if (data?.next_cursor) {
                  setPaging({ key: filterKey, cursors: [...cursors, data.next_cursor] });
                }
              }}
            >
              Next page
            </button>
          </div>
        )}
      </WidgetFrame>

      {triage && (
        <TriageQueue
          findings={items}
          onExit={() => setTriage(false)}
          invalidate={[queryKeyFor(listDescriptor), queryKeyFor({ endpoint: '/findings/stats' })]}
        />
      )}

      {detail !== null &&
        (overlay ? (
          <div
            ref={detailRef}
            className="fixed inset-0 z-40 overflow-auto bg-bg/95 p-4 backdrop-blur"
            role="dialog"
            aria-modal="true"
            aria-label={openFinding?.title ?? `Finding #${openId}`}
            tabIndex={-1}
            data-testid="finding-overlay"
            onKeyDown={(e) => {
              // Reaches here only from the loading / not-found / forbidden
              // states — the panel itself handles (and stops) its own Escape.
              if (e.key === 'Escape') close();
            }}
          >
            <div className="mb-2 flex justify-end">
              <button
                type="button"
                className="text-xs text-fg-muted underline underline-offset-2"
                data-testid="finding-overlay-close"
                onClick={close}
              >
                Back to the list
              </button>
            </div>
            {detail}
          </div>
        ) : (
          <div ref={detailRef}>{detail}</div>
        ))}
    </div>
  );
}
