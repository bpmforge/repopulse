import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { Link, createFileRoute, useNavigate } from '@tanstack/react-router';
import { WidgetFrame, frameState, PageHeader } from '../../components/index.js';
import { useApiQuery, queryKeyFor } from '../../api/useApiQuery.js';
import { apiFetch, buildUrl } from '../../api/client.js';
import { ErrorNote } from '../../components/primitives/ErrorNote.js';
import { FindingDetail } from '../../widgets/findings/FindingDetail.js';
import { TriageQueue } from '../../widgets/findings/TriageQueue.js';
import { BulkActions } from '../../widgets/findings/BulkActions.js';
import { useOverlayLayout } from '../../widgets/findings/layout.js';
import { trapTab } from '../../widgets/findings/focusTrap.js';
import {
  ALL_DIMENSIONS as DIMENSIONS,
  DIMENSIONS_AWAITING_PRODUCER,
  awaitingProducer,
  DEFAULT_STATUS_FILTER,
  FINDINGS_PAGE_SIZE,
  RISK_BAND_LABEL,
  SEVERITY_LABEL,
  STATUS_FILTERS,
  ageOf,
  dimensionLabel,
  locationOf,
  statusLabel,
  VERIFY_LABEL,
  type Finding,
  type FindingFacets,
  type FindingPage,
  type FindingStats,
  type RuleFacet,
  type ShadowMode,
} from '../../widgets/findings/contracts.js';
import { FindingSeverityBadge } from '../../widgets/findings/FindingSeverity.js';
import { SaveAsViewButton } from '../../views/SaveAsViewButton.js';
import type { ViewConfig } from '../../views/contracts.js';
import { ShadowBadge } from '../../widgets/findings/ShadowBadge.js';
import { ExportFindings } from '../../widgets/findings/ExportFindings.js';
import { TicketLink } from '../../widgets/findings/ExternalTicket.js';

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
export function validateFindingsSearch(search: Record<string, unknown>): FindingsSearch {
  const raw = search.finding;
  const id = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : Number.NaN;
  return {
    ...(Number.isInteger(id) && id > 0 ? { finding: id } : {}),
    ...validateFilterSearch(search),
  };
}

/**
 * The explorer's filters, in the URL (W20-03, UX_TODO FND-03 / FND-04).
 *
 * They lived in component state, so a reload, Back, or a shared link lost
 * them — and because validateSearch REPLACES the search object, a drill-down
 * sending `?dimension=secrets` (the Security tab's "Open in Findings") had it
 * stripped and landed on the unfiltered, workspace-wide list. Names match the
 * API's own query parameters so a link reads the same at both ends.
 *
 * Status defaults to "still to fix" (open + confirmed, W20-08 FND-49) and is
 * left out of the URL when it is; `any` is the explicit "every status".
 * Lenient, like `finding`: a junk value is dropped rather than white-screening
 * the screen.
 */
export interface FindingsSearch {
  finding?: number;
  dimension?: string;
  status?: string;
  severity_min?: number;
  verify_status?: string;
  scanner_key?: string;
  in_chain?: boolean;
  rule_id?: string;
  experimental?: 'include' | 'only';
  sort?: 'severity';
  /** W20-13 (FND-20): free text over title, file, CVE id and rule id. */
  q?: string;
  /** W20-13 (FND-64): known exploited only. */
  kev?: boolean;
  /** W20-13 (FND-64): act | schedule | track. */
  risk_band?: string;
  /** W20-13 (FND-64): one CVE, exactly (links from the Security tab). */
  cve_id?: string;
  /** W20-13 (FND-19): the API's confidence floor, 2–5. */
  confidence_min?: number;
  /** W20-13 (FND-46): one attack chain's findings. */
  chain_id?: string;
  /** W20-21 (FND-22): an explicit list of ids ("Show these" after a bulk action). */
  ids?: string;
  /** W20-21 (FND-68): the findings one scan run raised, or closed. */
  scan_run_id?: string;
  closed_by_scan_run?: string;
  /** W20-21 (AI-32): the findings one AI pass raised, or any model's. */
  ai_pass_run_id?: string;
  found_by?: 'model';
  /** W20-21 (FND-55): from the Overview tile — every security dimension, one severity. */
  dimension_group?: 'security';
  severity?: number;
}

