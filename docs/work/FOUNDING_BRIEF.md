# RepoPulse — Founding Brief (locked decisions, 2026-07-07)

Product: clone-free GitHub repository health, code-quality and delivery-performance
monitoring web service with drill-down dashboard, custom views, and a report center.
bpmforge family (ThreatForge sibling). All downstream docs trace to this brief.

> **Restated by D16 (2026-10-15):** the product line above is the 2026-07-07
> framing. Repo Pulse is now described as *a self-hosted code security and
> quality platform for teams shipping AI-written code, with delivery metrics as
> context*. C1/C1a and every other locked decision stand; see D16 below.

## Locked decisions (from discovery interview with Brad)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Deployment/tenancy | Internal on bpmforge infra (`repopulse.bpmforge.com`, Podman), SaaS-ready: `workspace_id` on every tenant-scoped table, single `default` workspace at launch. No billing/onboarding scope in v1. **D1a amendment (2026-08-12, founder; sharpened 2026-08-13): the delivery model is CUSTOMER-HOSTED, and self-hosting IS THE MVP rather than a packaging follow-on. bpmforge's own production deployment (W7-05/06/07) is consequently NOT a launch gate — it is our dogfood install. The gate is that a CUSTOMER can stand it up. — a customer runs RepoPulse in their own environment against their own forge, with their own LLM.** bpmforge's own deployment becomes the first install (dogfood), not the product. No architecture change is implied: a single-tenant install with one `default` workspace already IS the self-hosted shape, and `workspace_id` discipline continues unchanged. What this adds is a **packaging/distribution surface that had no ticket** — published images, a generic compose artifact, install/config/upgrade/backup docs, a customer-run forge-App setup flow, and a licensing decision — filed as wave **W11**. N-5 is UNCHANGED and still binding: no billing, no plans, no multi-org self-serve onboarding; a self-hosted customer needs none of those. |
| D2 | Analysis engine | Tiered hybrid. **Tier 1** API-derived metrics, always on. **Tier 2** local LLM (LM Studio on LAN) bulk diff review. **Tier 3** Claude API deep review, opt-in per repo/PR. Review dimensions ported from bpm-opencode-experts: code health, security, performance, test coverage. |
| D3 | Forge scope | GitHub v1 behind a `ForgeProvider` interface; Gitea adapter is a v1.x ticket. **D3a amendment (2026-08-13, founder): MULTI-FORGE IS PART OF THE MVP, not a v1.x follow-on.** The MVP is defined as *a customer runs RepoPulse in their own container system and points it at their own repositories — GitHub, GitLab or Gitea*. That makes the Gitea adapter (W7-02) MVP scope and **graduates N-6 for GitLab**, which now needs an adapter and a ticket (W12-01). Bitbucket stays a non-goal. The `ForgeProvider` interface and its capability flags are unchanged — this is adapter work plus the contract suite, not a redesign. |
| D4 | Name | RepoPulse (`~/Code/repopulse`, dual remotes Gitea origin + GitHub). |
| D5 | MVP slice | Health dashboard first: connect org → backfill 12 months → Tier-1 metrics dashboard with drill-down (org → repo → PR/file → detail). LLM review is roadmap wave 2, not MVP. |
| D6 | Auth | ~~GitHub OAuth; login identity powers personalized views.~~ **SUPERSEDED by D14 (2026-08-20).** |
| D7 | Reports | In-app report center with history + exportable audit-ready PDF packs. Email digests / Slack push are explicitly deferred (non-goals v1). |
| D8 | Security suite (added 2026-07-07) | Wave W8: productize the bpmforge security tooling — diff-stream + full-history secrets scanning, SBOM/CVE audit (syft/grype/OSV, KEV, slopsquatting), semgrep SAST runs, OWASP checklists + attack chaining — behind a **pluggable scanner framework** so capabilities still maturing in the bpm-opencode-experts go-forward plan (IaC checker, cloud security, anti-slop auditor, …) land as drop-in scanners. MVP (W0–W4) unchanged. |
| D9 | Improvement Plans + quality loops (added 2026-07-14) | Metrics→action pillar: **rules-first recommendation catalog** → ranked, evidence-linked plan items with machine-checkable verify criteria auto-evaluated off nightly snapshots ("3 of 7 done / 1 regressed"); **working agreements** (threshold + the actual exception list, never a gameable score); **artifact-bound goals** on files/hotspots (refactor/supervise/acknowledged). T2 narration passes (Weekly Pulse, plan summaries) may order and narrate but NEVER invent items. Analysis quality loops ported from bpm-opencode-experts: **verify pass with maker≠verifier across the two LAN hosts, challenger gate before any severity≥4 finding surfaces, FP-suppression memory, compound-risk detector** — hard caps, no-progress halts. Journey pack: persona picker, onboarding checklist, rail badges, triage queue, report diff/schedule/annotations. Design: docs/design/IMPROVEMENT_PLANS.md + docs/work/UX_AGENTS_IMPROVEMENT_PLANS.md. Slack/email digests stay deferred (N-4 unchanged). **D9a clarification (2026-08-12, founder): "fixes" in the product goal means THIS — recommend and verify, not write.** RepoPulse produces ranked, evidence-linked plan items with machine-checkable verify criteria and a nightly job that marks each done or regressed; it never opens a branch, never writes a patch, never posts a PR comment. **N-3 is NOT graduated and C5/SC-25 read-only App scopes stand.** Recorded because "reports and fixes" is ambiguous and the two richer readings — advisory PR comments (S-25) and generated fix PRs — each require a brief amendment plus write scopes, and neither is in scope. A ticket that writes to a customer repo is invalid under this decision; reject at review. |
| D10 | CVE validation & VEX (added 2026-07-14) | Kill SBOM false-positive noise — a raw grype/OSV list is not a deliverable. Every dependency finding passes **validation tiers**: alias dedup (one finding per vuln×package) → dev/prod + direct/transitive scoping → import/usage detection → symbol reachability where advisory data exists (govulncheck for Go; generated semgrep symbol rules elsewhere) → EPSS+KEV **effective-risk** score → optional T2 adversarial verify (proposes, never auto-dismisses). Human triage maps to **OpenVEX justifications** (component_not_present / vulnerable_code_not_in_execute_path / inline_mitigations_already_exist / …); VEX exports with the SBOM; suppression persists per (package, vuln, version) and a version bump reopens. Raw counts are never hidden — the funnel raw→deduped→scoped→affected is the audit story. Extends D8/FR-SEC-5; design: SECURITY_SUITE.md §3.6. |
| D11 | Code Health Suite (added 2026-07-14) | Wave W9, riding the W8 scanner framework: productize the bpm-opencode-experts code-health tooling for the AI-slop era. **Deterministic layer**: our own versioned code-health rulepack (semgrep custom pack — tool-checkable anti-slop rules R-01/02/10/13/14/16/27/29, logging antipatterns) + standalone source tools in the sandbox (lizard complexity, jscpd duplication) with the research-canon thresholds (cognitive ≤15, CC>10 warn/>20 crit, fn>50L, file>300L, nest>3, args>4, duplication 5% gate + trend) + LDR structural-slop measurement. **T2 checklist layer** for judgment rules (shallow modules, speculative abstraction, unwired scaffolding, privilege escalation, unvalidated LLM output) + logging-context adequacy (OWASP A09 2025). **Tier-1 debt signals** from our own warehouse (14d rework rate, revert rate — GitClear-style, no scanner needed). Surfaces: repo Code Health tab, org tile, `code_health` health-score sub-score, Code Health report type, D9 plan-catalog v2 entries. Evidence basis: GitClear 2024-2026 (copy/paste 9.4%→15.7%, refactoring −70%, error-masking +47%), Veracode 2025 (45% AI code fails security tests; log injection 88%), USENIX 2025 (19.7% hallucinated packages), Apiiro (+322% priv-esc paths) — citations in docs/design/CODE_HEALTH_SUITE.md. **The 30 rules are a seed, not a cap**: HealthRule schema + lifecycle with shadow mode (experimental findings excluded from scores until FP-gated promotion), intake via field-lesson proposals / LLM-drafted rules (never auto-activated) / license-gated external pack sync; per-language semgrep-compatible packs across domains (slop, logging, **perf**, correctness, framework) — Opengrep-swappable; tool adapter registry (ruff, Biome W9; actionlint/hadolint/shellcheck/sqlfluff/vale backlog) admission-filtered by the no-network sandbox. |
| D12 | Unified Risk Model (added 2026-07-15) | Wave W9: one deterministic answer to "what do I fix first?" across ALL finding dimensions — `effective_risk = 100·H·L·X` (hazard = canonical severity; likelihood = EPSS/KEV for dependencies, confidence × verify-status × D11 rule-precision prior elsewhere, overrides for KEV/secret/chain/compound; exposure = M2 hotspot percentile for file-bound findings, dep_scope × reachability for dependencies). Refactors D10's dependency-only formula into factored form — same column, same inputs, now priced for every open finding with the decomposition persisted (`risk_factors`) and always served. **SSVC-style action bands** act/schedule/track (accepted = human triage state, never computed) drive plan-generation ranking (KEV/chain pins unchanged), Top Risks cards (repo + org), default sorts, and a "top risks + movement" opener in reports. **Risk axes**: existing health sub-scores rendered as A–E letters per risk type (Security / Code Health / Delivery / Review / Activity; Performance v-next) with per-axis top contributors — no new arithmetic. Nightly `risk.reprice` job audits band transitions (EPSS/hotspot/precision drift). Industry anchors: CVSS bands, EPSS/KEV, SSVC verbs, OWASP likelihood×impact, SonarQube A–E, Snyk Risk Score. Raw severity + raw counts never hidden; "signals, not grades" carries over. Design: docs/design/RISK_MODEL.md. |
| D13 | Engineering Risk Registers (added 2026-07-15) | Wave W10: non-security risk *sources* through the existing findings contract, priced/banded/planned by D12 with zero new surface work. Four registers, all deterministic (no LLM): **knowledge concentration** (bus factor — active-maintainer count + top-contributor share per module weighted by hotspot; warehouse SQL; counts only, never names — N-9); **dependency health** (libyear staleness, abandonment, deprecated/yanked, major-version lag from SBOM + nightly release_meta db-sync; anchors: libyear, OpenSSF Scorecard) + **runtime/toolchain EOL** (endoflife.date db-sync vs manifests/Dockerfiles) + **license posture** (SPDX from SBOM, workspace policy list defaults AGPL/SSPL/unknown-in-prod — findings only, RepoPulse never gates); **architecture drift phase A** (config-free: cycles, god modules, orphan clusters via standalone import-graph adapters through the D11 admission filter — dependency-cruiser/import-linter/go list; declared-boundary phase B deferred to its own design pass); **test-gap** (warehouse test co-change ratio on hot files; coverage×churn full form PARKED pending a forge-budget review of CI-artifact ingestion). New dimensions `knowledge`/`dependency_health`/`architecture`/`test_gap`; **Supply Chain risk axis** (supply_chain sub-score mirroring the security-sub-score pattern); knowledge/architecture/test_gap roll into the Code Health axis. Proposal + adoption decisions: docs/work/D13_ENGINEERING_RISK_REGISTERS_PROPOSAL.md. |
| D15 | Product completion / standalone release (added 2026-09-08) | **The product-completion handoff (`IMPLEMENTATION-PLAN.md`, RP-01–RP-34 → board wave W17) is the execution plan for D1a, not a new direction.** D1a already made the delivery model customer-hosted and self-hosting the MVP; what changed on 2026-09-08 is that VISION/SCOPE/DEPLOYMENT still said "internal-only in v1" on `repopulse.bpmforge.com`, contradicting it. That phrasing is superseded — bpmforge's deployment is the **dogfood install, not the product**. Retained unchanged and still binding: the tenancy invariant (`workspace_id`), C1/C1a no-cloning, module boundaries, the budgeted forge client, the analysis-gateway rule, **D9a** (recommend and verify, never write), **D10 licensing** (proprietary; nothing public until a clean self-hosted install is proven end to end — which is why the release stops at a local image archive), and **D14** standalone auth. Out of scope for this release, carrying no N-id: Kubernetes/Helm, public SaaS signup, billing, new identity providers, model auth beyond API keys (`W16-09`, parked), production APM, coverage ingestion, IaC scanning, repository benchmarks. A reserved schema value is not a shipped capability: unsupported dimensions must read as explicitly unavailable, never as empty green panels. Full record incl. the RP↔W17 mapping, validator repairs and reconciled tickets: `docs/work/product-completion/DECISIONS.md`. |
| D16 | Product restatement: code security and quality platform (added 2026-10-15) | **Repo Pulse is a self-hosted code security and quality platform for teams shipping AI-written code, with delivery metrics as context.** A restatement of what D8, D10, D11, D12 and D13 already built, not a new direction: VISION, SCOPE and COMPETITIVE_ANALYSIS still described a health and delivery dashboard that "does not replicate rule-based SAST", so every new scanner ticket fought the documents. That framing is superseded. **Fix delivery is "Verified + CI pull"**: the model drafts a patch, Repo Pulse applies it to the scan snapshot inside the sandbox and re-runs the rules to prove the finding clears and nothing new appears, and the developer copies it (W18-19); PR-time results reach developers because the customer's OWN CI pulls them from the Repo Pulse API with the customer's OWN token (W18-18). **D9a stands unchanged**: Repo Pulse never opens a branch, never writes to a repo, never posts a PR comment and adds no forge write scope. N-3 and N-9 stand. Executed as wave W18. Full record: the D16 section below. |

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

