# RepoPulse — UX Specification

Canonical UX spec. Traces to `docs/work/FOUNDING_BRIEF.md` (P1–P4, D5–D7),
`docs/USER_PERSONAS.md` (saved views), `docs/USER_STORIES.md` (E3/E4/E5, E9.4),
`docs/SRS.md` (FR-WEB-*, FR-API-*, FR-INSIGHTS-*, FR-REPORTS-*, NFR-3/5).
Implementation counterpart: `docs/design/DASHBOARD.md`.

## 1. Design principles

1. **Data-dense but calm.** Many numbers per screen, one visual voice: a single
   type scale, one accent hue, severity color only where severity exists. No
   decorative gradients, no card shadows deeper than `shadow-sm`.
2. **Progressive disclosure.** Overview → drill-down; detail lives one click
   below, never crammed into the tile. Tiles show value + delta + sparkline, max.
3. **Every number is a door.** Any metric, score, or count is clickable and
   lands on its evidence (the PR list, the file list, the finding). No dead ends.
4. **Signals, not grades.** Health scores are framed as attention-routing
   signals: always shown with formula breakdown, basis label ("Tier-1 only"),
   and trend — never as letter grades or per-developer rankings (NON_GOALS N-9).
5. **Skeleton-first.** Every widget renders its skeleton within 100ms; data
   streams in per-widget. The page never blocks on its slowest query.
6. **Dark-first, light-complete.** Designed in dark; light theme is a first-class
   token swap, not an afterthought. Both pass WCAG 2.2 AA contrast.
7. **Honest states.** Backfilling ≠ empty (E3.6). Every widget distinguishes
   loading / syncing (with %) / empty / error, with copy that says which.

## 2. Design system

### 2.1 Tokens (Tailwind 4 `@theme`, consumed by shadcn/ui + ECharts bridge)

- **Spacing:** 4px base. Scale: 4/8/12/16/24/32/48/64. Card padding 16 (compact:
  8/12). Grid gutter 16, page margin 24.
- **Radius:** `--radius-sm` 6px (inputs, badges), `--radius-md` 10px (cards,
  widgets), `--radius-lg` 14px (modals, palette). Nothing fully rounded except
  avatars and status dots.
- **Type:** Inter (UI) + JetBrains Mono (numbers, SHAs, paths, code evidence).
  Scale: 12 (caption/axis), 13 (table body compact), 14 (body/table), 16
  (section head), 20 (page title), 28 (KPI value, mono, `font-variant-numeric:
  tabular-nums`). Line-height 1.5 body, 1.2 KPI.
- **Semantic color roles** (each defined per theme, AA-checked ≥4.5:1 text,
  ≥3:1 large/graphic):
  - Surface: `bg`, `surface` (card), `surface-2` (nested), `border`, `border-strong`.
  - Text: `fg`, `fg-muted`, `fg-faint` (never below 4.5:1 on its surface).
  - Accent: `accent` (brand indigo) — links, active nav, primary buttons, focus ring.
  - Status: `ok` (green), `warn` (amber), `crit` (red), `info` (blue), `neutral`.
  - **Severity ramp** (findings): `sev-critical` / `sev-high` / `sev-medium` /
    `sev-low` / `sev-info` — red→amber→yellow→blue→gray; badges use tinted
    background + strong text, not white-on-color, in both themes.
  - **Health ramp** (scores 0–100): 3 bands only — `health-good` (≥75),
    `health-watch` (50–74), `health-attend` (<50). Bands, not a continuous
    gradient: signals, not grades. Always paired with the numeric value and a
    trend arrow so color is never the only carrier (a11y).
- **Elevation/motion:** shadow only on overlays; transitions 150ms ease-out;
  all animation removed under `prefers-reduced-motion`.

### 2.2 Components

shadcn/ui is the base kit (Button, Card, Tabs, Dialog, DropdownMenu, Command,
Tooltip, Badge, Sheet, Toast/Sonner, Skeleton, Table primitives). Custom
composites built on it: `KpiTile`, `HealthBadge`, `TrendDelta` (▲/▼ + % vs
prior window, FR-INSIGHTS-4), `Sparkline`, `SeverityBadge`, `SyncStatusChip`,
`EvidenceQuote`, `WidgetFrame` (title, definition-info icon, state machine,
drill-down affordance), `FilterBar`, `Breadcrumb`, `DataTable`.

### 2.3 Chart rules (ECharts; see DASHBOARD.md §5 for wrapper)

- One series palette everywhere (6 hues, colorblind-safe, defined per theme);
  series identity is stable per metric (cycle-time stages always use the same
  4 hues in the same order on every screen).
