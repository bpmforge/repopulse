# RepoPulse — Vision

Traces to: `docs/work/FOUNDING_BRIEF.md` (D1–D7, C1–C3, P1–P4). This document restates
direction; it does not re-open any locked decision.

## Problem

Engineering teams cannot answer basic questions about repository health, code quality,
and delivery performance without paying one of two taxes:

1. **The clone tax.** Existing quality platforms (SonarQube-class, CodeScene-class)
   require cloning every repository, running heavyweight analyzers, and maintaining
   worker fleets sized to the codebase — expensive to operate, slow to onboard, and
   overkill when the questions are "where are our hotspots, who is bottlenecking
   review, is delivery getting faster or slower?"
2. **The egress tax.** SaaS insight products (LinearB/Swarmia/Code Climate Velocity
   class) answer those questions but require shipping org metadata — and often source
   diffs — to a third party. For teams that self-host their infrastructure, that is a
   non-starter.

The result: leads eyeball GitHub Insights, developers guess at their review load,
security engineers assemble audit evidence by hand, and execs get vibes instead of
DORA trends.

## The RepoPulse answer

RepoPulse is a **clone-free, self-hosted** repo health, quality, and delivery
monitoring web service. It ingests everything through forge APIs (commits, PR
files/diffs, reviews, checks, issues, releases — never `git clone`, per C1), stores it
in Postgres **in the customer's own environment** (D1a), and serves a drill-down
dashboard, personalized views (D14), and an audit-ready report center (D7). Data
stays where the customer installed it; the only opt-in exception is Tier-3
frontier-LLM review (D2).

**Delivery model: customer-hosted.** A customer installs the container stack in
their own environment, points it at their own forge, and optionally at their own
LLM. SaaS-ready by construction (`workspace_id` everywhere), single `default`
workspace per install. bpmforge's own deployment is the **dogfood install, not
the product** (D1a, 2026-08-13).

> Superseded 2026-09-08 (product-completion D15): this document previously read
> "internal-only in v1" and placed the database "on bpmforge infra". That
> phrasing predates D1a and contradicted it. See
> `docs/work/product-completion/DECISIONS.md`.

## Three product pillars

| Pillar | What it is | Brief trace |
|--------|-----------|-------------|
| **1. Clone-free ingestion** | ForgeProvider abstraction (GitHub v1, Gitea v1.x) with rate-limit budgeting, ETag conditional requests, incremental cursors, webhooks + reconciliation. 12-month backfill on connect. | C1, D3, D5 |
| **2. Tiered analysis** | Tier 1: API-derived metrics, always on. Tier 2: local LLM (LM Studio LAN) bulk diff review under C2 ops constraints. Tier 3: Claude API deep review, opt-in per repo/PR. Review dimensions ported from bpm-opencode-experts: code health, security, performance, test coverage. | D2, C2 |
| **3. Drill-down dashboard + reports** | Org → repo → PR/file → detail navigation, custom saved views, personalized "my PRs / my review load" (via a linked forge identity, D14), in-app report center with history and exportable audit-ready PDF packs. | D5, D7, D14 |

## What "done" means for v1 (D5 MVP)

The MVP is the **health dashboard slice**, end to end:

1. Sign in with a local account — the bootstrap admin the install creates (D14;
   GitHub sign-in is optional, added by registering your own GitHub App).
2. Connect a forge with a personal access token (GitHub, GitLab or Gitea, each
   connection with its own base URL); backfill 12 months of history within rate
   budget (C1).
3. See the Tier-1 metric catalog (churn, hotspots, bus factor, PR cycle-time stages,
   review coverage %, merged-without-review rate, PR size distribution, stale PRs,
   CI pass rate/duration, issue throughput, release cadence, DORA approximations)
   on a dashboard that drills org → repo → PR/file → detail.
4. Webhooks keep data current after backfill; nightly reconciliation catches gaps.
5. Personalized views work ("my PRs", "my review load").

LLM review (Tier 2/3), PDF packs, and the Gitea adapter were scoped as wave 2+
and have since been built (the Gitea adapter W7-02, first run against a real
Gitea 1.24.7 on 2026-09-23; a GitLab adapter W12). See SCOPE.md and STATUS.md.

> Updated 2026-09-23 (release/v1-selfhost): items 1-2 previously read "Log in
> with GitHub OAuth (D6)" and "Connect a GitHub org". D14 (2026-08-20) replaced
> forge sign-in with local accounts and connection-by-token.

## North-star outcomes per persona

| Persona | North-star outcome |
|---------|-------------------|
| P1 Engineering Lead | Spots a review bottleneck or hotspot within 60 seconds of opening the org dashboard; delivery-trend regressions surface before the retro does. |
| P2 Developer | One saved view answers "what do I owe, what's owed to me, what's risky in code I own" — no GitHub tab archaeology. |
| P3 Security Engineer | Pulls an audit-ready PDF pack (v1.x) instead of a week of manual evidence assembly; security signals per repo at a glance. |
| P4 EM / Exec | Quarterly DORA-style trend report generated, not hand-built; can defend throughput narratives with data. |

## Positioning in one line each

- vs SonarQube/CodeScene-class: they clone and scan; RepoPulse reads the API and
  stays cheap to run and instant to onboard.
- vs LinearB/Swarmia-class: same questions, zero data egress — the customer
  self-hosts it and the data never leaves their environment.
- vs GitHub Insights: cross-repo rollup, drill-down, saved views, audit reports,
  and LLM review tiers that GitHub does not offer.
- vs ThreatForge (`/security` deep audits): RepoPulse is continuous signal and
  attention-routing; ThreatForge-style audits remain the assurance tool (see
  NON_GOALS N-8).

## Non-goals

Deliberately excluded scope is enumerated with rationale in NON_GOALS.md — headline:
no cloning, no CI runner, no PR-blocking bot in v1, no email/Slack delivery in v1
(D7), no billing/multi-org onboarding in v1 (D1, N-5 — a self-hosted customer
needs none of those).
