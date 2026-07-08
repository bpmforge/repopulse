# METRICS — Tier-1 Metric Specification (packages/metrics) — THIS DOC IS LAW

Traces: FR-METRICS-1..15, FR-INSIGHTS-2/3/4/5, C1. Implementers MUST NOT improvise
definitions; ambiguity is resolved by editing this doc, not code. All metrics: computed from
warehouse only (FR-API-2), parameterized by window W ∈ {7,30,90,365}d default 30d, per-repo +
org rollup (FR-METRICS-14), snapshotted nightly (FR-METRICS-13). Registered in the
machine-readable catalog (FR-METRICS-15) with formula text, unit, direction, heuristic notes.

## 0. Shared rules

- **Bots**: exclude commits/PRs/reviews where author matches workspace bot list
  (default globs: `*[bot]`, `dependabot*`, `renovate*`, `github-actions*`) from every
  human-flow metric; bot activity remains queryable, never contributes to churn/ownership/cycle/review metrics.
- **Merge commits** (`parentShas.length > 1`): excluded from churn/ownership/hotspots
  (their stats double-count the branch); still count for DORA lead-time linkage.
- **Force-push/rebase**: rewritten SHAs upserted by the reconciliation sweep may orphan old
  commit rows; churn queries key on `(repo, sha)` rows currently reachable per ingest — orphaned
  rows are tombstoned (`superseded=true`) and excluded. Rebased PRs keep PR-level
  additions/deletions from the forge (authoritative), so PR metrics are rebase-immune.
- **Truncated diffs**: files with `patchTruncated` still carry additions/deletions counts →
  churn is exact; only Tier-2/3 review is affected.
- **Percentiles**: nearest-rank on the pooled sample. **Ratios**: keep numerator/denominator
  in snapshots. Empty denominator ⇒ value `null` ("no data"), never 0 or 100.

| Metric | Grain | Cadence | FR |
|---|---|---|---|
| M1 churn | org/repo/file/person | nightly snapshot; live on delta | FR-METRICS-1 |
| M2 hotspots | repo/file | nightly | FR-METRICS-2 |
| M3 ownership/bus factor | repo/dir/file/person | nightly (365d fixed) | FR-METRICS-3 |
| M4 cycle stages | org/repo/person | nightly; live | FR-METRICS-4 |
| M5 review coverage / M6 without-review | org/repo/person | nightly; live | FR-METRICS-5/6 |
| M7 PR size | org/repo | nightly | FR-METRICS-7 |
| M8 stale PRs | org/repo/person | live (point-in-time) | FR-METRICS-8 |
| M9 CI pass/duration/flakiness | repo/workflow | nightly; live | FR-METRICS-9 |
| M10 issue throughput | org/repo | nightly | FR-METRICS-10 |
| M11 release cadence | org/repo | nightly | FR-METRICS-11 |
| M12 DORA | org/repo | nightly | FR-METRICS-12 |

## 1. Definitions

**M1 Commit churn (FR-METRICS-1).** Over non-merge, non-bot, non-superseded commits in W:
`gross = Σ(additions+deletions)`; `net = Σ(additions−deletions)`;
`rework = Σ` over file-touches where the same file had any non-bot touch < 21d prior
(file-level commit sequence from `commit_file` rows — no clone, C1). Grains: repo = all files;
file = that path (renames: churn follows `previousPath` chain); person = author attribution.

**M2 File hotspots (FR-METRICS-2).** Per file f in repo, window W:
`hotspot(f) = normChurn(f) × decay(f)` where `normChurn(f) = gross(f,W) / max_g∈repo gross(g,W)`
(∈[0,1]; max=0 ⇒ all scores 0) and **decay is exponential with 30-day half-life**:
`decay(f) = 2^(−days_since_last_non_bot_touch(f) / 30)`. Untouched 1y ⇒ 2^(−12.17) ≈ 0.0002 ≈ 0.
API exposes decomposition {gross, normChurn, daysSince, decay, score} + contributing commits.
**v1.x extension (flagged, NOT MVP): complexity proxy v2** — multiply by
`norm(log(file_size_bytes) × max_indent_depth)` from targeted `getFileContent` fetches
(FR-FORGE-6, budget lane `reconcile`); ships behind `hotspot_v2` config flag.

