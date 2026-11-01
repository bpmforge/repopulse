# Changelog

All notable changes to RepoPulse are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/). The version is the one `deploy/bundle.sh
--version=` stamps into every image name, the tarball and `VERSION`; it is also what
`GET /api/v1/about` reports and what the About page's published accuracy is pinned to.

The release procedure is in [docs/RELEASE.md](docs/RELEASE.md).

## [Unreleased] — toward 0.2.0

### Added
- **Incremental scanning (W23).** Weekly and manual scans skip when a succeeded run already
  exists for the same commit, tool versions and advisory data (`scan_runs.scope` =
  `full` | `incremental` | `skipped`, `base_run_id`, `data_version`); "Run scans now" is one
  job and one tarball for every snapshot scanner (C1a now reads "one scan batch"); the
  per-file scanners (`code_health_tools`, `semgrep`) scan only files changed since their
  last full run and carry the rest of their findings forward; `dependency_cve` re-matches the
  stored SBOM when only the advisory data changed; `container_image` and
  `architecture_register` skip on unchanged inputs; per-runner probes make every scanner
  honest about what it would re-read. The Security coverage table shows scope, "last full"
  and a **Full rescan** control; `POST /repos/:id/scan` takes `force` and answers
  `up_to_date`. (W23-01..05, 08, 09)
- **Forge port:** `compareCommits` and `getCommitTreeSha` for GitHub, Gitea and GitLab
  (GitLab tree sha returns null). (W23-03)
- **Tier-2/3 prompts split into a static, cacheable prefix and a per-chunk body**; cache-read
  tokens are recorded per call and shown as a cache-hit rate on Settings → Models. (W23-06)
- **Incremental PR re-review:** a new push reviews only the hunks changed since the prior
  reviewed head; findings whose quoted lines survive are carried forward, the rest closed as
  `outdated_diff`. (W23-07)
- **Open-source preparation:** Apache-2.0 LICENSE and NOTICE, THIRD_PARTY_NOTICES, gitleaks
  over the full history, clean-machine install fixes from the 2026-10-31 fresh Linux test.
  (W22-13 in progress, W22-15)
- **Starter rule set on by default, slopsquat detection, pattern scanners on every PR push,
  second-model verify in production, tour findings and a green e2e suite.** (W21)
- **The W20 UX programme** (25 tickets): finding lifecycle and triage, saved views and
  repository sets, dashboards with exact date ranges, the AI layer's connections, routing and
  disclosure, install/connect/sign-in, admin, reports, the About page with this release's
  published accuracy, and the remaining polish rounds. (W20-01..25)

### Changed
- `docs/CONSTRAINTS.md` C1a: source may exist on disk for the length of one scan **batch**.
- Three migrations: `0065_scan_runs_scope`, `0066_analysis_cache_read_tokens`,
  `0067_ai_pass_incremental`.

### Not yet done for 0.2.0
- The published accuracy on the About page (`apps/web/src/about/release-accuracy.json`) is
  still the 0.1.0 measurement of 2026-10-16; the benchmark must be re-run on the release
  commit before the version moves (the About test enforces this).
- The release-day steps of W22-13 (make `bpmforge/lodestone` and `bpmforge/bpm-rulepacks`
  public, pin a tagged Lodestone release — W22-01 — record licence/visibility/tag per repo).
- Live-infra `pnpm test`, the W19-05 review-quality evals (prompt order changed in W23-06)
  and `pnpm e2e` have not been run on the W23 merge; GitHub Actions on this private repo
  does not start runners (see docs/STATUS.md 2026-11-01).

## [0.1.0-rc1] — 2026-10 (install bundle, untagged)

The first customer-hosted install bundle (`repopulse-0.1.0-rc1-<os>-<arch>.tar.gz`, built
with `deploy/bundle.sh`), with the accuracy published on the About page measured on
2026-10-16 (`docs/benchmarks/report.json`). Everything before it is in `docs/STATUS.md`.
