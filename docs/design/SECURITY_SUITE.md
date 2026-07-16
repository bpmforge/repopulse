# Security Suite — Pluggable Scanner Framework (packages/security) — wave W8

Traces: FR-SEC-1..12, NFR-13/14/15, D8, C1a, S-30..S-35. Integrates — never duplicates — the
findings store and triage flow of ANALYSIS_TIERS.md (§4–5: FR-ANALYSIS-5 schema, FR-ANALYSIS-6
dedup, FR-INSIGHTS-1 lifecycle) and the budgeted client of FORGE_PROVIDER.md. Rules: scanners
never call a forge host or an LLM directly — repo bytes arrive only through `ScannerContext`
(→ BudgetedClient), LLM calls only through `AnalysisGateway` (CLAUDE.md Laws 7/8). Origin:
productized bpm-opencode-experts security tooling (D8) — the framework is the product; the
five W8 scanners are its first tenants, the §7 backlog its growth path.

## 1. Scanner framework (FR-SEC-1, FR-SEC-11/12) — the extensibility contract

```ts
export type ScannerInput = 'diff' | 'manifests' | 'snapshot' | 'findings';
export type ScanTrigger  = 'pr_synced' | 'push' | 'schedule' | 'manual';

export interface Scanner {
  key: string;                        // stable slug: 'secrets' | 'dependency' | 'semgrep' | ...
  displayName: string;
  version: string;                    // scanner+rulepack version — stamped on every finding + scan_run
  inputs: ScannerInput;               // what the framework must provision before run()
  triggers: ScanTrigger[];            // which events may enqueue this scanner
  requiredTools?: string[];           // container tool deps, e.g. ['semgrep@1', 'syft@1', 'grype@0.8x']
  run(ctx: ScannerContext): Promise<ScannerFinding[]>;
}

export interface ScannerContext {
  repoId: string; workspaceId: string; commitSha: string;   // hash pin — all results reproducible per SHA
  trigger: ScanTrigger; prNumber?: number;                  // present for pr_synced
  diff(): AsyncIterable<ForgeDiffFile>;                     // inputs:'diff' — warehouse pr_file patches (W2 ingestion)
  getFileContent(path: string): Promise<ForgeFileContent>;  // targeted fetch (FR-FORGE-6), draws scanner forge quota
  snapshot(): Promise<SnapshotHandle>;                      // inputs:'snapshot' only — §2 (C1a); throws otherwise
  priorFindings(f: FindingFilter): Promise<ScannerFinding[]>; // inputs:'findings' — read-only, chainer input
  gateway: AnalysisGateway;                                 // checklist scanners → Tier-2/3 (ANALYSIS_TIERS §1)
  budget: ScanBudget; signal: AbortSignal;                  // deadline/limits, §1.2
  log: Logger;
}
```

**Registry.** Static list in `packages/security/src/registry.ts`; a new scanner = one module +
one registry line. The framework never branches on scanner keys — dispatch, budgets, findings
persistence, UI facets, and report sections are all driven by registry metadata. Acceptance
(FR-SEC-1): adding a `backlog` scanner (§7) touches zero framework files.

**Per-repo enablement** (FR-SEC-11). Table `repo_scanner_config(workspace_id, repo_id,
scanner_key, enabled, config jsonb, updated_by, updated_at)`. Workspace-level defaults:
`secrets` + `dependency` ON, `semgrep` ON (weekly schedule), `owasp_web` manual, `owasp_llm`
auto-enabled only when the dependency scanner detects LLM deps (§3.4), `attack_chainer` ON
(it costs nothing without prior findings). Admin-only mutation (FR-AUTH-4).

### 1.2 Budgets & failure isolation (FR-SEC-11, NFR-15)

