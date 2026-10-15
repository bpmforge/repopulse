# RepoPulse — Vision

Traces to: `docs/work/FOUNDING_BRIEF.md` (D1–D16, C1–C3, P1–P4). This document restates
direction; it does not re-open any locked decision.

> Restated 2026-10-15 (D16): this document previously described a clone-free
> "repo health, quality, and delivery monitoring web service" and positioned
> against SonarQube as "they clone and scan; RepoPulse reads the API". The
> scanners added by D8, D10, D11, D12 and D13 made Repo Pulse a code security
> and quality platform; D16 says so. Delivery metrics stay, as context.

## Problem

Teams now ship code that a model wrote, and they have two kinds of tool to check
it. Both fall short:

1. **Rule-based SAST drowns people.** Vendor and benchmark reports put false
   positives at 60–90% out of the box and 10–20% even after tuning (Mend), and
   security engineers spend 50–80% of their time on triage. Tools ship thousands
   of rules on day one and the standard advice is to tune for weeks. Findings
   that never get resolved "generally get ignored".
2. **AI reviewers are SaaS, model-first and unproven.** Every AI reviewer in
   Sourcegraph's 2026 roundup is SaaS, and self-hosting is Enterprise-only for
   Qodo, CodeRabbit, Greptile and DeepSource. Precision varies widely between them, almost no vendor publishes a
   reproducible number, and they miss business logic, auth and permission
   changes, and IDOR. Their failure mode is false confidence.

Meanwhile AI-written code needs governing and few teams check it: vendor reports
say only 24% of organisations comprehensively evaluate it (Black Duck). For a
team that cannot send its code to a third party, the choice today is a noisy
scanner or nothing. Sources and the full landscape: COMPETITIVE_ANALYSIS.md.

## The Repo Pulse answer

Repo Pulse is **a self-hosted code security and quality platform for teams
shipping AI-written code, with delivery metrics as context** (D16). It checks
code, AI-written or not, with rules first and the customer's own model second,
proves every finding and every fix, ranks them by real risk, and tracks them
until they are gone, without the code leaving the customer's network.

- **Rules first, model second.** Deterministic rules (Opengrep packs, the
  in-process fast lane, standalone tools) settle what they can on CPU. The model
  only judges what is left, and a second model on another host has to agree
  before an LLM finding shows (D9 maker ≠ verifier).
- **Built for AI-written code.** Anti-slop, logging and perf rule packs with a
  cited evidence base: hallucinated packages and names, duplication, swallowed
  errors, tests that test nothing (D11, W18).
- **Every rule earns its place.** New rules run in shadow, are promoted on
  measured precision and flagged when they become noisy; the customer sees each
  rule's precision (D11, W18-22).
- **Ranked by real risk.** One score across every finding type: severity ×
  likelihood × exposure, where exposure is how often the code changes (D12).
- **Fixes proven and tracked.** A model-drafted patch is shown only after Repo
  Pulse re-scans the patched snapshot and the finding clears with nothing new
  (W18-19); every finding becomes a plan item a nightly job marks done or
  regressed (D9).
- **Never writes to your repos.** PR-time results reach developers because the
  customer's own CI pulls them with its own token (W18-18). Repo Pulse opens no
  branch, posts no comment and holds no write scope (D9a).

It ingests through forge APIs (commits, PR files/diffs, reviews, checks, issues,
releases — never `git clone`, per C1); deep scans fetch the API tarball into an
ephemeral sandbox, scan and delete it (C1a). Everything is stored in Postgres
**in the customer's own environment** (D1a). Data stays where the customer
installed it; the only opt-in exception is Tier-3 frontier-LLM review (D2),
which writes a data-egress audit row.

**Delivery model: customer-hosted.** A customer installs the container stack in
their own environment, points it at their own forge (GitHub, GitLab or Gitea),
and optionally at their own LLM. SaaS-ready by construction (`workspace_id`
everywhere), single `default` workspace per install. bpmforge's own deployment
is the **dogfood install, not the product** (D1a, 2026-08-13).

