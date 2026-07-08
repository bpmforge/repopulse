# RepoPulse — User Stories

Traces to `docs/SRS.md` (FR/NFR IDs) and `docs/work/FOUNDING_BRIEF.md` (P1–P4, D1–D8).
Points: Fibonacci. **[MVP]** = roadmap wave 1 (D5). Epics align to modules/waves.

Personas: P1 Engineering Lead · P2 Developer · P3 Security Engineer · P4 EM/Exec.
(Admin actor = whichever persona holds the admin role, typically P1.)

## Epic E1 — Connect + Ingest (forge, ingest, auth) [MVP wave]

### E1.1 Sign in with GitHub [MVP] — 3 pts — FR-AUTH-1, FR-AUTH-2, FR-AUTH-6
As P2, I want to sign in with my GitHub account so that RepoPulse knows who I am and can personalize my views.
- OAuth round-trip creates my user linked to my GitHub login/avatar
- Session survives reload; logout fully revokes; expired session redirects to login
- My forge identity is linked so "my PRs" can resolve later

### E1.2 Connect an org [MVP] — 5 pts — FR-INGEST-1, FR-FORGE-5, FR-AUTH-4, FR-AUTH-5
As P1 (admin), I want to connect our GitHub org with a PAT or GitHub App so that RepoPulse can start monitoring our repos.
- Credential accepted (PAT or App), stored encrypted, shown only as fingerprint/last-4
- Accessible repos listed; I can pick specific repos or "all + auto-add new"
- Members cannot access the connect flow (403)

### E1.3 Watch the 12-month backfill [MVP] — 8 pts — FR-INGEST-2/3/4/8, FR-FORGE-3/4, NFR-1, NFR-2
As P1, I want backfill to run unattended with visible progress so that I trust the data will arrive without babysitting rate limits.
- Per-repo progress (% + entity phase) and org banner while backfilling
- Backfill survives worker restart and rate-limit pauses without restarting from zero
- Most-active repos' PR data lands first
- 50-repo org completes ≤24h within budget (benchmark evidence)

### E1.4 Stay current via webhooks [MVP] — 5 pts — FR-INGEST-5/6, NFR-10
As P1, I want new activity to appear automatically so that dashboards are never stale.
- Webhooks auto-registered at connect; forged/unsigned deliveries rejected 401
- PR/push/check/release events reflected in warehouse ≤60s
- Replayed deliveries are idempotent (no duplicates)

### E1.5 Nightly self-repair [MVP] — 3 pts — FR-INGEST-7, FR-FORGE-4
As P1, I want a nightly reconciliation sweep so that missed webhooks never silently corrupt metrics.
- Injected gap in fixtures is healed by the sweep
- Sweep of unchanged repos consumes near-zero rate budget (ETag 304s)

### E1.6 Pause or remove a repo — 2 pts — FR-INGEST-9
As P1, I want to pause or disconnect a repo so that noise or decommissioned projects drop out cleanly.
- Pause stops all jobs; remove deregisters the webhook; optional data purge

## Epic E2 — Tier-1 Metrics (metrics) [MVP wave]

### E2.1 PR cycle-time stages [MVP] — 5 pts — FR-METRICS-4, FR-METRICS-13/14
As P1, I want median+p90 durations for open→first-review→approved→merged so that I can find the slowest stage of our review pipeline.
- Stage bars per repo + org rollup, window-selectable (7/30/90/365d)
- Bot PRs excluded per configurable list; trend vs prior window shown

### E2.2 Review discipline [MVP] — 3 pts — FR-METRICS-5/6
As P1, I want review coverage % and merged-without-review rate so that unreviewed merges are visible and listable.
- Both numbers per repo + org; click-through to the exact offending PRs

### E2.3 Hotspots & churn [MVP] — 5 pts — FR-METRICS-1/2
As P2, I want file hotspot rankings (churn × recency) so that I know which files in code I own are risk concentrations.
- Top-N hotspot list per repo with score components and contributing commits
- Churn split gross/net/rework

### E2.4 Ownership / bus factor [MVP] — 3 pts — FR-METRICS-3
As P1, I want per-area bus factor so that single-owner files are flagged before people leave.
- Files/dirs with top-author share ≥80% flagged; bus factor number per directory

### E2.5 PR size + staleness [MVP] — 3 pts — FR-METRICS-7/8
As P1, I want PR size distribution and stale-PR lists so that oversized and stuck work is surfaced.
- XS–XL histogram + median trend; stale list age-sorted with configurable threshold

### E2.6 CI health [MVP] — 3 pts — FR-METRICS-9
As P2, I want CI pass rate, duration trends, and flaky-workflow ranking so that I know where pipeline pain comes from.

