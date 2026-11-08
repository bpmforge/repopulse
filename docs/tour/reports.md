# Share status as reports and PDFs

Reports are pinned to their window, so regenerating one with the same scope reproduces the same numbers. Each has a print view and a PDF to send to anyone; the link only works for people with an account.

**For:** Manager or exec, Security engineer · **3 steps** · [All tours](README.md)

> Real screens from a RepoPulse test install built from the current main branch (0.2.1 in development). It tracks copies of three open-source projects on a local Gitea: gin (Go), saleor (Python) and RepoPulse's own code (TypeScript), with the qwen3.8-27b model running in LM Studio on the same network.

## 1. Generate a report

**Reports**: pick a type and a window and generate. The history here has an Organization Executive Summary and a Security Posture report for 30 days, each with View, PDF, Regenerate and Make a plan. Reports can also be scheduled monthly or quarterly.

![Generate a report](images/reports-01-reports.webp)

## 2. Read the executive summary

The summary starts with its basis: the snapshot time, the health weights, and each repository's coverage and sync lag. Then the top risks, the 7,114 open findings split into 30 to act on, 332 to schedule and 6,752 to track, and the share of commits written with AI help. It shows organization-level figures, with no per-person data.

![Read the executive summary](images/reports-02-exec-print.webp)

## 3. Hand over the security posture

The Security Posture report has the same basis and lists the open security findings, critical first, with links back to each one. Download PDF gives a file to send to anyone outside the workspace.

![Hand over the security posture](images/reports-03-posture-print.webp)

---

Trends need more than one window: this is the first report on this install, so it has no change to show yet. On a running install the reports and the overview show the change against the previous window.

---

Next tour: [Let a local model review your code](ai-review.md) · [All tours](README.md)