`ScanBudget` per scanner, workspace defaults overridable per repo: wall-clock timeout,
container CPU/mem caps (§2.2), forge-call quota (targeted fetches + tarball, drawn from the
FR-FORGE-3 budget in a new low-priority `scan` lane), LLM token budget (checklist scanners —
enforced by the gateway's existing T2/T3 accounting, `meta.initiator = 'scanner:{key}'`).
Budget exhausted or timeout ⇒ scan_run status `budget_exceeded`, partial findings kept and
flagged `partial: true`. A failing/crashing scanner NEVER blocks ingestion, Tier-1 metrics, or
other scanners (NFR-15) — scans run on a separate BullMQ queue (`security.scan`) with its own
workers; poison scans dead-letter per NFR-11.

### 1.3 Findings integration (FR-SEC-12) — DATABASE.md delta, not a new store

Scanner findings are rows in the EXISTING findings store (ANALYSIS_TIERS §4–5). Deltas:

- `dimension` enum extended: `+ 'secrets' | 'dependency' | 'sast' | 'iac' | 'chain'`
  (OWASP checklist scanners keep dimension `security` — they are LLM security review).
- New nullable columns: `scanner_key`, `rule_id`, `cve_id`, `chain_id`,
  `preconditions jsonb`, `yields jsonb` (§3.4/3.5), `scan_run_id`.
- `file` / `line_range` become nullable — repo-level findings (dependency posture, chains)
  have no single location; `file` = manifest path for dependency findings.
- Dedup (FR-ANALYSIS-6 extension): `dedup_key = sha256(scanner_key + rule_id + dimension +
  (file ?? '') + normalize(evidence_quote))`; occurrence-count/reopen semantics unchanged.
- Triage: same lifecycle (`open → confirmed | dismissed(reason) → resolved | wont_fix`);
  semgrep triage states map REAL→`confirmed`, FP→`dismissed(false_positive)`,
  UNVERIFIED→`open`. FP dismissals feed the same tuning metric.

`scan_run(id, workspace_id, repo_id, scanner_key, trigger, commit_sha, status
queued|running|done|failed|budget_exceeded, started_at, finished_at, findings_count,
tool_versions jsonb, error text?)` — powers UI status, reproducibility, and NFR-13 audit.

### 1.4 ForgeProvider delta (FORGE_PROVIDER.md)

- New op `getTarball(ctx: CallCtx, repo: string, ref: string): Promise<ReadableStream>`;
  capability `supportsTarball` (GitHub true; Gitea true via `/repos/{o}/{r}/archive/{ref}.tar.gz`).
  Research: GitHub `GET /repos/{o}/{r}/tarball/{sha}` = **1 REST call charged 1 core point,
  responds 302 → codeload URL; client must follow the redirect** (redirect fetch itself uncharged).
- `Lane` union gains `'scan'` (priority between `backfill` and `reconcile`).
- FR-FORGE-6 lint gate amended, not removed: tarball/zipball endpoints callable ONLY from the
  snapshot service module; `git clone`/`git://` remain absolutely banned everywhere (C1a).

## 2. Snapshot service (FR-SEC-2, C1a, NFR-13/14)

The only component allowed to materialize repo contents. Fetch→extract→scan→shred; nothing
persisted except findings + scan_run rows.

### 2.1 Lifecycle

1. **Fetch**: `getTarball(ctx{lane:'scan'}, repo, commitSha)` — hash-pinned to a commit SHA,
   never a branch name, so re-scans are reproducible and chain evidence is stable.
2. **Extract** into `SCAN_SCRATCH_ROOT/snap-{repoId}-{sha12}-{jobId}` (tmpfs preferred),
   streaming tar with guards: reject absolute paths, `..` traversal, symlink/hardlink entries
   escaping the root (all dropped + counted); per-file size cap (default 50 MB) and total cap
   (default 2 GB, workspace config) — cap breach ⇒ abort, scan_run `failed(reason:'size_cap')`.
3. **Scan**: `SnapshotHandle { rootDir, sha, fileCount, byteSize }` handed to the scanner's
   container run (§2.2) as a read-only mount.
4. **Shred**: recursive delete in `finally` regardless of outcome + startup/hourly sweeper
   removing any orphan `snap-*` older than 2× max scan timeout. NFR-13 acceptance: after any
   scan (success, crash, kill −9) no snapshot bytes exist on disk, in DB, or in logs.

### 2.2 Sandbox (NFR-14) — repo content is UNTRUSTED input

Tool-running scanners execute inside a locked-down Podman container per scan: non-root UID,
read-only snapshot mount at `/scan` (`:ro,noexec`), `--network=none` by default, `--pids-limit`,
CPU/mem caps and wall timeout from `ScanBudget`, no forge credentials or env secrets mounted —
the host-side service fetches the tarball; the container only ever sees extracted files.
Scanners needing vulnerability data (grype/OSV) use a **pre-synced local DB volume** refreshed
by a nightly host-side `db-sync` job — scan containers still get `--network=none`. Findings
leave the container as JSON on stdout; the host validates against the schema before persisting.

## 3. W8 scanner roster (FR-SEC-3..8)

### 3.1 `secrets` — inputs: diff (stream) / snapshot (history) — FR-SEC-3/4

- **Stream mode** (default ON): runs on every ingested diff patch, riding W2 ingestion —
  no snapshot, no container; regex + entropy ruleset in **gitleaks-compatible rule format**
  (MIT; versioned asset `rulepacks/secrets.v{N}.yaml`) so upstream/custom detectors drop in.
  TruffleHog OSS is AGPL-3.0 and is excluded from the corpus/format choice — its license
  is incompatible with vendoring into a proprietary rulepack (CPU_FIRST_OFFLOAD 2026-07-16
  §4). Triggers: `pr_synced`, `push`.
- **History mode**: scheduled/manual pass over all backfilled patches in the warehouse (12-month
  window) — catches secrets committed then "removed"; still no snapshot needed (patches are
  already warehoused). Optional snapshot pass for current-tree files with no patch coverage.
- **Verified-secret escalation**: detectors with a verification probe (token format + issuer
  check where safely possible offline; live verification is config-gated, default OFF) that
  confirm ⇒ severity 5, `confidence 5`, immediate surfacing: org banner + top of Security tab.
  Unverified matches: severity by rule, `UNVERIFIED`-equivalent status `open`.
- Yields for chaining: `yields: ['credential:{kind}']`.

### 3.2 `dependency` — inputs: manifests — FR-SEC-5

No snapshot needed: manifest + lockfile paths (`package.json`, `pnpm-lock.yaml`,
`requirements*.txt`, `go.mod`, `Cargo.lock`, …) targeted-fetched at the default-branch head
SHA via `getFileContent` (budgeted). Pipeline per repo per default-branch commit:

1. **SBOM**: syft over the fetched manifest set → CycloneDX stored per (repo, sha) — the one
   allowed persistence beyond findings (it contains no repo code, only coordinates).
2. **CVE match**: grype + OSV against the SBOM; one finding per (package, CVE), `cve_id` set,
   severity mapped from CVSS (≥9.0→5, ≥7.0→4, ≥4.0→3, else 2).
3. **KEV correlation**: CISA KEV list (nightly db-sync) — KEV hit ⇒ severity floor 4 + `kev:true`
   in finding payload; surfaced as its own facet.
4. **Slopsquatting** (AI-hallucinated package names): heuristics — package-not-in-registry,
   registry age < 90d with low download count, small typo-distance (Damerau-Levenshtein ≤2) to
   a top-N popular package. Any hit ⇒ dimension `dependency`, rule `slopsquat`, severity 4.
5. **Posture rollup**: counts by severity + finding age percentiles → feeds Security tab tile
   and FR-INSIGHTS-2 security sub-score.

Triggers: daily `schedule` on default branch + `manual`; cheap `pr_synced` mode diffs
manifest changes only. Yields: `yields: ['vuln-dependency:{cve}']`.

### 3.3 `semgrep` — inputs: snapshot (full) / diff (incremental) — FR-SEC-6

- **Full mode**: weekly `schedule` / `manual` over a §2 snapshot; container runs **Opengrep**
  (LGPL fork, semgrep-rule-format compatible — same engine-swap contract as
  CODE_HEALTH_SUITE.md §9) with the workspace's configured rule packs — our own in-house
  **bpm-rulepacks** corpus (git URL + ref, fetched host-side by db-sync, mounted read-only).
  Semgrep's own registry rules/packs (`p/*`, `--config auto`) are never used — that license is
  barred for service use (CPU_FIRST_OFFLOAD 2026-07-16 §4/§6). Rulepack config in
  `repo_scanner_config.config`; pack + tool versions stamped in `scan_run.tool_versions`.
- **Incremental mode**: `pr_synced` cheap trigger — diff-scoped semgrep over changed files
  only (files targeted-fetched, not tarball) to catch regressions between weekly fulls.
- **Triage**: findings land `UNVERIFIED` (`open`); reviewer marks REAL/FP per §1.3 mapping —
  the bpm-opencode-experts semgrep-runner triage discipline, on RepoPulse's lifecycle rails.
- Yields where rules declare them (e.g. `yields: ['injection:sql', 'ssrf']`).

### 3.4 `owasp_web` / `owasp_llm` — inputs: diff + targeted contents — FR-SEC-7

LLM checklist scanners: OWASP Web Top-10 (2021) and OWASP LLM Top-10 (2025) checklists as
versioned prompt assets (`checklists/owasp-web.v{N}.md`, `checklists/owasp-llm.v{N}.md`),
executed through the **Tier-2/3 gateway** with all ANALYSIS_TIERS machinery unchanged:
chunking, 45k maxTokens, JSON-mode, zod validation, dedup, egress rules — same REQUIRED
finding schema plus two fields the checklist prompts must populate:
`preconditions: string[]`, `yields: string[]` (chaining vocabulary, §3.5). T3 escalation per
the existing security-dimension rule (severity ≥3). `owasp_llm` auto-enables when the
dependency scanner's SBOM contains LLM packages (`@anthropic-ai/sdk`, `openai`, `langchain*`,
`llamaindex`, …); `owasp_web` is manual/scheduled per repo. Triggers: `schedule`, `manual`,
optional `pr_synced` for changed-surface-only passes.