const FILTER_STATUSES = STATUS_FILTERS.map((s) => s.value);
const VERIFY_STATUSES = ['confirmed', 'unverified', 'contradicted'];

function validateFilterSearch(search: Record<string, unknown>): Omit<FindingsSearch, 'finding'> {
  const str = (v: unknown) => (typeof v === 'string' && v.length > 0 && v.length <= 200 ? v : '');
  const out: Omit<FindingsSearch, 'finding'> = {};
  const dimension = str(search.dimension);
  if ((DIMENSIONS as readonly string[]).includes(dimension)) out.dimension = dimension;
  const status = str(search.status);
  if (status === 'any' || (FILTER_STATUSES.includes(status) && status !== DEFAULT_STATUS_FILTER)) {
    out.status = status;
  }
  const sev = Number(search.severity_min);
  if (Number.isInteger(sev) && sev >= 2 && sev <= 5) out.severity_min = sev;
  const verify = str(search.verify_status);
  if (VERIFY_STATUSES.includes(verify)) out.verify_status = verify;
  const scanner = str(search.scanner_key);
  if (scanner) out.scanner_key = scanner;
  if (search.in_chain === true || search.in_chain === 'true') out.in_chain = true;
  const rule = str(search.rule_id);
  if (rule) out.rule_id = rule;
  if (search.experimental === 'include' || search.experimental === 'only') {
    out.experimental = search.experimental;
  }
  if (search.sort === 'severity') out.sort = 'severity';
  const q = str(search.q);
  if (q) out.q = q;
  if (search.kev === true || search.kev === 'true') out.kev = true;
  const band = str(search.risk_band);
  if (band in RISK_BAND_LABEL) out.risk_band = band;
  const cve = str(search.cve_id);
  if (cve) out.cve_id = cve;
  const conf = Number(search.confidence_min);
  if (Number.isInteger(conf) && conf >= 2 && conf <= 5) out.confidence_min = conf;
  const chain = str(search.chain_id);
  if (chain) out.chain_id = chain;
  // Id lists: digits and commas only, so a link cannot smuggle anything else.
  const idList = (v: unknown) => {
    const raw = typeof v === 'number' ? String(v) : str(v);
    return /^\d+(,\d+)*$/.test(raw) ? raw : '';
  };
  const ids =
    typeof search.ids === 'string' && /^\d+(,\d+)*$/.test(search.ids) && search.ids.length <= 2000
      ? search.ids
      : '';
  if (ids) out.ids = ids;
  const scanRun = idList(search.scan_run_id);
  if (scanRun) out.scan_run_id = scanRun;
  const closedBy = idList(search.closed_by_scan_run);
  if (closedBy) out.closed_by_scan_run = closedBy;
  const pass = idList(search.ai_pass_run_id);
  if (pass) out.ai_pass_run_id = pass;
  if (search.found_by === 'model') out.found_by = 'model';
  if (search.dimension_group === 'security') out.dimension_group = 'security';
  const exact = Number(search.severity);
  if (Number.isInteger(exact) && exact >= 1 && exact <= 5) out.severity = exact;
  return out;
}

/**
 * The explorer's filters as a saved view (W20-16, UX_TODO FND-03).
 *
 * Every filter has been in the URL since W20-03; what was missing was a way
 * to KEEP a set of them. A view of target `findings` stores exactly what
 * validateFilterSearch accepts (plus the topbar's repository filter), so
 * opening it later lands on the same list. The open finding is left out: a
 * view is a list, not one row.
 */