> Superseded 2026-09-08 (product-completion D15): this document previously read
> "internal-only in v1" and placed the database "on bpmforge infra". That
> phrasing predates D1a and contradicted it. See
> `docs/work/product-completion/DECISIONS.md`.

## Product pillars

| Pillar | What it is | Brief trace |
|--------|-----------|-------------|
| **1. Code security scanning** | Secrets (diff stream + full history), SBOM/CVE with KEV and slopsquatting, validated down to affected with VEX, Opengrep SAST, OWASP checklists, attack chaining; pluggable scanner framework over sandboxed tarball snapshots. | D8, D10, C1a |
| **2. Code quality for AI-written code** | Own rule packs (anti-slop, logging, perf, correctness) per language, the in-process fast lane, complexity and duplication tools, risk registers (knowledge concentration, dependency health, EOL, architecture drift, test gaps); rule lifecycle with shadow mode and measured precision. | D11, D13, W18 |
| **3. Tiered, verified analysis** | Tier 1: API-derived metrics, always on. Tier 2: local LLM bulk review under C2 ops constraints. Tier 3: Claude API deep review, opt-in per repo/PR. LLM findings pass the verify pass and challenger gate; model-drafted patches are proven by re-scan before they show. | D2, D9, C2, D16 |
| **4. Risk, plans and proof** | One `effective_risk` ranking with action bands across every finding; plans with machine-checkable verify criteria and nightly done/regressed; findings delivered to the customer's CI by pull; audit-ready report center and PDF packs. | D7, D9, D12, D16 |
| **5. Delivery metrics as context** | Clone-free ingestion (ForgeProvider: GitHub, GitLab, Gitea) with rate-limit budgeting, 12-month backfill, Tier-1 catalog (hotspots, ownership, PR cycle time, review coverage, DORA approximations) and an org → repo → PR/file → detail drill-down. Hotspots feed the risk model's exposure factor. | C1, D3a, D5, D14 |

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
| P2 Developer | One saved view answers "what do I owe, what's owed to me, what's risky in code I own" — no GitHub tab archaeology. New findings on their PR show up in their own CI, with a verified patch to copy where one exists (W18-18, W18-19). |
| P3 Security Engineer | Pulls an audit-ready PDF pack (v1.x) instead of a week of manual evidence assembly; security signals per repo at a glance, ranked by real risk rather than raw severity. |
| P4 EM / Exec | Quarterly DORA-style trend report generated, not hand-built; can defend throughput narratives with data. |

## Positioning in one line each

- vs CodeRabbit, Qodo, Greptile, Copilot: the same bug-finding, but self-hosted on
  every tier, with verified findings and fixes, and a measured accuracy number
  instead of a claim.
- vs SonarQube and Codacy: fewer, proven findings, ranked by risk and churn, plus
  rules for AI-written code and an LLM layer they don't have.
- vs Snyk: reachability-style triage for code findings, not only for
  dependencies, and self-hosted.
- vs Kodus: self-hosting with a local model is not unique — Kodus (open source,
  AGPL) does it too. Kodus is a PR commenter; Repo Pulse is a scanner with a rule
  engine, a risk model and fix tracking.
- vs ThreatForge (`/security` deep audits): Repo Pulse is continuous signal and
  attention-routing; ThreatForge-style audits remain the assurance tool (see
  NON_GOALS N-8).

## Non-goals

Deliberately excluded scope is enumerated with rationale in NON_GOALS.md — headline:
no cloning, no CI runner, no PR-blocking bot (the customer's CI may gate on pulled
results with its own token; N-3, D16), no writes to customer repos (D9a), no quality
grades or developer leaderboards (N-9), no email/Slack delivery in v1 (D7), no
billing/multi-org onboarding in v1 (D1, N-5 — a self-hosted customer needs none of
those).