### 3.5 `attack_chainer` — inputs: findings — FR-SEC-8

Post-scan pass, enqueued after any scan batch completes (and weekly full recompute). Reads ALL
open findings for the repo (any scanner, any dimension) via `priorFindings`; matches
`yields → preconditions` across findings using the shared vocabulary (`credential:*`,
`injection:*`, `vuln-dependency:*`, `ssrf`, `authz-gap:*`, …) to build multi-step exploit
paths. Emits one finding per chain: dimension `chain`, `chain_id`, member finding ids in
payload, `evidence_quote` = the path summary. **Chain severity = min(5, max(member severities)
+ 1)** — a chain is worse than its worst link. Chains auto-resolve when any member finding
resolves (link broken, audit row). Dashboard renders the chain graph mermaid-style:
`entry → step → … → impact`, each node linking to its member finding.

### 3.6 CVE validation & VEX (D10, FR-SEC-13/14/15) — killing SBOM false-positive noise

A raw grype/OSV list is not a deliverable: most hits are dev-only, never imported, or hit
code paths the repo never calls — and unjustified suppression is how security tools lose
dev trust. Every `dependency` finding therefore runs a validation funnel; every dismissal
becomes an exportable, auditor-readable **VEX statement** — justified suppression, never
silent ignoring.

