# The attest experts, inventoried for Repo Pulse (read-only survey, 2026-10-17)

Brad confirmed that the "specialist agents" in `AI_LAYER.md` are the **attest** experts (the project
`ANALYSIS_TIERS.md` §4 calls bpm-opencode-experts; the name changed). This document says what is
there, how it maps onto Repo Pulse's roles, and which parts can ship as data and which cannot.
Nothing was copied out of attest: the descriptions below are mine, and the only quoted text is a few
file, section and rule names.

## Where it is, and what it is

| Place | What |
|---|---|
| `~/Code/attest` | The canonical source, **v3.13.3**, Apache-2.0, Brad's (remote `bmatthews/attest`). Written for [OpenCode](https://opencode.ai). |
| `~/Code/attest-claude` | The Claude Code variant. **Generated** from the above (`GENERATED_FILES.txt`: edit attest, then `npm run build:claude`), so the expert text is identical; only skills, hooks and install differ. |
| `~/Code/attest-browser` | A different project (a browser-testing tool). Not experts. |
| `~/.config/opencode`, `~/.claude/agents` | Installed copies / config. Not the source. |

Counts in `attest/agents` (156 markdown files, about 2.2 MB, roughly 560k tokens if loaded whole):
36 `primary` experts, 47 `subagent` specialists, 68 reference documents and shared protocols that
declare themselves "read on demand, not an agent", and 5 templates or other. Beside them: 51 skills,
6 commands, 48 reference files, 18 tool scripts, 2 OpenCode plugins, a `models.json`, and an `evals/`
tree of 619 files. `dist/compact-agents` holds 50 shorter variants for small local models; they average
**90%** of the full size, so they are not a large saving.

How this was measured: by structure only. I parsed each file's frontmatter (`description`, `mode`),
size, headings and the tools it names; I read the opening of the security coordinator, the specialist
tables of the code-health and performance coordinators and a sample of specialist headers, and counted
the rest (the scaffolding counts above are exact, over all 23 files). Token counts are bytes divided by four.
"Expects" lists tool names a file mentions, which is evidence of what it assumes, not a proof that it
cannot run without them.

## The shape every cluster shares

