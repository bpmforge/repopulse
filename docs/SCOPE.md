# RepoPulse — Scope

Traces to: `docs/work/FOUNDING_BRIEF.md`. Scope items are numbered **S-x** for
traceability; downstream FR-x/NFR-x requirements (per C3) must cite an S-x.

## In scope — v1 (MVP: health dashboard slice, per D5)

| ID | Item | Brief trace |
|----|------|-------------|
| S-1 | GitHub OAuth login; session management; login identity drives personalized views ("my PRs", "my review load"). | D6 |
| S-2 | Workspace model: `workspace_id` on every tenant-scoped table; single `default` workspace at launch. No billing, no self-serve onboarding. | D1 |
| S-3 | `ForgeProvider` interface + GitHub implementation (REST + GraphQL). All data via API — commits, PR files/diffs, reviews, review comments, checks/CI runs, issues, releases, targeted contents fetches. No cloning. | C1, D3 |
| S-4 | Org connect flow: select org → register webhooks → kick off backfill. | D5 |
| S-5 | 12-month historical backfill with rate-limit budgeter, ETag conditional requests, incremental sync cursors; resumable and idempotent. | D5, C1 |
| S-6 | Webhook ingestion for ongoing sync (push, PR, review, check, issue, release events) + nightly reconciliation sweep for missed deliveries. | C1 |
| S-7 | Tier-1 metrics engine computing the baseline catalog: commit churn; file hotspots (churn × recency); ownership/bus factor; PR cycle-time stages (open → first review → approval → merge); review coverage %; merged-without-review rate; PR size distribution; stale PRs; CI pass rate + duration trends; issue throughput; release cadence; DORA approximations (deployment frequency, lead time, change-failure rate via revert/hotfix heuristic). | D5, brief metric catalog |
| S-8 | Dashboard web app with drill-down: org rollup → repo → PR/file → detail. ECharts visualizations, trend windows (e.g. 30/90/365d). | D5 |
| S-9 | Custom saved views (filter + layout persistence per user) including the personalized P2 views. | D6, brief product line |
| S-10 | Postgres 16 + Drizzle schema for all of the above; Redis + BullMQ job infrastructure (backfill, webhook processing, metric computation, reconciliation). | brief tech stack |
| S-11 | Podman deployment to bpmforge infra at `repopulse.bpmforge.com`. | D1 |
| S-12 | `analysis` module boundary stubbed (LLM gateway interface + dimension checklists defined, not executed) so Tier 2/3 lands without rearchitecture. | D2, brief modules |

## In scope — v1.x (roadmap, designed-for now, built later)

| ID | Item | Brief trace |
|----|------|-------------|
| S-20 | Tier-2 LLM review: LM Studio LAN gateway, chunked diff review (C2: 45k maxTokens headroom, ~10k usable output, retry + warm-up), dimension checklists (code health, security, performance, test coverage), findings persisted to `insights`. | D2, C2 |
| S-21 | Report center: in-app report history + exportable audit-ready PDF packs. | D7 |
| S-22 | Gitea adapter implementing `ForgeProvider`. | D3 |
| S-23 | Tier-3 deep review: Claude API, opt-in per repo/PR, minimized payload (see CONSTRAINTS.md). | D2 |
| S-24 | Findings scoring/trends in `insights` (confidence scores, verify tier, trend lines over findings). | D2 |
| S-25 | PR comment write-back of review findings (advisory only, never blocking). | NON_GOALS N-3 boundary |

## In scope — wave W8: Security Suite (post-v1, per D8/C1a; design: docs/design/SECURITY_SUITE.md)

| ID | Item | Brief trace |
|----|------|-------------|
| S-30 | Pluggable scanner framework: `Scanner` interface + registry + `ScannerContext` (diff stream, targeted fetch, snapshot handle, prior findings, LLM gateway), per-repo enablement + per-scanner budgets/timeouts; findings persist into the existing `insights` store (extended schema — dimensions, scanner/rule/CVE/chain columns). New scanners register without core changes. | D8 (FR-SEC-1/11/12) |
| S-31 | Snapshot service: forge API tarball via the budgeted client into an ephemeral sandboxed scratch dir (hash-pinned SHA, traversal guards, size caps, locked-down no-network container, shred after scan); never `git clone`, nothing persisted but findings. | C1a, D8 (FR-SEC-2, NFR-13/14) |
| S-32 | Secrets scanning: stream mode on every ingested diff + history mode over 12-month backfilled patches (TruffleHog-compatible rules, entropy, verified-secret escalation to severity 5). | D8 (FR-SEC-3/4) |
| S-33 | Dependency audit: syft SBOM + grype/OSV CVE match + CISA KEV correlation + slopsquatting detection from targeted manifest/lockfile fetches; daily default-branch posture. | D8 (FR-SEC-5) |
| S-34 | Semgrep SAST (weekly snapshot fulls + diff-scoped PR runs, workspace rule packs, REAL/FP/UNVERIFIED triage) + OWASP Web/LLM Top-10 checklist scanners via the Tier-2/3 gateway + attack chainer composing yields→preconditions across all findings. | D8 (FR-SEC-6/7/8) |
| S-35 | Security surfaces: Findings Explorer scanner/CVE/KEV/chain facets, per-repo Security tab, org security rollup tile, enriched Security Posture report sections; scanner backlog (IaC, cloud, anti-slop, container-image) lands as drop-in registry entries. | D8 (FR-SEC-9/10) |

## Out of scope

Enumerated with rationale in `NON_GOALS.md` (N-1 … N-9). Binding summary: no `git clone`
ever — full-repo SAST deferred to W8 over ephemeral C1a tarball snapshots (N-1 as amended),
no CI runner, no PR-blocking gate bot in v1, no email/Slack delivery in v1, no
billing/multi-org onboarding in v1, no GitLab/Bitbucket, no IDE plugin, no replacement
for deep security audits.

## Change control

Adding an S-x requires updating this file and NON_GOALS.md if it graduates a non-goal
(S-30..S-35 graduated the SAST half of N-1 via the D8/C1a brief amendment, 2026-07-07);
it must not contradict D1–D8 / C1–C3 without a brief amendment.
