# Decide which rules count

Every rule shows how it was measured and whether it counts. New rules run in shadow first, excluded from every score, until they have enough findings and days to judge. Rules proposed from AI triage wait for your approval.

**For:** Engineering lead · **3 steps** · [All tours](README.md)

> Real screens from a RepoPulse test install built from the current main branch (0.2.1 in development). It tracks copies of three open-source projects on a local Gitea: gin (Go), saleor (Python) and RepoPulse's own code (TypeScript), with the qwen3.8-27b model running in LM Studio on the same network.

## 1. The rule registry

**Settings → Rules** lists each rule's state, where it came from and its findings. Here four imported tool rule sets (shellcheck, hadolint, checkov, iacrender) run in shadow, excluded from every score, and each says what it still needs: 20 findings and 30 days. Below, precision measured on public benchmarks.

![The rule registry](images/rules-01-registry.webp)

## 2. Precision on every finding

Each finding shows its rule's record. bpm-perf-membership-in-list-in-loop-py is active and counts everywhere, backed by 15 of 15 hits marked real by hand on 3 public repositories. Your own triage is counted too once you start.

![Precision on every finding](images/rules-02-precision.webp)

## 3. Look at what shadow rules found

Shadow findings are hidden by default. Set **Rule stage** to shadow rules only to review them: 1,197 here, such as Kubernetes containers sharing the host network, kept out of every score until their rule is promoted.

![Look at what shadow rules found](images/rules-03-shadow.webp)

---

Next tour: [Share status as reports and PDFs](reports.md) · [All tours](README.md)