**Validation tiers (deterministic first — run in order, each stamps the finding):**

| Tier | What | Mechanism | Output |
|---|---|---|---|
| V0 | Alias dedup | group by OSV `aliases` (CVE↔GHSA↔OSV ids) | one finding per vuln×package, aliases recorded |
| V1 | Scope classification | lockfile graph: dev vs prod, direct vs transitive (+depth) | `dep_scope`; dev-only downgrades effective risk, NEVER auto-dismisses (build-time supply chain is still real) |
| V2 | Usage detection | import/require scan — snapshot tree when one exists for the SHA, else targeted fetches of source roots | `imported: bool`; never-imported ⇒ **proposes** `not_affected(vulnerable_code_not_in_execute_path)` |
| V3 | Symbol reachability | **Go**: govulncheck source mode inside the §2.2 sandbox (call-graph proof); **JS/TS/Python**: semgrep rules GENERATED from OSV affected-symbol data when the advisory carries it | `reachability: manifest_only \| imported \| symbol_reachable \| proven_unreachable` — tier honesty label rendered everywhere |
| V4 | Exploitability context | EPSS (nightly db-sync alongside grype/KEV — scan containers stay `--network=none`) + KEV | `epss`, `effective_risk` — since D12 the factored unified formula (EPSS/KEV→likelihood, reachability/dep_scope→exposure; RISK_MODEL.md §2 — same inputs, same column, catalog-versioned + workspace-tunable) |
| V5 | T2 adversarial verify (optional, top-N by effective risk) | FR-ANALYSIS-9 machinery: prompt = advisory summary + V2/V3 evidence (imports, call sites); maker≠verifier | proposed VEX justification + confidence — **proposes only; a human confirms** |

**VEX (FR-SEC-14).** Triage on dependency findings maps to OpenVEX:
`affected` (=confirmed) · `not_affected` — REQUIRES one justification:
`component_not_present | vulnerable_code_not_present | vulnerable_code_not_in_execute_path |
vulnerable_code_cannot_be_controlled_by_adversary | inline_mitigations_already_exist`
("there's a mitigation" and "we never call it" are first-class, auditable answers) ·
`fixed` · `under_investigation` (default for new findings). Statements persist in
`vex_statements` (DATABASE.md) keyed (repo, purl, vuln, version-range); re-scans at the
same version suppress silently (0 new rows); a version outside the range **reopens as
under_investigation** — suppressions never outlive their evidence. Exports: OpenVEX JSON +
CycloneDX-embedded VEX served alongside the SBOM (`GET /repos/{id}/sbom?vex=1`); the
Security Posture report gains the funnel + per-justification breakdown.

**Honesty rule (FR-SEC-15):** dependency surfaces always show the funnel
`raw → deduped → scoped → affected / not_affected / under_investigation`; default sort is
`effective_risk`; the raw count is never hidden. "47 raw advisories → 9 affected" is the
credibility story, in both directions.

Licensing/tooling notes: govulncheck BSD-3 (Go team) — runs as a sandbox tool like
semgrep/syft; OpenVEX spec + CycloneDX Apache-2.0; EPSS data is freely published by
FIRST.org (attribution line in the report footer — VERIFY exact terms at W8, Law 2).