## D10 — Licensing and distribution (founder, 2026-08-14)

**Proprietary, all rights reserved. Nothing goes public until a clean
self-hosted install is proven working end to end.**

- **License applied:** `LICENSE` (proprietary) plus `"license": "UNLICENSED"`
  on the root and every workspace manifest, so a package extracted from the
  workspace does not lose the licence with the repo root.
- **Distribution:** none. No public registry, no public image, no open-source
  grant. The gate to reconsider is a **clean self-hosted working option** —
  concretely W11-05: pull, fill `.env`, `up`, reach the login page on a
  machine that has never built the repo.
- **Support commitment:** none while undistributed. Stated explicitly in the
  LICENSE rather than left silent, because "no commitment" and "unstated
  commitment" are different things to a customer.

**Why proprietary, and why now.** The choice is deliberately the REVERSIBLE
one. Proprietary today can become any open-source license later; an open-source
grant, once published, cannot be withdrawn from the copies it created. Picking
an OSS license before the product is even distributable would be making an
irreversible decision to save writing one file.

**Checked, not assumed:** the W11-04 ticket warned that Lodestone is
deliberately private/UNLICENSED and that any consumption of it must be resolved
BEFORE distribution. RepoPulse does not depend on it — every dependency is
public npm or `workspace:*`, with no `file:`, `git:` or `link:`
specifiers anywhere. That risk is not present today; re-check if it is ever
added.

