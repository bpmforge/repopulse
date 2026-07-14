# Code Health Suite — Anti-Slop, Cleanliness, Logging (packages/security scanners) — wave W9

Traces: FR-CH-1..7, FR-REPORTS-8, D11, S-50..S-56. Rides the W8 framework end-to-end:
`Scanner` registry (SECURITY_SUITE.md §1), snapshot service + sandbox (§2), findings
store/dedup/triage (FR-ANALYSIS-5/6, FR-INSIGHTS-1), verify/challenger rails
(FR-ANALYSIS-9/10), budgets (FR-SEC-11). Rule content ported from
bpm-opencode-experts (`agents/shared/ANTI_SLOP_RULES.md`, `agents/code-review/
METHODOLOGY.md`, `references/code-health-checklist.md`, `agents/performance/
METHODOLOGY.md`) — productized, not reinvented.

## 0. Why (evidence basis — cite these in report footnotes)

| Claim | Number | Source |
|---|---|---|
| Copy/paste share of new code | 9.4% (2022) → 15.7% (H1 2026); moved/refactored 21% → 3.8%; block duplication +81%; error-masking constructs +47% | GitClear "AI Code Quality / Maintainability Gap" 2025-2026 (gitclear.com) |
| AI code failing security tests | 45% overall; log injection 88%, XSS 86% fail (CWE-117/79); larger models NOT safer | Veracode GenAI Code Security Report 2025 (veracode.com) |
| Hallucinated package names | 19.7% of samples; 205k unique fake names; 43% recur across re-runs (pre-registerable) | Spracklen et al., USENIX Security 2025 (arXiv:2406.10279) |
| Privilege-escalation paths / design flaws | +322% / +153% (Fortune-50 telemetry) | Apiiro, Dec 2024–Jun 2025 (vendor data) |
| AI adoption vs delivery | throughput ↑ but stability still ↓; "AI is an amplifier" | DORA 2025 (dora.dev/research/ai) |
| Secrets exposure in AI commits | 3.2% vs 1.5% human | CSA 2025/2026 |

Product stance follows METRICS.md §3: **signals, not grades** — findings route attention,
thresholds are tunable, trend > absolute value, and no per-developer slop leaderboards
(NON_GOALS N-9).

## 1. Rule inventory — 30 anti-slop rules, mapped to detection layers

Legend: **PACK** = deterministic (our semgrep rulepack / tool), **HYB** = pack locates +
T2 confirms, **LLM** = T2 checklist judgment (runs through the gateway with verify pass).

| Rule (bpm-opencode-experts id) | Layer | Where it lands |
|---|---|---|
| R-01 empty/swallowing catch · R-02 try/catch in loops · R-10 silent fallback returns · R-13 what-comments · R-14 step-narration blocks · R-16 emoji comments · R-27 stub-as-feature (`not implemented` throws, TODO bodies) · R-29 prose padding | **PACK** | FR-CH-1 rulepack → anti_slop deterministic layer |
| R-19 duplicated blocks | **PACK** (jscpd) | code_health_tools |
| R-21 hallucinated packages · R-23 credential literals | **PACK** | already shipped: FR-SEC-5 slopsquat · secrets scanner (W8) — anti_slop cross-links, never duplicates |
| R-25 phantom/unused imports | **PACK** (pack rule; full unused-export analysis needs dep install → backlog `dead_code`) | FR-CH-1 (partial) |
| R-03 exception control flow · R-04 serial awaits · R-15 stale JSDoc params · R-24 docstring inflation (doc/impl >3×, LDR) · R-26 unwired scaffolding · R-28 LLM output w/o validation · R-30 library-shaped reimplementation (silent vendor fork) | **HYB** | pack/AST locates candidates → T2 confirms with evidence quote |
| R-05 single-impl interfaces · R-06 delegation-only wrappers · R-07 single-use helpers · R-08 repository-on-CRUD · R-09 null checks on owned types · R-11 unspecified retry · R-12 orphan feature flags · R-17 speculative generalization · R-18 cargo-cult patterns · R-20 pattern inconsistency · R-22 architectural privilege escalation | **LLM** | `anti_slop.v1` T2 checklist (diff-scoped; snapshot mode samples worst files) |

**LDR (logic density ratio)** — reconciling the two source definitions: file-level
`LDR = logic_lines / (logic_lines + overhead_lines)` (overhead = imports, type-only
decls, docstrings/comments, blanks); **file LDR < 0.3 ⇒ structural-slop finding**;
per-exported-symbol **doc/impl > 3× ⇒ docstring-inflation finding** (R-24). Both
computed deterministically in the anti_slop scanner; thresholds workspace-tunable.

## 2. Scanner roster (registry entries — zero framework changes, FR-SEC-1 acceptance)

| key | inputs | triggers | requiredTools | dimension |
|---|---|---|---|---|
| `code_health_tools` | snapshot | weekly schedule, manual | lizard@1 (MIT), jscpd@4 (MIT) — standalone source parsers, run with no dependency install (sandbox stays `--network=none`) | `code_health` |
| `anti_slop` | diff + snapshot | pr_synced (diff), weekly (snapshot), manual | semgrep + rulepack `code-health.v{N}` | `slop` |
| `logging_hygiene` | diff + snapshot | pr_synced, weekly, manual | semgrep + same pack (logging rules) | `logging` |

Backlog delta (SECURITY_SUITE.md §7): `anti_slop` **promoted** to W9; new backlog row
`dead_code` (knip ISC / vulture MIT / staticcheck MIT — full unused-export analysis
needs installed dependencies, which conflicts with the no-network sandbox; ships when a
deps-cache volume design exists, same pattern as the vuln-DB volumes).

