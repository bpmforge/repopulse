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
- W23-03: optional ops `compareCommits(ctx, repo, base, head) -> {files: {path, status, previousPath?}[],
  truncated}` and `getCommitTreeSha(ctx, repo, sha) -> string | null`, both through the budgeted
  client (§4.2). `truncated` means "the list may be short, treat the answer as unknown".

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
4. **Slopsquatting** (AI-hallucinated package names) — **built in W21-05** as its own scanner key
   `slopsquat` (`scanners/slopsquat/`), dimension `dependency`, both rules shipped as candidates
   (shadow):
   - `slopsquat` — the declared package is not in the registry's name list. Severity 4,
     confidence 4 (5 when it is also a near miss or arrived in the scanned diff). Registry data
     is an OFFLINE index (`$SCAN_RULES_DIR/package-index`, built host-side by
     `deploy/build-package-index.py` from `deploy/scan-db-sync.sh`); no registry call is ever made
     at scan time. An absent index, ecosystem or private index is reported as "not checked" on the
     run (`tool_versions.registry.<eco>`), never as clean, and the sweep keeps such findings open.
   - `slopsquat.near-miss` — the package exists but imitates a popular one (homoglyph, separator,
     affix, Go look-alike owner, one edit of a top-1,000 name keeping its first letter). Where the
     index carries metadata (crates.io, Go first-seen) only young (< 90 d) or low-download
     (< 1,000) packages are flagged, at severity 4; elsewhere severity 3, confidence 2.
   The original spec here said Damerau-Levenshtein ≤ 2; two edits were measured on 4,000 real
   packages and dropped (see `similarity.ts`). Snapshot mode runs inside this scanner's run over
   the same snapshot; the cheap `pr_synced`/`push` mode rides the secrets stream and reads only
   ADDED manifest lines (modified manifests fetched at head via `getFileContent`).
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

**Java benchmark gaps (W18-49).** Two shadow-mode packs of our own, written for ordinary Java and not for
a benchmark: `bpm-baseline.java-crypto.v1.yaml` (weak hash CWE-328, weak cipher CWE-327, and weak
random CWE-330 inside a servlet request handler) and `bpm-baseline.java-web.v1.yaml` (cookie without
Secure CWE-614, plus taint rules for LDAP filters CWE-90, XPath CWE-643 and session trust boundary
CWE-501). The Java injection rules gain the other servlet sources (`getHeaders`, `getHeaderNames`, a
request variable of any name by its declared type) and the fully qualified `java.io` / `java.nio.file`
sinks. The scanner now runs Opengrep with `--taint-intrafile`, so a value passed through a helper defined
in the same file is followed instead of assumed tainted; that is the largest single false-positive
reduction on the public benchmarks. `bpm-java-sql-string-concat` no longer runs inside a servlet
request handler, where `bpm-inj-sql-java` reports the site once with data flow; the rule records the
cost (second-order injection in a handler is no longer reported). A bare `Cipher.getInstance("AES")`
(ECB by default in the JCA) is deliberately not reported: public benchmarks count it as safe, and the
rule is left for a separate measured candidate. Measured results: BENCHMARKS.md. (W18-50: the Juliet sample now includes path traversal and weak PRNG, and `bpm-java-insecure-random-token` matches `Math.random()`.) (W18-53: `bpm-kt-insecure-random-token` has the same fix, plus `Random.Default`, `kotlin.random.Random`, `java.util.Random()` and the collection/range `.random()` forms.)

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

### 3.3a Third-party rule files (W22-07, 2026-10-28)

The licence rule in §3.3 bars *Semgrep's registry* rules, not every rule someone else
wrote. Rules published under MIT or Apache-2.0 may ship, verbatim, with their licence
beside them. `scripts/import-third-party-rules.mjs` copies them at a pinned commit into
`packages/security/rulepacks/third-party/<source>/` and writes `LEDGER.json` (file,
licence, rule ids, SHA-256). Admission is deny-by-default and per file: GitLab's
sast-rules mixes MIT, Apache-2.0 (gosec-derived), GPL-2.0 (flawfinder-derived `c/`), LGPL,
Commons Clause and EE folders, and only the first two are taken.

