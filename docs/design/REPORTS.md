# Reports — Report Center + PDF (packages/reports) — D7

Traces: FR-REPORTS-1..7, FR-METRICS-12/13/15, FR-INSIGHTS-2, NFR-9, P3/P4. Reports are
**immutable snapshots** (FR-REPORTS-1): generated once, stored forever, byte-stable on re-render.

## 1. Report types & section outlines

**Repo Health (FR-REPORTS-2, MVP)** — 1 repo × window.
1. Exec summary (auto-composed: score, delta vs prior window, top 3 movers)
2. Health score breakdown (full FR-INSIGHTS-2 decomposition table: input → normalized → weight → contribution; "Tier-1 only" badge when applicable per FR-INSIGHTS-3)
3. Hotspots (top-10 M2 table + treemap image; score decomposition columns)
4. PR flow (M4 stage medians/p90 bars, M5/M6 with offender list, M7 histogram, M8 stale list)
5. CI (M9 pass-rate trend, duration trend, flakiness top-5)
6. Findings digest (when analysis rows exist: open by dimension×severity, new-in-window, top confirmed) — else "No analysis data (Tier-1 only)". Sections never render blank: "no data" states designed (FR-REPORTS-2 acceptance).

**Org Executive Summary (FR-REPORTS-3, MVP, P4)** — repo set × window.
1. Headline trends (org health, throughput, cycle-time — snapshot sparklines)
2. DORA tiles with basis labels (M12)
3. Per-repo score table (score, delta, worst sub-score)
4. Top risks (single-owner hotspot files M3, review-bypass repos M6, flaky workflows M9)
5. Team throughput (merged PRs, issue throughput M10, pooled percentiles per FR-METRICS-14 — org-level only, no person leaderboards; "signals not grades", METRICS.md §3)