This is a decision recorded by its author, not legal advice. A lawyer should
review before the first actual distribution, whichever direction it goes.

## D14 — Authentication is standalone; the forge is not the identity provider (founder, 2026-08-20, supersedes D6)

**Decision.** RepoPulse authenticates users with its OWN accounts (local
password) or with the customer's OWN identity provider (generic OIDC). Signing
in with a forge is ONE option among several, never a requirement.

**Why this had to change.** D6 made a GitHub account the only way through the
front door. That is wrong for a product a customer self-hosts, and it produced
an absurdity we hit in practice: an operator could not connect a **Gitea**
organisation — which has nothing to do with GitHub — without first registering
a GitHub App, because the Connections screen sits behind GitHub sign-in. A
product whose first setup step depends on a second vendor's approval cannot be
bootstrapped by the person who bought it.

**What follows.**
- A person is identified by `(auth_provider, auth_subject)`.
  `users.forge_user_id` stops being the identity of a person and becomes a
  LINK — nullable, set when someone connects their forge identity so "my PRs"
  resolves.
- Forge OAuth stays as a provider, because it is the one case that can
  auto-link that identity. Demoted, not deleted.
- The first admin on a fresh install comes from `ADMIN_EMAIL` /
  `ADMIN_PASSWORD` on first boot, with a forced password change.
  First-visitor-claims-the-instance was rejected: on a LAN or a cloud box it
  hands the install to whoever finds the URL first.