### Thresholds (workspace defaults, `repo_scanner_config.config`; canon sources in §0/§4)

| Check | Default | Source |
|---|---|---|
| Cognitive complexity / function | ≤15 | SonarSource cognitive-complexity whitepaper |
| Cyclomatic complexity | >10 warn, >20 critical | lizard `--CCN 10`; experts checklist |
| Function length / file length | >50 lines / >300 lines | experts checklist (TS row); Code Climate file ≤250 as the strict preset |
| Nesting / args | >3 / >4 | Code Climate defaults |
| Duplication (jscpd `--min-lines 5 --min-tokens 50`) | ≥5% repo gate; any new duplicated block in a PR diff | GitClear 2025/2026 (trend is the headline metric) |
| File LDR / doc-impl ratio | <0.3 / >3× | ANTI_SLOP_RULES R-24 + auditor Phase 3 (reconciled §1) |

## 3. Logging hygiene (FR-CH-4) — net-new ruleset (no experts-repo equivalent)

Deterministic (in the FR-CH-1 pack): `console.log`/`print` in production paths (test/
script globs excluded); user-controlled input flowing into a log call without encoding
(log-injection taint, CWE-117 — Veracode: 88% AI fail rate); secret/PII-shaped values in
log arguments (field-name denylist mirrors SC-2's scrubber list — token, password,
authorization, ssn, email in payload contexts); local log-and-rethrow (`catch { log; throw }`).

T2 checklist `logging.v1` (OWASP Logging Cheat Sheet + Top-10 2025 A09 basis, each item
citing its OWASP id): level correctness (errors not logged as info; expected flows not
logged as error), context adequacy (bare `e.message`/`"error"` without operation context),
correlation-id propagation on request paths, security-event coverage (auth failures,
authz denials logged at all), cross-layer double logging. RepoPulse's own codebase
already follows the stricter version of these rules (NFR-12, SC-2) — the product now
checks monitored repos for the same discipline.

## 4. Clean-code doctrine encoded in `anti_slop.v1` checklist framing

The checklist system prompt carries the doctrine (so T2 judges with the right defaults,
matching the experts `code` skill): abstractions need ≥2 real implementations; three
similar lines beat a premature abstraction; deep modules > shallow wrappers (Ousterhout);
trust the framework — flag re-implementations of what a present dependency provides;
why-comments only; no defensive null checks on owned types; YAGNI on retries/flags/
config not traceable to a requirement. Verdicts require verbatim evidence quotes
(SC-13 substring rule) and ride the FR-ANALYSIS-9 verify pass — a judgment finding that
the second host refutes never surfaces.

## 5. Tier-1 debt signals (FR-CH-7 — packages/metrics, no scanner)

- **M13 rework-14d**: share of line changes touching lines authored <14 days prior
  (GitClear "mistake code" convention; M1's 21d rework definition unchanged — both in
  the catalog with heuristic notes). Grain: repo/file/window; snapshotted.
- **M14 revert rate**: `is_revert_heuristic` commits ÷ non-merge commits per window
  (column already exists for DORA CFR).
Both feed the Code Health tab header and the FR-CH-6 plan-catalog entries.

## 6. Surfaces & scoring (FR-CH-6)

- **Repo Code Health tab**: debt-signal header (M13/M14 sparklines), complexity
  distribution + worst-10 functions table (file:line → drill-down), duplication % trend
  (`ch_duplication_pct` snapshots), slop density by rule (findings/KLOC), logging
  posture, per-scanner status chips ("not enabled" state, never blank — NFR-15 pattern).
- **Health score**: `code_health` sub-score joins FR-INSIGHTS-2 (inputs: duplication
  ramp(3%, 15%), complexity-p90 ramp, slop density ramp, M13 ramp) — renormalized +
  basis-labeled like the security sub-score.
- **Code Health report** (FR-REPORTS-8): sections per §above + open plan items;
  thresholds + heuristic bases footnoted (REPORTS.md §5 discipline); GitClear-style
  trend framing ("duplication 11.2% ▲ from 8.1% — above your 5% gate").
- **Plan catalog v2** (IMPROVEMENT_PLANS.md): `duplication-over-ceiling` (verify:
  `ch_duplication_pct ≤ target` for 30d), `complexity-worst-functions` (verify: worst-fn
  count drops), `slop-density-high` (verify: density ≤ target), `logging-hygiene-adoption`
  (verify: logging findings resolved + no new for 30d).

## 7. Testing (extends TESTING.md §10 rules — no live tools/LLMs in CI)

Seeded fixture trees per scanner under `packages/security/fixtures/code-health/`:
threshold-boundary functions (CC 10/11, 15/16 cognitive, 50/51 lines), duplicated block
pairs (jscpd min-lines edge), each PACK rule's triggering + non-triggering case, LDR
boundary files (0.29/0.31), logging fixtures (console.log in handler vs test file, taint
case, log-and-rethrow). Golden finding-set snapshots per scanner; dedupe test between
scanner rules and `code_health.v2` T2 findings (FR-CH-5); posture-metric rows asserted
in metric_snapshots; checklist runs mocked at the gateway with `initiator='scanner:*'`.

Licensing: lizard MIT · jscpd MIT · semgrep engine LGPL-2.1 (subprocess, unchanged from
W8) · rulepack is OURS (no Semgrep-registry rules — license gate per DESIGN_REVIEW G-18)
· knip ISC / vulture MIT / staticcheck MIT reserved for the `dead_code` backlog entry.
