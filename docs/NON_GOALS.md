# RepoPulse — Non-Goals

Traces to: `docs/work/FOUNDING_BRIEF.md` (C1, D1, D2, D3, D7). Each non-goal is
binding for v1 unless the brief is amended. IDs N-x are citable from SCOPE.md and
requirements docs.

| ID | Non-goal | Rationale (one line) |
|----|----------|----------------------|
| N-1 | **No repository cloning or full-repo SAST (semgrep-style scanning) in v1.** | C1 is the product's defining constraint — clone-free ingestion is the moat; full-repo static analysis requires a checkout and a worker fleet we explicitly refuse to operate. |
| N-2 | **No CI runner / build execution.** | RepoPulse observes CI results via forge APIs (check runs, statuses); running builds is a different product with a different risk and cost profile. |
| N-3 | **No PR-blocking gate bot in v1.** | Dashboard-first (D5): trust must be earned before RepoPulse can block merges; advisory PR comments are a v1.x candidate (S-25), required status checks are not. |
| N-4 | **No email digests or Slack push in v1.** | D7 locks delivery to the in-app report center with history + PDF export; outbound channels are explicitly deferred. |
| N-5 | **No billing, plans, or multi-org self-serve onboarding in v1.** | D1: internal deployment with a single `default` workspace; SaaS-readiness is a schema discipline (`workspace_id`), not a v1 feature surface. |
| N-6 | **No GitLab or Bitbucket adapters.** | D3 scopes forges to GitHub v1 + Gitea v1.x behind `ForgeProvider`; further adapters dilute effort before the interface is proven twice. |
| N-7 | **No IDE plugin.** | The product surface is the web dashboard and reports; editor integration multiplies clients without serving P1/P3/P4 at all. |
| N-8 | **Not a replacement for deep security audits (`/security`-style, ThreatForge-style).** | Tier-2/3 diff review yields signals with confidence scores, not exhaustive OWASP coverage; RepoPulse routes attention, audits provide assurance. |
| N-9 | **No quality "grades" or developer leaderboards.** | Metrics are presented as signals for humans to interpret (see RISKS R-5, Goodhart); single-letter scores and per-developer rankings invite gaming and misuse. |

## How to use this file

- A requirement or ticket that implements an N-x item is invalid — reject at review.
- Graduating a non-goal (e.g. N-3 → gate bot in v2) requires a brief amendment plus
  updates here and in SCOPE.md, not a silent ticket.