**Dependency licensing.** Every dependency this adds must be usable and
REDISTRIBUTABLE inside a proprietary product (D10). Password hashing therefore
uses Node's built-in `scrypt` — no dependency, no native build, no licence
question. OIDC token verification uses `jose` (MIT), and only for the
cryptography: discovery, PKCE and the code exchange are ours, because they are
plain HTTPS. Hand-rolling JWKS handling and signature verification was
considered and REJECTED — `alg` confusion and key-rotation bugs are a known
source of critical auth vulnerabilities, and a licence inconvenience would
never justify writing that ourselves.

## D16 — Repo Pulse is a self-hosted code security and quality platform (founder, 2026-10-15, restates the product line; supersedes the "we do not replicate SAST" positioning)

**Decision.** Repo Pulse is *a self-hosted code security and quality platform
for teams shipping AI-written code, with delivery metrics as context*. The
health and delivery dashboard stays; it is the context a finding is ranked in,
not the headline.

**Why this had to be written down.** The product moved and the documents did
not. D8 added secrets, SBOM/CVE and Semgrep/Opengrep SAST; D10 cut dependency
false positives with reachability and VEX; D11 added the anti-slop, logging and
perf rule packs plus complexity and duplication; D12 put every finding on one
"fix this first" ranking; D13 added the risk registers. Together those make
Repo Pulse a SAST and code-health scanner. Yet VISION.md still described a
health dashboard, positioned against SonarQube with "they clone and scan;
RepoPulse reads the API", and COMPETITIVE_ANALYSIS.md said "we do not replicate
rule-based SAST". With those documents in place, every scanner ticket argued
against the vision it was meant to serve.

