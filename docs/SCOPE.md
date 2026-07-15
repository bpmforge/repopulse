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

## In scope — 2026-07-14 additions (D9/D10; design: docs/design/IMPROVEMENT_PLANS.md, SECURITY_SUITE.md §3.6)

| ID | Item | Brief trace |
|----|------|-------------|
| S-40 | Improvement Plans engine: versioned deterministic recommendation catalog (condition over warehouse → template + evidence query + verify criterion), plans/plan_items with lifecycle + audit, nightly auto-verify job (done/regressed), plan section in every report, org tile, Plans page. | D9 (FR-PLANS-1/2/3/6) |
| S-41 | Working agreements: numeric thresholds over existing metrics + the actual exception list (offending PRs, 14d) + in-app digest card; violations feed plan items. No outbound channels (N-4). | D9 (FR-PLANS-4) |
| S-42 | Artifact-bound goals: refactor/supervise/acknowledged intents on files/dirs with time-aware warnings from snapshots. | D9 (FR-PLANS-5) |
| S-43 | Analysis quality loops: verify pass (maker≠verifier host affinity), challenger gate for severity≥4 pre-surfacing, FP-suppression memory, compound-risk detector. | D9 (FR-ANALYSIS-9/10, FR-INSIGHTS-6) |
| S-44 | Journey pack: persona picker at first login, onboarding checklist, first-insight toast, rail badges, My-Focus deltas, Weekly Pulse narrative, triage queue mode, report diff/schedule/annotations, visual deltas (tabular-nums, bento heroes). | D9 (FR-WEB/REPORTS extensions) |
| S-45 | CVE validation pipeline: alias dedup, dev/prod + direct/transitive scoping, import/usage detection, symbol reachability (govulncheck / generated semgrep rules), EPSS enrichment, effective-risk ranking, raw→affected funnel UI. | D10 (FR-SEC-13/15) |
| S-46 | VEX: triage↔OpenVEX justification mapping (not_affected requires a justification), OpenVEX + CycloneDX-embedded export with the SBOM, per-(package, vuln, version) suppression persistence with version-bump reopen. | D10 (FR-SEC-14) |

## In scope — wave W9: Code Health Suite (D11; design: docs/design/CODE_HEALTH_SUITE.md)

| ID | Item | Brief trace |
|----|------|-------------|
| S-50 | Code-health rulepack: OUR versioned semgrep custom pack implementing the tool-checkable anti-slop rules (empty catch, try/catch-in-loop, silent fallbacks, what-comments, narration blocks, emoji comments, stub-as-feature, prose padding) + logging antipatterns (console.log in prod paths, log-injection taint, secret-shaped values in log calls, local log-and-rethrow) — own license, no Semgrep-registry dependency. | D11 (FR-CH-1) |
| S-51 | `code_health_tools` scanner: lizard (complexity) + jscpd (duplication) over W8 snapshots in the sandbox with canon thresholds (workspace-tunable); findings + posture metrics written to metric_snapshots (`ch_*` keys) so trends ride the existing chart/report machinery. | D11 (FR-CH-2) |
| S-52 | `anti_slop` scanner (promoted from the W8 backlog): deterministic layer (S-50 pack + LDR structural-slop measurement + hallucinated-package reuse of FR-SEC-5) + T2 checklist layer for judgment rules (shallow modules, speculative abstraction, unwired scaffolding, privilege escalation, unvalidated LLM output); diff mode on pr_synced, snapshot mode weekly. | D11 (FR-CH-3) |
| S-53 | `logging_hygiene` scanner: deterministic patterns (S-50) + T2 checklist for level correctness, context adequacy, correlation-id propagation (OWASP Logging Cheat Sheet + Top-10 2025 A09 basis). | D11 (FR-CH-4) |
| S-54 | Checklist v2 bumps: performance checklist completes the 5 static scans (adds try/catch-in-hot-loop, hot-path allocations); code_health checklist cross-references slop rules; golden-prompt snapshots re-recorded. | D11 (FR-CH-5) |
| S-55 | Code-health surfaces: repo Code Health tab, org tile, `code_health` health-score sub-score, **Code Health report type** (FR-REPORTS-8), D9 plan-catalog v2 entries (duplication ceiling, complexity worst-functions, slop density, logging adoption). | D11 (FR-CH-6) |
| S-56 | Tier-1 debt signals (no scanner, warehouse-only): 14-day rework rate + revert rate per repo/file, snapshotted — the GitClear-style "mistake code" trend. | D11 (FR-CH-7) |
| S-57 | Rule lifecycle + intake: HealthRule schema (provenance/license/fixtures mandatory), shadow mode (experimental findings excluded from scores/banners/plans), FP-rate promotion/demotion gates, admin workbench; intake via field-lesson proposals, LLM-drafted rules (never auto-activated), license-gated external pack sync. | D11 (FR-CH-8/9) |
| S-58 | Tool adapter registry inside `code_health_tools`: standalone-only admission (no network/install), language auto-routing, per-tool license ledger; W9 adapters ruff (Python) + Biome (JS/TS); backlog roster (actionlint, hadolint, shellcheck, sqlfluff, vale, gocyclo). Per-language perf/correctness/framework semgrep packs (§9). | D11 (FR-CH-10) |

