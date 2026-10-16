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

**License policy (W18-39).** `registers/spdx.ts` resolves SPDX expressions (`OR` takes the side that obliges
least, `AND` the strictest, `WITH` linking exceptions downgrade GPL to weak copyleft) into five categories:
permissive, weak, strong and network copyleft, unknown. The license register flags network and strong copyleft
in prod scope by default; `licensePolicy.flagCategories` tunes it per workspace and the old `allow`/`flag` id lists
still work. Text that is not a recognised expression is `unknown`, never permissive. `GET /repos/:id/attribution`
exports a NOTICE-style inventory. Findings are posture only and gate nothing (N-3).

**Provider formats (W18-38).** The secrets pack carries 125 rules: the original 15 plus 110 provider formats
(cloud, CI, observability, payments, messaging, AI, package registries and connection URLs). The new ones are
`lifecycle: candidate` in `secrets.v1.yaml`: they run and their findings are stored experimental, out of scores
and gates until an admin promotes a rule on measured precision. `formats.test.ts` assembles a trigger and a
clean sample per rule at run time and checks no other rule claims the same token; live verification stays off.

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

**Injection dataflow (W18-33)** — `rulepacks/semgrep/bpm-baseline.injection.v1.yaml`, 28 taint-mode
rules, every one a shadow-mode candidate, each tagged with a CWE and an OWASP Top 10 (2021)
category. Seven weakness classes across JS/TS, Python, Java and Go: SQL injection (CWE-89),
OS command injection (CWE-78), path traversal (CWE-22), cross-site scripting (CWE-79, plus a
browser-side DOM variant), SSRF (CWE-918), open redirect (CWE-601) and unsafe deserialization
(CWE-502; no common JS sink, so no JS rule). Sources are request objects (express/fastify/koa,
flask/django/starlette, servlet and Spring bound parameters, net/http/gin/echo/chi);
sanitizers are per sink. **Limit, stated plainly:** the engine follows a value through one
function. A flow that crosses a call into another function, a field or a framework injection
is missed, not misreported — real interprocedural dataflow is the next step, not claimed here.

**Dependency fix paths (W18-36).** `scanners/dependency/fixpath/` reads the lockfile graphs in the snapshot (npm,
pnpm, yarn v1, poetry, uv, Cargo; go.mod is flat) and `adviseFix` names, for a transitive CVE, the direct
dependency to bump and a pin that is correct by construction (`overrides`, `pnpm.overrides`, `resolutions`,
`override-dependencies`, `cargo update --precise`); for a direct one, the lowest fixed version; for Go,
`go get module@fixed`. It says plainly when no fixed version exists or no graph can be read. A lockfile records
only what is installed, so the *release* of the direct dependency that picks up the fix is not guessed. Advice
only (D9a).

**Container images (W18-34).** `container_image` is opt-in (off by default,
manual trigger). Image references are extracted from Dockerfiles, compose files
and Kubernetes manifests (`scanners/image/refs.ts`), pulled host-side with
skopeo into ephemeral scratch (C1a), scanned with grype over the archive in the
network-less sandbox, and deleted. Registry credentials are the self-hoster's
(`IMAGE_SCAN_AUTH_FILE`). Findings use the `dependency` dimension at the
Dockerfile line; a file naming an image that failed to pull is never declared
reviewed, so an outage cannot close findings. Upgrade suggestions come from
scanning up to two newer same-variant tags.

**Swift (W18-41).** `bpm-baseline.swift.v1.yaml` (force-unwrapped URLs, MD5/SHA-1,
hard-coded `SymmetricKey`, interpolated `evaluateJavaScript`, trust-all
`URLSession` challenge handlers), `bpm-baseline.swift-plist.v1.yaml` (ATS
`NSAllowsArbitraryLoads`, generic matcher over `*.plist`), and Swift anti-slop and
logging packs. All are shadow candidates with trigger and clean fixtures under
`fixtures/swift/`. Engine limits (interpolation and comments are not structure)
are in each pack header. `Package.resolved` and `Podfile.lock` fixtures are in
`fixtures/ecosystems/swiftpm` and `cocoapods`; they are rows of the W18-47
matrix (`docs/ECOSYSTEMS.md`), which records whether syft and grype read them.

