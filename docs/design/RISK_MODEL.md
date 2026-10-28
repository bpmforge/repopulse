# Unified Risk Model (D12) — one answer to "what do I fix first?"

Design deep-dive for SRS §2.5b (FR-RISK-1..6). Decision D12 (FOUNDING_BRIEF).
Wave W9 (rides the completed findings machinery: W8 scanners + D10 funnel + D11
rule lifecycle). Supersedes the *packaging* of D10's dependency-only
`effective_risk` — same column, same inputs, now factored and applied to EVERY
finding dimension.

## 1. Why

`severity` is hazard-only. A sev-4 injection hit in a file nobody has touched in
two years and the same hit in the repo's hottest churn path rank identically —
that is how tools lose the developer's trust in ranking. Industry practice
prices vulnerabilities as hazard × likelihood × exposure (CVSS × EPSS/KEV ×
reachability — Snyk Risk Score, SSVC), but stops at dependencies. RepoPulse
already computes the missing exposure signal for *all* code (M2 hotspot decay
scores) and the missing likelihood signal for *all* rules (D11 lifecycle FP
stats + D9 verify passes) — D12 just connects them.

Non-goals: no new scanners, no new scores invented (axes reuse FR-INSIGHTS-2
sub-scores), no ML. Deterministic, catalog-versioned, decomposition always
served (metrics honesty pattern).

## 2. The score (FR-RISK-1/2/3)

```
effective_risk = round(100 · H · L · X, 2)      risk_model.v1, H,L,X ∈ (0,1]
```

Multiplicative on purpose (OWASP Risk Rating shape): a near-zero factor tanks
the score, and floors below keep anything from vanishing entirely. Constants
live in the metrics catalog (`risk_model.v1`), workspace-tunable like ramps;
the formula version is stamped into `risk_factors`.

| Factor | Meaning | Inputs (defaults) |
|---|---|---|
| **H** hazard | how bad if it bites | `severity/5` (canonical 1–5, ANALYSIS_TIERS §4) |
| **L** likelihood | will it bite | **dependency dim** (v3): `max(EPSS, 0.05, confidence/5 × verify multiplier × 0.7)` — the version match priced like any rule hit with the unmeasured-rule prior, EPSS only raising it (v1/v2: `max(EPSS, 0.05)`, D10 V4; see §2a). **KEV and an installed malicious package → 1.0.** **All other dims**: `confidence/5` × verify multiplier (`confirmed` 1.0 / `unverified` 0.7 / `contradicted` 0.15, FR-ANALYSIS-9) × rule precision prior `1 − fp_rate` from D11 lifecycle stats (floor 0.3; rules without stats → 0.7). **Overrides → 1.0**: KEV, verified secret, chain, compound. |
| **X** exposure | does it sit where the code lives | **file-bound**: repo-relative hotspot percentile of the file (M2 decay score, latest snapshot), mapped to [0.25, 1.0] — floor 0.25 so cold-file criticals never disappear. **v2 (W18-25) import-graph multiplier**: × 0.6 when nothing imports the file, × `1 + 0.3·log(fanIn/2)/log(16)` (1.0 at ≤ 2 importers, capped 1.3 at 32+) for high fan-in, re-floored at 0.25 and capped at 1.0; exactly 1.0 (neutral) when the graph cannot say — capped snapshot, unindexed language (JS/TS only today), entry-point path, possible path alias, file not in the graph, or no graph yet. **dependency**: dep_scope (prod-direct 1.0 / prod-transitive `0.8 − 0.05·(depth−1)`, floor 0.5 / dev 0.35) × reachability (`symbol_reachable` 1.0 / `imported` 0.85 / `manifest_only` 0.6 / `proven_unreachable` 0.2). **repo-scoped** (no file — e.g. missing-policy findings): 1.0. D13 registers declare their factors here: deterministic registers use L = 1.0 × rule-precision prior; `knowledge`/`architecture`/`test_gap` use the file/module hotspot mapping; `dependency_health` reuses the dep_scope factors. |

