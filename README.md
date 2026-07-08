# RepoPulse

Clone-free GitHub repository health, code-quality and delivery-performance
monitoring. Connect an org, backfill history through the forge APIs (never
`git clone`), and get a drill-down dashboard (org → repo → PR → file →
finding), custom saved views, and an in-app report center with exportable
PDF packs.

**Analysis is tiered:**

| Tier | Engine | Cost | What it does |
|------|--------|------|--------------|
| 1 | API-derived metrics | free | hotspots, churn, ownership/bus factor, PR cycle time, review coverage, CI health, DORA approximations |
| 2 | Local LLM (LM Studio on LAN) | ~free | bulk diff review against expert-system dimension checklists (code health, security, performance, test coverage) |
| 3 | Claude API (opt-in per repo) | paid | deep review of flagged/critical PRs |

**Status:** SDLC design package complete; implementation executed ticket-by-ticket
by coding agents. Entry point for agents: `MASTER_PROMPT.md` → `plan.json` →
`PLAYBOOK.md`. Humans: start with `docs/VISION.md` and `docs/ARCHITECTURE.md`.

## Stack

TypeScript / Node 22 · pnpm monorepo · Fastify · PostgreSQL 16 + Drizzle ·
Redis + BullMQ · React 18 + Vite + TanStack Router/Query · Tailwind 4 +
shadcn/ui · ECharts · vitest + Playwright. Deployed as Podman containers on
bpmforge infra (internal, SaaS-ready tenancy).

## Docs

| Doc | What |
|-----|------|
| `docs/work/FOUNDING_BRIEF.md` | Locked decisions D1-D7, constraints, personas |
| `docs/VISION.md`, `docs/SCOPE.md` | Product definition |
| `docs/SRS.md`, `docs/USER_STORIES.md` | Requirements + stories (traceable IDs) |
| `docs/ARCHITECTURE.md` + `docs/design/*` | C4 architecture + subsystem deep-dives |
| `docs/research/*` | Verified GitHub API + competitive research |
| `docs/ROADMAP.md`, `plan.json` | Waves, exit criteria, ticket board |
| `docs/STATUS.md` | Progress ledger |
