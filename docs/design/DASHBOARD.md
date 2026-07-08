# DASHBOARD — apps/web implementation design

Implements `docs/UX_SPEC.md` on the fixed stack (React 18 + Vite + TanStack
Router/Query + Tailwind 4 + shadcn/ui + ECharts). API shapes referenced as
`/api/v1/...` per `docs/design/API_DESIGN.md` (FR-API-1..6). Law 4 applies:
web reads only our API — zero forge calls.

## 1. Route map (TanStack Router, file-based, `apps/web/src/routes/`)

```
__root.tsx                    shell: rail, topbar, breadcrumb, palette, SSE mount
index.tsx                     / Org Overview (redirects to user home pref)
me.tsx                        /me My Focus
repos/index.tsx               /repos list
repos/$repoId/route.tsx       repo layout (header, score, tabs)
repos/$repoId/index.tsx       → redirect to ./pulse
repos/$repoId/{pulse,hotspots,pr-flow,ci,findings}.tsx
repos/$repoId/prs/index.tsx   repo PR list
repos/$repoId/prs/$prNumber.tsx        PR detail
repos/$repoId/files/$fileId.tsx        file drill-down (fileId = path hash from API)
prs/index.tsx                 /pull-requests org-wide PR list
findings/index.tsx            /findings explorer
findings/$findingId.tsx       finding detail (renders as side panel over list)
views/index.tsx               /views list + templates gallery
views/$viewId.tsx             saved view renderer (+ ?edit=1 for edit mode)
reports/index.tsx             /reports center (history + inline viewer via ?open=:id)
admin/route.tsx               role guard (403 page for members)
admin/{connections,sync,analysis,members}.tsx
print/reports/$reportId.tsx   print route (no shell) → Playwright PDF
```

### URL param schema (shared, zod-validated with `validateSearch`)

```ts
// packages/shared/src/urlState.ts — single source of truth
GlobalSearch = { window: '7d'|'30d'|'90d'|'365d'|`${iso}..${iso}`,
                 repos?: string,          // csv of repo ids | 'all'
                 person?: string }        // github login
FindingsSearch = GlobalSearch & { dim?: csv, sev?: csv, conf?: 'gte:0.7'|…,
                 status?: csv, sort?: string, cursor?: string }
TableSearch = { sort?: `${col}:asc|desc`, cursor?: string, density?: 'c'|'m' }
```

Rules: every route inherits `GlobalSearch` via router context and **preserves
it across navigation** (drill-down keeps `window/repos/person`). Params are the
only view state — paste a URL, get the identical screen (FR-WEB-2/5). Defaults
are omitted from the URL to keep links clean.

## 2. State strategy

- **URL = source of truth** for all view state (filters, window, tab, sort,
  cursor, selected finding). Navigation = `router.navigate({search})`. No view
  state in component state that outlives the component.
- **TanStack Query = all server state.** Query keys mirror endpoints:
  `['org','summary',{window,repos}]`. `staleTime: 30s`, SWR everywhere,
  `placeholderData: keepPreviousData` for the 50%-opacity stale-chart pattern
  (UX §8). SSE events invalidate targeted keys (§6). No client cache writes
  except optimistic finding-status transitions (rollback on error).
- **zustand = ephemeral UI only** (one small store): rail collapsed, palette
  open, density mode, active toasts, `lastSeenAt` for the attention feed.
  Persisted (`persist` middleware, localStorage) for rail/density/lastSeenAt.
  Nothing in zustand that belongs in a URL.

## 3. Data layer

`apps/web/src/api/` — one typed client generated from the API's OpenAPI spec
(FR-API-1) via `openapi-typescript`; a thin `useApiQuery(descriptor)` hook maps
a **QueryDescriptor** (§4) to fetch + query key. Cursor lists use
`useInfiniteQuery` with the shared `TableSearch` fragment (FR-API-3). All
errors surface the API envelope `{code,message,requestId}` into WidgetFrame's
error state.

## 4. Widget framework (powers Org Overview, My Focus, saved views)

```ts
type Widget = {
  id: string;                       // nanoid
  type: WidgetType;                 // 'kpi'|'trend'|'health-grid'|'hotspot-list'|
                                    // 'treemap'|'stage-funnel'|'review-matrix'|
                                    // 'histogram'|'pr-table'|'finding-table'|
                                    // 'attention-feed'|'my-prs'|'my-queue'|'text'
  query: QueryDescriptor;           // { endpoint: '/api/v1/…', params, scopeOverride? }
  layout: { x:number; y:number; w:number; h:number };  // 12-col grid units
  options?: Record<string, unknown>; // per-type display opts (metric id, topN…)
};
type SavedView = { id; name; scope: GlobalSearch; widgets: Widget[];
                   ownerId; sharedWithWorkspace: boolean; isHome: boolean };
```

- `WidgetRegistry` maps `WidgetType` → lazy React component + default
  layout/options + category (for the picker). Adding a widget type = one
  registry entry, no grid-engine changes.
