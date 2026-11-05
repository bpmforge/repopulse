# Repo Pulse 0.2.0 tutorial: screenshot notes

Captured 2026-11-05 on a fresh install of the public 0.2.0 arm64 bundle (sha256 matches the GitHub release).
Install: http://localhost:8299, compose project `rptutorial`, bundle in `~/tmp/rp-tutorial-020`.
Data: six repos on the test Gitea (axum, gin, mastodon-ios, nowinandroid, outline, saleor). Model: LM Studio, qwen/qwen3.8-27b.
All LAN IPs are covered with a grey block, including the example IP in the model address hint.

**Status: non-AI set done. AI screens are pending (see "Pending").** Numbers below were read from the pages at capture, and will move when the AI stage finishes.

Two sets:
- `tour/*.png`: the website tour set, named `<tour>-NN-<slug>.png`, 1440 wide, 900-1600 high.
- `*.jpg`: the linear walkthrough, 1440x900, JPEG quality 80.

## Tour set (tour/)

"Replaces" is the image in bpmforge-site `pages/repopulse/`.

### setup
| File | Replaces | Caption |
|---|---|---|
| setup-01-sign-in.png | repopulse-tour-sign-in | Sign-in screen: email and password only, as no SSO is configured. |
| setup-02-checklist-empty.png | repopulse-tour-setup | First landing with no data: "Finish setting up" with 6 open items, "No metrics computed yet". 1440x900, converted from JPEG (this state exists only once). |
| setup-03-connect.png | repopulse-tour-connect | Gitea over https connected: "Connected. Now choose which repositories to track below", 6 repositories visible to the token. 1440x900, from JPEG. |
| setup-04-repositories.png | repopulse-tour-repositories | Six tracked repos, health 50 to 65. |
| setup-05-models-wizard.png | rp-setup-01-models | Wizard, four choices of where the model runs, each saying what leaves the network. 1440x900, from JPEG. |
| setup-06-routing.png | rp-setup-02-routing | Configured provider LM Studio plus routing, Local only ticked, every role on LM Studio. |
| setup-07-analysis.png | rp-setup-03-analysis | Per-repo policy: Tier 3 off and "nothing sent" for all six; AI switch on; no schedules. Contains the stale "Security tab" wording (issue P6). |
| setup-08-scanning | repopulse-tour-scanning | PENDING: needs a scan running; captured with the gin rerun. |
| setup-09-system-health.png | rp-setup-04-connections | System health: 6 Ready, 1 Degraded (saleor code_health_tools failed), 1 Setup needed (backups). |
| setup-10-setup-checklist.png | rp-setup-05-setup | Install checklist: "ready to use, 1 step left" (remove ADMIN_PASSWORD from .env). |

### overview
| File | Replaces | Caption |
|---|---|---|
| overview-01-repositories.png | rp-hub-repositories | Health: axum 65, gin 50, mastodon-ios 52, nowinandroid 65, outline 52, saleor 50 (the site says 49 to 68). |
| overview-02-gin-pulse.png | rp-ov-01-repo-pulse-gin | gin: health 50, Security 0/100 (8 open), Supply Chain 100/100. Delivery tiles all 0 (mirror has no recent activity). Top risk CVE-2026-78663 in golang.org/x/net v0.57.0, risk 59.50, sev 5, "act". 159 open: 1 act, 8 schedule, 150 track. |
| overview-03-score-why.png | rp-ov-02-score-why | Score breakdown popover, e.g. open findings (severity-weighted) 31 -> 0. |
| overview-04-outline-pulse.png | rp-ov-03-outline-pulse | outline: Security 13/100 (13 open), Supply Chain 100/100. Top risk is now CVE-2026-116693 in dd-trace 5.130.0, risk 33.32; the site's compound-risk findings are not at the top. 4,435 open, 4,422 not yet priced. |
| overview-05-findings-all.png | rp-ov-04-findings-all | 6,201 findings (site: 23,180), 790 shadow not listed. No "fixes ready" block yet. |

