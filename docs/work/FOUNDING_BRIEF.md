# RepoPulse — Founding Brief (locked decisions, 2026-07-07)

Product: clone-free GitHub repository health, code-quality and delivery-performance
monitoring web service with drill-down dashboard, custom views, and a report center.
bpmforge family (ThreatForge sibling). All downstream docs trace to this brief.

## Locked decisions (from discovery interview with Brad)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Deployment/tenancy | Internal on bpmforge infra (`repopulse.bpmforge.com`, Podman), SaaS-ready: `workspace_id` on every tenant-scoped table, single `default` workspace at launch. No billing/onboarding scope in v1. **D1a amendment (2026-08-12, founder): the delivery model is CUSTOMER-HOSTED — a customer runs RepoPulse in their own environment against their own forge, with their own LLM.** bpmforge's own deployment becomes the first install (dogfood), not the product. No architecture change is implied: a single-tenant install with one `default` workspace already IS the self-hosted shape, and `workspace_id` discipline continues unchanged. What this adds is a **packaging/distribution surface that had no ticket** — published images, a generic compose artifact, install/config/upgrade/backup docs, a customer-run forge-App setup flow, and a licensing decision — filed as wave **W11**. N-5 is UNCHANGED and still binding: no billing, no plans, no multi-org self-serve onboarding; a self-hosted customer needs none of those. |
| D2 | Analysis engine | Tiered hybrid. **Tier 1** API-derived metrics, always on. **Tier 2** local LLM (LM Studio on LAN) bulk diff review. **Tier 3** Claude API deep review, opt-in per repo/PR. Review dimensions ported from bpm-opencode-experts: code health, security, performance, test coverage. |
| D3 | Forge scope | GitHub v1 behind a `ForgeProvider` interface; Gitea adapter is a v1.x ticket. |
| D4 | Name | RepoPulse (`~/Code/repopulse`, dual remotes Gitea origin + GitHub). |
| D5 | MVP slice | Health dashboard first: connect org → backfill 12 months → Tier-1 metrics dashboard with drill-down (org → repo → PR/file → detail). LLM review is roadmap wave 2, not MVP. |
| D6 | Auth | GitHub OAuth; login identity powers personalized views ("my PRs", "my review load"). |
| D7 | Reports | In-app report center with history + exportable audit-ready PDF packs. Email digests / Slack push are explicitly deferred (non-goals v1). |
| D8 | Security suite (added 2026-07-07) | Wave W8: productize the bpmforge security tooling — diff-stream + full-history secrets scanning, SBOM/CVE audit (syft/grype/OSV, KEV, slopsquatting), semgrep SAST runs, OWASP checklists + attack chaining — behind a **pluggable scanner framework** so capabilities still maturing in the bpm-opencode-experts go-forward plan (IaC checker, cloud security, anti-slop auditor, …) land as drop-in scanners. MVP (W0–W4) unchanged. |
| D9 | Improvement Plans + quality loops (added 2026-07-14) | Metrics→action pillar: **rules-first recommendation catalog** → ranked, evidence-linked plan items with machine-checkable verify criteria auto-evaluated off nightly snapshots ("3 of 7 done / 1 regressed"); **working agreements** (threshold + the actual exception list, never a gameable score); **artifact-bound goals** on files/hotspots (refactor/supervise/acknowledged). T2 narration passes (Weekly Pulse, plan summaries) may order and narrate but NEVER invent items. Analysis quality loops ported from bpm-opencode-experts: **verify pass with maker≠verifier across the two LAN hosts, challenger gate before any severity≥4 finding surfaces, FP-suppression memory, compound-risk detector** — hard caps, no-progress halts. Journey pack: persona picker, onboarding checklist, rail badges, triage queue, report diff/schedule/annotations. Design: docs/design/IMPROVEMENT_PLANS.md + docs/work/UX_AGENTS_IMPROVEMENT_PLANS.md. Slack/email digests stay deferred (N-4 unchanged). **D9a clarification (2026-08-12, founder): "fixes" in the product goal means THIS — recommend and verify, not write.** RepoPulse produces ranked, evidence-linked plan items with machine-checkable verify criteria and a nightly job that marks each done or regressed; it never opens a branch, never writes a patch, never posts a PR comment. **N-3 is NOT graduated and C5/SC-25 read-only App scopes stand.** Recorded because "reports and fixes" is ambiguous and the two richer readings — advisory PR comments (S-25) and generated fix PRs — each require a brief amendment plus write scopes, and neither is in scope. A ticket that writes to a customer repo is invalid under this decision; reject at review. |
| D10 | CVE validation & VEX (added 2026-07-14) | Kill SBOM false-positive noise — a raw grype/OSV list is not a deliverable. Every dependency finding passes **validation tiers**: alias dedup (one finding per vuln×package) → dev/prod + direct/transitive scoping → import/usage detection → symbol reachability where advisory data exists (govulncheck for Go; generated semgrep symbol rules elsewhere) → EPSS+KEV **effective-risk** score → optional T2 adversarial verify (proposes, never auto-dismisses). Human triage maps to **OpenVEX justifications** (component_not_present / vulnerable_code_not_in_execute_path / inline_mitigations_already_exist / …); VEX exports with the SBOM; suppression persists per (package, vuln, version) and a version bump reopens. Raw counts are never hidden — the funnel raw→deduped→scoped→affected is the audit story. Extends D8/FR-SEC-5; design: SECURITY_SUITE.md §3.6. |
| D11 | Code Health Suite (added 2026-07-14) | Wave W9, riding the W8 scanner framework: productize the bpm-opencode-experts code-health tooling for the AI-slop era. **Deterministic layer**: our own versioned code-health rulepack (semgrep custom pack — tool-checkable anti-slop rules R-01/02/10/13/14/16/27/29, logging antipatterns) + standalone source tools in the sandbox (lizard complexity, jscpd duplication) with the research-canon thresholds (cognitive ≤15, CC>10 warn/>20 crit, fn>50L, file>300L, nest>3, args>4, duplication 5% gate + trend) + LDR structural-slop measurement. **T2 checklist layer** for judgment rules (shallow modules, speculative abstraction, unwired scaffolding, privilege escalation, unvalidated LLM output) + logging-context adequacy (OWASP A09 2025). **Tier-1 debt signals** from our own warehouse (14d rework rate, revert rate — GitClear-style, no scanner needed). Surfaces: repo Code Health tab, org tile, `code_health` health-score sub-score, Code Health report type, D9 plan-catalog v2 entries. Evidence basis: GitClear 2024-2026 (copy/paste 9.4%→15.7%, refactoring −70%, error-masking +47%), Veracode 2025 (45% AI code fails security tests; log injection 88%), USENIX 2025 (19.7% hallucinated packages), Apiiro (+322% priv-esc paths) — citations in docs/design/CODE_HEALTH_SUITE.md. **The 30 rules are a seed, not a cap**: HealthRule schema + lifecycle with shadow mode (experimental findings excluded from scores until FP-gated promotion), intake via field-lesson proposals / LLM-drafted rules (never auto-activated) / license-gated external pack sync; per-language semgrep-compatible packs across domains (slop, logging, **perf**, correctness, framework) — Opengrep-swappable; tool adapter registry (ruff, Biome W9; actionlint/hadolint/shellcheck/sqlfluff/vale backlog) admission-filtered by the no-network sandbox. |
| D12 | Unified Risk Model (added 2026-07-15) | Wave W9: one deterministic answer to "what do I fix first?" across ALL finding dimensions — `effective_risk = 100·H·L·X` (hazard = canonical severity; likelihood = EPSS/KEV for dependencies, confidence × verify-status × D11 rule-precision prior elsewhere, overrides for KEV/secret/chain/compound; exposure = M2 hotspot percentile for file-bound findings, dep_scope × reachability for dependencies). Refactors D10's dependency-only formula into factored form — same column, same inputs, now priced for every open finding with the decomposition persisted (`risk_factors`) and always served. **SSVC-style action bands** act/schedule/track (accepted = human triage state, never computed) drive plan-generation ranking (KEV/chain pins unchanged), Top Risks cards (repo + org), default sorts, and a "top risks + movement" opener in reports. **Risk axes**: existing health sub-scores rendered as A–E letters per risk type (Security / Code Health / Delivery / Review / Activity; Performance v-next) with per-axis top contributors — no new arithmetic. Nightly `risk.reprice` job audits band transitions (EPSS/hotspot/precision drift). Industry anchors: CVSS bands, EPSS/KEV, SSVC verbs, OWASP likelihood×impact, SonarQube A–E, Snyk Risk Score. Raw severity + raw counts never hidden; "signals, not grades" carries over. Design: docs/design/RISK_MODEL.md. |
| D13 | Engineering Risk Registers (added 2026-07-15) | Wave W10: non-security risk *sources* through the existing findings contract, priced/banded/planned by D12 with zero new surface work. Four registers, all deterministic (no LLM): **knowledge concentration** (bus factor — active-maintainer count + top-contributor share per module weighted by hotspot; warehouse SQL; counts only, never names — N-9); **dependency health** (libyear staleness, abandonment, deprecated/yanked, major-version lag from SBOM + nightly release_meta db-sync; anchors: libyear, OpenSSF Scorecard) + **runtime/toolchain EOL** (endoflife.date db-sync vs manifests/Dockerfiles) + **license posture** (SPDX from SBOM, workspace policy list defaults AGPL/SSPL/unknown-in-prod — findings only, RepoPulse never gates); **architecture drift phase A** (config-free: cycles, god modules, orphan clusters via standalone import-graph adapters through the D11 admission filter — dependency-cruiser/import-linter/go list; declared-boundary phase B deferred to its own design pass); **test-gap** (warehouse test co-change ratio on hot files; coverage×churn full form PARKED pending a forge-budget review of CI-artifact ingestion). New dimensions `knowledge`/`dependency_health`/`architecture`/`test_gap`; **Supply Chain risk axis** (supply_chain sub-score mirroring the security-sub-score pattern); knowledge/architecture/test_gap roll into the Code Health axis. Proposal + adoption decisions: docs/work/D13_ENGINEERING_RISK_REGISTERS_PROPOSAL.md. |

## Hard constraints

- **C1 No cloning.** All analysis via forge APIs (commits, PR files/diffs, targeted
  contents fetches, checks, reviews). Rate-limit budgeting, ETag conditional requests,
  and incremental sync cursors are first-class architecture concerns.
  **C1a amendment (2026-07-07, with D8):** never `git clone`, but deep security scans
  may fetch the forge API **tarball** into an ephemeral sandboxed scratch dir, scan,
  and delete — nothing persisted except findings. Tarball fetches go through the
  budgeted ForgeProvider client like every other call.
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
