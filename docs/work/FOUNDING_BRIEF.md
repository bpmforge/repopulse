# RepoPulse — Founding Brief (locked decisions, 2026-07-07)

Product: clone-free GitHub repository health, code-quality and delivery-performance
monitoring web service with drill-down dashboard, custom views, and a report center.
bpmforge family (ThreatForge sibling). All downstream docs trace to this brief.

## Locked decisions (from discovery interview with Brad)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Deployment/tenancy | Internal on bpmforge infra (`repopulse.bpmforge.com`, Podman), SaaS-ready: `workspace_id` on every tenant-scoped table, single `default` workspace at launch. No billing/onboarding scope in v1. |
| D2 | Analysis engine | Tiered hybrid. **Tier 1** API-derived metrics, always on. **Tier 2** local LLM (LM Studio on LAN) bulk diff review. **Tier 3** Claude API deep review, opt-in per repo/PR. Review dimensions ported from bpm-opencode-experts: code health, security, performance, test coverage. |
| D3 | Forge scope | GitHub v1 behind a `ForgeProvider` interface; Gitea adapter is a v1.x ticket. |
| D4 | Name | RepoPulse (`~/Code/repopulse`, dual remotes Gitea origin + GitHub). |
| D5 | MVP slice | Health dashboard first: connect org → backfill 12 months → Tier-1 metrics dashboard with drill-down (org → repo → PR/file → detail). LLM review is roadmap wave 2, not MVP. |
| D6 | Auth | GitHub OAuth; login identity powers personalized views ("my PRs", "my review load"). |
| D7 | Reports | In-app report center with history + exportable audit-ready PDF packs. Email digests / Slack push are explicitly deferred (non-goals v1). |

## Hard constraints

- **C1 No cloning.** All analysis via forge APIs (commits, PR files/diffs, targeted
  contents fetches, checks, reviews). Rate-limit budgeting, ETag conditional requests,
  and incremental sync cursors are first-class architecture concerns.
- **C2 Local-LLM ops reality** (from prior bpmforge projects): 45000 maxTokens headroom
  per local call; retry + warm-up for LM Studio transient "model crashed"; real usable
  output ≈10k tokens on qwen3.6-class models → diff review must be chunked.
- **C3 Cheap-agent buildability.** Every doc is written to be executed by inexpensive
  coding agents (RetroForge pattern: `MASTER_PROMPT.md` → `plan.json` → `PLAYBOOK.md`).
  Requirements carry IDs (FR-x / NFR-x) for traceability.

## Personas (P1–P4)

- **P1 Engineering Lead** — org/repo health rollup, hotspots, review bottlenecks, delivery trends.
- **P2 Developer** — my open PRs, my review load, hotspots in code I own, feedback on my changes.
- **P3 Security Engineer** — security findings, dependency/secret signals, audit-ready PDF packs.
- **P4 Engineering Manager / Exec** — DORA-style trends, throughput, exec summary reports.

## Fixed tech stack (Phase 3 may refine versions, not direction)

TypeScript / Node 22, pnpm monorepo (`apps/api`, `apps/web`, `packages/*`), Fastify,
PostgreSQL 16 + Drizzle ORM, Redis + BullMQ jobs, React 18 + Vite + TanStack
Router/Query, Tailwind 4 + shadcn/ui, ECharts, vitest + Playwright.

## Fixed module boundaries

`forge` (ForgeProvider + GitHub impl) · `ingest` (backfill, webhooks, cursors, rate
budgeter) · `metrics` (Tier-1 computations) · `analysis` (Tier-2/3 LLM gateway +
dimension checklists) · `insights` (findings store, scoring, trends) · `reports`
(report center + PDF) · `auth` (GitHub OAuth, sessions, workspaces) · `api` · `web`.

## Tier-1 metric catalog (baseline; METRICS design doc may extend)

Commit churn · file hotspots (churn × recency) · ownership / bus factor · PR cycle-time
stages (open → first review → approval → merge) · review coverage % ·
merged-without-review rate · PR size distribution · stale PRs · CI pass rate + duration
trends · issue throughput · release cadence · DORA approximations (deployment frequency,
lead time, change-failure rate via revert/hotfix heuristic).
