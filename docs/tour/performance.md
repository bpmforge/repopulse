# Fix code that gets slower as data grows

Performance findings are code shapes that cost more as data grows: a lookup that scans a whole list, an array copied on every append. Each one points at the line and says why it grows, and where a rule can prove it, comes with a patch that has been re-scanned before you see it.

**For:** Developer · **2 steps** · [All tours](README.md)

> Real screens from a RepoPulse test install built from the current main branch (0.2.1 in development). It tracks copies of three open-source projects on a local Gitea: gin (Go), saleor (Python) and RepoPulse's own code (TypeScript), with the qwen3.8-27b model running in LM Studio on the same network.

## 1. Open the performance findings

Performance sits under **Code health**. RepoPulse's own code has 36 open, all the same shape: each append copies the whole accumulated array, so building it from k items costs O(k²). The page says when and at which commit it was last reviewed, and what these are: code-review findings, not measured latency.

![Open the performance findings](images/performance-01-tab.webp)

## 2. See where in the code, and why the model agrees

In saleor, `checkout_lines_update.py:286` tests membership against a list inside a loop over another collection: O(n·m). The fix: build a set first, O(n + m). The model agrees it is real with confidence 4 of 5 and cites the three lines it relied on.

![See where in the code, and why the model agrees](images/performance-02-finding.webp)

---

When a fix is drafted and verified it appears on the finding as a Suggested change, as in the verified fixes tour. After you apply it, the next scan of your branch closes the finding on its own.

---

Next tour: [Fix the mistakes AI coding tools make](ai-slop.md) · [All tours](README.md)