- Sparklines: 96×28px inline in tiles/tables, no axes, no dots, last-point
  marker only; area fill at 10% opacity.
- No chart-junk: no 3D, no gridline clutter (dashed `border` color, y only),
  no legends when ≤2 series (label the lines), axis labels 12px `fg-muted`.
- Tooltips: exact values in mono, window/date, delta vs prior, and a
  "definition ↗" link opening the metric's formula (FR-METRICS-15 / E2.8).
- Every chart has a "view as table" toggle (accessible data alternative, NFR-5).

### 2.4 Density modes

`comfortable` (default) and `compact` (table row 40→32px, card padding 16→10,
type 14→13). Toggle in user menu, persisted per user; tables additionally
remember per-view density inside saved views.

## 3. Information architecture + navigation

### 3.1 Left rail (collapsible to icons, 240px/64px)

Org Overview · Repos · Pull Requests · Findings · Reports · Views (saved views
list + "New view") · Admin (admin role only). Bottom: sync-status chip, theme
toggle, user menu. Active item = accent bar + tinted background.

### 3.2 Drill-down spine (FR-WEB-2, E3.2)

`org → repo → PR → file → finding`. Every hop appends a breadcrumb segment
AND a URL segment; breadcrumb is sticky under the top bar; browser back and
breadcrumb clicks are equivalent. Every level is deep-linkable.

### 3.3 Command palette ⌘K (FR-WEB-6, E3.4)