### security
| File | Replaces | Caption |
|---|---|---|
| security-01-coverage.png | rp-sec-01-coverage | gin coverage: 19 scanners, 5 with nothing to scan. Shows the false "Vulnerability database: not synced" line (issue P3). |
| security-02-ranked.png | rp-sec-02-ranked | 71 security findings across repos, 26 shadow not listed, critical CVE marked Act now first. |
| security-03-cve-why.png | rp-sec-04-cve-why | CVE-2026-78663: critical, reachability "imported" (no call traced), EPSS 0.62%. Same EPSS as the site. |
| security-04-vex-button.png | rp-sec-06b-cve-vex-button | Record VEX statement button on CVE-2026-78663, with the verified-fix and AI-review notes beneath it (neither applies to a dependency CVE). |
| security-05-sast-where.png | rp-sec-07-sast-where | server/models/User.ts:337 createHash("md5"), rule bpm-js-weak-hash, with recommendation. |
| security-06-sast-ai | rp-sec-08-sast-ai | PENDING (AI). |
| security-07-ai-vex | rp-sec-06-ai-vex | PENDING (AI). |
| security-08-saleor-ranked.png | rp-sec-09-saleor-ranked | saleor: Security 0/100 (35 open), 214 open overall. Code health "last run failed" (stdout cap exceeded), Anti-slop "cut short", listed first. |

### performance
| File | Replaces | Caption |
|---|---|---|
| performance-01-tab.png | rp-perf-01-tab | outline: 9 open performance findings (site: 11); 298 more are shadow and not listed. No AI confirmation yet; retake after the judge. |
| performance-02-finding.png | rp-perf-02-finding | server/utils/authentication.ts:57, find-by-key in a loop (rule bpm-perf-find-by-key-in-loop). |
| performance-03-ai | rp-perf-04-ai | PENDING (AI). |
| performance-04-fix-finding.png | rp-perf-05-fix-finding | shared/editor/lib/ExtensionManager.ts:181-195, copy-on-append. "Not yet run" for AI review. |
| performance-05-fix-diff | rp-perf-06-fix-diff | PENDING (AI). |

### ai-slop
| File | Replaces | Caption |
|---|---|---|
| ai-slop-01-codehealth-tab.png | rp-slop-01-codehealth-tab | gin: duplication 4.24%, complexity p90 3, worst functions 7, revert rate 0%. |
| ai-slop-02-finding.png | rp-slop-02-finding | context.go:1196, discarded error, rule bpm-ch-go-discarded-error. |
| ai-slop-03-ai, -04-diff, -05-judge-real, -06-closed-history | rp-slop-04-ai, -05-diff, -06-judge-real, -07-closed-history | PENDING (AI). |

### fixes
All five PENDING (AI): rp-fix-01-ready, rp-slop-05-diff, rp-fix-02-log, repopulse-tour-refused, rp-closed-findings. The Verified fixes page is empty so far.

### health
| File | Replaces | Caption |
|---|---|---|
| health-01-codehealth-outline.png | rp-health-01-codehealth-outline | outline: duplication 6.05%, complexity p90 4, worst functions 54, revert rate 1.4%. Anti-slop was cut short, so "slop by rule" says it is not a measurement. |
| health-02-codehealth-kotlin.png | rp-health-02-codehealth-kotlin | nowinandroid: duplication 15.43% (same as the site), complexity p90 2, revert rate 2.2%. |
| health-03-plans.png | rp-health-03-plans | Plan #1 for outline, 30d: one proposed item (review SLA) with auto-close condition and owner picker. The site shows two. |

### rules
| File | Replaces | Caption |
|---|---|---|
| rules-01-registry.png | rp-rules-01-registry | Rule registry: 64 shadow rows with promotion criteria. No proposed rules yet; retake after the rule draft pass. |
| rules-02-precision.png | rp-rules-02-precision | Rule block on the md5 finding. |
| rules-03-shadow.png | rp-rules-03-shadow | Filtered to shadow rules: 790 findings (same as the site). |