## In scope — wave W9: Unified Risk Model (D12; design: docs/design/RISK_MODEL.md)

| ID | Item | Brief trace |
|----|------|-------------|
| S-59 | Risk pricing engine: `effective_risk = 100·H·L·X` for EVERY open finding (all dimensions), deterministic + catalog-versioned (`risk_model.v1`, workspace-tunable); likelihood from EPSS/KEV (deps) or confidence × verify-status × D11 rule-precision prior; exposure from M2 hotspot percentile / dep_scope × reachability; decomposition persisted (`risk_factors`) and served; nightly `risk.reprice` with audited band transitions. | D12 (FR-RISK-1/2/3/4) |
| S-60 | Action bands act/schedule/track (SSVC-style, thresholds in catalog, KEV/secret/chain/compound override to act) driving: plan-generation rank input (replaces raw severity; pins unchanged), Top Risks cards (repo + org), default `effective_risk` sorts across finding surfaces, decomposition popover; raw severity + raw counts never hidden. | D12 (FR-RISK-4/5) |
| S-61 | Risk axes: existing health sub-scores rendered as A–E letters per risk type with per-axis top-contributor findings; "top risks + movement" opening section in repo_health / org_exec / security_posture reports. | D12 (FR-RISK-6) |

## In scope — wave W10: Engineering Risk Registers (D13; proposal: docs/work/D13_ENGINEERING_RISK_REGISTERS_PROPOSAL.md)

| ID | Item | Brief trace |
|----|------|-------------|
| S-62 | Knowledge-concentration register: module/dir-level bus-factor findings (active-maintainer count, top-contributor share, 180d window) weighted by hotspot percentile — warehouse SQL only, counts never names (N-9). | D13 (FR-REG-1) |
| S-63 | Dependency-health register: libyear drift, abandonment, deprecated/yanked, major-version lag from SBOM + nightly release_meta db-sync (sandbox stays no-network); license posture flags per workspace policy list (findings only, never gating). | D13 (FR-REG-2/4) |
| S-64 | Runtime/toolchain EOL register: endoflife.date db-sync (eol_products) checked against manifests, lockfiles, Dockerfile base images in the C1a snapshot; severity ramps on time past/until EOL. | D13 (FR-REG-3) |
| S-65 | Architecture-drift register phase A (config-free): dependency cycles, god modules, orphan clusters via standalone import-graph adapters (dependency-cruiser, import-linter, go list) through the D11 ToolAdapter admission filter; declared-boundary phase B deferred. | D13 (FR-REG-5) |
| S-66 | Test-gap register (warehouse-only): hot files whose changes never co-change with tests; coverage ingestion parked (separate decision, forge-budget review). Supply-chain sub-score + axis, D12 factor declarations, plan-catalog entries for all four registers. | D13 (FR-REG-6/7) |

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