### E2.7 Throughput, releases, DORA [MVP] — 5 pts — FR-METRICS-10/11/12
As P4, I want issue throughput, release cadence, and DORA approximations so that I can track delivery performance quarter over quarter.
- Deployment frequency, lead time, change-failure rate with heuristic-basis labels
- All trendable via snapshots (FR-METRICS-13)

### E2.8 Transparent definitions [MVP] — 2 pts — FR-METRICS-15
As P4, I want every metric's formula visible in a tooltip so that numbers are defensible in front of leadership.

## Epic E3 — Dashboard Shell + Drill-down (web, api, insights) [MVP wave]

### E3.1 Org overview landing [MVP] — 5 pts — FR-WEB-1, FR-INSIGHTS-2/3/4, FR-API-1/2, NFR-3
As P1, I want a dark-first org overview with health scores, metric tiles, sparklines, and sync status so that one glance answers "are we healthy?".
- Health score 0–100 with full formula breakdown on click (no black box; Tier-1-only basis labeled)
- Every tile shows trend delta ▲/▼ vs prior window
- p95 page data <500ms from warehouse; zero live forge calls

### E3.2 Drill-down with breadcrumbs [MVP] — 8 pts — FR-WEB-2, FR-API-5
As P1, I want to drill org→repo→PR→file→finding with a persistent breadcrumb so that I can go from a bad org number to the exact line-level cause and back.
- Every level is a deep-linkable URL; browser back and breadcrumb both work
- Repo page: score, metrics, hotspots; PR page: stage timings, reviews, checks, files; file page: churn, owners, hotspot history

### E3.3 Sparklines + heatmap visualizations [MVP] — 5 pts — FR-WEB-3, NFR-5
As P4, I want sparklines on tiles and a hotspot treemap heatmap so that trends and risk concentrations read instantly.
- ECharts trend lines for all snapshot metrics; directory treemap with hotspot intensity
- Charts have accessible data-table fallbacks (WCAG 2.2 AA)

### E3.4 Command palette ⌘K [MVP] — 3 pts — FR-WEB-6
As P2, I want ⌘K fuzzy quick-nav to any repo, PR, view, or report so that navigation never needs the mouse.
- Keyboard-only: open palette → type → Enter navigates; recent items surfaced first

### E3.5 My PRs / my review load [MVP] — 3 pts — FR-WEB-7, FR-AUTH-6
As P2, I want personal widgets for my open PRs and my pending review requests so that my day starts on my dashboard, not GitHub search.

### E3.6 Honest empty/sync states [MVP] — 2 pts — FR-WEB-8, FR-INGEST-8
As P1, I want backfilling repos to show progress instead of zeros so that I never mistake "still syncing" for "no activity".

## Epic E4 — Custom Views (web, api) [MVP wave]

### E4.1 Save a custom view [MVP] — 5 pts — FR-WEB-4, FR-API-6
As P1, I want to save a named view (repo filter + window + tile layout) so that my team-slice of the org is one click away.
- Create/rename/delete; persists across sessions; per-user default view on login

### E4.2 Share a view link [MVP] — 3 pts — FR-WEB-5, FR-API-6
As P4, I want a stable URL for a saved view so that I can pin "exec: platform repos, 90d" in our wiki and everyone sees the same layout.
- Any workspace member opening the link sees identical filters/layout; non-members get 403

## Epic E5 — Report Center + PDF (reports) [MVP wave]

### E5.1 Generate + browse reports [MVP] — 5 pts — FR-REPORTS-1/7
As P4, I want to generate reports on demand and browse an immutable history so that last quarter's numbers stay reproducible.
- History lists type/scope/window/author/time; reopening renders the stored snapshot

### E5.2 Repo Health report [MVP] — 3 pts — FR-REPORTS-2
As P1, I want a repo health report (score breakdown, metrics, hotspots, stale PRs) so that repo reviews have a standing artifact.

### E5.3 Org Exec Summary [MVP] — 3 pts — FR-REPORTS-3
As P4, I want an org exec summary (rollups, DORA trends, per-repo score table, notable deltas) so that leadership updates write themselves.

### E5.4 Delivery/DORA report [MVP] — 2 pts — FR-REPORTS-5
As P4, I want a delivery report with heuristic footnotes so that DORA claims are auditable.

### E5.5 PDF export [MVP] — 5 pts — FR-REPORTS-6
As P3, I want any report exported as a paginated, audit-ready PDF so that compliance packs don't require screenshots.
- Header/footer, page numbers, generated-at; same stored report → byte-stable PDF

### E5.6 Security Posture report — 3 pts — FR-REPORTS-4
As P3, I want a security posture report (findings by severity, review-bypass rate, dependency/secret signals) so that audits start from evidence, not vibes. (v1.x; degrades to Tier-1-only sections.)

