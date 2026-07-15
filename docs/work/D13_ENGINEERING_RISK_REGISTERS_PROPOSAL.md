# D13 proposal — Engineering Risk Registers (non-security risk sources)

**Status: PROPOSED 2026-07-15 — awaiting Brad's adoption call. Nothing here is
threaded into SRS/stories/plan.json yet.**

## Framing

D12 built the pricing engine: any finding, regardless of dimension, gets
`effective_risk`, a band, plan ranking, Top Risks placement, and report
movement. D13 is the other half of "risk ranking beyond security": **new
non-security risk *sources*** that emit findings through the existing contract
and get prioritization for free. No new scoring machinery — each register just
declares its severity mapping and its D12 likelihood/exposure inputs.

Everything below is deterministic (Tier-1 SQL or standalone sandbox tools — no
LLM required), respects C1/C1a (warehouse + tarball snapshots only), the
no-network sandbox, and N-9 (team/module-scoped, never person-named).

## Candidate registers

### R1 — Knowledge-concentration risk (bus factor) · RECOMMEND v1

The classic non-security risk devs and execs both feel: "only one person has
touched `payments/` in a year." **Industry anchors:** truck-factor research
(Avelino et al. 2016), Microsoft/Bird et al. ownership→defect correlation
(MSR). **Data:** already in the warehouse — commits × files × authors; pure
SQL, no scanner, no new ingestion. **Findings** (`knowledge` dimension):
module/directory with active-maintainer count ≤ N over 180d, top-contributor
share ≥ X%, weighted by hotspot percentile (D12 exposure slots in directly —
a single-maintainer *hot* module is the risk; a single-maintainer frozen util
is track-band noise). **N-9 discipline:** findings name modules and *counts*
("1 active maintainer"), never people; the developer's own view (D6) is the
only person-grain surface. Effort: ~5 pts (metrics job + catalog entries).

### R2 — Dependency-health risk (non-CVE) · RECOMMEND v1

CVEs are D10's lane; this is everything else that makes a dependency risky:
**staleness** (libyear — the standard drift metric), **abandonment** (last
release/commit age), **deprecated/yanked** packages, **major-version lag**,
and **license posture** (copyleft-in-prod-scope, license-unknown — SPDX
already comes out of the syft SBOM; RepoPulse's own TruffleHog/AGPL episode is
the use case). **Industry anchors:** libyear, OpenSSF Scorecard (maintained /
release-cadence signals), deps.dev. **Data:** SBOM already exists (W8); release
metadata arrives via the established nightly db-sync pattern (KEV/EPSS — scan
sandbox stays `--network=none`). **Findings** (`dependency_health`): severity
from a documented ramp (e.g. abandoned + prod-direct ⇒ 4; libyear drift ⇒
2–3), exposure reuses D10's dep_scope factors verbatim. License flags gated by
a workspace policy list (default: flag AGPL/SSPL/unknown in prod scope).
Effort: ~8 pts (registry sync source + rules + policy config).

### R3 — Runtime/toolchain EOL risk · RECOMMEND v1 (folded into R2)

Node 18 past EOL, Python 3.8 in the Dockerfile, base image out of support.
**Anchor/data:** endoflife.date dataset (nightly db-sync); inputs from
manifests (`engines`, lockfiles) + Dockerfiles in the C1a tarball snapshot.
High signal, near-zero noise, exec-legible ("unsupported runtime in prod" is a
board-slide risk). Severity ramps on time-past-EOL. ~3 pts inside R2's ticket
set.

### R4 — Architectural-drift risk · RECOMMEND v1 config-free subset

Boundary erosion is the compounding maintainability killer (Apiiro's +322%
priv-esc paths in AI codebases is partly this). Two phases:
- **Phase A (config-free, recommend now):** dependency cycles, god modules
  (fan-in+fan-out outliers), orphan clusters — computable from import graphs
  via standalone tools (dependency-cruiser JS/TS, import-linter Python, `go
  list` graph) that pass the D11 ToolAdapter admission filter (standalone, no
  network). `architecture` dimension; exposure = hotspot percentile of the
  offending module.
- **Phase B (declared boundaries, defer):** workspace-declared module rules
  ("metrics never imports forge" — RepoPulse Law 6 productized) checked per
  snapshot. Needs boundary-config UX; park until a design pass.
**Anchors:** evolutionary-architecture fitness functions (Ford/Parsons), SQALE
architecture debt. Phase A effort: ~5 pts (adapters ride W9 registry).

### R5 — Test-gap risk · RECOMMEND v1 warehouse signal only

The industry-standard form (coverage × churn, Google test-gap practice) needs
per-repo coverage data we don't ingest — CI-artifact ingestion is new
machinery with real rate-budget cost (Law 7), so that half is an **open
decision**, not a recommendation. What IS free today: **test co-change ratio**
from the warehouse — hot files whose changes are never accompanied by test
changes (GitClear-style, pure SQL). `test_gap` dimension, exposure = hotspot.
~3 pts. Coverage ingestion, if ever, is its own decision with a forge-budget
review.

### Considered and NOT proposed

- **Documentation drift** — comment-staleness already covered by D11 R-15;
  full doc-drift detection is LLM-judgment territory with weak FP economics.
- **Performance risk** — already a dimension; D11 per-language perf packs are
  the source; D12 prices them. Nothing new needed.
- **Delivery risk** — DORA (M9–M12) + agreements + plans already carry it;
  it's metric-shaped, not finding-shaped.
- **Data-migration / ops-readiness risk** — needs runtime/deploy context
  RepoPulse deliberately doesn't have (no CI runner, N-goals).

## Shape of adoption (if approved)

- New finding dimensions: `knowledge`, `dependency_health`, `architecture`,
  `test_gap` (enum extension — same pattern as D11's `slop`/`logging`).
- Each register = catalog-versioned rules + severity ramps + D12 factor
  declarations; all findings flow into bands/plans/Top Risks/reports with zero
  new surface work (D12 pays out immediately).
- Risk-axes addition (RISK_MODEL.md §4): `knowledge` + `architecture` +
  `test_gap` roll into a new **Structure** axis or into Code Health — decide
  at threading time; `dependency_health` joins the Security axis's dependency
  lane or gets its own **Supply Chain** axis (leaning: Supply Chain, it's the
  exec vocabulary).
- **Wave: W10** (~24 pts as scoped above). Mechanical prerequisite:
  `scripts/validate-plan.mjs:48` wave regex is single-digit
  (`/^W([0-9])-(\d{2})$/`) — one-line extension to `W(\d{1,2})`, plus the
  PLAYBOOK wave-list mention.

## Open questions for Brad

1. Adopt all four v1 recommendations (R1, R2+R3, R4 Phase A, R5 warehouse
   signal), or a subset?
2. Supply Chain as its own risk axis, or fold under Security?
3. Coverage ingestion (R5 full form): investigate now as a design spike, or
   park until a customer asks?
4. R2 license policy: ship with the AGPL/SSPL/unknown default deny-ish list,
   or start report-only?