**M3 Ownership / bus factor (FR-METRICS-3).** Fixed trailing 365d, per file and directory
(dir = recursive sum of files): `linesChanged(author) = Σ(additions+deletions)` by author;
`topShare = max_author linesChanged / total`; `busFactor` = size of the smallest author set
whose summed linesChanged ≥ 50% of total (sort desc, take until ≥50%). Flag `single_owner`
when topShare ≥ 0.80. Fixture 60/30/10 ⇒ busFactor 1 (60 ≥ 50), no flag (0.60 < 0.80).

**M4 PR cycle-time stages (FR-METRICS-4).** Merged, non-bot PRs in W (by merged_at). Stages:
`open→firstReview` (first non-author review of any state or review-comment; author events never
count); `firstReview→approved` (first APPROVED **after the last review-re-request**; dismissed
approvals don't count); `approved→merged`; `e2e = merged_at − created_at` (draft time included;
draft-heavy repos see it in the number — documented in catalog notes). PRs merged with zero
reviews contribute only to e2e. Report median + p90 per stage, pooled across PRs.

**M5 Review coverage % (FR-METRICS-5).** `covered / merged` over W where covered = ≥1
completed non-author review (APPROVED, CHANGES_REQUESTED, or COMMENTED with body/comments;
self-review never counts). **M6 (FR-METRICS-6)** `= 1 − M5`, plus drill-down list
{pr, author, merger, sizeBucket, mergedAt} that reconciles with the rate to the PR.

**M7 PR size distribution (FR-METRICS-7).** Merged-PR `gross = additions + deletions`
(PR-level forge numbers). Buckets inclusive-lower/exclusive-upper: XS [0,10), S [10,100),
M [100,500), L [500,1000), XL [1000,∞). Median-size trend from snapshots.

**M8 Stale PRs (FR-METRICS-8).** Open PRs whose last activity (commit push, review, review-
comment, issue-comment — any tracked kind resets the clock) is > N days old (default 7,
workspace config). Output: count + age-sorted list with lastActivityKind; drafts flagged
separately, counted in a separate `stale_drafts` series.

**M9 CI (FR-METRICS-9).** Completed workflow runs in W, default-branch vs PR runs reported
separately. `passRate = success / (completed − cancelled − skipped)`; duration = median+p90 of
`run_started_at→updated_at` (research §3); `flakiness(workflow) = reruns of same head SHA that
flipped fail→pass ÷ rerun groups` — rank workflows desc. In-progress runs never in denominators.

**M10 Issue throughput (FR-METRICS-10).** `isPullRequest=false` only. Opened count
(created_at ∈ W), closed count (closed_at ∈ W; each close event counts once — reopen+reclose
= 2 closes), median time-to-close for issues closed in W (last open→close interval), open-issue
age distribution (p50/p90 + histogram) at snapshot time.

**M11 Release cadence (FR-METRICS-11).** Published, non-draft releases (config may include
prereleases; default off). Fallback when repo has zero releases: annotated tags-as-releases if
pushed (basis labeled `tags`). Outputs: releases per W, median gap between consecutive
publishedAt, days since last release.

**M12 DORA approximations (FR-METRICS-12)** — every tile/report carries `basis` labels:

| DORA metric | API facts used | Honesty caveat (printed) |
|---|---|---|
| Deployment frequency | `deployments` with latestStatus=success per W; **fallback** releases (basis=`releases`), Gitea always fallback (no deployments API, research §7) | counts deploy *records*, not user-visible releases; env filter defaults to prod-like (`prod*`, config) |
| Lead time for changes | per deployment D: median over commits C ∈ (prev deploy of same env, D] of `D.createdAt − C.mergedAt-or-authoredAt` (merge time preferred via PR linkage) | approximates "commit→running" using forge timestamps; no runtime confirmation |
| Change-failure rate | deployments followed <48h (same env) by a revert/hotfix commit — message `/\b(revert|hotfix|rollback)\b/i` or GitHub revert linkage — ÷ deployments | keyword heuristic; teams that don't say "hotfix" undercount; 48h window is a convention |
| MTTR | **not computed in v1** — no incident source | tile renders "needs incident data" (never a fake number) |