### reports
| File | Replaces | Caption |
|---|---|---|
| reports-01-reports.png | rp-rep-01-reports | Generate form, two reports in history, schedule form. |
| reports-02-exec-print.png | rp-rep-02-exec-print | Organization Executive Summary, 30-day window, basis table of repos and top risks. |
| reports-03-posture-print.png | rp-rep-03-posture-print | Security Posture print view. |

## Pending (needs finished AI work)
setup-08-scanning, security-06/07, performance-03/05, ai-slop-03/04/05/06, fixes-01..05. Retakes after AI: performance-01, overview-05, rules-01.
Linear set still to come: 24-run-scans-now and the AI verdict, fixes, refused fixes and proposed rules screens.

## Linear set (*.jpg)
| File | Shows |
|---|---|
| 01-sign-in | Sign-in. |
| 02-forced-password-change | Forced change, the only screen reachable until it is done. |
| 03-first-landing | Empty Overview, "Finish setting up" (6 items), "Password updated" toast. |
| 04-settings-setup | Settings -> Setup at the start: "ready to use, 3 steps left". |
| 05-models-wizard-start | Wizard step 1. |
| 06-model-test-result | "Reached it" in about 19 s; context 262,144 tokens; streaming, JSON and tools yes. |
| 07-model-roles | Eight roles ticked. |
| 08-model-review | "What leaves your network": every role "Stays home". |
| 09-forge-tls-error | Untrusted certificate error, "your token was not checked". |
| 10-forge-connected | Connected, repo picker with 6 repos. |
| 11-choose-repositories | "Track all 6 and auto-add new". |
| 11b-persona-prompt | "What best describes you?" dialog, appears once data lands (5 roles, "Not now"). |
| 12-repositories-list | Six repos, health 50 to 65. |
| 13-connections-active | Connection: gitea:3000, Active, 6 repos, Auto-add on, Scheduled sync only. |
| 14-overview | Overview with next actions; 6,201 open: 1 act, 15 schedule, 934 track, 5,251 not yet priced. |
| 15-gin-findings | gin: 159 still to fix, 3 shadow not listed. |
| 16-gin-security-coverage | gin coverage, 19 scanners. |
| 17-mastodon-performance | mastodon-ios: 4 of 4 performance findings, all find-in-loop, Low. |
| 18-nowinandroid-code-health | Duplication 15.43%; most complex: SettingsDialogTest.kt:36 measured 150 (threshold 50). |
| 19-all-findings | 1-50 of 6,201, 790 shadow not listed. |
| 20-gin-pulse-top-risks | Top risks, CVE-2026-78663 first. |
| 21-rules | Rule registry and benchmark precision table. |
| 22-sync | All 6 up to date, 100% history, worst lag 26.8d, dead-letter empty. |
| 23-gin-ai-review-tab | New AI review tab (W24-04): limits, where code goes, "Not yet run". |
| 25-models-configured | Models page opens on Configured providers (W24-01). |
| 26-models-routing | Shared pool stated once above the table (W24-02). |
| 27-models-quality | Quality per model: row per role, P/R columns (W24-03). |

