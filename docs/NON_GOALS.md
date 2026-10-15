# RepoPulse — Non-Goals

Traces to: `docs/work/FOUNDING_BRIEF.md` (C1/C1a, D1, D2, D3, D7, D8, D9a, D16). Each non-goal is
binding for v1 unless the brief is amended. IDs N-x are citable from SCOPE.md and
requirements docs.

| ID | Non-goal | Rationale (one line) |
|----|----------|----------------------|
| N-1 | **No `git clone`, ever; no full-repo SAST in v1 — deferred to wave W8 (D8) over ephemeral API tarball snapshots (C1a).** | C1 clone-free ingestion remains the moat; the 2026-07-07 brief amendment (D8/C1a) permits W8 scanners to fetch the forge API tarball through the budgeted client into a sandboxed scratch dir — scan, shred, persist findings only (FR-SEC-2, NFR-13/14, S-30..S-35). Persistent checkouts, working copies, and `git clone` stay forbidden in every wave. |
| N-2 | **No CI runner / build execution.** | RepoPulse observes CI results via forge APIs (check runs, statuses); running builds is a different product with a different risk and cost profile. *Not contradicted by W18-18 (D16):* the `repopulse check` CLI runs inside the customer's own pipeline, on the customer's runners; RepoPulse still runs no builds. |
| N-3 | **No PR-blocking gate bot in v1.** | Dashboard-first (D5): trust must be earned before RepoPulse can block merges; ~~advisory PR comments are a v1.x candidate (S-25)~~ (S-25 withdrawn: D9a forbids RepoPulse posting PR comments, reaffirmed by D16), required status checks are not. *Clarified 2026-10-15 (D16):* the customer-CI pull (W18-18, S-73) does not graduate this. The customer's own CI may fail its own build on results it pulls with a read-only token, or post them with its own forge token; that gate belongs to the customer. RepoPulse ships no bot, sets no status check and holds no write scope. |
| N-4 | **No email digests or Slack push in v1.** | D7 locks delivery to the in-app report center with history + PDF export; outbound channels are explicitly deferred. |
| N-5 | **No billing, plans, or multi-org self-serve onboarding in v1.** | D1/D1a: a CUSTOMER-HOSTED install with a single `default` workspace needs none of them. SaaS-readiness is a schema discipline (`workspace_id`), not a v1 feature surface. D1a explicitly left N-5 binding when it made self-hosting the MVP. |
| N-6 | ~~**No GitLab or Bitbucket adapters.**~~ **GRADUATED for GitLab 2026-08-13 (D3a)** — the MVP is a customer pointing a self-hosted install at their own repos on GitHub, GitLab or Gitea, so a GitLab adapter is now in scope (W12-01). **Bitbucket remains a non-goal.** Original rationale: | D3 scopes forges to GitHub v1 + Gitea v1.x behind `ForgeProvider`; further adapters dilute effort before the interface is proven twice. |
| N-7 | **No IDE plugin.** | The product surface is the web dashboard and reports; editor integration multiplies clients without serving P1/P3/P4 at all. |
| N-8 | **Not a replacement for deep security audits (`/security`-style, ThreatForge-style).** | Tier-2/3 diff review yields signals with confidence scores, not exhaustive OWASP coverage; RepoPulse routes attention, audits provide assurance. |
| N-9 | **No quality "grades" or developer leaderboards.** | Metrics are presented as signals for humans to interpret (see RISKS R-5, Goodhart); single-letter scores and per-developer rankings invite gaming and misuse. *Applies to W18 (D16):* the AI-code governance report (W18-20) compares AI-authored and human changes as groups, never per developer; per-rule precision (W18-22) and AI-reviewer measurement (W18-23) rate rules and bots, not people. |

## Out of scope for the product-completion release (D15, 2026-09-08)

These are not permanent non-goals — they are excluded from THIS release and
carry no N-id. Recorded so an empty panel is never mistaken for a shipped
capability (`docs/work/product-completion/DECISIONS.md`).

- Kubernetes/Helm packaging; public SaaS signup; billing.
- Automatic code changes or PR submission (D9a already forbids these outright).
  D16's verified patches (W18-19) do not change this: a patch is proven by
  re-scanning the snapshot in the sandbox and shown for the developer to copy;
  nothing is applied to or submitted against a repo.
- New identity-provider integrations beyond D14's local + generic OIDC.
- Model auth beyond API keys — Vertex AI, Bedrock, Copilot (`W16-09`, parked).
- Production APM / runtime performance measurement. "Performance review" means
  static and AI code-review evidence, never measured latency, CPU or memory.
- Coverage ingestion and IaC scanning. Both have reserved schema values; **a
  reserved schema value is not a shipped capability**, and each must read as
  explicitly unavailable rather than as an empty green panel. *Update
  2026-10-15 (D16):* IaC scanning is now planned after this release (W18-26,
  checkov/hadolint/actionlint/shellcheck adapters); it keeps reading as
  unavailable until that ticket ships. Coverage ingestion stays parked.
- Executing repository benchmarks, and autonomous browser review of customer
  applications.

## How to use this file

- A requirement or ticket that implements an N-x item is invalid — reject at review.
- Graduating a non-goal (e.g. N-3 → gate bot in v2) requires a brief amendment plus
  updates here and in SCOPE.md, not a silent ticket.