- `<WidgetGrid>` renders `Widget[]` on CSS grid (12 cols; static render) with
  drag/resize only in edit mode (interact via `@dnd-kit`, layout writes back
  to the view JSON). Same component renders Org Overview (a built-in, non-
  editable SavedView constant) and user views — one engine (personas note:
  views differ by config, not page builds).
- `<WidgetFrame>` (from UX §2.2) wraps every widget: title, definition link,
  loading/syncing/empty/error state machine keyed off its query, "save to
  view…" and drill-down affordances.
- Saved views serialize the exact `SavedView` JSON to `/api/v1/views`
  (FR-API-6); "Save as view" composes current route's `GlobalSearch` + the
  screen's widget list.

## 5. ECharts conventions

- **One wrapper**: `<Chart option={} onEvents={}>` in
  `apps/web/src/components/chart/Chart.tsx`. It owns: init/dispose, container
  resize (ResizeObserver), theme registration, `renderer:'canvas'`,
  reduced-motion (`animation:false`), and the "view as table" toggle (renders
  `option.dataset` into a shadcn Table for NFR-5).
- **Theme-token bridge**: `chartTheme.ts` reads CSS custom properties
  (`getComputedStyle` on `:root`) at theme change and registers ECharts themes
  `rp-dark`/`rp-light` — series palette, axis/gridline/tooltip colors all come
  from the same Tailwind tokens as the UI. No hex literals in chart code.
- **Variants** built on the wrapper: `<Sparkline data points>` (fixed 96×28,
  no axes, `silent:true`, aria-label per UX §7), `<TrendChart>`, `<Treemap>`,
  `<StageFunnel>`, `<HeatMatrix>`, `<Histogram>`. Tooltip formatter is shared:
  mono values + delta + "definition ↗" (metric id → `/docs/metrics#id`).
- **Lazy bundles**: `echarts/core` + only used renderers/charts/components,
  imported inside `React.lazy` chart chunks so list/table routes never pay for
  chart JS.

## 6. SSE client

`apps/web/src/sse/useSyncStream.ts` — one `EventSource` to `/api/v1/events`
mounted in `__root`. Event types: `sync.progress {repoId, phase, pct}`,
`sync.done`, `report.status {reportId, status}`, `analysis.progress`,
`budget.warning`. Handler policy: update zustand chip state directly (no
refetch churn), debounce-invalidate matching query keys (500ms), emit batched
toasts (`role="status"`). Auto-reconnect with backoff + `Last-Event-ID`;
connection state shown in the rail sync chip.

## 7. Tables

TanStack Table v8 + `@tanstack/react-virtual` for all lists (findings, PRs,
hotspots, report history). One `<DataTable>` component: column defs in,
URL-synced sort/cursor (TableSearch), virtualized rows (row height 40/32 per
density), j/k/Enter/x keyboard nav (UX §5), selection + sticky bulk bar,
skeleton rows for loading, infinite scroll on cursor pagination. Cells render
shared primitives (SeverityBadge, TrendDelta, Sparkline, SyncStatusChip).

## 8. Print route + PDF

`/print/reports/$reportId` renders the stored report snapshot with the same
widget components, no shell, `print.css` (page margins, `break-inside:avoid`
per widget, header/footer with report meta + page numbers via CSS
`@page`/counters). Charts render with `animation:false` and fixed widths.
The reports worker drives Playwright chromium at this route → `page.pdf()`
(FR-REPORTS-6); byte-stability comes from rendering the immutable snapshot,
never live queries. E2E asserts extracted text contains section headings.

## 9. Performance budget (CI-enforced)

- Route-level code splitting (router lazy routes) + lazy chart/grid-edit
  chunks. **Initial JS ≤200KB gz** (shell + org overview sans charts);
  `size-limit` check in CI fails the gate.
- LCP <1.5s on LAN against seeded dev stack (Playwright + `web-vitals`
  assertion); data endpoints p95 <500ms is API-side (NFR-3).
- Skeletons render synchronously with route shell; no widget blocks another
  (each has its own query + Suspense-free state machine).
- Prefetch: `router.preload='intent'` + query prefetch on tile hover (UX §8).

## 10. E2E hooks (Playwright, `docs/TESTING.md`)

`data-testid` conventions — stable, semantic, kebab-case:
- Widgets: `widget-{type}-{id}`; frame states `widget-state-{loading|syncing|empty|error}`.
- Nav: `rail-{item}`, `breadcrumb-{level}`, `palette`, `palette-item-{n}`.
- Tables: `table-{name}`, `row-{entityId}`, `cell-{col}`; bulk `bulk-bar`.
- Charts: `chart-{name}` + `chart-table-toggle` (a11y fallback assertions).
- Filters: `filter-window`, `filter-repos`, `filter-person`.
Rules: testids on containers and interactive elements only (not every cell);
E2E asserts via testid + accessible-name (dual-locator pattern) so a11y
regressions fail functional tests too. Fixture warehouse seeds (FR-WEB-1
acceptance) power all e2e; nock guard asserts zero forge calls from web.