D10 relationship: V4's `f(CVSS, KEV, EPSS, reachability, dep_scope)` is
refactored, not replaced — CVSS→H (via the §3.1 severity mapping), EPSS/KEV→L,
reachability/dep_scope→X. Same `findings.effective_risk` column, now non-null
for every open finding.

**Import-graph exposure (v2, W18-25).** The fast lane's import graph is persisted by the
weekly `anti_slop` snapshot pass (`metric_snapshots` key `import_graph`, latest row only;
`complete` false when the source read was capped) and read per repo by `risk.reprice`.
`risk_factors.inputs` carries `import_graph` (state), `import_fan_in`, `import_multiplier`
and `exposure_why` — the sentence the popover shows ("imported by 14 modules", "nothing
imports this file", "import graph incomplete (snapshot capped); exposure not adjusted").
Files nothing imports but whose path marks an entry point (index/main/server, routes, bin,
cli, scripts, config, setup) are not discounted. On Repo Pulse's own tree (1,016 indexed
files): 601 imported (242 boosted), 316 orphans (313 of them tests), 98 entry points.
`model_version` is `risk_model.v2`; `RISK_MODEL_V1` remains and ignores the graph.

### 2a. risk_model.v3 (2026-10-28) — supersedes D10's EPSS-as-likelihood for dependencies

D12 exists to put every dimension on one list, but L meant two different things:
for code findings, how sure we are a finding is real (confidence × verify × rule
precision, typically 0.4–0.7); for a CVE, its 30-day exploitation probability
(EPSS), floored at 0.05. EPSS is small for nearly every CVE, and the EPSS feed
(W8-13) has never landed, so every CVE sat at the floor. Measured on the
2026-10-28 walkthrough install (six public repositories, 22,931 priced findings):
a second-model-confirmed critical CVE in a direct production dependency scored
3.0 ("track") beneath a test-gap finding at 23.5.

v3 prices the dependency branch as `max(EPSS, floor, confidence/5 × verify ×
precisionWithoutStats)` — no new constant: the version match is evidence like a
rule hit, and an unmeasured rule's prior is 0.7. EPSS, when it lands, can only
raise it. On the same install: 26 dependency findings moved, 16 crossed a band
(confirmed critical/high CVEs into "schedule"); contradicted CVEs stayed in
"track"; compound/chain overrides were unchanged; neither class wholly outranks
the other. An installed OpenSSF malicious package now overrides to "act" like
KEV (installing it is the compromise). The nightly reprice also now reads the
finding's stored reachability, EPSS and malicious flag; it had dropped all three,
so a CVE priced "imported" at insert fell to "manifest_only" overnight.