**AI-authored vs human changes (W18-20)** — a section of Repo Health and Org Executive Summary, placed after the type's own sections and before the plan; the same numbers drive the Org Overview tile (`GET /org/ai-governance`).
- Authorship classifier (`packages/metrics/src/authorship/`): agent bot author → AI; a `Co-authored-by` / `Assisted-by` / `Generated-by` trailer whose value matches a trailer pattern → AI; the PR it landed through (head SHA or a `(#N)` squash subject) is AI → AI; a PR is AI from its author, an agent branch prefix (`claude/`, `copilot/`, …) or a linked AI-trailered commit. Non-agent bots (the workspace bot list) are `automation`; rows ingested before migration 0035 with no positive signal are `unknown`. Both are counted and excluded from the comparison.
- Patterns live in `workspaces.settings.ai_authorship_patterns` (`trailer_patterns`, `bot_logins`, `branch_prefixes`), edited at Admin → Settings. Substrings, prefixes and single-`*` globs only — no regexes. Classification happens on read, so an edit re-classifies history; the report prints the pattern set's fingerprint.
- Measures are EXISTING metrics sliced, never redefined: findings per 1,000 lines changed (findings first seen in the window, attributed to their PR or else the last change to their file — an approximation, said so), M13 rework (attributed per change over the full history, then grouped), M14 revert rate (the reverting commit's cohort), M5 review coverage and non-author reviews per merged PR.
- Signals, not grades (N-9): two numbers and a direction word (`higher` / `lower` / `similar`) per measure; no score, letter or person. Below 20 commits / 10 merged PRs / 1,000 lines changed per cohort a measure prints "too small to compare" instead of a direction, and when nothing clears its minimum the section says so first.

**Security Posture (FR-REPORTS-4, v1.x, P3)** — audit-pack framing mandatory.
1. Open security-dimension findings by severity × repo × age
2. Review-bypass exposure (M6 rate + unreviewed-merge list) — renders Tier-1-only
3. Dependency & secret signals (v1.x: manifest-diff heuristics from PR files; labeled heuristic)
4. Egress audit summary (T3 calls: count, bytes, repos, initiators — from `egress_audit`, NFR-9)
5. Finding lifecycle stats (mean time open→resolved, dismissal/false-positive rate)

**Delivery/DORA (FR-REPORTS-5, MVP)** — repo set × window.
1. Four DORA tiles + trends, **each footnoted with its heuristic basis** (FR-METRICS-12; MTTR renders "needs incident data")
2. Cycle-time stages (M4) · 3. Release cadence (M11) · 4. Throughput trend · 5. Change-failure drill-down (the reverts/hotfixes counted, so the number is inspectable)

## 2. Data snapshot determinism (FR-REPORTS-1/7)

```ts
interface ReportParams {           // stored with the report; "regenerate with same scope" reuses it
  type: 'repo_health' | 'org_exec' | 'security_posture' | 'delivery_dora';
  workspaceId: string; repoIds: string[]; windowDays: 7 | 30 | 90 | 365;
  windowEnd: string;               // pinned at generation ("now" resolved once)
  snapshotAt: string;              // metric_snapshot computed_at high-watermark used — THE determinism pin
  weightsVersion: string;          // health-score config version in force
  catalogVersion: string;          // FR-METRICS-15 definitions version (appendix source)
}
```

Generation resolves all numbers from `metric_snapshot` rows with `computed_at ≤ snapshotAt`
(+ findings as of `snapshotAt`) — never live tables mid-write, never forge calls (FR-API-2).
Regenerating with identical `ReportParams` reproduces identical content; the stored artifact
is still authoritative (regeneration creates a *new* history row, never mutates).

## 3. Generation pipeline (FR-REPORTS-6)

```mermaid
flowchart LR
  A[POST /api/v1/reports<br/>ReportParams] --> B[BullMQ reports.generate<br/>jobId rpt:{uuid}]
  B --> C[data assembler:<br/>snapshot + findings queries → ReportData JSON]
  C --> D[SSR render: same React components<br/>via dedicated /print/:reportId route]
  D --> E[store report.html + report.json]
  E --> F[Playwright print-to-PDF<br/>A4, headless chromium, print CSS]
  F --> G[store report.pdf]
  G --> H[report row status=ready<br/>html_uri + pdf_uri + params]
```

- **Print route** `apps/web /print/:reportId`: renders from the stored `ReportData` JSON only
  (no live queries) — the same shadcn/ECharts components with `media=print` styles; charts
  render to SVG (deterministic, crisp in PDF; no animation).
- **Playwright**: `page.goto(printUrl); page.waitForFunction(window.__REPORT_READY)`;
  `page.pdf({ format:'A4', displayHeaderFooter:true, headerTemplate: workspace+type,
  footerTemplate: generatedAt + pageNumber/totalPages })`. Byte-stability: fixed viewport,
  embedded fonts, `Date` mocked to `snapshotAt` in print route, no external assets ⇒ same
  stored report → same PDF bytes (FR-REPORTS-6 acceptance). Budget ≤30s; job timeout 60s → DLQ.
- **Storage**: `report(workspace_id, id, type, params jsonb, status
  queued|running|ready|failed, html_uri, pdf_uri, json_uri, generated_by, generated_at,
  error)`; artifacts on local volume `${DATA_DIR}/reports/{workspaceId}/{id}/` (D1 internal;
  URI scheme keeps S3 possible later). Retention: immutable, kept indefinitely (SRS A3).

## 4. Report center UX contract (FR-REPORTS-1)

| Surface | Contract |
|---|---|
| List | history table: type, scope (repo names + window), generated_by, generated_at, status chip; filter by type/repo; cursor-paginated (FR-API-3) |
| Generate | modal: type → repo set + window (defaults from active view) → confirm; row appears `queued` immediately, live status via polling |
| View inline | `ready` opens stored HTML in-app (sandboxed iframe route) — pixel-identical to the PDF source, reopening renders identical stored content |
| Download | `GET /api/v1/reports/:id/pdf` streams stored artifact; content-disposition filename `repopulse-{type}-{scope}-{date}.pdf` |
| Regenerate | "regenerate with same scope" clones params with fresh windowEnd/snapshotAt (FR-REPORTS-7) |
| Failure | `failed` chip + error detail + retry (re-enqueue same params); DLQ visible on admin ops page (NFR-11) |

AuthZ: members generate + view within workspace (FR-AUTH-4); artifacts served through the API
with session check — never a public static path (NFR-4/6).

## 5. Audit-pack framing (P3/P4 defensibility)

Every PDF ships as a self-defending document:
1. **Cover page** — report type, workspace, scope (repo list), data window (start/end),
   generated-at, generated-by, report id + params digest (verifiable reference).
2. **Basis box** (page 2) — data sources ("GitHub API via RepoPulse warehouse; no repository
   clone — C1"), snapshotAt pin, sync-lag note per included repo (from FR-INGEST-8 status at
   generation: any repo not `live`/fully backfilled is flagged "partial data").
3. **Heuristic footnotes inline** — every DORA/heuristic number footnotes its basis label
   (FR-METRICS-12 acceptance: basis present in payload → rendered).
4. **Appendix A: metric definitions** — auto-generated from the FR-METRICS-15 catalog at
   `catalogVersion` (id, name, formula text, unit, direction, heuristic notes) — every number
   in the report is defined in the same document, so figures are defensible standalone.
5. **Appendix B (Security Posture only)** — egress audit table + finding-schema/version notes
   (ANALYSIS_TIERS.md §3/§4).
6. Page numbers + generated-at in every footer (FR-REPORTS-6).

## 6. Assembler interface & test hooks

```ts
export interface ReportAssembler {
  assemble(params: ReportParams): Promise<ReportData>;      // pure warehouse reads, deterministic
}
export interface ReportData {
  params: ReportParams; sections: ReportSection[];          // ordered per §1 outlines
  appendix: { definitions: MetricCatalogEntry[]; egressSummary?: EgressSummary };
  dataQuality: { repoId: string; phase: string; partial: boolean }[];  // feeds Basis box §5.2
}
export type ReportSection =
  | { kind: 'summary'; markdown: string }
  | { kind: 'score_breakdown'; rows: ScoreBreakdownRow[] }
  | { kind: 'table'; id: string; columns: string[]; rows: unknown[][] }
  | { kind: 'chart'; id: string; echartsOption: object }    // serialized option = deterministic render
  | { kind: 'no_data'; id: string; reason: string };        // FR-REPORTS-2: never blank
```

Testing (docs/TESTING.md gates): assembler snapshot tests per report type against the seeded
fixture warehouse (same fixtures as METRICS.md worked examples E1–E3); PDF pipeline E2E =
generate → poll ready → download → `pdf-parse` asserts section headings + footnote text
present and generation ≤30s (FR-REPORTS-6); byte-stability test regenerates from the same
stored ReportData and diffs PDF bytes. Metrics (NFR-12): `report_generate_seconds` histogram,
`report_failures_total{type}`, queue depth on the admin ops page.