export function findingsViewConfig(search: Record<string, unknown>): ViewConfig {
  const filters: Record<string, string | number | boolean> = { ...validateFilterSearch(search) };
  const repos = typeof search.repos === 'string' && search.repos !== 'all' ? search.repos : '';
  if (repos) filters.repos = repos;
  const repoIds = repos
    .split(',')
    .map(Number)
    .filter((n) => Number.isInteger(n) && n > 0);
  return { repo_ids: repoIds, window: '30d', layout: [], target: 'findings', search: filters };
}

export const Route = createFileRoute('/findings/')({
  validateSearch: validateFindingsSearch,
  component: FindingsExplorer,
});

const LIST = { endpoint: '/findings' } as const;

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

/** The HTTP status behind a failed by-id fetch, if the error carries one. */
function statusOf(error: unknown): number | undefined {
  return (error as { status?: number } | null | undefined)?.status;
}

function FindingsExplorer() {
  // THE URL IS THE STATE, not a mirror of it (W16-16). Reading it back rather
  // than keeping a copy in useState is what makes the back button and a pasted
  // link behave the same as a click. Since W20-03 that is true of the filters
  // too (UX_TODO FND-03).
  const navigate = useNavigate({ from: Route.fullPath });
  const search = Route.useSearch();
  const openId = search.finding ?? null;
  const dimension = search.dimension ?? '';
  // W20-08 (UX_TODO FND-49): "still to fix" by default, the definition the
  // Security tab and Sensitive changes count by. `open` alone dropped a
  // finding from this list the moment someone confirmed it.
  const status = search.status === 'any' ? '' : (search.status ?? DEFAULT_STATUS_FILTER);
  const severityMin = search.severity_min ? String(search.severity_min) : '';
  const verifyStatus = search.verify_status ?? '';
  // W8-10 scanner facets. A secrets finding was storable and countable before
  // this and not FILTERABLE — the API dropped an unknown dimension silently,
  // so asking for the thing you wanted showed you everything instead.
  const scannerKey = search.scanner_key ?? '';
  const inChain = search.in_chain === true;
  // W18-29: the shadow facet and the rule facet.
  const shadowMode: ShadowMode = search.experimental ?? 'exclude';
  const ruleId = search.rule_id ?? '';
  const sort = search.sort;
  const text = search.q ?? '';
  const kev = search.kev === true;
  const riskBand = search.risk_band ?? '';
  const cveId = search.cve_id ?? '';
  const confidenceMin = search.confidence_min ? String(search.confidence_min) : '';
  const chainId = search.chain_id ?? '';
  const idsFilter = search.ids ?? '';
  const scanRunFilter = search.scan_run_id ?? '';
  const closedByFilter = search.closed_by_scan_run ?? '';
  const passFilter = search.ai_pass_run_id ?? '';
  const foundByModel = search.found_by === 'model';
  const securityGroup = search.dimension_group === 'security';
  const severityExact = search.severity ? String(search.severity) : '';
  // The search box's draft: the URL changes on Enter or Search, not per key.
  const [draft, setDraft] = useState(text);
  useEffect(() => setDraft(text), [text]);
  /**
   * Change filters by writing the URL. Pushed, so Back undoes a filter change;
   * the other search params (window, repos, the open finding) ride along. An
   * empty value removes the param, and defaults are never written.
   */
  const setFilters = (patch: Partial<Record<keyof FindingsSearch, string | boolean>>) => {
    const next: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      next[key] = value === '' || value === false ? undefined : value;
    }
    if ('status' in patch) {
      next.status =
        patch.status === ''
          ? 'any'
          : patch.status === DEFAULT_STATUS_FILTER
            ? undefined
            : patch.status;
    }
    if (patch.experimental === 'exclude') next.experimental = undefined;
    void navigate({
      search: (prev: Record<string, unknown>) => ({ ...prev, ...next }) as never,
    });
  };
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
  const [triage, setTriage] = useState(false);

  // The global repository filter, at last read by a screen (W16-50). The API
  // has supported repo_id since W6-04; the topbar has serialized `?repos=`
  // since W4-02; nothing joined them.
  const repos = search.repos;

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
    ...(sort ? { sort } : {}),
    ...(text ? { q: text } : {}),
    ...(kev ? { kev: 'true' } : {}),
    ...(riskBand ? { risk_band: riskBand } : {}),
    ...(cveId ? { cve_id: cveId } : {}),
    ...(confidenceMin ? { confidence_min: confidenceMin } : {}),
    ...(chainId ? { chain_id: chainId } : {}),
    ...(idsFilter ? { ids: idsFilter } : {}),
    ...(scanRunFilter ? { scan_run_id: scanRunFilter } : {}),
    ...(closedByFilter ? { closed_by_scan_run: closedByFilter } : {}),
    ...(passFilter ? { ai_pass_run_id: passFilter } : {}),
    ...(foundByModel ? { found_by: 'model' } : {}),
    ...(securityGroup ? { dimension_group: 'security' } : {}),
    ...(severityExact ? { severity: severityExact } : {}),
  } as const;

  const [filtersOpen, setFiltersOpen] = useState(false);
  const activeFilterCount = Object.keys(filterQuery).filter(
    (k) => k !== 'repo_id' && k !== 'sort',
  ).length;

  // Filters that only arrive by link are said, and can be removed.
  const count = (list: string) => list.split(',').length;
  const linkFilters: { key: keyof FindingsSearch; label: ReactNode; testId: string }[] = [
    ...(cveId
      ? [
          {
            key: 'cve_id' as const,
            testId: 'clear-cve',
            label: (
              <>
                CVE <span className="font-mono">{cveId}</span>
              </>
            ),
          },
        ]
      : []),
    ...(chainId
      ? [{ key: 'chain_id' as const, testId: 'clear-chain', label: 'One attack chain' }]
      : []),
    ...(idsFilter
      ? [
          {
            key: 'ids' as const,
            testId: 'clear-ids',
            label: `${count(idsFilter)} chosen finding${count(idsFilter) === 1 ? '' : 's'}`,
          },
        ]
      : []),
    ...(scanRunFilter
      ? [
          {
            key: 'scan_run_id' as const,
            testId: 'clear-scan-run',
            label: `Raised by scan run ${scanRunFilter.replace(/,/g, ', ')}`,
          },
        ]
      : []),
    ...(closedByFilter
      ? [
          {
            key: 'closed_by_scan_run' as const,
            testId: 'clear-closed-by',
            label: `Closed by scan run ${closedByFilter.replace(/,/g, ', ')}`,
          },
        ]
      : []),
    ...(passFilter
      ? [
          {
            key: 'ai_pass_run_id' as const,
            testId: 'clear-ai-pass',
            label: `Raised by AI pass ${passFilter}`,
          },
        ]
      : []),
    ...(foundByModel
      ? [{ key: 'found_by' as const, testId: 'clear-found-by', label: 'Raised by a model' }]
      : []),
    ...(securityGroup
      ? [
          {
            key: 'dimension_group' as const,
            testId: 'clear-security-group',
            label: 'Security findings (every security scanner)',
          },
        ]
      : []),
    ...(severityExact
      ? [
          {
            key: 'severity' as const,
            testId: 'clear-severity',
            label: `Severity: ${SEVERITY_LABEL[Number(severityExact)] ?? severityExact} only`,
          },
        ]
      : []),
  ];

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

  const { data, isLoading, isError, error, refetch, isPlaceholderData } =
    useApiQuery<FindingPage>(listDescriptor);
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

  const items = data?.items ?? [];

  /**
   * The selection, held against the list it was made in (W20-03, UX_TODO
   * FND-12). It survived paging and filter changes, so "12 selected" could
   * count rows no longer on screen and a bulk Dismiss silently acted on them.
   * A different page or a different filter is a different list, and starts
   * with nothing selected.
   */
  const selectionKey = `${filterKey}|${cursor ?? ''}`;
  const [selection, setSelection] = useState<{ key: string; ids: number[] }>({
    key: selectionKey,
    ids: [],
  });
  const selected = selection.key === selectionKey ? selection.ids : [];
  const setSelected = (update: (ids: number[]) => number[]) =>
    setSelection({ key: selectionKey, ids: update(selected) });
  const selectedFindings = items.filter((f) => selected.includes(f.id));
  const allOnPage = items.length > 0 && items.every((f) => selected.includes(f.id));
  const someOnPage = !allOnPage && items.some((f) => selected.includes(f.id));

  /**
   * "Select all N matching" (W20-08, UX_TODO FND-12). Offered once the whole
   * page is selected and more match than the page holds. The ids come from
   * GET /findings/ids under the same filters as `total`, so the bar acts on
   * exactly the findings it names. Held against the filters like the page
   * selection; unticking any row on the page drops back to the page.
   */
  const [matching, setMatching] = useState<{
    key: string;
    ids: number[];
    truncated: boolean;
  } | null>(null);
  const [matchingState, setMatchingState] = useState<{ pending: boolean; error: unknown }>({
    pending: false,
    error: null,
  });
  const allMatching = matching && matching.key === filterKey && allOnPage ? matching : null;
  const total = data?.total ?? 0;
  const selectAllMatching = async () => {
    setMatchingState({ pending: true, error: null });
    try {
      const found = await apiFetch<{ ids: number[]; truncated: boolean }>(
        buildUrl('/findings/ids', { query: filterQuery }),
      );
      setMatching({ key: filterKey, ids: found.ids, truncated: found.truncated });
      setMatchingState({ pending: false, error: null });
    } catch (error) {
      setMatchingState({ pending: false, error });
    }
  };

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
        // Remounted per finding (W20-03): a note typed for one finding must
        // not carry over to the next one opened.
        key={openFinding.id}
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
      {/* W18-28: titled after the rail entry ("Findings") that leads here, with
          the triage action beside the title instead of floating alone. */}
      <PageHeader
        title="Findings"
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
            <SaveAsViewButton
              widgets={[]}
              window="30d"
              repos={undefined}
              defaultName="Findings — my filters"
              label="Save filters as view…"
              stay
              config={findingsViewConfig(search as Record<string, unknown>)}
            />
            {/* W20-18 (UX_TODO X-08): the list under its current filters, as a file. */}
            <ExportFindings filters={filterQuery} total={data?.total} />
            {/* W20-03 (UX_TODO FND-10): the queue holds this page, at most
                fifty, and was labelled as though it were the whole queue. */}
            <button
              type="button"
              className="rounded-md border border-accent bg-accent/10 px-3 py-1.5 text-sm focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
              data-testid="start-triage"
              disabled={items.length === 0}
              onClick={() => setTriage(true)}
            >
              {typeof data?.total === 'number'
                ? `Triage this page (${items.length} of ${data.total.toLocaleString()})`
                : `Triage this page (${items.length})`}
            </button>
          </>
        }
      />

      {/* W20-21 (UX_TODO FND-43): on a phone the seven-control bar pushed the
          list off the first screen; below md it folds behind a disclosure
          that says how many filters are on. */}
      <button
        type="button"
        className="self-start rounded-md border border-border px-2 py-1 text-sm md:hidden focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
        aria-expanded={filtersOpen}
        aria-controls="finding-filters"
        data-testid="filters-toggle"
        onClick={() => setFiltersOpen((o) => !o)}
      >
        Filters ({activeFilterCount})
      </button>
      <div
        id="finding-filters"
        className={`${filtersOpen ? 'flex' : 'hidden'} flex-wrap items-end gap-3 md:flex`}
        data-testid="finding-filters"
      >
        {/* W20-13 (UX_TODO FND-20): "find the lodash one" without paging. */}
        <form
          role="search"
          className="flex items-end gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            setFilters({ q: draft.trim() });
          }}
        >
          <label className="flex flex-col gap-1 text-xs text-fg-muted">
            Search
            <input
              type="search"
              className="panel w-56 px-2 py-1 text-sm"
              data-testid="filter-q"
              placeholder="Title, file, CVE or rule"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
            />
          </label>
          <button
            type="submit"
            className="rounded-md border border-border px-2 py-1 text-sm hover:border-accent focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
            data-testid="filter-q-submit"
          >
            Search
          </button>
        </form>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Dimension
          <select
            className="panel px-2 py-1 text-sm"
            data-testid="filter-dimension"
            value={dimension}
            onChange={(e) => setFilters({ dimension: e.target.value })}
          >
            <option value="">Any</option>
            {DIMENSIONS.map((d) => (
              <option key={d} value={d}>
                {/* Marked in the option itself, so the cost of choosing it is
                    visible BEFORE the click rather than as an empty table
                    afterwards (W9-14). */}
                {dimensionLabel(d)}
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
            onChange={(e) => setFilters({ status: e.target.value })}
          >
            <option value="">Any</option>
            {STATUS_FILTERS.map((s) => (
              <option key={s.value} value={s.value}>
                {s.label}
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
            onChange={(e) => setFilters({ severity_min: e.target.value })}
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
            onChange={(e) => setFilters({ scanner_key: e.target.value })}
          >
            <option value="">Any source</option>
            {(scanners?.items ?? []).map((s) => (
              <option key={s.key} value={s.key}>
                {s.display_name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Risk
          <select
            className="panel px-2 py-1 text-sm"
            data-testid="filter-risk-band"
            value={riskBand}
            onChange={(e) => setFilters({ risk_band: e.target.value })}
          >
            <option value="">Any</option>
            {Object.entries(RISK_BAND_LABEL).map(([value, label]) => (
              <option key={value} value={value}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Min confidence
          <select
            className="panel px-2 py-1 text-sm"
            data-testid="filter-confidence"
            value={confidenceMin}
            onChange={(e) => setFilters({ confidence_min: e.target.value })}
          >
            <option value="">Any</option>
            {[5, 4, 3, 2].map((c) => (
              <option key={c} value={c}>
                {c}/5 and above
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Sort
          <select
            className="panel px-2 py-1 text-sm"
            data-testid="filter-sort"
            value={sort ?? ''}
            onChange={(e) => setFilters({ sort: e.target.value })}
          >
            <option value="">Risk (highest first)</option>
            <option value="severity">Severity (highest first)</option>
          </select>
        </label>
        <label className="flex items-center gap-2 text-xs text-fg-muted">
          <input
            type="checkbox"
            data-testid="filter-kev"
            checked={kev}
            onChange={(e) => setFilters({ kev: e.target.checked })}
          />
          Known exploited (KEV)
        </label>
        <label className="flex items-center gap-2 text-xs text-fg-muted">
          <input
            type="checkbox"
            data-testid="filter-in-chain"
            checked={inChain}
            onChange={(e) => setFilters({ in_chain: e.target.checked })}
          />
          In an attack chain
        </label>
        <label className="flex flex-col gap-1 text-xs text-fg-muted">
          Rule
          <select
            className="panel max-w-[18rem] px-2 py-1 text-sm"
            data-testid="filter-rule"
            value={ruleId}
            onChange={(e) => setFilters({ rule_id: e.target.value })}
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
            onChange={(e) => setFilters({ experimental: e.target.value })}
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
            onChange={(e) => setFilters({ verify_status: e.target.value })}
          >
            <option value="">Any</option>
            <option value="confirmed">Verified by a second model</option>
            <option value="unverified">Not independently verified</option>
            <option value="contradicted">Contradicted on review</option>
          </select>
        </label>
      </div>
      {/* Filters that only arrive by link are said, and can be removed. */}
      {linkFilters.length > 0 && (
        <p className="flex flex-wrap items-center gap-2 text-xs" data-testid="link-filters">
          {linkFilters.map((f) => (
            <span key={f.key}>
              {f.label}{' '}
              <button
                type="button"
                className="text-accent underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                data-testid={f.testId}
                onClick={() => setFilters({ [f.key]: '' })}
              >
                remove
              </button>
            </span>
          ))}
        </p>
      )}

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
            <p className="text-xs text-fg-muted" data-testid="fp-basis">
              {stats?.false_positive_rate === null
                ? 'no findings triaged yet'
                : typeof stats?.triaged === 'number'
                  ? // W20-13 (FND-71): of what a person judged, not of everything.
                    `dismissed as false positive, of ${stats.triaged.toLocaleString()} triaged`
                  : 'dismissed as false positive'}
            </p>
          </div>
          <div>
            <p className="text-[28px] leading-none tabular-nums">{stats?.total ?? 0}</p>
            <p className="text-xs text-fg-muted">findings total, all repositories</p>
          </div>
        </div>
      </WidgetFrame>

      {allOnPage && total > items.length && (
        <div
          className="flex flex-wrap items-center gap-2 text-xs"
          data-testid="select-all-matching"
        >
          {allMatching ? (
            <>
              <span>
                All {allMatching.ids.length.toLocaleString()} findings matching these filters are
                selected
                {allMatching.truncated
                  ? ` (the most one action takes; ${total.toLocaleString()} match)`
                  : ''}
                .
              </span>
              <button
                type="button"
                className="text-accent underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                data-testid="select-page-only"
                onClick={() => setMatching(null)}
              >
                Select only this page
              </button>
            </>
          ) : (
            <>
              <span>All {items.length} findings on this page are selected.</span>
              <button
                type="button"
                className="text-accent underline underline-offset-2 disabled:opacity-50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
                data-testid="select-all-matching-button"
                disabled={matchingState.pending}
                onClick={() => void selectAllMatching()}
              >
                {matchingState.pending
                  ? 'Selecting…'
                  : `Select all ${total.toLocaleString()} matching`}
              </button>
            </>
          )}
          <ErrorNote error={matchingState.error} testId="select-all-matching-error" />
        </div>
      )}

      <BulkActions
        selected={selectedFindings}
        allMatching={
          allMatching ? { ids: allMatching.ids, truncated: allMatching.truncated } : null
        }
        onApplied={() => {
          setSelection({ key: selectionKey, ids: [] });
          setMatching(null);
        }}
        onShowIds={(ids) =>
          void navigate({
            search: (prev: Record<string, unknown>) =>
              ({ ...prev, ids: ids.join(','), status: 'any', finding: undefined }) as never,
          })
        }
        invalidate={[
          queryKeyFor(listDescriptor),
          queryKeyFor(LIST),
          queryKeyFor({ endpoint: '/findings/stats' }),
        ]}
      />

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
            onClick={() => setFilters({ experimental: 'include' })}
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
            ? `Nothing writes ${dimensionLabel(dimension).toLowerCase()} findings yet, so this filter cannot return anything. ${DIMENSIONS_AWAITING_PRODUCER[dimension]}`
            : shadowMode === 'only'
              ? 'No shadow findings match these filters. Shadow findings come from rules still being measured; an admin promotes or retires them under Settings → Rules.'
              : shadowHidden > 0
                ? 'No findings from active rules match these filters. The ones that do match come from rules still in shadow (see above).'
                : 'No findings match these filters. Findings appear once an analysis run completes for a repository.'
        }
      >
        {/* W17-31: the table scrolls inside its own wrapper. Six columns of
            min-content pushed <main> 272px past a 390px viewport (and 134px
            past 768), so the whole Findings screen scrolled sideways — visible
            in the RP-01 baseline shot as a file column cut off mid-word. */}
        <div className="overflow-x-auto">
          {/* W20-21 (UX_TODO FND-43): below md each row is a stacked card
              (CSS only, one markup), so a phone no longer scrolls sideways. */}
          <table className="table-plain w-full text-sm md:min-w-[48rem]">
            <caption className="sr-only">Findings across every analysed repository</caption>
            <thead className="max-md:sr-only">
              <tr className="text-left text-xs text-fg-muted">
                <th scope="col">
                  {/* Select the page (W20-03, UX_TODO FND-12). The page only:
                      the selection never reaches past what is on screen. */}
                  <input
                    type="checkbox"
                    aria-label="Select all findings on this page"
                    data-testid="finding-select-page"
                    checked={allOnPage}
                    ref={(el) => {
                      if (el) el.indeterminate = someOnPage;
                    }}
                    disabled={items.length === 0}
                    onChange={(e) =>
                      setSelected(() => (e.target.checked ? items.map((f) => f.id) : []))
                    }
                  />
                </th>
                <th scope="col">Severity</th>
                {/* W20-13 (FND-19): the list is sorted by risk by default, and
                    no column showed it, so the order looked random. */}
                <th scope="col" aria-sort={sort ? undefined : 'descending'}>
                  Risk
                </th>
                <th scope="col">Finding</th>
                <th scope="col">Repository</th>
                <th scope="col">File</th>
                <th scope="col">Status</th>
                <th scope="col">Age</th>
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
                  className={`cursor-pointer border-t border-border max-md:block max-md:py-2 [&>td]:max-md:mr-3 [&>td]:max-md:inline-block [&>th]:max-md:block ${f.id === openId ? 'bg-accent/5' : ''}`}
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
                  <td
                    className="py-1 text-xs whitespace-nowrap"
                    data-testid={`finding-risk-${f.id}`}
                  >
                    {f.risk_band ? (RISK_BAND_LABEL[f.risk_band] ?? f.risk_band) : 'Not priced'}
                    {f.kev ? ' · KEV' : ''}
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
                    {/* W20-21 (UX_TODO AI-32): a model's finding is marked in
                        the list, not only in the panel. */}
                    {f.found_by?.kind === 'model' ? (
                      <span
                        className="ml-2 rounded-sm border border-border px-1 text-xs text-fg-muted"
                        title={`Raised by your AI model ${f.found_by.model}; a person should confirm it`}
                        data-testid={`finding-ai-${f.id}`}
                      >
                        AI
                      </span>
                    ) : null}
                    {/* W20-18 (UX_TODO X-08): where the work is tracked. */}
                    <TicketLink
                      url={f.external_ticket_url}
                      testId={`finding-ticket-${f.id}`}
                      className="ml-2 text-xs text-fg-muted"
                    />
                  </th>
                  <td className="py-1 text-xs">{f.repo.name}</td>
                  <td className="py-1 font-mono text-xs" data-testid={`finding-file-${f.id}`}>
                    {locationOf(f)}
                  </td>
                  <td className="py-1 text-xs">{statusLabel(f.status)}</td>
                  <td
                    className="py-1 text-xs whitespace-nowrap tabular-nums"
                    title={`First seen ${f.first_seen_at.slice(0, 10)}`}
                  >
                    {ageOf(f.first_seen_at)}
                  </td>
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
            {/* W20-13 (FND-21): where this page sits in the whole list. */}
            <span className="text-fg-muted" data-testid="findings-range">
              {items.length > 0 && typeof data?.total === 'number'
                ? `${(cursors.length * FINDINGS_PAGE_SIZE + 1).toLocaleString()}–${(
                    cursors.length * FINDINGS_PAGE_SIZE +
                    items.length
                  ).toLocaleString()} of ${data.total.toLocaleString()} matching`
                : `Page ${cursors.length + 1}`}
            </span>
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

      {/* Mounted only on a settled page, and keyed by it: the queue takes its
          set when it opens, and "Continue with the next page" must open on
          the next page's findings, not on the previous page still on screen
          while the next one loads (W20-03, FND-10). */}
      {triage && data && !isPlaceholderData && (
        <TriageQueue
          key={selectionKey}
          findings={items}
          nextCursor={data.next_cursor}
          onNextPage={(next) => setPaging({ key: filterKey, cursors: [...cursors, next] })}
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
              // W20-13 (FND-42): Tab stays inside the modal dialog.
              trapTab(e);
            }}
          >
            <div className="mb-2 flex justify-end">
              <button
                type="button"
                className="text-xs text-fg-muted underline underline-offset-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent"
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