**Honesty rules (carried from D10/metrics):** decomposition
`{H, L, X, inputs, model_version}` persisted per finding (`risk_factors`) and
served by the API — the UI popover shows the arithmetic; raw `severity` renders
next to every risk number; raw counts are never hidden ("200 findings → 12
Act" is the same credibility story as the CVE funnel); copy stays "signals,
not grades" (METRICS §3 presentation rule).

## 3. Action bands (FR-RISK-4) — SSVC-style verbs, not just numbers

People act on verbs. Effective risk buckets into `risk_band`:

| Band | Default threshold | Behavior |
|---|---|---|
| **act** | ≥ 55, OR override (KEV / verified secret / chain / compound) | pinned into plan generation (replaces raw-severity rank input, IMPROVEMENT_PLANS §2); Top Risks card; org banner rules unchanged |
| **schedule** | ≥ 25 | plan-eligible, ranked below act |
| **track** | < 25 | visible in explorer, default-collapsed in reports |
| *(accepted)* | — not a score band | derived view state: `wont_fix` / `dismissed` / VEX `not_affected` — human decisions, never computed |

Thresholds in the catalog (workspace-tunable). Stamped on finding upsert;
nightly `risk.reprice` job (after `metrics.snapshot`) re-prices open findings
for input drift — EPSS updates, hotspot decay, rule-precision movement — and
band *transitions* are audited (finding_events `reason='reprice'`), so "this
climbed into Act overnight" is explainable. No LLM anywhere in pricing.

## 4. Risk axes (FR-RISK-6) — ratings by type of risk

The "types of risk" view reuses FR-INSIGHTS-2 sub-scores — no new arithmetic,
a presentation layer (SonarQube-familiar letters):

| Axis | Source sub-score | Finding dimensions rolled up |
|---|---|---|
| Delivery | delivery + CI health | — (metric-driven) |
| Review | review hygiene | — |
| Activity | activity | — |
| Security | security | `security`, `compound`, dependency CVE findings |
| Supply Chain (W10, D13) | `supply_chain` (FR-REG-7 — open dependency_health findings weighted by effective_risk, security-row ramp pattern) | `dependency_health` (libyear / abandonment / EOL / license) |
| Code Health | `code_health` (D11) | `code_health`, `slop`, `logging`; + D13 structural dims `knowledge`, `architecture`, `test_gap` (contributors roll-up; dedicated Structure axis is a v-next call) |
| Performance | *(v-next: appears when the D11 per-language perf packs produce findings; renorm rule FR-INSIGHTS-3 applies)* | `performance` |

Letter bands (catalog defaults): A ≥ 85 · B ≥ 70 · C ≥ 50 · D ≥ 30 · E < 30.
Each axis chip expands to its top-3 open findings by effective_risk from its
mapped dimensions. Absent sub-score ⇒ axis absent + basis label (FR-INSIGHTS-3
pattern), never a fake grade.

**Presentation, settled 2026-10-19 (W20-09, UX_TODO DSH-11/72):** the
dashboard shows each axis as its 0–100 score plus the health band word
(HEALTH_BAND_LABEL), never a letter — N-9 ("signals, not grades") wins over
the letter chips above, and UX_SPEC already drew numbers. Org-wide the axis
is the median of the repositories that have the sub-score, with the worst
repository named and the count measured; Performance is not served until it
has a sub-score. Since W20-12 the report PDFs follow suit (score of 100 and
band word in the headline, the per-repository table and the axis table); the
letter bands above are kept only as the API's legacy `letter` field, which no
surface prints.

## 5. Surfaces (FR-RISK-5/6)

- **Findings Explorer / Security tab / Code Health tab**: default sort
  `effective_risk desc` everywhere findings render (severity sort remains one
  click away); band chips; decomposition popover.
- **Top Risks card** (repo Overview + Org Overview): top-5 open by
  effective_risk across ALL dimensions, band chip + movement vs previous
  window (`risk.reprice` audit rows make deltas computable).
- **Plans** (IMPROVEMENT_PLANS §2): generation rank input =
  `effective_risk`; KEV/chain pins unchanged; `sev-findings-cluster` catalog
  condition gains an `act-band-cluster` sibling.
- **Reports**: `repo_health`, `org_exec`, `security_posture` open with "Top
  risks this window + movement since previous same-scope report"; axis letter
  row on the repo header block and the org grid.
- **API**: findings endpoints gain `risk_band` filter + `effective_risk` sort;
  score endpoint gains `axes[]` (letter + basis + top contributors).

## 6. Data & jobs (delta summary — canonical DDL in DATABASE.md)

- `findings` += `risk_factors jsonb null`, `risk_band text null
  check (risk_band in ('act','schedule','track'))`; `effective_risk` populated
  for all dimensions; index `(workspace_id, repo_id, status, effective_risk
  desc)`.
- Catalog: `risk_model.v1` entry (factor constants, band thresholds, axis
  letter bands) — versioned with the metrics catalog, workspace overrides.
- Job: nightly `risk.reprice` (idempotent, after `metrics.snapshot`); pricing
  also inline on finding upsert (pure function in `packages/insights`).

## 7. Industry anchors

CVSS 3.1/4.0 severity bands (already the D10 mapping) · EPSS + CISA KEV
likelihood (D10) · SSVC (CISA/CMU) act/attend/track decision verbs → our bands
· OWASP Risk Rating likelihood×impact factor shape · SonarQube MQR/SQALE
per-axis A–E letters · Snyk Risk Score (validates the dependency formula; D12
extends the idea past dependencies). Verify exact citations at W9 (Law 2).