**Kotlin (W18-42).** Its own `bpm-baseline.kotlin.v1.yaml` (WebView file access and
JavaScript bridge, accept-all `TrustManager`), `bpm-baseline.kotlin-android.v1.yaml`
(`AndroidManifest.xml` cleartext traffic and exported components without a
permission, generic matcher), and Kotlin anti-slop (`!!`, `GlobalScope`,
`runBlocking`) and logging packs, all shadow candidates with fixtures under
`fixtures/kotlin/`. `!!` is a text match because the parser drops the operator.
A `gradle.lockfile` fixture is in `fixtures/ecosystems/gradle` for the W18-47
matrix; `build.gradle(.kts)` is not read.

**Injection for C#, Kotlin and Rust (W18-43).** `bpm-baseline.injection.dotnet-kotlin-rust.v1.yaml`
extends the W18-33 pack with 19 taint rules: C# (ASP.NET sources, seven classes
including `BinaryFormatter`), Kotlin (Spring and Ktor, six classes) and Rust
(actix/axum extractors, six classes). Kotlin XSS is not claimed and Rust has no
common unsafe deserialization sink. Fixtures announce each finding with
`// ruleid:` on the line before, and the golden test requires the engine to
report exactly those lines and nothing on the clean tree.

**C and C++ dataflow (W18-44).** `bpm-baseline.c-cpp-flow.v1.yaml` adds five taint
rules beside the W18-15 shape rules: argv, getenv and the buffer of fgets, read,
recv and fread reach system/popen/exec* (command), fopen/open/unlink (path), the
printf family (format string), strcpy/strcat/sprintf (unbounded copy) and the
length of memcpy/strncpy/read (size). Taint does not survive a write into a
buffer, so a command built with snprintf stays with `bpm-c-command-built-string`;
C++ stream declarations are not reported; a bounds check is not understood.
cppcheck reports none of these defects, so the dedup map is unchanged.

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

### 3.7 `sensitive_change` — inputs: diff (rides secrets stream) — W18-21

A radar for changes that **loosen** a protection: an auth or permission check removed, a
validation schema dropped or relaxed, a crypto work factor lowered or algorithm downgraded,
token/signature verification removed, TLS verification or CORS widened, security-header or
CSRF middleware removed, a rate limit removed or raised. Code: `src/scanners/sensitive-change/`.

- **Why in-process over patches, not an Opengrep pack.** The thing these rules notice is a line
  that is *no longer in the tree*. The pattern lane (§3.3 incremental mode included) scans files
  after the change and cannot see a removal. The radar reads both sides of the unified diff.
- **Pipeline reuse.** It runs inside secrets stream mode (§3.1) on the diff that scan already
  fetched for the same head SHA (`scanOneTarget`): no extra forge call, no snapshot, no queue
  hop. Arrivals only (`pr_synced`, `push`); history mode does not run it, because a year-old
  change is not something anyone can usefully review now. Own `scan_run` row
  (`sensitive_change.v1`), own enablement key (`sensitive_change`, default on), failures
  isolated from the secrets result (NFR-15).
- **Four rule shapes.** `removed` (guard name on the `-` side that nothing on the `+` side of
  the whole diff puts back), `added` (explicit weak setting), `lowered` / `raised` (a paired
  number moved the loose way, e.g. bcrypt rounds 12 → 8, `5/minute` → `1000/hour`).
- **Precision guards.** Names inside string literals are masked; a guard that reappears
  anywhere in the diff is "moved", not removed; a hunk that deletes the endpoint itself is
  skipped; tests, fixtures, docs, browser code (`.jsx`/`.tsx`, `frontend/`, `client/`) and
  new/deleted files are skipped and counted. One finding per rule per file.
- **Findings.** Dimension `security`, tier 1, title `Needs human review: …`, evidence = the
  `-`/`+` lines verbatim, no author (N-9), advice only (D9a). Severity is capped at 3 so a
  radar finding never needs a verify-pass confirmation to surface (FR-ANALYSIS-10); it is
  deterministic, never enters the verify pass, and is never auto-resolved by a diff-scoped
  run. Every rule ships as a shadow-mode candidate (`experimental: true` until the workspace's
  `rule_registry` row says `active`; `deprecated` stops it).
