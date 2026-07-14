# RepoPulse — Status ledger

- 2026-07-07 — project created; founding brief locked (D1–D7, C1–C3).
- 2026-07-07 — design package complete (SRS, ARCHITECTURE, design/*, UX_SPEC, ROADMAP, TESTING, DEPLOYMENT).
- 2026-07-14 — full design review (docs/work/DESIGN_REVIEW.md): pre-flight fix pack applied.
  5 tickets added (W0-05 GitHub App registration, W1-08 API hardening, W4-00 e2e harness,
  W4-09 workspace settings, W5-05 identity admin); doc reconciliation (auth → packages/auth,
  forge_etag naming, webhook_delivery/job_failure tables, findings severity/dedup/lifecycle
  canonicalized, report status, 9 missing API endpoints); Redis pinned 7.2 (licensing);
  board now 67 tickets / 305 pts, validators green.
- 2026-07-14 — journey UX review + micro-agent/loop architecture port + improvement-plans
  research (docs/work/UX_AGENTS_IMPROVEMENT_PLANS.md): 30+ recommendations (R-A/B/C/D),
  Improvement Plans proposed as new pillar (needs D9 brief amendment), verify/challenger
  passes for T2 (maker≠verifier across the two LAN hosts), agreements + artifact goals.
- 2026-07-14 — D9 + D10 ADOPTED (Brad): Improvement Plans + quality loops (D9) and CVE
  validation & VEX (D10 — SBOM false-positive funnel: alias dedup → dev/prod scoping →
  import/usage detection → reachability (govulncheck / generated semgrep symbol rules) →
  EPSS+KEV effective risk → justification-gated OpenVEX suppression, version-bump reopen).
  Threaded: SCOPE S-40..46 · SRS FR-PLANS-1..6 / FR-ANALYSIS-9,10 / FR-INSIGHTS-6 /
  FR-SEC-13..15 · design/IMPROVEMENT_PLANS.md · SECURITY_SUITE §3.6 · DATABASE D9/D10 ·
  USER_STORIES E11/E12 (total 250 pts) · ROADMAP addendum · plan.json W4-10, W5-06..09,
  W6-05..07, W8-09(+compound), W8-13..15. Board: 78 tickets / 360 pts, validators green.
- 2026-07-14 — D11 ADOPTED (Brad): Code Health Suite, wave W9 on the W8 scanner framework.
  30-rule anti-slop taxonomy mined from bpm-opencode-experts (≈12 deterministic → OUR
  semgrep rulepack; rest T2 checklist behind the maker≠verifier verify pass), lizard/jscpd
  with canon thresholds, LDR structural-slop measure, net-new logging-hygiene ruleset
  (OWASP A09/CWE-117), M13/M14 debt signals (14d rework, revert rate), Code Health
  tab/report/sub-score + plan-catalog v2. Evidence: GitClear 2026 (copy-paste 15.7%,
  refactoring −70%), Veracode 2025 (45% fail; log injection 88%), USENIX 2025 (19.7%
  hallucinated pkgs), Apiiro (+322%). New: design/CODE_HEALTH_SUITE.md, SRS §2.12
  FR-CH-1..7 + FR-REPORTS-8, SCOPE S-50..56, E13, ROADMAP W9, plan W9-01..06 (validator
  now allows W9). Board: 84 tickets / 399 pts, validators green.
- 2026-07-14 — D11 extended (Brad): rule lifecycle + shadow mode + intake (FR-CH-8/9 —
  30 rules = seed not cap; experimental findings excluded from scores until FP-gated
  promotion; field-lesson + LLM-drafted + license-gated external-pack intake, all land
  proposed), tool adapter registry (FR-CH-10 — ruff/Biome W9; actionlint/hadolint/
  shellcheck/sqlfluff/vale/gocyclo backlog; standalone-only sandbox admission), and
  per-language perf/correctness/framework semgrep packs (Opengrep-swappable engine
  contract). Tickets W9-07/08. Board: 86 tickets / 409 pts, validators green.
- Next: W0 tickets — W0-05 (human: GitHub App) can run parallel to W0-01/W0-02.