W24 fixes (PR #208) are in 0.2.0: confirmed as an ancestor of the tag commit 4a338f7b.

## Install: what the docs got wrong or left out
Result: checksum OK, install 15 s, all services healthy, `healthz` OK, scan-db-sync worked first time (3.3 GB). The internal-CA steps worked as written.

1. **The bundle has no INSTALL.md.** README points to "`INSTALL.md` -> Uninstall". I used `docs/INSTALL.md` at the v0.2.0 tag.
2. README refers to `docs/RUNBOOK.md`, but the bundle has `RUNBOOK.md` at its root and no `docs/`. Its "What is where" table lists RUNBOOK twice.
3. README says data is in "two named volumes"; compose has three (`reportdata` too).
4. **A second install on one host is undocumented in README and INSTALL.** `REPOPULSE_PROJECT` appears only in one RUNBOOK example, is not stored in `.env`, and must be set on every later `deploy/*.sh` call.
5. **`repopulse-scan-scratch` is a fixed name**, so a second install shares it with the first (compose prints a warning). `uninstall.sh` on one would remove what the other uses.
6. `up.sh` "Next steps" omit `deploy/scan-db-sync.sh`, so CVE scanning is easy to miss. They also repeat "you will be asked to change it" on every run, even after it is done.
7. Docs name `podman-compose` as the tested provider; this Mac used Docker Compose 5.6.1 under Podman 6.1.2. It worked, but that combination is not in the tested list.
8. `.env` already has a blank `NODE_EXTRA_CA_CERTS=` line, and the doc appends a second. It works (last wins) but looks wrong.

Workarounds for this test only, not product issues:
- Gitea was stopped, so I started it (`podman start`).
- Its cert and CA expired Nov 3 (7-day certs), and 8199 also fails with `CERT_HAS_EXPIRED`.
- I left Gitea and 8199 unchanged and added a forwarder container, `rptutorial-gitea-forward`, using a new CA in `~/tmp/rp-tutorial-020/pki`. It presents as `gitea` on the tutorial network.
- Connection is scheduled-only, so no webhooks were added to Gitea.

## Product problems seen
### AI scheduling
- **A1. Judge fails instantly when the model is busy.** nowinandroid's run failed in 16 ms: "The model failed 5 times in a row (last: No Tier-2 host is available under the configured concurrency cap.)". No retry or queue, so that repo waits for its next scan. `LMSTUDIO_CONCURRENCY` defaults to 1, so any multi-repo first scan can hit this.
- **A2. Judge overruns its 30-minute budget behind scan reviews.** axum's run took 71 minutes for 2 calls and 4 verdicts, all needs_human, leaving 34 hits. gin's run has gone over 35 minutes with 0 calls so far. Scan reviews (8-10 chunks a repo) share the same slot, and gin's took 69 minutes.

### Other
- **P1. Expired certificate gets the wrong advice.** The error says "certificate has expired" but the headline says the cert isn't trusted, add your CA. Adding a CA can't fix that.
- **P2. Same TLS message twice** (09-forge-tls-error).
- **P3. False "Vulnerability database: not synced".** The Security tab says CVE scanning cannot run, right above Dependency CVEs (grype) showing findings. `vuln-db` is present in both worker and api containers. The message prints the relative path `vuln-db`, so a bad path in the status check is my best guess; not confirmed.
- **P4. Supply Chain 100/100 "healthy" on gin** while the register says no SBOM was read. Probably a first-run ordering effect, but it reads as a clean result.
- **P5. "Worst functions 0" on nowinandroid** beside a list with functions measured at 150 and 77.
- **P6. Stale copy after W24-04.** Settings -> Analysis still says to start a pass on the repository's Security tab.
- **P7. Sync page shows "Loading History 100%"** for minutes while commits are still loading, and shows "issues not ingested — HTTP 403" under Last error for a token with exactly the documented minimum scopes.
- **P8. Contradictory or empty-looking labels.** "AI code review not configured — A model is configured but has not reviewed this repository yet." The pulse tiles show 0% with no data where Overview shows "—". Coverage shows `opengrep@unknown`.
- **P9. saleor code_health_tools failed with "stdout cap exceeded"**, and anti-slop was cut short on saleor and outline, so a large repo gets incomplete code-health data on first scan.
- **P10. Reloading the Models page after step 2 of the wizard** loses the role and review steps, with no way back. Harmless, as the shared pool still applies.
- **P12. CVE page contradicts itself on AI review.** The header says "verified by qwen/qwen3.8-27b: confirmed" and "A second model checked the evidence", while the AI REVIEW section lower down says "No AI review" and that an AI pass will not add one for a dependency CVE (security-03-cve-why).
- **P11. Site copy is now out of date:** health range, total findings (23,180 vs 6,201), and outline performance count (11 vs 9).