## Epic E6 — Tier-2 Local-LLM Review (analysis, insights) [wave 2]

### E6.1 Auto-review PRs on the LAN — 8 pts — FR-ANALYSIS-1/2/3/8, NFR-8
As P1, I want new PRs bulk-reviewed by the local LLM so that every change gets a quality pass at zero API cost.
- Diff chunked (≤10k expected output/chunk, 45k maxTokens, warm-up+retry per C2)
- Per-repo auto-analyze policy + manual "analyze now"; LAN concurrency cap

### E6.2 Dimension checklists — 5 pts — FR-ANALYSIS-4/5
As P3, I want findings tagged code-health/security/performance/test-coverage with severity, confidence, file/line, and evidence so that triage is filterable and trustworthy.

### E6.3 Dedup + finding lifecycle — 5 pts — FR-ANALYSIS-6, FR-INSIGHTS-1, FR-WEB-9
As P2, I want re-runs to update existing findings (not duplicate) and let me acknowledge/resolve so that the findings list stays actionable.
- Unchanged PR re-analysis creates 0 new rows; resolved-but-reappearing findings reopen

### E6.4 Findings enrich scores + hotspots — 3 pts — FR-INSIGHTS-2/5
As P1, I want open findings to feed the health score security sub-score and hotspot ranking so that LLM insight changes the headline numbers transparently.

### E6.5 Degrade gracefully — 3 pts — NFR-7
As P1, I want Tier-1 dashboards untouched and a clear "analysis paused" banner when LM Studio hosts are down so that a LAN outage never looks like a product outage.

## Epic E7 — Tier-3 Deep Review + Scheduling (analysis) [wave 2/3]

### E7.1 Opt-in Claude deep review — 5 pts — FR-ANALYSIS-7, FR-ANALYSIS-1
As P1 (admin), I want to opt specific repos/PRs into Tier-3 Claude review so that critical changes get frontier-grade analysis while everything else stays local.
- Opt-in per repo with per-PR override; non-opted repos can never dispatch T3
- Per-call cost recorded and visible

### E7.2 Egress audit log — 3 pts — NFR-9
As P3, I want an audit log of exactly what was sent to the Claude API (repo, PR, sizes, digest, initiator, time) so that data-egress questions have answers.

### E7.3 Analysis scheduling controls — 3 pts — FR-ANALYSIS-8
As P1, I want org-level schedules and concurrency caps for analysis so that review runs don't starve ingest or melt the LAN hosts.

## Epic E8 — Gitea Adapter (forge) [v1.x]

### E8.1 GiteaProvider — 8 pts — FR-FORGE-7, FR-FORGE-1
As P1 (bpmforge internal), I want to connect our Gitea instance through the same ForgeProvider interface so that internal repos get the same dashboards as GitHub ones.
- Full contract-test suite passes against Gitea fixtures; connect flow offers forge type
- Webhook signature scheme + rate handling adapted to Gitea semantics

### E8.2 Mixed-forge org views — 3 pts — FR-METRICS-14, FR-API-5
As P1, I want GitHub and Gitea repos side-by-side in rollups and drill-down so that forge choice is invisible to consumers of the data.

## Epic E9 — Admin / Ops (auth, api, ops) [MVP hardening]

### E9.1 Workspace roles [MVP] — 3 pts — FR-AUTH-3/4, NFR-4
As P1 (admin), I want admin vs member roles enforced on every route so that credential and config surfaces are locked down.
- Route-walker test: members 403 on all admin endpoints; tenancy isolation suite green

### E9.2 Credential hygiene [MVP] — 3 pts — FR-AUTH-5, NFR-6
As P3, I want tokens encrypted at rest and never logged so that a DB or log leak doesn't leak forge access.

### E9.3 Ops visibility [MVP] — 3 pts — NFR-11, NFR-12
As P1 (admin), I want a queue/DLQ page plus budget and sync-lag gauges so that "is ingest healthy?" is answerable in one screen.
- Poison jobs land in visible DLQ with retry button; forge budget gauge live

### E9.4 Accessibility gate [MVP] — 3 pts — NFR-5
As P2 (keyboard user), I want the whole app — palette, charts, drill-down — usable by keyboard and screen reader so that WCAG 2.2 AA holds incl. dark theme contrast.

## Epic E10 — Security Suite (security) [wave W8, D8]

### E10.1 Enable scanners per repo — 3 pts — FR-SEC-1, FR-SEC-11
As P3 (with P1 as admin), I want to enable/disable each scanner per repo with sane workspace defaults so that noisy or irrelevant scanners never pollute findings.
- Secrets + dependency on by default; semgrep weekly; OWASP manual (LLM Top-10 auto-enables only on LLM deps)
- Admin-only config (members 403); disabled scanner never enqueues a job
- Per-scanner budget/timeout visible; blown budget shows `budget_exceeded` with partial findings flagged

