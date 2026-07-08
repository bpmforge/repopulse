# RepoPulse — User Personas

Traces to: `docs/work/FOUNDING_BRIEF.md` P1–P4 and D5–D7. Personas drive user
stories (US-x) and dashboard/report design; every primary view below should map to
a saved-view spec in the UX design doc.

## P1 — Engineering Lead

Brief: org/repo health rollup, hotspots, review bottlenecks, delivery trends.

- **Goals:** keep 5–15 repos healthy; spot bottlenecks before they cost a sprint;
  walk into planning/retro with evidence, not anecdotes.
- **Frustrations today:** GitHub Insights is per-repo and shallow; no cross-repo
  rollup; review-load imbalance is invisible until someone burns out; hotspot
  knowledge lives in one senior head.
- **Top 5 dashboard questions:**
  1. Which repos are trending unhealthy this month (cycle time, stale PRs, CI)?
  2. Where are the hotspots — high-churn, recently-touched files — across my repos?
  3. Who is the review bottleneck, and whose PRs wait longest for first review?
  4. Is our PR cycle time improving or regressing, and in which stage (open → first
     review → approval → merge)?
  5. What merged without review this week, and what's the bus factor on our riskiest
     code?
- **Primary saved views:** "My org rollup" (health tiles per repo, trend arrows);
  "Review flow" (cycle-time stage breakdown + reviewer load matrix); "Hotspot map"
  (churn × recency, drill to file).
- **Report needs (v1.x, D7):** monthly team-health pack per repo group; retro
  evidence export (cycle-time + review-coverage trend for the sprint window).

## P2 — Developer

Brief: my open PRs, my review load, hotspots in code I own, feedback on my changes.

- **Goals:** clear personal queue; know what blocks whom; get early, useful signals
  on changes without waiting for human review.
- **Frustrations today:** open-PR state scattered across repo tabs and notification
  noise; no view of "what I owe as a reviewer"; discovers they own a fragile hotspot
  only when it breaks.
- **Top 5 dashboard questions:**
  1. Which of my open PRs are stalled, and at which stage?
  2. What reviews am I on the hook for, oldest first?
  3. Which files I own are hotspots or low-bus-factor?
  4. How do my PR sizes and cycle times compare with the repo's distribution?
  5. What did automated review (Tier 2/3, v1.x) flag on my latest PRs?
- **Primary saved views:** "My work" (my open PRs + my review queue, one screen —
  the D6 flagship view); "My code health" (hotspots/ownership for files I touch
  most); per-repo PR detail drill-down.
- **Report needs:** minimal — dashboard-first; may export a personal cycle-time
  snapshot for reviews/1:1s.

## P3 — Security Engineer

Brief: security findings, dependency/secret signals, audit-ready PDF packs.

- **Goals:** continuous security signal across every repo without cloning anything;
  audit evidence on demand; know where review discipline is weakest (unreviewed
  merges = audit findings).
- **Frustrations today:** evidence assembly for audits is manual screenshot archaeology;
  no cross-repo view of security-relevant activity; SAST platforms want clones and
  agents (data-egress and ops cost, exactly the taxes RepoPulse removes); one-off
  deep audits go stale immediately.
- **Top 5 dashboard questions:**
  1. Which repos have open security-dimension findings (Tier 2/3, v1.x), by
     confidence and age?
  2. What merged without review — when, where, by whom (audit red flag #1)?
  3. Which PRs touched dependency manifests or security-sensitive paths recently?
  4. Are CI security checks passing, and where are checks absent or flaky?
  5. What changed in low-bus-factor, high-churn code that nobody else understands?
- **Primary saved views:** "Security posture" (per-repo: security findings,
  unreviewed-merge rate, sensitive-path activity, CI check status); "Audit window"
  (date-range-filtered evidence view).
- **Report needs (v1.x, D7):** the persona that most needs the report center —
  **audit-ready PDF packs**: date-range evidence bundles (review coverage,
  unreviewed merges, findings + dispositions) with history retained in-app.
  Understands RepoPulse signals route attention and do not replace deep audits
  (NON_GOALS N-8).

## P4 — Engineering Manager / Exec

Brief: DORA-style trends, throughput, exec summary reports.

- **Goals:** defensible quarterly delivery narrative; early warning on delivery
  regressions; compare team trends without buying a SaaS that exports org data.
- **Frustrations today:** DORA numbers hand-assembled in spreadsheets, stale by
  presentation day; anecdotes dominate reviews; existing insight SaaS = data egress
  (the exact D1 dealbreaker).
- **Top 5 dashboard questions:**
  1. What are our DORA approximations this quarter vs last (deployment frequency,
     lead time, change-failure rate) and their trend lines?
  2. Is throughput (merged PRs, issue throughput, release cadence) up or down, and
     where?
  3. Which teams/repos are outliers on cycle time — good or bad?
  4. Is quality holding while speed changes (CI pass rate, revert/hotfix rate)?
  5. What single chart do I show leadership this month?
- **Primary saved views:** "Exec rollup" (DORA tiles + 12-month trend lines,
  org-level only — never per-developer, per NON_GOALS N-9); "Quarter compare".
- **Report needs (v1.x, D7):** quarterly exec summary pack (DORA trends, throughput,
  cadence, one-page narrative header); report history so quarters are comparable
  artifact-to-artifact.

## Cross-persona notes for designers/builders

- P1/P2 are served fully by the v1 MVP (D5); P3/P4 get their dashboard slices in v1
  but their report packs land in v1.x (S-21) — set that expectation in-app.
- All personas share the same drill-down spine (org → repo → PR/file → detail,
  S-8); saved views (S-9) differ by filters and layout, not by separate page builds.
- No persona gets developer leaderboards or letter grades (NON_GOALS N-9, RISKS R-5).