- **Languages.** JS/TS and Python. Java, Go and Rust rules are a follow-up once those packs land.

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
| `iac` | IaC Checker | snapshot | schedule, manual | checkov, KICS, trivy-config | partly shipped — **checkov, actionlint and hadolint run as `code_health_tools` adapters (W18-26)** writing `iac`-dimension findings as shadow candidates; the `iac` capability reports from that run (W18-35). Helm/Kustomize rendering and promotion on evidence follow in W18-45 (CODE_HEALTH_SUITE.md §10) |
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

## 8. External scanner results — SARIF uploads and GitHub code scanning (W18-24)

Repo Pulse is the one place for all findings, including the ones other tools found. Two
intakes feed the SAME findings store (`read.findings`) as our own scanners — no second table,
no `external` dimension. Code: `packages/security/src/external/`.

**Intakes.**

| Intake | Trigger | Scanner key | Run row |
|---|---|---|---|
| SARIF 2.1.0 upload — `POST /api/v1/repos/{id}/external-findings/sarif` (👑) | manual | `external:<tool>` | one per tool in the file, `trigger=manual` |
| GitHub code-scanning alerts (read-only pull) | nightly (`REGISTERS_NIGHTLY_CRON`) + manual "run now" | `external:<tool>:code-scanning` | one per tool + one `code_scanning_pull` summary row |

`<tool>` is the slugged `tool.driver.name` (`CodeQL` → `codeql`, `Semgrep OSS` → `semgrep-oss`).
Upload and pull are deliberately different keys, so a team doing both never has one sweep
closing the other's findings.

**Untrusted input (upload).** The SARIF body is data from an admin session, never instructions:
- capped at 10 MiB (`SARIF_MAX_BYTES`, 413 before parsing); `application/json` or
  `application/sarif+json`; prototype-poisoning keys refused by Fastify's hardened JSON parser;
- validated against a zod subset of the OASIS 2.1.0 schema (`version` must be exactly `2.1.0`,
  ≤20 runs, ≤20,000 results, bounded string lengths) — a failure is a 400 with field paths and
  **nothing stored**; zod strips every key we do not map, so snippets, code flows, fixes,
  invocations (command lines, environment) and attachments are never read or stored;
- **nothing is executed, fetched or resolved.** URIs are strings: `file://` and relative paths
  become repo-relative paths; absolute paths are accepted only under `originalUriBaseIds`, a
  caller-supplied `source_root`, or a GitHub Actions checkout root; `..` and unknown absolute
  roots drop the result (counted in `skipped.unusable_path`); non-file URIs make the result
  repository-level;
- results that are not failures (`kind` pass/notApplicable/informational), suppressed in the
  producing tool, or `baselineState: absent` are skipped and counted, never stored.