Fuzzy jump to: repos, PRs (#/title), saved views, report types, admin pages;
action verbs: "Generate report…", "New view", "Toggle theme", "Set time
window…". Recents first; groups labeled; fully keyboard operable.

### 3.4 Global filters (URL-persisted)

Top bar holds three global filters: **time window** (7/30/90/365d + custom
range), **repo set** (all / multi-select / saved set), **person** (any org
member — scopes PR/review widgets). All serialize to URL query params
(`?window=90d&repos=a,b&person=login`) so every screen state is shareable and
bookmarkable; saved views (E4) are named snapshots of exactly this state +
layout.

## 4. Screen specs

Each widget uses `WidgetFrame` states: **loading** = skeleton matching final
shape; **syncing** = skeleton + "backfilling — X% (phase)" chip (FR-INGEST-8);
**empty** = one-line explanation + next action; **error** = message + request
id + retry button. Listed states below only note screen-specific copy.

### 4.a Org Overview (`/`) — P1 home, E3.1

```
┌ rail ┬──────────────────────────────────────────────────────────┐
│      │ Org ▸            [window 90d ▾][repos: all ▾][person ▾]  │
│ Org  │ ┌KPI──┐┌KPI──┐┌KPI──┐┌KPI──┐┌KPI──┐   sync: ● 42/50 ok  │
│ Repos│ │cycle││rev %││merged││CI % ││DORA │  (banner if backfill)│
│ PRs  │ │4.1d▼││92%▲ ││no-rev││ ~   ││ lead│                     │
│ Find.│ └─────┘└─────┘└─────┘└─────┘└─────┘                      │
│ Rpts │ ┌ Repo health tiles (grid) ───────────┐┌ Attention ────┐ │
│ Views│ │ [repo-a 82▲ ╱╲╱] [repo-b 61▼ ╲╲╱]  ││ since last    │ │
│ Admin│ │ [repo-c 74– ╱──] [repo-d 45▼ ╲╲╲]  ││ visit: 7 items│ │
│      │ └─────────────────────────────────────┘│ • repo-d CI ↓ │ │
│      │ ┌ Hotspot leaderboard (top 10, x-repo)┐│ • 3 merged    │ │
│      │ │ file · repo · score · spark · owner ││   w/o review  │ │
└──────┴─┴─────────────────────────────────────┘└───────────────┘─┘
```

- **Components:** KpiTile×5, health tile grid (HealthBadge + Sparkline +
  TrendDelta, click → repo), hotspot leaderboard table (click → file
  drill-down), attention feed ("what changed since you last looked": score
  band changes, new stale PRs, CI regressions, unreviewed merges — computed
  vs `last_seen_at`), sync banner.
- **Data:** `/api/v1/org/summary`, `/api/v1/org/health-tiles`,
  `/api/v1/hotspots?scope=org`, `/api/v1/attention?since=`,
  `/api/v1/sync/status`. All warehouse-only, p95 <500ms (NFR-3).
- **States:** first-run empty → "Connect your org" CTA (admin) / "Ask an admin
  to connect" (member); backfill → tiles render with syncing chips, banner
  shows org-level % (E3.6).

### 4.b Repo Detail (`/repos/:repo`) — tabbed

```
│ Org ▸ repo-b                    [window][person]        health 61 ▼ (why?) │
│ [Pulse] [Hotspots] [PR Flow] [CI] [Findings]                               │
│ Pulse: KPI row (repo-scoped) + trend charts grid (cycle time, churn,       │
│   review coverage, throughput, release cadence) + stale-PR list            │
│ Hotspots: directory treemap (size=churn, intensity=hotspot score) ─ click  │
│   dir → zoom, click file → file drill-down; side list = top-N with score   │
│   components (churn × recency), gross/net/rework split, bus-factor flags   │
│ PR Flow: cycle-time funnel (open→first-review→approved→merged, median+p90  │
│   per stage) + review-load matrix (reviewer × week heat cells, click →     │
│   that reviewer's PR list) + size histogram XS–XL                          │
│ CI: pass-rate trend, duration trend, flaky-workflow ranking (click → runs) │
│ Findings: repo-filtered Findings Explorer (see 4.e), v1.x                  │
```

- **Components:** Tabs (each tab = routed URL `/repos/:repo/pulse|hotspots|
  pr-flow|ci|findings`), "why?" score popover with full formula breakdown +
  basis label (FR-INSIGHTS-2/3), ECharts treemap/funnel/heatmap/histogram.
- **Data:** `/api/v1/repos/:id` (+ `/metrics`, `/hotspots`, `/pr-flow`,
  `/ci`, `/findings`), snapshot series via `/api/v1/repos/:id/trends`.
- **States:** paused repo → banner "monitoring paused"; backfilling → per-tab
  syncing chips with phase (commits/PRs/checks); Findings tab pre-v1.x →
  teaser explaining Tier-2/3 with admin link (persona note: set expectations).

### 4.c PR Detail (`/repos/:repo/prs/:number`)

```
│ Org ▸ repo-b ▸ PR #412 "Extract budgeter"   [size L] [risk: hotspot-touch] │
│ opened 3d ago by @sam · 2 approvals · merged                    ↗ GitHub   │
│ ┌ Stage timeline ────────────────────────────────────────────┐             │
│ │ open ──2.1d── first review ──0.4d── approved ──0.2d── merge │            │
│ └─────────────────────────────────────────────────────────────┘            │
│ ┌ Findings (by dimension) ──────────────┐ ┌ Review activity ┐ ┌ Files ───┐ │
│ │ ▸ security (1 high)                   │ │ @kim requested… │ │ churn/   │ │
│ │   "token logged at line 88"           │ │ @lee approved   │ │ hotspot  │ │
│ │   `logger.info(token)` src/a.ts:88 ↗  │ │ 2 comments      │ │ badges   │ │
│ │ ▸ code-health (2 med) ▸ tests (1 low) │ └─────────────────┘ └──────────┘ │
```

- **Components:** stage timeline (durations vs repo median annotated), size/
  risk badges (L per histogram bands; risk = touches hotspot / sensitive path
  / low bus factor), findings accordion grouped by dimension with
  EvidenceQuote (mono quote + file:line anchor deep-linking to GitHub blob ↗),
  review activity feed, files list with per-file hotspot badges → file
  drill-down, checks summary.
- **Data:** `/api/v1/prs/:id` (stages, reviews, checks, files),
  `/api/v1/prs/:id/findings`.
- **States:** open PR → timeline shows elapsed-so-far stage pulsing (static
  under reduced motion); no findings → "no automated review yet" + tier
  status/policy (FR-WEB-8); analysis running → progress chip via SSE.

### 4.d File drill-down (`/repos/:repo/files/*path`)

```
│ Org ▸ repo-b ▸ src/ingest/budgeter.ts      hotspot 91 · bus factor 1 ⚠     │
│ ┌ Churn history (52w bars, gross/net/rework) ┐ ┌ Owners ──────────────┐    │
│ └─────────────────────────────────────────────┘ │ @sam 78% · @kim 12% │    │
│ ┌ Recent PRs touching this file ┐ ┌ Findings on this file ┐└───────────┘   │
```

- **Components:** churn bar chart (stacked gross/net/rework), ownership list
  with top-author-share flag (≥80% ⚠, E2.4), recent-PRs table → PR detail,
  file-scoped findings list, hotspot-score history sparkline.
- **Data:** `/api/v1/repos/:id/files/:fileId` (+ `/churn`, `/prs`, `/findings`).
- **States:** deleted/renamed file → banner with last-seen date + rename chain
  link; no findings → single quiet line, not an empty card.

### 4.e Findings Explorer (`/findings`) — P3 home, v1.x (shell ships in MVP as teaser)

```
│ Findings   [dimension ▾][severity ▾][confidence ▾][status ▾][repo ▾]       │
│ FP rate: 8% (last 30d dispositions)              [bulk: ack ▾] 3 selected  │
│ ☑ sev  dim       finding                repo    conf  age   status         │
│ ☑ ●H   security  token logged…          repo-b  0.9   2d    open           │
│ ☐ ●M   code-hlth duplicated retry…      repo-a  0.7   6d    ack            │
```

- **Components:** virtualized DataTable (sortable, j/k nav), filter bar (all
  URL-synced), bulk-select + bulk status transitions (acknowledge/resolve/
  wont-fix with required note, FR-INSIGHTS-1), false-positive-rate widget
  (wont-fix÷dispositioned, trend), row click → finding detail panel (evidence,
  file/line ↗ GitHub, status history) → link to PR/file drill-down.
- **Data:** `/api/v1/findings?filters…` (cursor-paginated, FR-API-3),
  `/api/v1/findings/stats`, `PATCH /api/v1/findings/:id/status`.
- **States:** MVP (no Tier-2 yet) → explainer + "enable analysis" admin link;
  analysis paused (LM Studio down) → banner "analysis paused — Tier-1
  dashboards unaffected" (E6.5).

### 4.f My Focus (`/me`) — P2 home, E3.5

```
│ My Focus (@sam)                                   [window 30d]             │
│ ┌ My open PRs ───────────────────┐ ┌ My review queue (oldest first) ─────┐ │
│ │ #412 repo-b · waiting review 2d│ │ #388 repo-a · requested 4d ago ⚠    │ │
│ │      stage ● open→[review]     │ │ #401 repo-c · requested 1d ago     │ │
│ └────────────────────────────────┘ └─────────────────────────────────────┘ │
│ ┌ Hotspots I own ──────────────────────┐ ┌ My cycle time vs repo median ─┐ │
```

- **Components:** my-open-PRs list (cycle stage chip + time-in-stage, stalled
  highlighted), review queue (age-sorted, over-SLA amber), hotspots-I-own
  table (ownership ≥ threshold ∩ hotspot list), personal cycle-time/size
  comparison vs repo distribution (no cross-person comparisons, N-9).
- **Data:** `/api/v1/me/prs`, `/api/v1/me/review-queue`, `/api/v1/me/hotspots`,
  `/api/v1/me/stats` (via D6 identity link, FR-AUTH-6).
- **States:** identity unlinked → "re-authorize GitHub" CTA; all-clear →
  "queue clear 🎉-free" quiet celebration line (text, no confetti).

### 4.g Custom Views (`/views`, `/views/:id`) — E4

- A **view** = named JSON: `{scope: {repos, window, person}, filters, layout:
  Widget[]}` (see DASHBOARD.md §4). Views render on the same grid engine as
  Org Overview.
- **Create from current state:** every dashboard screen has "Save as view…" —
  captures current URL filters + visible widgets into a new named view.
- **Edit mode:** widget picker (categorized: KPIs, trends, tables, hotspots,
  personal), drag-resize on a 12-col grid, per-widget scope override.
- **Share:** stable URL `/views/:id` — any workspace member sees identical
  layout (FR-WEB-5); non-members 403. "Set as home" makes it the login
  landing (per-user default, E4.1).
- **Data:** `/api/v1/views` CRUD (FR-API-6); widget data via each widget's own
  query descriptor.
- **States:** widget whose scope lost access/repo removed → inline "source
  unavailable" placeholder with fix/remove actions; empty views list → gallery
  of persona starter templates (§6).

### 4.h Report Center (`/reports`) — P4/P3, E5

```
│ Reports   [Generate ▾: Repo Health · Org Exec · Delivery/DORA · Security]  │
│ history: type · scope · window · by · at · status      [open][PDF ⬇]      │
│ ▸ Org Exec Summary · all repos · Q2 · brad · 07-01 · ● ready              │
│ ▸ Repo Health · repo-b · 30d · kim · 06-28 · ● ready                      │
│ ┌ inline viewer (stored snapshot, immutable) ───────────────────────────┐  │
```

- **Components:** generate dialog (type → repo set + window params, stored
  with report, FR-REPORTS-7), history table (status: queued/running/ready/
  failed via SSE), inline viewer rendering the stored snapshot, PDF download
  (byte-stable, FR-REPORTS-6), "regenerate with same scope" action.
- **Data:** `/api/v1/reports` (list/create), `/api/v1/reports/:id`
  (+ `/pdf`).
- **States:** generating → progress row with stage; failed → error + retry
  keeping params; Security Posture pre-v1.x → generates Tier-1-only sections
  with basis note (E5.6).

### 4.i Admin (`/admin`) — E1/E9, admin role only

- **Tabs:** **Connections** (org credential fingerprint/last-4, repo picker,
  pause/remove with purge option), **Sync** (per-repo table: phase, %, rate-
  budget gauge, lag, last webhook; DLQ list with retry, E9.3), **Analysis**
  (v1.x: Tier-2 policy, Tier-3 opt-in flags per repo with per-PR override +
  egress audit log link, E7), **Members** (role assignment admin/member).
- **Data:** `/api/v1/admin/connections`, `/api/v1/admin/sync`,
  `/api/v1/admin/queues`, `/api/v1/admin/members`, `/api/v1/admin/analysis`.
- **States:** member hitting `/admin` → 403 page with "ask an admin" copy;
  webhook failing → repo row flagged crit with remediation hint.

## 5. Interaction patterns

- **Drill-down contract:** every drill adds a breadcrumb + URL segment; Esc or
  breadcrumb ascends; state (filters) survives the round trip via URL params.
- **Hover = define, click = evidence:** hovering any metric shows tooltip with
  exact value + formula link; clicking navigates to the underlying records.
- **Time-window scrubbing:** changing the global window (or brushing a chart's
  x-axis) updates every chart/tile on screen in one synchronized transition.
- **Live sync:** SSE stream drives sync-status chips, backfill %, report
  status, and analysis progress; user-visible changes announce via toast
  (rate-limited, batched "3 repos finished backfill").
- **Keyboard-first:** ⌘K palette; `j/k` row navigation + `Enter` to open +
  `x` to select in all DataTables; `g o`/`g r`/`g f` go-to shortcuts; `?`
  opens shortcut sheet. Full tab order matches visual order.
- **Row selection & bulk:** checkbox column appears on first selection;
  bulk bar is sticky bottom; destructive actions confirm with typed count.

## 6. Personalization per persona

- **Default home by role/choice:** first login routes P1→Org Overview,
  P2→My Focus, P3→Findings Explorer, P4→Exec Rollup view; any saved view can
  be "set as home" and overrides.
- **Starter saved views (seeded templates, map to persona top questions):**
  - P1: "My org rollup" (health tiles + attention feed), "Review flow"
    (stage funnel + reviewer-load matrix), "Hotspot map" (org treemap +
    leaderboard), "Merged without review" (offender list, weekly window).
  - P2: "My work" (My Focus as a view), "My code health" (hotspots I own +
    bus-factor flags).
  - P3: "Security posture" (findings by severity/age, unreviewed-merge rate,
    sensitive-path PR list, CI check status), "Audit window" (date-range
    evidence view feeding the PDF pack).
  - P4: "Exec rollup" (DORA tiles + 12-month trends, org-level only),
    "Quarter compare" (this-vs-last-quarter deltas).

## 7. Accessibility (WCAG 2.2 AA — gated by E9.4)

- Contrast ≥4.5:1 text / ≥3:1 UI+chart graphics in **both** themes; severity
  and health never rely on color alone (icons/arrows/text labels always paired).
- Every chart has a "view as table" data alternative; sparklines carry
  `aria-label` with value + delta ("cycle time 4.1 days, down 8%").
- Focus management: drill-down navigation moves focus to the new page's h1;
  dialogs/palette trap focus and restore on close; visible focus ring
  (`accent`, 2px) everywhere.
- `prefers-reduced-motion`: all transitions/pulses become instant state swaps.
- Live regions: sync/report toasts use `role="status"` (polite); error toasts
  `role="alert"`; SSE-driven chips update silently, batched announcements.
- Full keyboard operability incl. palette, treemap (arrow-key cell traversal),
  and table nav; touch targets ≥24×24px (WCAG 2.2 target-size).

## 8. Perceived performance

- **Per-widget skeletons** shaped like the final content (tile, chart box,
  n table rows) — no full-page spinners, ever.
- **Optimistic filters:** filter/window changes apply to the URL and UI
  immediately; charts show previous data at 50% opacity until fresh data lands
  (stale-while-revalidate via TanStack Query, see DASHBOARD.md §3).
- **Progressive backfill messaging:** during backfill, widgets render partial
  data with the chip "last 30 days ready — older history filling in (68%)"
  driven by per-repo sync phase (E1.3/E3.6). Never zeros for syncing repos.
- **Prefetch on intent:** hovering a repo tile/breadcrumb prefetches its
  summary query; palette prefetches top hit.
- Budgets (enforced in DASHBOARD.md §8): LCP <1.5s LAN, data p95 <500ms
  (NFR-3), route-level code splitting, lazy chart bundles.