## 4. Scheduling & triggers (FR-SEC-9)

| Trigger | Scanners (enabled repos) | Queue / idempotency key |
|---|---|---|
| `pr_synced` webhook | secrets(stream), semgrep(incremental), owasp_* (opt) | `sec:{repo}:{scanner}:{headSha}` |
| `push` (default branch) | secrets(stream) | `sec:{repo}:secrets:{sha}` |
| daily schedule | dependency (default-branch head) | `sec:{repo}:dependency:{sha}` |
| weekly schedule | semgrep(full), chains recompute, secrets(history, monthly) | `sec:{repo}:{scanner}:{sha}:w{isoWeek}` |
| manual "scan now" | any enabled scanner (admin/member per FR-AUTH-4 read vs run policy) | as above + `initiator` |

Queue `security.scan`, own worker pool, priority below `analysis.review`; idempotent jobs +
DLQ per NFR-11. `attack_chainer` is chained as a completion job after each batch.

## 5. Surfaces (FR-SEC-10)

- **Findings Explorer** (FR-WEB-9): new facets `scanner_key`, extended `dimension`, `cve_id`,
  KEV flag, chain membership; finding detail shows rule id, scan_run link, chain graph.
- **Repo Detail — Security tab**: posture score, CVE/KEV table (dependency), secrets status
  (last stream/history scan + open count), SAST summary, open chains with graph.
- **Security Posture report** (REPORTS.md / FR-REPORTS-4 enrichment): one section per enabled
  scanner (posture counts, deltas vs prior run, top findings) + chains appendix; degrades to
  existing Tier-1-only sections when scanners are disabled.
- **Org rollup tile**: workspace security tile — open findings by severity across repos, KEV
  count, verified-secret count (always red-flagged), worst chain; drills to per-repo Security tabs.
- Health score: open scanner findings feed the FR-INSIGHTS-2 security sub-score basis
  (label upgrades from "Tier-1 only" when scanner data present).

## 6. Non-functional commitments

- **NFR-13** snapshot never persisted — §2.1 shred + sweeper; test kills a scan mid-run and
  asserts zero residual bytes.
- **NFR-14** scan isolation — §2.2 container profile is the ONLY way tools touch repo content;
  lint gate: no `child_process` spawn of scan tools outside `packages/security/sandbox`.
- **NFR-15** scanner failure isolation — chaos test: crash every scanner; ingestion lag and
  Tier-1 dashboards unaffected; UI shows per-scanner error state, not a broken page.

## 7. Scanner backlog (registered contract targets — status `backlog`)

Future bpm-opencode-experts capabilities land as tickets against §1's interface — no core work:

| key | displayName | inputs | triggers | requiredTools | status |
|---|---|---|---|---|---|
| `iac` | IaC Checker | snapshot | schedule, manual | checkov, KICS, trivy-config | backlog |
| `cloud_security` | Cloud Security Checker (AWS/GCP anti-patterns) | snapshot | schedule, manual | checkov, semgrep cloud packs | backlog |
| `anti_slop` | Anti-Slop Auditor (30 AI-slop rules) | diff + snapshot | pr_synced, schedule | semgrep custom pack + heuristics | **promoted → W9 (D11, FR-CH-3; docs/design/CODE_HEALTH_SUITE.md)** — with siblings `code_health_tools` (lizard/jscpd) and `logging_hygiene` |
| `container_image` | Container Image Scan (Dockerfiles + built images) | snapshot | schedule, manual | trivy, grype | backlog |
| `dead_code` | Dead Code Detector (unused exports/files/deps) | snapshot | schedule, manual | knip (ISC), vulture (MIT), staticcheck (MIT) | backlog — full analysis needs installed dependencies, which conflicts with `--network=none`; ships when a deps-cache volume design exists (same pattern as vuln-DB volumes, SC-28)¹ |

¹ For interprocedural/deep taint beyond unused-export detection (JS/TS/Py/Java/C-C++
call-graph taint), **Joern** (Apache-2.0) is the selective deep-tier option — RAM-hungry,
run per-engagement not per-run (CPU_FIRST_OFFLOAD 2026-07-16 §2/§9). **CodeQL is excluded**:
its license bars use on non-OSS/commercial code without a GitHub Advanced Security
entitlement.

Each backlog scanner ships with: registry entry, rulepack asset, dimension mapping (`iac` uses
the reserved `iac` dimension; others reuse `sast`/`dependency`), yields vocabulary additions,
and a fixture-repo contract test — the same acceptance bar as the W8 five.