| Source | Commit | Licence | Files / rules | Languages |
|---|---|---|---|---|
| 0xdea/semgrep-rules | e0121ac | MIT | 49 / 49 | C, C++ (memory safety) |
| elttam/semgrep-rules (`rules-audit/`) | 2442685 | MIT | 60 / 73 (2 files excluded) | Java, Go, C#, JS, Python, Kotlin, C, generic |
| gitlab-org/security-products/sast-rules | 705c083 | MIT, Apache-2.0 | 270 / 270 | Java, Scala, Python, C#, Go, JS/TS |
| bpmforge/bpm-rulepacks (`packs/`, ours) | 8448116 | MIT | 219 / 232 | framework, house, OWASP, secrets, slop |

bpm-rulepacks is our own, not third-party, but it was a separate private repo marked
"All rights reserved". The owner opened it into Repo Pulse on 2026-10-28 ("open the
rules"), so it goes through the same ledger, shadow status and flag. It was relicensed
MIT in its own repository (bpm-rulepacks#45) and re-imported at 8448116, which also
carries the 16 rules narrowed by the grading below (bpm-rulepacks#46: 674 -> 254 hits on
the walkthrough repos, 29 of 30 true hits kept). The source is private until release
day (W22-13), so it imports with `--src` only.

**Graded and excluded (2026-10-28).** All 629 imported rules pass `opengrep --validate`.
On the six walkthrough repos they made 975 hits outside test paths, and a seeded sample of
775 was read: proposed precision 3.9% (30 true), with 1 true from the third-party sources.
[docs/benchmarks/rule-grade-w22-07](../benchmarks/rule-grade-w22-07/README.md) has the sheet.
Two elttam files fire on the wrong language or framework and are excluded in the importer, with
the reason in `LEDGER.json` (`excluded`): `struts-xml-action-name.yml` matched every
AndroidManifest.xml, and `beego-orm.yaml` (4 rules) matched `fmt.Fprintf` in a repo with no
Beego. That leaves 392 third-party rules. A third-party file cannot carry our per-rule
`paths: exclude`, so the scanner drops third-party findings on test, fixture and `.semgrep/`
paths (`isThirdPartySkipPath`).

**How they run.** The scanner reads the ledger, never the directory, and mounts the pack
at `/rules-tp` beside ours, only for a full security run that did not narrow its pack.
Every imported rule ships **shadow** (`rules/shadow.ts` via `rules/third-party.ts`)
whatever its file says, and earns `active` the way ours do. `SCAN_THIRD_PARTY_RULES`
is `off` until the pack has been validated on the live engine (`opengrep --validate`
plus a scan of the walkthrough repos with hit counts per rule); a rule the engine
rejected would otherwise turn every full scan's sweep narrow. Tests
(`rules/third-party.test.ts`) hold the ledger to its word: allowlisted licences only,
files unmodified since import, nothing on disk that is not listed, a LICENSE per
source, no id colliding with ours.

**Not imported, and why** (project file review-2026-10-27/THIRD_PARTY_RULES.md):
opengrep/opengrep-rules (Commons Clause over LGPL, Semgrep as licensor), Trail of Bits
(AGPL-3.0), Bearer (Elastic License 2.0), Decurity and parsiya (CC BY-NC-SA), GitLab
`c/` (GPL-2.0) and `rules/lgpl*` (LGPL / Commons Clause, pending the owner's call on
LGPL rule files). gitleaks (MIT, 222 secrets rules) is TOML for its own engine and is a
separate slice.

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

### 4.1 "Up to date" short-circuit for weekly and manual runs (W23-01)

Before this, a weekly job or a second press of "Run scans now" re-fetched a tarball and
re-ran every tool even when nothing could have changed. The PR path already asked the
question (`headAlreadyScanned`); `packages/security/src/framework/up-to-date.ts`
generalises it.

- **Ledger columns** on `scan_runs`: `scope` (`full` | `incremental` | `skipped`, default
  `full`), `base_run_id` (the run a skipped/incremental row stands on), `data_version`
  (the scanner's data stamp, null when it declares none).
- **`isUpToDate(db, {workspaceId, repoId, scannerKey, commitSha, toolVersions, dataVersion})`**
  returns the earlier run (id, finding count) or null. A match is a *succeeded*,
  *non-partial* run for the same workspace, repo, scanner and commit, whose `tool_versions`
  deep-equal the ones the next run would stamp (null on both sides = equal) and whose
  `data_version` equals the query's (a null query value ignores the comparison). `skipped`
  rows and `pr_synced` rows (changed-files-only) never count as a baseline.
- **How the framework learns what the next run would stamp, without a key branch:** an
  injected map of probes by scanner key (`ScanProcessorDeps.probes`, built in
  `apps/api/src/routes/runs/probes.ts`, same shape as `weeklyRunners`) answers
  `{commitSha, toolVersions, dataVersion}` for a repo. **A scanner with no probe always
  runs**; each one without is listed in `ALWAYS_RUN` with the reason, and a test fails when a
  `weeklyRunners` key is in neither list (W23-09). See the table below.

**Probe table (W23-09).** A probe never starts the scan, a container or a tarball fetch. The
three fields come from:

- `commitSha`: the newest ingested commit (`headShaFor`, workspace-filtered), except the supply
  chain register, whose run row carries its newest SBOM's commit.
- `toolVersions`: those of the newest succeeded, non-partial run at that commit
  (`latestBaseline`). Everything the scanners stamp here is a function of the tree (the
  adapters it triggers, the packages the SBOM holds) and of the scan image / registry that
  `dataVersion` pins, so for an unchanged commit it cannot differ from what the last run read.
  This is why the semgrep probe no longer needs podman: the engine version is the one the last
  run read from the image, reused only while `dataVersion` (which names the image) is unchanged
  and only when it is not `unknown`. No such run, or one that could not read the engine, means
  "run".
- `dataVersion`: everything else the answer stands on, recomputed from files and rows by the
  same function the runner stamps with (one per scanner, beside its runner). It is a readable,
  order-independent `name@value` string (`framework/data-stamp.ts`); any input that applies but
  cannot be read makes the whole stamp, and so the probe, null: a probe never returns
  `dataVersion: null`, because the framework reads that as "no data, skip the comparison".

| runner key | probe | `dataVersion` stands on | stamped by |
|---|---|---|---|
| `semgrep` | yes | rulepack file list, scan image, third-party ledger when `SCAN_THIRD_PARTY_RULES=on`, workspace rule-lifecycle digest, scanner version | `runSemgrepFull` |
| `code_health_tools` | yes | registered adapters + versions (a new adapter may apply to the same tree), lizard/jscpd pins, thresholds, scan image, rule-lifecycle digest, scanner version | `runCodeHealthScan` (not when an adapter reported an error) |
| `dependency_cve` | yes | advisory data: grype DB build stamp (`import.json`, which carries the OSV/KEV/EPSS-enriched advisories), malicious-package index and package-name index signatures; scan image; scanner version. Null (run) when the DB is missing or older than grype's 5-day limit, so its named failure still surfaces | `runDependencyScan` |
| `container_image` | yes | the same advisory data, scan image, scanner version and a **UTC day bucket**. A tag is a mutable pointer and its digest is known only after a pull (`pullImage` writes a docker-archive and reports none), so no pre-pull fact says the registry still holds what was scanned; the bucket bounds how stale an answer may be. Partial runs (an image failed to pull) never count | `runImageScan` |
| `anti_slop` | yes, **worker only** | slop half of the code-health rulepack, scan image, rule-lifecycle digest, scanner version, and the **judgement state** (`off`, or `on:<hosts/models>`) so a run with AI off never stands in for one with a model on. The API route has no gateway, so there the probe says "cannot say" and the worker still skips | `runAntiSlopScan` (`dataVersion` dep, from the worker) |
| `supply_chain_register` | yes | newest SBOM id (a regenerated SBOM is a new row), repository head (the EOL half snapshots Dockerfiles), license policy, scanner version and a **UTC day bucket**: the register refreshes npm/PyPI release metadata and endoflife.date from the network on every run, which has no stamp to read first. It does not read the grype database | worker runner, after `runSupplyChainRegisters` |
| `architecture_register` | yes | registered adapters + versions, drift pack version, scan image, scanner version | worker runner, after `runArchitectureScan` |
| `knowledge_register` | always runs | pure SQL over commits already in the warehouse, no tarball and no tool; its input is a rolling 90-day window, so the same head answers differently as the window moves | n/a |
| `test_gap_register` | always runs | pure SQL over the warehouse, no tarball and no tool; costs nothing | n/a |
| `attack_chainer` | always runs | reads the findings table, which every other scanner changes; no forge call; a skip would leave chains built on findings that have since closed | n/a |
| `code_scanning_pull` | always runs | its input is live forge state (alerts opened or dismissed since); no tarball | n/a |
| `owasp_web`, `owasp_llm` | always run | manual-only, model-judged over the newest diff; which model answers is known only after it does; a repeat press asks for a fresh judgement; no tarball | n/a |
| `rule_draft_pass` | always runs | workspace-scoped learning pass through a model; no commit to compare; no tarball | n/a |

`secrets` history is not in this map: its own `covered` filter already skips commits a
succeeded or running secrets run holds, and `force` now bypasses it (below).

**What the stamps still do not cover** (stated so a skip is not read as stronger than it is):
a scan image rebuilt under the SAME tag is invisible (the image reference is stamped, not its
digest); the dependency run's optional second-model CVE verification and the Go vulnerability
database are not stamped, so toggling AI or refreshing only the Go DB does not re-run it; the
registry `Scanner.dataVersion()` hook is not populated for these scanners (`catalogue.ts` is
outside W23-09's write scope), so the probes carry the stamp explicitly and the processor's
registry fallback has nothing to read; the probes read the rulepack and advisory directories
from the process they run in, so a probe in a process that cannot see `SCAN_RULES_DIR` (an API
container that does not mount it) answers "cannot say", and only the worker's check, which runs
where the scanners run, can skip.

- **`runSweep`** (weekly and manual/history jobs) asks before calling the runner. Up to
  date → one `scan_runs` row `{status: succeeded, scope: skipped, finding_count: <prior>,
  base_run_id: <prior id>, commit_sha: <the real head>}` whose `error` carries the
  `up_to_date` sentence from `NOTHING_SCANNED`, and the runner is not called. The Security
  and Code Health payloads treat a skipped row as an `ok` result (`last_run_scope:
  "skipped"`, error withheld) and the tables read "Up to date as of <date>". A probe that
  throws or returns null runs the scan: a skip is earned by evidence.
- **Force:** `ScanJobData.force` bypasses the check. `POST /repos/:id/scan` accepts
  `{scanner_key?, force?: boolean}` (the "Full rescan" checkbox beside "Run scans now"),
  computes the same check synchronously before enqueueing and returns
  `up_to_date: [...]` beside `started` / `already_running` (up-to-date keys are still
  enqueued so the worker records the skipped row, but are not in `started`). A forced job
  uses a distinct jobId (`...-force-<window>`) so it is not deduped against a non-forced
  press in the same five-minute window.
- Real runs keep `scope = 'full'`. Since W23-09 the runners stamp `data_version` on their own
  rows (semgrep, code health, dependency, container image and anti-slop in the security
  package; the supply chain and architecture registers from the worker runner, which writes
  the stamp onto the row the package created). A row without a stamp can never be matched.
- **`force` and the secrets history sweep (W23-09):** `ScanJobData.force` is now passed to every
  sweep runner, and `runSecretsHistoryScan({force: true})` bypasses the `covered` filter, so a
  commit stuck in a `running` row (a worker that died mid-scan; `covered` counts `running`)
  is swept again. It re-sweeps the window oldest-first up to the usual 200-commit cap through
  the same budgeted `scan` lane.

### 4.2 Incremental runs for per-file scanners (W23-03)

A manual or weekly run of a scanner that judges each file on its own does not need the whole
tree again when one file changed. `code_health_tools` and `semgrep` now plan an **incremental**
run against the last real answer: fetch only the files that changed, scan those, and carry the
rest of the previous findings forward. The result is still the whole tree's; only the work is
incremental (INCREMENTAL_SCAN_PLAN claim C12).

**Registry metadata, not a branch.** `Scanner.incremental?: { maxChangedFiles }` (catalogue.ts)
marks a scanner as eligible and sets the largest delta it will fetch file by file (200 for both).
The framework never reads a scanner key to decide this.

**Forge port.** `compareCommits(ctx, repo, base, head)` returns the changed paths and statuses:

| Forge | Endpoint | `truncated` when |
|---|---|---|
| GitHub | `GET /repos/{repo}/compare/{base}...{head}` (3 pages of 100) | 300 files reached, or `base` is not an ancestor of `head` (`diverged`/`behind`: GitHub then lists the change from the merge base) |
| Gitea | `GET /repos/{repo}/compare/{base}...{head}` lists commits only, so files come from each commit's own file list | a merge commit is in the range (its files are not listed), or more than 50 commits |
| GitLab | `GET /projects/:id/repository/compare?from&to&straight=true` | `compare_timeout`, or 1000 diffs |

`getCommitTreeSha` is `GET /repos/{repo}/git/commits/{sha}` -> `tree.sha` on GitHub and
`commit.tree.sha` on Gitea; GitLab exposes no tree id on a commit and answers `null`. It is what
the W23-04 architecture gate already asked for (`commitTreeSha`).

**The plan** (`framework/incremental.ts`, `planIncremental`) answers `full` unless every one of
these holds, so a refusal is a redundant full scan and never a stale answer:

1. the forge can compare, the comparison is not truncated and has at most `maxChangedFiles` files;
2. there is an earlier real run (`latestBaseRun`: succeeded, whole, not skipped, not a PR look)
   whose tool versions and data stamp equal this run's (a null stamp, i.e. unreadable now, plans full);
3. **drift guard:** fewer than 10 incremental runs since the last `full` row, that full is at most
   30 days old, and one is on record at all.

A run that is handed a tree already on disk (a batch that fetched one for another scanner) or
that is a "Full rescan" (`force`) does not plan: a full run is free in the first case and asked
for in the second.

**The merge** (`carryForward`, packages/insights). Findings the base run saw (`last_seen_scan_run_id`)
on files not in the delta are re-sighted on the new run: same rows and dedup keys, `last_seen` and the
sighting pointer moved, `occurrence_count` +1. Findings on files the delta deleted (or renamed away)
are closed (`outdated_diff`, an event naming the new run). Findings on changed files are left to the
new scan's `persistFindings`, whose sweep is limited to the files the run actually read (it passes
`reviewedFiles` and no tree list, so nothing outside the changed set is closed by silence).
The run row is `scope = 'incremental'` with `base_run_id` set, and carries the same `data_version`
stamp, so it is itself a valid baseline for the next probe and plan.

**Anything that cannot be exact falls back to a full run having written nothing** (no row, no
finding): a changed file the forge will not return in full (over 1 MB, binary), a path outside the
scratch dir, a failed fetch.

**Which tools are per-file.** Each code-health adapter declares `scope` (an adapter that does not is
read as `'tree'`):

| Tool | `scope` | Why |
|---|---|---|
| lizard (complexity, file length) | per-file | measured per function and file |
| ruff, Biome, shellcheck, hadolint, actionlint | `file` | each finding is a property of one file |
| cppcheck | `tree` | whole-program analysis across translation units |
| checkov, iacrender | `tree` | graph checks and renders follow references across files |
| jscpd (duplication) | whole-tree | a clone is a relation between files |

A last full run that used a `tree` adapter, or a changed file one would read, makes the next run full.
jscpd is **not run** incrementally: clone findings already on record are neither replaced nor closed
by an incremental run (only deleting their file closes them) and the three posture metrics
(`ch_duplication_pct`, `ch_complexity_p90`, `ch_worst_fn_count`) are not written, because over a handful
of files they would plot a drop that never happened. The next full run, at most ten incrementals or
thirty days away, recomputes both.

semgrep is planned the same way, with the engine and the same per-file fetch the PR path uses
(`fetchChangedFiles`, shared with `runSemgrepIncremental`, whose behaviour is unchanged). Its
`filesScanned` is the number of changed files read. A baseline that never recorded the engine version
is not trusted.

**Coverage chip.** The Security tab's coverage table shows "incremental since a1b2c3d - last full
14 Oct" under the last-run date of an incremental run (`last_run_base_sha`, `last_full_at` on the
scanner status payload).

**Step 0 verdicts (recorded here and in the commit).**
- `owasp_web` / `owasp_llm` "scheduled surface" (`owasp/run.ts:29-30,57`) is a **delta**, not the tree:
  the runner (`runChecklistNow`, workers/index.ts) reads the newest ingested commit's own file list
  (`diffOf` -> `getCommitFiles`). No change needed. (It does mean a scheduled run reviews one commit,
  not everything since the last run, which is a coverage question rather than a cost one.)
- `anti_slop` (workers/index.ts) is **whole-tree**: it reads every source in the snapshot
  (`readSnapshotSources`) for density measures and a model judgement over the tree, and the logging and
  perf packs ride the same bracket. Not per-file, not changed.

**Known limitation.** Inside a batch ("Run scans now") the batch still fetches the one tarball when
any scanner in it reads a tree (`usesSnapshot`), and the scanners run on that tree as a full run; the
incremental path applies to weekly per-scanner jobs, a manual run of one scanner, and batches where
no tree was fetched. Skipping the tarball when only incremental-capable scanners remain needs a hook in
`scan-processor.ts` (outside this ticket's scope).

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

### 5.1 Scan scope on the Security tab (W23-08)

The coverage table has a **Scope** column that says what each scanner's *last run* actually did,
so a date in "Last run" is never read as "the whole repository was re-read that day":

| Scope cell | What it means for an operator |
|---|---|
| `full` | The last run read the whole tree (or the whole input, for a whole-tree scanner). Its findings are a fresh, complete measurement. |
| `incremental since a1b2c3d` | The last run looked only at the files changed since commit `a1b2c3d` (seven characters of the base) and merged that delta with the findings carried forward from the earlier run. Cheaper, and correct for per-file tools, but it is only as complete as the last full scan. |
| `up to date as of 31 Oct` | Nothing was scanned. A successful run at this same commit, with the same tool versions and data, already answers the question, so the row restates it. The date is when that was confirmed. State reads "up to date", never "ran clean". |
| `—` | No run yet, or a scope this build does not recognise (older payloads). Nothing is guessed. |

Under the scope text the cell states **Last full scan: <date>** (or "No full scan on record"). It is
also the cell's tooltip, and is rendered as text so keyboard and screen-reader users get it too. It
comes from `last_full_at` on the coverage payload; a `full` run is itself that moment.

**Full rescan** is reachable from three places, all sending `force: true` to
`POST /repos/:id/scan`, which skips the up-to-date question and the incremental baseline:

1. the "Full rescan" checkbox beside **Run scans now** (every enabled scanner);
2. a **Full rescan** button in the Scope cell of any row whose last run was `incremental` or
   `skipped` (that scanner only; admin only);
3. a "Full rescan" checkbox beside the per-row **Re-run** link in the State cell.

Use it when you changed something the commit does not show (a rules file, a scanner's config, the
vulnerability database), or when the last full scan is old enough that you no longer trust the
carried-forward findings. e2e: `e2e/scan-scope.spec.ts`.

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
| `iac` | IaC Checker | snapshot | schedule, manual | checkov, KICS, trivy-config | partly shipped — **checkov, actionlint and hadolint run as `code_health_tools` adapters (W18-26)** writing `iac`-dimension findings as shadow candidates; the `iac` capability reports from that run (W18-35). Helm/Kustomize rendering shipped in W18-45; the four adapters were measured on labelled fixtures and this repository's own files in W18-48 (docs/BENCHMARKS.md): none is promoted, all stay shadow candidates until a workspace's own triage meets the promotion gate |
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

**Swift, CocoaPods and vcpkg (W18-51, W18-52).** Measured on the real tools, not assumed.
*SwiftPM* was read by syft and matched by nothing, though the database holds active swift-nio
advisories for the pinned version: syft names the package `swift-nio`, the database indexes
`github.com/apple/swift-nio`, and grype looks up the name it is given. The dependency scanner now
runs `deploy/scan-tools/sbom-normalise.mjs` between syft and grype, which writes a COPY of the SBOM
with a namespaced Swift package named by its purl path; the SBOM returned to the caller stays
syft's own, and a normaliser failure fails the scan. The SwiftPM row is now Supported (3
advisories). *CocoaPods* has the advisory too (an NVD record under the CPE vendor
`afnetworking_project`) but no key joins it to syft's `AFNetworking`; a wildcard vendor matches it
and also matches unrelated products by name alone (measured against the 103,421-pod index), so no
join is applied and the row stays unmatched with its cause published. *vcpkg*: syft reads the
manifest's own name and version, never its dependencies, even with an exact `overrides` pin; not
built (W18-52).

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

**Symbol reachability for npm and PyPI (W18-46).** V3 used to stop at "imported"
outside Go. `src/validation/symbols.ts` now holds a catalogue of advisories that
name a public vulnerable function (lodash `template` and the prototype-pollution
set, PyYAML `load`, jsonwebtoken `verify`, minimist, ejs, underscore, node-serialize),
and `pnpm --filter @repopulse/security reach:generate` renders one Opengrep rule per
symbol into `rulepacks/reachability/bpm-reach.v1.yaml` (a test holds the committed file
equal to its rendering). The rules spell out every way the symbol is bound (require,
`import x`, `import * as x`, destructuring, aliases, per-method modules such as
`lodash/template`) because the engine resolves only some of them itself. PyYAML calls
that pass a safe loader are excluded.

A call site upgrades the finding to `symbol_reachable`, proven by `opengrep`, and the
finding says "this repository calls X at file:line … that shows the function is used,
not that untrusted data reaches it". The absence of a call changes nothing and the
verdict says so: these ecosystems never answer `proven_unreachable`, because a text-level
call search cannot see dynamic access, re-exports or transitive callers. A scan that has
no catalogued vulnerable package starts no container. The rules are shadow candidates and
produce no findings of their own. Growth is by adding catalogue rows (each needs a trigger
and a clean fixture), or via `symbolsFromOsv` when a feed carries
`ecosystem_specific.imports[].symbols`, which npm and PyPI records rarely do.