A **coordinator** (a `primary` expert, 19-21 KB, about 4-5k tokens) dispatches **specialists**
(`subagent`, 8-14 KB, about 2-3k tokens each) in ordered waves, some conditional ("if cloud SDKs are
detected", "only when a performance problem is confirmed"), then runs a **synthesizer** last. Each
specialist writes a dated markdown file (`<AREA>_FINDINGS_<date>.md`) and the synthesizer reads those.
The finding shape is fixed by a small schema document per cluster (`FINDING_SCHEMA.md` /
`FINDINGS_SCHEMA.md`, 4-5 KB) that also carries `preconditions` and `yields`, the fields Repo Pulse's
attack chainer already consumes.

Runtime scaffolding comes before the checklist. Counted across the 23 specialist and synthesizer files in
the three clusters: **23 of 23** carry a mandatory handoff-intake section, and **23 of 23** mention the
memory-store and task-delegation tools. (A "do not end your turn early" persistence rule is in the
coordinators, not in the specialists.)

## Inventory by cluster

### Security (coordinator `security-auditor`, 21 KB)

| Specialist | Role | Size | Expects |
|---|---|--:|---|
| `semgrep-runner` | Runs SAST packs and triages each hit real / false positive / unverified | 9 KB | bash, semgrep or opengrep, memory |
| `secrets-scanner` | Hard-coded credentials in source, config, history | 9 KB | bash, grep, trufflehog |
| `dependency-auditor` | CVE and supply-chain review, flags hallucinated package names | 14 KB | bash, grep |
| `owasp-web-checker` | OWASP Top 10 (2021), one category at a time, with a confidence loop | 8 KB | read, semgrep |
| `owasp-llm-checker` | OWASP LLM Top 10 (2025), only if LLM code is present | 10 KB | bash, grep |
| `threat-modeler` | STRIDE per component, trust boundaries, ratings | 9 KB | read |
| `cloud-security-checker` | AWS/GCP anti-patterns | 8 KB | checkov, trufflehog |
| `iac-security-checker` | Terraform, CDK, Pulumi, CloudFormation | 8 KB | checkov |
| `attack-chainer` | Chains the others' findings into multi-step paths (runs last) | 12 KB | read, bash |

Method documents it reads: `OWASP_METHODOLOGY` (**87 KB, about 22k tokens**), `OWASP_LLM_METHODOLOGY`
(18 KB), `IaC_METHODOLOGY`, `CLOUD_METHODOLOGY`, `MCP_METHODOLOGY` (8-10 KB each), `FINDING_SCHEMA` (5 KB).

### Code health (coordinator `code-reviewer`, 21 KB)

| Specialist | Role | Size | Expects |
|---|---|--:|---|
| `complexity-analyzer` | Cyclomatic and cognitive complexity, function length, nesting | 8 KB | bash |
| `duplication-detector` | Copy-paste and near-duplicates | 8 KB | bash |
| `error-handling-auditor` | Empty catches, swallowed errors, exceptions as control flow | 10 KB | bash, grep |
| `type-safety-checker` | any-escapes, unguarded assertions, null coercion | 9 KB | bash, grep |
| `pattern-consistency-checker` | Cross-file pattern and naming drift, stale comments | 10 KB | code search |
| `dead-code-detector` | Stubs, uncalled functions, unused exports, orphan files | 12 KB | code search |
| `anti-slop-auditor` | The AI-slop rules (see below) | 12 KB | bash, grep |
| `code-health-synthesizer` | Finds compounding risk (complex and duplicated and badly handled in one module) | 9 KB | read |

Method documents: `METHODOLOGY` (26 KB), `FINDINGS_SCHEMA` (4 KB), and the shared `ANTI_SLOP_RULES`
(31 numbered rules, R-01 to R-31).

### Performance (coordinator `performance-engineer`, 19 KB)

| Specialist | Role | Size | Expects |
|---|---|--:|---|
| `static-perf-analyzer` | Nested loops, N+1, blocking I/O in async paths; no profiler | 8 KB | read |
| `db-query-analyzer` | Missing indexes, unbounded queries, per-ORM patterns | 8 KB | bash, grep |
| `concurrency-checker` | Races, unguarded shared state, unbounded `Promise.all` | 9 KB | bash, grep |
| `profiler-agent` | Real hotspots from a profiler run, only when a problem is confirmed | 9 KB | **runs a profiler** |
| `bundle-analyzer` | Frontend bundle size, splitting, Web Vitals | 8 KB | **runs a bundler analysis** |
| `perf-synthesizer` | Compounding slowdowns, a prioritised fix list | 9 KB | read |

Method documents: `METHODOLOGY` (**41 KB, about 10k tokens**), `FINDINGS_SCHEMA` (5 KB).

### Other experts relevant to a Repo Pulse role

`test-engineer` (36 KB, writes and reviews unit/e2e tests), `qa-vnv-engineer` (19 KB, end-user
verification), `challenger` (11 KB, tests whether a claim in a high-stakes artifact is true),
`coding-agent` (48 KB, doc-driven implementation), `api-designer` (28 KB), `a11y-compliance` (10 KB),
`architecture-designer` (21 KB), `llm-integration-engineer` (8 KB), `task-decomposer` (20 KB), plus the
SDLC workflow (`sdlc-*`), game, design, guide and release experts, which have no Repo Pulse role.

Shared protocols worth knowing by name: `FIX_VERIFY_LOOP`, `CHALLENGER_PROTOCOL`,
`GATE_SCORING_PROTOCOL`, `BOUNDED_TASK_CONTRACT`, `MODEL_ADAPTER`, `LOCAL_LLM_PRIMER`,
`CONTEXT_BUDGET`.

## Mapping onto Repo Pulse's roles

`AI_LAYER.md` names eight roles. "Already in Repo Pulse" is what ports exist today
(`ANALYSIS_TIERS.md` §4: diff-scoped checklists for `code_health`, `security`, `performance`,
`test_coverage`, a REQUIRED finding JSON, verified patches W18-19) plus the mechanical scanners.

| Repo Pulse role | attest source | Already in Repo Pulse | What the AI layer would add |
|---|---|---|---|
| security | the nine security specialists and their methodology documents | opengrep packs, secrets scanner, syft/grype, checkov and friends, a deterministic attack chainer (W8-09), a diff-scoped checklist | Judgement the scanners cannot make: OWASP categories read against the code, STRIDE, LLM Top-10 |
| performance | `static-perf-analyzer`, `db-query-analyzer`, `concurrency-checker`, `perf-synthesizer` | perf rule packs, a diff-scoped checklist | Whole-module reading for N+1 and async blocking |
| code health | the seven code-review specialists and the synthesizer | lizard, jscpd, error-handling and dead-code rules, a diff-scoped checklist | The compounding-risk step, naming and comment drift |
| best practices | no single expert. Closest: `pattern-consistency-checker`, `api-designer` and `a11y-compliance` review modes, `architecture-designer` | partly, through the pack rules | A roster has to be chosen, not ported (W19-03) |
| AI slop | `anti-slop-auditor` and `ANTI_SLOP_RULES` (31 rules) | **Most of it**, apparently: `SECURITY_SUITE.md` describes the anti-slop pack as the Anti-Slop Auditor's rules, and Repo Pulse has the LDR and phantom-symbol checks | Only the rules that need judgement |
| test coverage | `test-engineer`, `qa-vnv-engineer` | a diff heuristic ("risky change with no test change") | Which behaviour a change leaves untested; both experts mostly author and run tests |
| triage | `challenger`, `CHALLENGER_PROTOCOL`, `GATE_SCORING_PROTOCOL`, `semgrep-runner`'s real / false positive / unverified discipline, the maker-verifier split in `MODEL_ADAPTER` | the triage discipline and the VEX rule | The evidence-fed verdict (W19-04) |
| patch | `coding-agent`, `FIX_VERIFY_LOOP` | verified patches (W18-19) | A second opinion; `coding-agent` is tied to attest's SDLC documents |

## What is portable, and what is not

**Portable as data, as they are (class A).** The finding schemas (`FINDING_SCHEMA`,
`FINDINGS_SCHEMA`), the AI-slop rule list, the severity and confidence conventions, and the
`MODEL_ADAPTER` tiering idea. They are short, self-contained and already close to what Repo Pulse
stores. They need versioning and a mapping to the finding JSON, not a rewrite.

**Portable as versioned checklist assets, after extraction (class B).** The specialists' checklists and the
methodology documents. The checklist body is the asset; the scaffolding around it is not. Two limits:

- **Size.** The OWASP methodology is about 22k tokens and the performance one about 10k. Neither fits
  a 32k local model beside a code slice, so they must be **sliced** (one OWASP category, one
  performance concern per call), which is how the specialists already work. A slice, not the whole
  document, is the asset.
- **Prompt text is not a portable unit on its own.** The 8-14 KB specialist files interleave the
  checklist with runtime instructions. Extracting the checklist is a per-file editorial job; I have not
  measured how much of each file it is.

**Depends on an agent runtime that Repo Pulse does not ship (class C).** The coordinators and the SDLC
modes (they dispatch specialists through the runtime's delegation tool, keep state in files and a memory
server, resume from checkpoints, and use hooks for gates); the loop and handoff protocols
(`HANDOFF_*`, `CHECKPOINT_*`, `RALPH_WIGGUM_LOOP`, `GAUNTLET_LOOP`, `AUTONOMY_PROTOCOL`); the tool
scripts and the two OpenCode plugins; and the specialists that must execute something to work
(`profiler-agent`, `bundle-analyzer`, and the scanner-driving parts of `semgrep-runner`,
`secrets-scanner`, `iac-security-checker`). Repo Pulse already replaces these with its own pieces: the
analysis gateway for dispatch, the sandboxed scanners for execution, and the database for state. They
should be re-specified, not ported.

## Things in attest that bear directly on the W19 tickets

- **W19-01 (capability probe).** `MODEL_ADAPTER` sorts a model into small (about 32k local), medium
  (60-128k) or large (cloud) by context window, and `models.json` records a per-model
  `max_output_real` (by its name an observed output cap rather than a documented one). The same idea belongs
  in the probe: record what the server actually did, not what its model card says.
- **W19-05 (eval harness).** `attest/evals` is a tree of small fixture repositories with planted defects
  and deterministic checks, with an optional mode that drives real agents and stamps results with the
  model tier. Its fixtures are data and its idea transfers; its runner is attest-specific (it drives
  `opencode run`).
- **W19-03 (roster).** The conditional-wave pattern (a specialist runs only if its trigger is present)
  and the compounding-risk synthesizers are the transferable designs. The attack chainer's job is already
  done deterministically by Repo Pulse.

## Recommendation

1. Treat class A as the first import: schemas and the rule list, versioned, mapped to the finding JSON.
2. For W19-03/04, extract checklists (class B) for security and performance first, as category-sized
   slices with a recorded source version (`attest v3.13.3`, file, section), because those are the roles
   with the weakest mechanical coverage of judgement. Code health and slop are mostly mechanical already.
3. Do not take the runtime-bound protocols (class C); keep Repo Pulse's own orchestration.
4. Best practices needs a decision about which review modes to adopt before there is anything to port.

## Not verified

I did not read the specialist prompts end to end, so the class B / C line is drawn from file structure
and the tools each names. Which parts of an individual specialist are checklist and which are scaffolding
should be confirmed per file when its extraction ticket is picked up. The compact variants and the
Claude Code variant were compared only by size and header.