## 2. Snapshots & rollups

**FR-METRICS-13**: nightly `metrics.snapshot` job writes
`metric_snapshot(workspace_id, repo_id, metric_id, window, value, numerator, denominator, dims jsonb, computed_at)`
for every metric × window; retention ≥400d; trend endpoints (FR-INSIGHTS-4) read snapshots
only — never recompute. **FR-METRICS-14** org rollups pool correctly: percentile metrics pool
raw samples across repos (pooled p90 ≠ mean of repo p90s — tested); ratio metrics sum
numerators/denominators; hotspots/ownership rank globally. Rollups honor the active view's
repo filter (FR-API-6).

## 3. Health score (FR-INSIGHTS-2/3)

`health = Σ w_i × sub_i`, sub-scores 0–100, weights from workspace config (**not code**;
defaults below), renormalized when a sub-score is absent (FR-INSIGHTS-3: no analysis rows ⇒
drop security, label "Tier-1 only"). Normalization: each input mapped by a documented piecewise
ramp `ramp(x, good, bad)` = 100 at good-or-better, 0 at bad-or-worse, linear between (values in
catalog, tunable in config).

| Sub-score | w | Inputs (equal-weight mean of ramps) |
|---|---|---|
| activity | 0.20 | commit count vs repo's own 365d weekly median; days-since-last-push ramp(2d,30d) |
| review hygiene | 0.30 | M5 ramp(0.9,0.4); median first-review hrs ramp(4h,72h); stale-PR count ramp(0,10) |
| CI health | 0.25 | M9 default-branch passRate ramp(0.95,0.6); top flakiness ramp(0,0.3) |
| delivery | 0.25 | e2e cycle p50 ramp(24h,240h); M11 days-since-release ramp(14d,120d); (when present) M12 CFR ramp(0.05,0.4) |
| security (v1.x) | +0.20 then renorm | open security findings weighted by severity, ramp(0, 10 sev-weighted) |

API returns full breakdown (input, raw value, ramp params, normalized, weight, contribution).
**Presentation rule (Goodhart risk R-x)**: UI/report copy says "signals, not grades"; scores
are trend/triage aids, never individual performance measures; person-grain data appears only
in the developer's own view (D6), not in rankings.

## 4. Worked examples (fixture: repo "demo", W=30d, today=2026-07-07)

**E1 — M2 hotspot.** Commits in W touch `api.ts` (+120/−40 on 2026-07-05) and `util.ts`
(+20/−10 on 2026-06-10). gross: api=160, util=30 ⇒ normChurn: api=1.0, util=0.1875.
daysSince: api=2 ⇒ decay 2^(−2/30)=0.955; util=27 ⇒ 2^(−27/30)=0.536.
**hotspot(api)=0.955, hotspot(util)=0.100** — ordering api > util, matches FR-METRICS-2 acceptance.

**E2 — M4 stages.** PR #7: created 07-01 09:00; alice (non-author) COMMENTED 07-01 15:00;
alice APPROVED 07-02 09:00; author re-requested review 07-02 10:00; alice APPROVED 07-02 18:00;
merged 07-03 09:00. open→firstReview = 6h. Approval must follow the last re-request ⇒
firstReview→approved = 07-01 15:00 → 07-02 18:00 = 27h. approved→merged = 15h. e2e = 48h.

**E3 — M5/M6 + health input.** 10 merged PRs in W: 6 with non-author reviews, 1 approved only
by its author (self-approval ⇒ uncovered), 2 with zero reviews, 1 authored by `renovate[bot]`
(excluded). Denominator 9, covered 6 ⇒ **M5 = 66.7% (6/9)**, M6 = 33.3% with a 3-PR drill-down
list. Health input: ramp(0.667, good=0.9, bad=0.4) = (0.667−0.4)/(0.9−0.4)×100 = **53.4**.
