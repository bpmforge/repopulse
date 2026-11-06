# RepoPulse tour

Step-by-step tours of RepoPulse 0.2.0, one per job, with a real screen for every step.

> Real screens from a fresh RepoPulse 0.2.0 install that scanned copies of six public open-source projects (axum, gin, mastodon-ios, nowinandroid, outline and saleor) on a local Gitea over https, with models running in LM Studio on the same network. No GitHub account or token was involved. Numbers on the screens are from that install on 2026-11-05.

## Tours

| Tour | For | Steps |
|---|---|---|
| [Install and set up RepoPulse](setup.md) | Admin | 10 |
| [See where every repository stands](overview.md) | Engineering lead, Manager or exec | 5 |
| [Triage security findings: CVEs, code flaws and secrets](security.md) | Security engineer, Developer | 8 |
| [Fix code that gets slower as data grows](performance.md) | Developer | 5 |
| [Fix the mistakes AI coding tools make](ai-slop.md) | Developer | 6 |
| [Review and apply verified fixes](fixes.md) | Developer, Security engineer, Engineering lead | 5 |
| [Track code health and the improvement plan](health.md) | Engineering lead | 3 |
| [Decide which rules count](rules.md) | Engineering lead | 3 |
| [Share status as reports and PDFs](reports.md) | Manager or exec, Security engineer | 3 |

## By role

- **Admin:** [Install and set up RepoPulse](setup.md)
- **Developer:** [Triage security findings: CVEs, code flaws and secrets](security.md) · [Fix code that gets slower as data grows](performance.md) · [Fix the mistakes AI coding tools make](ai-slop.md) · [Review and apply verified fixes](fixes.md)
- **Security engineer:** [Triage security findings: CVEs, code flaws and secrets](security.md) · [Review and apply verified fixes](fixes.md) · [Share status as reports and PDFs](reports.md)
- **Engineering lead:** [See where every repository stands](overview.md) · [Review and apply verified fixes](fixes.md) · [Track code health and the improvement plan](health.md) · [Decide which rules count](rules.md)
- **Manager or exec:** [See where every repository stands](overview.md) · [Share status as reports and PDFs](reports.md)

## About these screens

34 of the 48 screens were captured on the 0.2.0 install. The other 14 depend on the AI review (model verdicts, verified and refused fixes) or a scan in progress; until the local model finishes its review on the 0.2.0 install they show the same step from the 0.9.17 walkthrough of 2026-10-30, and each is labelled.

The same tours are on the website at [bpmforge.com/repopulse](https://bpmforge.com/repopulse#roles). To install RepoPulse yourself, start with [INSTALL.md](../INSTALL.md).
