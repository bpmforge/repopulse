# Repo Pulse PR-flow tour screens (2026-11-19)

Captured on the M4 test install (project rpcli) running **main a5d0f48** (PR page shots 08, 09, 09b, 11 re-taken on **53d5f8a**, the "not in CI" badge), AI backend **Claude Code CLI with Haiku (claude-haiku-5-5)**, forge = local test Gitea. 1440 px wide at device scale 2 (2880 px images), light and dark versions with the same names in `light/` and `dark/`. Repos are the SampleCo demo app (test code, `sampleco6` / `sampleco7`) and a mirror of gin at 0f09c3a9. The admin is linked to the commit and PR identities, so no banner. Known clutter from the test install: the sidebar shows "Findings 781" and "Inbox 99+" (other test repos on the same install); the cross-repo overview is NOT included (needs the clean install).

| File | Shows | Numbers visible |
|---|---|---|
| 02-repo-sampleco-pulse.png | SampleCo repo page (Pulse) by area | Security 0/100 needs attention, "10 open findings, sub-score 0"; Supply chain 100/100 healthy; health 54 |
| 03-rule-finding-sql.png | A rule finding with evidence: semgrep bpm-js-sql-string-concat on src/services/invoiceService.js:7, the whole file with line 7 highlighted, "What to do", start of the verified fix | lines 1–15 of invoiceService.js; L7 |
| 04-rule-finding-ai-verdict.png | Same finding scrolled to the AI judge verdict | "AI suggests this is a real issue", AI confidence 5/5, Claude CLI (Haiku), cited lines invoiceService.js:6 and :7 |
| 05-verified-fix-diff.png | Verified fix: split diff with changed words, re-scan proof, "Not tested" note, Copy/Download .patch, then the AI verdict | +2 −2; patch against commit 4dd815e; drafted by claude-haiku-5-5 |
| 06-ai-finding-hardcoded-key.png | An AI first-look finding: live API key and JWT secret hard-coded in src/config.js | severity 5 (critical), security, Haiku |
| 07-pr-list.png | Repo → Delivery → Pull requests | #1 Add customer and region reports · rpadmin · open · 1h · size S · reviewed no |
| 08-pr-page-top.png | PR page header and stage timeline | "S · 65 lines", open, opened 2026-11-19 |
| 09-pr-page-files-findings.png | PR page: Files table + "New on this PR" with labelled, folded AI notes | 3 files: src/index.js modified +2 −0, src/routes/reportRoutes.js added +21 −0, src/services/reportService.js added +42 −0; head a0eeb68 scanned by 7 scanners; one line above the table: "Rows marked \"not in CI\" come from an AI review that no second model has confirmed. They are shown here and do not fail a CI check."; each AI row has a small "not in CI" badge in Found by (your AI model claude-haiku-5-5); Critical rows with "(+2 more AI notes on this line)" |
| 09b-pr-page-full.png | The whole PR page (tall) | as 08 + 09, plus the rule findings: High SQL concat :10, Medium empty catch :27–32 |
| 10-ai-review-run.png | Repo → AI review, the finished PR review run | "✓ finished · Nov 19, 2026, 08:20 AM EST · started by admin · 6 model calls"; reviewed the diff of PR #1 |
| 11-pr-after-fix-push.png | PR page after the second commit (sampleco6, tall) | "S · 71 lines"; head eb2f486; the rule SQL and empty-catch findings gone from "New on this PR" (resolved); new path traversal from a rule in shadow |
| 12-gin-open-redirect-ai.png | gin: AI finding "Client-controlled X-Forwarded-Prefix can yield a scheme-relative (open) redirect Location" | gin.go:813 (813–819), low, confidence 3/5, Haiku; "Why this applies" explains the "///" Location |
| 13-gin-open-redirect-rule.png | gin: rule bpm-go-open-redirect (shadow) "Request data decides where the user is redirected" | gin.go:859 (redirectRequest) |
| 14-settings-models.png | Settings → Models: the configured connection and per-role routing | Claude CLI (Haiku), model haiku, "the CLI keeps its own login", leaves the network ⚠ yes, answered 11/19/2026 7:59:14 AM; "Local only" switch shown |
| 15-ci-check-failing.png | The CI check in a terminal (rendered from the real `repopulse.mjs check` output) | `--fail-on high` → "2 new findings on #1 — failed", exit code 1; high SQL concat src/services/reportService.js:10, medium empty catch :27 |

Raw text of every screen is beside each image (`.txt`). ci-check.txt is the exact CLI transcript (no token in it). With `--include-unconfirmed-ai` the same PR reports 30 (2 rule + 28 AI) — not shown as an image.