**What sets it apart.** Not self-hosting with a local model on its own: Kodus
(open source, AGPL) already does that, so Repo Pulse has to win on what comes
after "runs on your network":
- rules first on CPU, the model second, and a second model on another host
  must agree before an LLM finding shows (maker ≠ verifier, D9);
- rules aimed at what AI-written code gets wrong (hallucinated packages and
  names, duplication, swallowed errors, tests that test nothing; D11, W18);
- every rule runs in shadow until it earns promotion on measured precision,
  and the customer can see that precision (W9-07, W18-22);
- risk ranked by how often the code changes, not severity alone (D12);
- fixes tracked until a nightly job marks them done or regressed (D9);
- audit-ready output (D7, D10) on GitHub, GitLab and Gitea (C1, D3a).

**Fix delivery: "Verified + CI pull" (founder's choice).**
- *Verified patches (W18-19).* For a finding, the model drafts a patch. Repo
  Pulse applies it to the scan snapshot inside the sandbox and re-runs that
  file's rules. The patch is shown only if the target finding clears and no new
  finding appears; otherwise it is stored as rejected with the reason. The
  developer copies or downloads it. Nothing is written to the forge.
- *Customer-CI pull (W18-18).* A CLI or CI step in the customer's own pipeline
  asks the Repo Pulse API for the new findings on a PR, using a scoped
  read-only token. It fails their build on their thresholds, or posts the
  results itself with the customer's own forge token. Repo Pulse stays
  read-only.
- *Rejected: advisory PR comments from Repo Pulse itself.* That is the usual
  market approach, but it needs forge write scopes and a D9a amendment, and the
  two options above cover the need without either.

**What follows.**
- **D9a stands unchanged and is reaffirmed.** Repo Pulse recommends and
  verifies; it never opens a branch, never writes a patch to a repo, never
  posts a PR comment. No forge write scope is added; W18-18 carries a test that
  asserts the App and token scopes. C5/SC-25 read-only scopes stand. A ticket
  that writes to a customer repo is still invalid; reject at review.
- **D9a note (2026-10-19, founder): removing our own webhooks is allowed.**
  `deploy/uninstall.sh` (W20-15, UX_TODO X-27) deletes the push webhooks
  Repo Pulse itself registered, matched by its own delivery URL, one hook by
  id, through the budgeted client and the same hook scope registration already
  uses. Without it a removed install leaves hooks firing at a dead server.
  Nothing else about D9a changes: no repo content, branch, patch or comment is
  ever written. The D9a gate test names this one delete.
- **N-3 stands.** The customer's CI failing its own build with Repo Pulse's
  results is the customer's gate, run with the customer's credentials; Repo
  Pulse ships no gate bot and sets no required status check. **N-9 stands**:
  the AI-code governance report (W18-20) compares AI-authored and human changes
  as groups, with no per-developer ranking.
- **S-25 (advisory PR comment write-back) is withdrawn**, as D9a already
  required; the customer-CI pull replaces it.
- **Superseded:** the product line at the top of this brief, VISION.md's
  "repo health, quality, and delivery monitoring" framing and its
  SonarQube/CodeScene positioning line, and COMPETITIVE_ANALYSIS.md's "we do
  not replicate rule-based SAST / quality gates". Those documents are updated
  with this decision.
- **Unchanged and still binding:** C1/C1a (no `git clone`; tarball snapshots in
  the sandbox only), D1a (customer-hosted), D2 (tiered analysis; Tier 3 opt-in
  with an egress audit row), D10 licensing (nothing public until a clean
  self-hosted install is proven), D14, N-1, N-2, N-4 to N-8.
- **Executed as wave W18** (`plan.json` W18-01 to W18-30; ROADMAP.md): the
  mechanical fast lane, language packs beyond JS/TS, published accuracy,
  customer-CI pull, verified patches, AI-code governance, the sensitive-change
  radar, trust surfaces, SARIF ingest and IaC adapters. The gaps a SAST buyer
  checks first (language coverage, PR-time results, fix suggestions, IaC,
  proof of accuracy, ingesting other tools) each have a W18 ticket.