### E10.2 Secrets caught on every diff — 5 pts — FR-SEC-3, FR-SEC-9
As P3, I want every ingested diff scanned for secrets (regex + entropy, TruffleHog-compatible rules) so that a leaked token surfaces within a minute of the push, not at the next audit.
- Finding appears ≤60s after webhook delivery; rides ingestion, no snapshot or container needed
- Verified secret ⇒ severity 5 + org banner + top of the repo Security tab
- Rulepack version stamped on every finding

### E10.3 History secrets sweep — 3 pts — FR-SEC-4
As P3, I want a scheduled sweep over all 12 months of backfilled patches so that secrets committed and then "removed" are still found.
- Committed-then-deleted fixture secret is found from history alone
- Re-runs dedup against stream findings (0 new rows on unchanged history)

### E10.4 Dependency posture (SBOM/CVE/KEV/slopsquat) — 8 pts — FR-SEC-5, FR-SEC-9
As P3, I want a daily SBOM + CVE + KEV + slopsquatting audit of every repo's default branch so that exploited-in-the-wild and AI-hallucinated dependencies are flagged without any checkout.
- syft SBOM per (repo, head SHA) from targeted manifest/lockfile fetches only
- grype/OSV findings carry `cve_id` + CVSS-mapped severity; KEV hits floored at severity 4 and faceted
- Hallucinated/typo-distance package fixture flagged `slopsquat`; posture counts by severity + age on the Security tab

### E10.5 Semgrep SAST over snapshots — 8 pts — FR-SEC-6, FR-SEC-2, NFR-13/14
As P3, I want weekly full semgrep runs (community + our custom rule packs) over ephemeral tarball snapshots, plus cheap diff-scoped runs on PRs, so that full-repo SAST works without ever cloning.
- Snapshot fetched via budgeted client at a pinned SHA, scanned in a no-network non-root container, shredded after — zero residual bytes even on crash
- Rule-pack config per workspace; pack/tool versions stamped on the scan run
- Triage REAL/FP/UNVERIFIED maps onto confirmed/dismissed(false_positive)/open

### E10.6 OWASP checklist reviews — 5 pts — FR-SEC-7
As P3, I want OWASP Web Top-10 and LLM Top-10 checklist reviews run through the existing Tier-2/3 gateway so that structured OWASP coverage lands in the same findings list as everything else.
- Same JSON finding schema + preconditions/yields; zod-validated; T3 only under existing opt-in rules
- LLM Top-10 auto-enabled only when the SBOM shows LLM dependencies

### E10.7 Attack chains — 5 pts — FR-SEC-8
As P3, I want findings from ALL scanners chained yields→preconditions into multi-step exploit paths so that three "medium" findings that compose into a breach read as the critical they are.
- Chain finding carries member ids + elevated severity (max member +1, cap 5)
- Dashboard renders the entry→…→impact path graph; nodes link to member findings
- Resolving any member auto-resolves the chain with an audit row

### E10.8 Security tab + org rollup — 5 pts — FR-SEC-10, FR-SEC-12
As P1 (with P3), I want a per-repo Security tab and an org security rollup tile so that security posture sits beside health scores, not in a separate tool.
- Security tab: posture score, CVE/KEV table, secrets status, open chains; Findings Explorer gains scanner/CVE/KEV/chain facets
- Org tile: open findings by severity, KEV + verified-secret counts, worst chain; drills down
- Scanner findings upgrade the health-score security sub-score basis label

### E10.9 Audit-ready security posture pack — 3 pts — FR-SEC-10, FR-REPORTS-4
As P3 (with P4), I want the Security Posture report enriched with per-scanner sections and a chains appendix so that the exported PDF is the audit evidence pack.
- One section per enabled scanner with posture counts + deltas vs prior run; disabled scanners state "not enabled", never blank
- Immutable history + PDF export semantics inherited from E5

## Summary

| Epic | Stories | Points | MVP points |
|------|---------|--------|------------|
| E1 Connect + Ingest | 6 | 26 | 24 |
| E2 Metrics | 8 | 29 | 29 |
| E3 Dashboard + Drill-down | 6 | 26 | 26 |
| E4 Custom Views | 2 | 8 | 8 |
| E5 Report Center + PDF | 6 | 21 | 18 |
| E6 Tier-2 LLM Review | 5 | 24 | 0 |
| E7 Tier-3 + Scheduling | 3 | 11 | 0 |
| E8 Gitea Adapter | 2 | 11 | 0 |
| E9 Admin / Ops | 4 | 12 | 12 |
| E10 Security Suite (W8) | 9 | 45 | 0 |
| **Total** | **51** | **213** | **117** |
