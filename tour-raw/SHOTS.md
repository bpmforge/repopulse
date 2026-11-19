# Tour recapture for 0.3.0 (2026-11-19)

Raw recaptures for `docs/tour/images/`, not yet swapped in. Light theme, signed in as the admin of each install. Desktop shots are 1440 px wide at device scale 1, taken from the browser viewport (not a clipped full page), so there is no grey band at the bottom and the sidebar logo shows. WebP at quality 88; the PNG next to each one is the source.

Checked before saving: the page text of every shot was scanned for LAN IPs, emails and tokens (none), and each image was looked at by eye. Any 192.168.x.x address on screen is covered by a grey box.

## SampleCo pull-request install (project rpcli on the M4, build 0.2.1-w27.53d5f8a, AI = Claude Code CLI with Haiku)

| File | Shows |
|---|---|
| pr-03-files-findings | sampleco7 PR #1 page scrolled so "New on this PR" starts at the top: head a0eeb68, seven scanners, the "not in CI" note, Critical and High AI rows with "+N more AI notes on this line". 1440×900 |
| pr-04-ai-review-run | sampleco7 → AI review, with the PR pass header fully visible under the top bar: "finished · Nov 19, 2026, 08:20 AM EST · started by admin · 6 model calls", "Reviewed the diff of pull request #1 (base main, head a0eeb68a)", then the two judge passes and the first look. 1440×900 |
| pr-06-finding | Finding 16033 (sampleco6, bpm-js-sql-string-concat, src/services/invoiceService.js:7): The issue with line 7 marked, and What to do. Same framing as before. 1440×900 |
| pr-07-verified-fix | Same finding: Suggested change (Verified fix, split diff +2 −2, against 4dd815e) and the AI review card (real issue, confidence 5/5, cited lines 6 and 7). 1440×900 |

The sidebar now shows Findings 785 and a "1" badge on Settings, which are other test repos and a setup item on the same install.

## 3-repo install (project rpw25 on the M5, build 0.2.1-w25.1e3b74c, AI = qwen3.8-27b in LM Studio)

| File | Shows |
|---|---|
| ai-03-start-form | saleor → AI review, cropped to the "AI review pass" start form only, from the heading to "To start: enter at least one file or directory": Full review and Include tests visible. The LM Studio address in "Where the code goes" is a grey box, as before. 1162×662 |
| security-09-phone | iPhone 13 emulation (390×664 CSS px at scale 3), finding 3687 "CVE-2020-14343 in pyyaml 5.3.1", top of the page. **The overflow bug is still there:** the evidence line, the requirements.txt path link and the long path in "Why this applies" run past the card's right edge. A check on the page found 5 elements wider than the 390 px screen (the page itself does not scroll sideways). Captured as is. |

## Skipped

- security-05-sast (gin.go:859, rule bpm-go-open-redirect): rpw25 has no finding from that rule; filtering gin's findings by that rule returns nothing. The rpcli install on the M4 has it (finding 77, from the earlier PR tour, 13-gin-open-redirect-rule), if a desktop shot from there is acceptable.

## How these were taken

The stacks were started without their workers (no scan or AI job ran) and stopped again afterwards. Each page load clicked "Not now" on the role prompt, as the earlier captures did. Nothing else on either install was changed.
