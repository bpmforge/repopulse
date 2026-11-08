# RepoPulse tour

Step-by-step tours of RepoPulse, one per job, with a real screen for every step.

> Real screens from a RepoPulse test install built from the current main branch (0.2.1 in development). It tracks copies of three open-source projects on a local Gitea: gin (Go), saleor (Python) and RepoPulse's own code (TypeScript), with the qwen3.8-27b model running in LM Studio on the same network. Numbers on the screens are from that install on 2026-11-08.

## Tours

| Tour | For | Steps |
|---|---|---|
| [Install and set up RepoPulse](setup.md) | Admin | 10 |
| [See where every repository stands](overview.md) | Engineering lead, Manager or exec | 7 |
| [Triage security findings: CVEs, code flaws and secrets](security.md) | Security engineer, Developer | 9 |
| [Fix code that gets slower as data grows](performance.md) | Developer | 2 |
| [Fix the mistakes AI coding tools make](ai-slop.md) | Developer | 3 |
| [Review and apply verified fixes](fixes.md) | Developer, Security engineer, Engineering lead | 6 |
| [Track code health and the improvement plan](health.md) | Engineering lead | 3 |
| [Decide which rules count](rules.md) | Engineering lead | 3 |
| [Share status as reports and PDFs](reports.md) | Manager or exec, Security engineer | 3 |
| [Let a local model review your code](ai-review.md) | Developer, Security engineer, Engineering lead | 4 |

## By role

- **Admin:** [Install and set up RepoPulse](setup.md)
- **Developer:** [Triage security findings: CVEs, code flaws and secrets](security.md) · [Fix code that gets slower as data grows](performance.md) · [Fix the mistakes AI coding tools make](ai-slop.md) · [Review and apply verified fixes](fixes.md) · [Let a local model review your code](ai-review.md)
- **Security engineer:** [Triage security findings: CVEs, code flaws and secrets](security.md) · [Review and apply verified fixes](fixes.md) · [Share status as reports and PDFs](reports.md) · [Let a local model review your code](ai-review.md)
- **Engineering lead:** [See where every repository stands](overview.md) · [Review and apply verified fixes](fixes.md) · [Track code health and the improvement plan](health.md) · [Decide which rules count](rules.md) · [Let a local model review your code](ai-review.md)
- **Manager or exec:** [See where every repository stands](overview.md) · [Share status as reports and PDFs](reports.md)

The same tours are on the website at [bpmforge.com/repopulse](https://bpmforge.com/repopulse#roles). To install RepoPulse yourself, start with [INSTALL.md](../INSTALL.md).