**Mapping** (`external/map.ts`, one mapper for both intakes):
- provenance: `scanner_key` = the tool's external key, `rule_id` = `external.<tool>.<native id>`
  (so FP-rate stats accrue to the tool's rule, never ours), `scan_run_id` → a run row whose
  `scanner_version` is `<tool>@<version>` and `tool_versions` holds the version and intake;
- severity: `security-severity` (0-10, GitHub's bands: ≥9→5, ≥7→4, ≥4→3, >0→2) wins; otherwise
  SARIF level error→4, warning (the spec default)→3, note→2, none→1. Code-scanning alerts carry
  the band (`security_severity_level`), mapped to the same 1-5;
- confidence: 3 (our own pattern-rule confidence) unless CodeQL `precision` says high (4) / low (2);
- dimension — existing `FINDING_DIMENSIONS` only: CVE/GHSA rule ids → `dependency`; secrets tools
  (gitleaks, trufflehog, …) or a `secret` tag → `secrets`; IaC tools (checkov, tfsec, kics,
  trivy, …) → `iac`; a `security-severity`, a `security` tag, a CWE tag or a SAST-only tool →
  `sast`; a `performance` tag → `performance`; else `code_health`;
- a secrets-dimension result never stores the tool's message (it may contain the value, SC-29);
- dedup key: the tool's `partialFingerprints` (or the code-scanning alert number) replaces the
  evidence + 10-line bucket in `dedupKey`, scoped by scanner key, rule and file — so a CodeQL
  result that drifts 40 lines is the same finding. Our own scanners never set it; no stored key moves.

**Dedup against our own rules.** `DEDUP_MAP` (`scanners/code-health/adapters/registry.ts`) gained
an optional `tool` scope and external entries (eslint `no-empty`/`no-console`/`no-eval`/
`no-await-in-loop`, CodeQL `js/*`). An external result is dropped — and reported as
`superseded_by_pack` — when its native rule maps (`keep: 'pack'`) to one of our pack rules **and**
that rule has an open finding of ours at the same file within 3 lines. Identity counts as a
mapping: a team uploading SARIF from our own `bpm-*` pack (semgrep prefixes the config path,
`rulepacks.semgrep.bpm-js-eval-dynamic`) yields to our live finding. `keep: 'tool'` entries (e.g.
CodeQL's taint-tracked `js/sql-injection` vs our pattern rule) keep both. Ids only — no rule text
from any tool is used.

**Sweep isolation.** An upload (or a complete pull) is treated as the tool's full current result
set: that tool's open findings it no longer reports are auto-resolved (`outdated_diff`), via
`persistFindings({ sweepScannerKey: external:<tool>… })`. It can never close another tool's
findings or ours; every one of our scanners already sweeps under its own key, so ours never close
an external one. `?sweep=false` (a partial upload, e.g. one CodeQL language category) and a pull
cut short by its 50-page cap close nothing.

**Pricing.** No separate path: the nightly reprice in the `metrics.snapshot` job prices every open
finding — external ones included — by dimension, severity, confidence, the rule's FP rate and the
file's hotspot exposure (RISK_MODEL.md). The findings API marks each external finding with
`external: { tool, source: 'sarif' | 'code_scanning', tool_version }` (null for ours).

**GitHub code scanning — permission.** Listing alerts needs the GitHub App repository permission
**"Code scanning alerts: Read"** (`security_events: read`). The App registration
(docs/research/github-app.md) requests it, read-only (product decision, 2026-10-15). Existing
installations must re-approve before it takes effect, so the pull still runs behind the
permission's presence —
a 403 is recorded as `no_code_scanning_permission` with a sentence telling an org owner what to
grant, never as "zero alerts" (which would sweep everything closed). No write scope is requested or
usable: the forge method is a GET of `state=open` alerts, budgeted on the `scan` lane, `checks`
secondary bucket. A repository without code scanning answers 404 → `code_scanning_not_enabled`.
A PAT connection needs `security_events` (classic) or "Code scanning alerts: read" (fine-grained).

**GitLab / Gitea: not supported yet.** Their adapters do not declare
`supportsCodeScanningAlerts`; the pull records `code_scanning_not_supported`. GitLab's
vulnerability-report API and Gitea (no native code scanning) are follow-ups; teams on either can
upload SARIF instead.

Note: §7 excludes *running* CodeQL ourselves for licensing reasons. Ingesting results a team
produced under its own entitlement is a different act and is what this section does.

**Ecosystem matrix (W18-47).** `fixtures/ecosystems/<id>` holds one pinned,
known-vulnerable lockfile per ecosystem (17 rows, including Conan and vcpkg).
`pnpm --filter @repopulse/security ecosystems` runs syft and grype over each in
the scan image and writes `docs/ecosystems.json` and `docs/ECOSYSTEMS.md`, so a
row reads Supported, Read-but-unmatched, or Unsupported from a measurement, never
from the tools' documentation. Until that has been run, every row says "Not yet
run". A test holds the committed doc equal to its rendering.

**Helm and Kustomize (W18-45).** The `iacrender` adapter renders every Helm chart
(`helm template`, the chart's own default values, vendored subcharts through
their parent) and every kustomize overlay (`kustomize build`, default load
restrictor, no plugins and no helm inflation) into the sandbox tmpfs, then runs
checkov's `kubernetes` framework over the result with the same allowlist as plain
manifests. Findings are attributed to `Chart.yaml` or `kustomization.yaml` at line 1,
because generated YAML has no source line, with the rendered resource named in the
message. Rendering is offline: a chart whose dependencies are not vendored, or an
overlay with a remote base, is reported as `tool.iacrender.render-failed` ("not
checked"), never as clean. Per-environment values files are not applied. Findings are
shadow candidates like every checkov rule.
