# Changelog

All notable changes to RepoPulse are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/). The version is the one `deploy/bundle.sh
--version=` stamps into every image name, the tarball and `VERSION`; it is also what
`GET /api/v1/about` reports and what the About page's published accuracy is pinned to.

The release procedure is in [docs/RELEASE.md](docs/RELEASE.md).

## [Unreleased]

## [0.2.0] — 2026-11-02

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
- **Apache-2.0 licence.** RepoPulse is licensed under the Apache License 2.0: `LICENSE`,
  `NOTICE` and `THIRD_PARTY_NOTICES.md` at the root, copied into every image
  (`/usr/share/doc/repopulse/`) and every install bundle; a written source offer for the
  GPL/LGPL scanners in the scan image; our own rules labelled Apache-2.0; gitleaks over the
  full history. (W22-13, W23-11)
- **Repository AI review tab.** The AI review pass has its own tab beside Security; old
  `/security?ai_path=` and `#ai-review-pass` links redirect. Third-party review bots are
  listed as "Review bots". (W24-04)
- **Starter rule set on by default, slopsquat detection, pattern scanners on every PR push,
  second-model verify in production, tour findings and a green e2e suite.** (W21)
- **The W20 UX programme** (25 tickets): finding lifecycle and triage, saved views and
  repository sets, dashboards with exact date ranges, the AI layer's connections, routing and
  disclosure, install/connect/sign-in, admin, reports, the About page with this release's
  published accuracy, and the remaining polish rounds. (W20-01..25)

### Changed
- **Valkey replaces Redis.** The bundled cache/queue is Valkey 9.0.7 (BSD-3-Clause) instead of
  `redis:7-alpine` (Redis 7.4, RSALv2/SSPLv1), in `deploy/compose.yaml`, the dev compose file
  and the bundle image archive. Existing Redis 7.4 volumes load as they are (sessions and
  report schedules verified across a live upgrade); see RUNBOOK "Redis became Valkey". (W23-11)
- **Settings → Models opens on what is configured.** Once a connection exists the page leads
  with the configured providers; the guided setup and the by-hand form fold together behind
  "Set up another model". (W24-01)
- **Routing** describes the shared model pool once; pooled roles say "Shared pool" with a
  short network mark instead of repeating the egress sentence. (W24-02)
- **Quality per model** is a row per role with a precision/recall column pair per model. (W24-03)
- `docs/CONSTRAINTS.md` C1a: source may exist on disk for the length of one scan **batch**.
- Three migrations: `0065_scan_runs_scope`, `0066_analysis_cache_read_tokens`,
  `0067_ai_pass_incremental`.

### Fixed
- **Clean-machine installs** (from the 2026-10-31 fresh Linux test): `deploy/up.sh` refuses
  Podman/podman-compose below the version floor with a sentence instead of hanging, and ends a
  compose call that never returns with a timeout that names it; `configure.sh` builds the
  migrate image itself in a checkout and writes `deploy/.env` under rootless Podman;
  `scan-db-sync.sh` honours `RUNTIME` and names a missing scan image. (W22-15)
- The Settings → Rules link in the Security tab's coverage map is underlined (axe
  `link-in-text-block`). (W24-05)
- Settings → Models no longer scrolls sideways at phone width: the W24 routing table scrolls
  in its own region. (W23-10)

### Verified for this release (W23-10, 2026-11-02, macOS arm64 with Podman)
- `pnpm lint`, `pnpm typecheck`, `pnpm test` with live Postgres 16 and Valkey 9.0.7:
  5,935 passed, 22 skipped, 0 failed (613 files).
- `pnpm e2e` against the seeded dev stack: see the release notes for the final count; the
  first run found a persona race in the suite, an undecryptable seeded credential and the
  routing overflow above, all fixed.
- Migrations 0065–0067 match the schema (scratch database: every migration applied, then
  `drizzle-kit push`). `pnpm db:generate` itself cannot run: the snapshot chain forks at
  0032/0033 and stops at 0038. Two older differences remain (an FK name from 0051, an
  index from 0054 the schema does not declare); neither changes behaviour.
- Review-quality evals (qwen/qwen3.8-27b): triage 12/12; see docs/MODEL_EVAL.md.
- Benchmark on commit 3a35f24 with opengrep 1.27.1: totals precision 0.778, recall 0.600 (0.1.0:
  0.777 / 0.599). Every public suite unchanged except Juice Shop precision 1.00 → 0.70 (three
  `bpm-perf-includes-in-loop` hits on `String.includes`, a rule false positive).

### Known limitations
- The open-source release-day steps of W22-13 (make `bpmforge/lodestone` and
  `bpmforge/bpm-rulepacks` public, pin a tagged Lodestone release) are not part of this tag.
- Review-quality eval fixtures are four to eight AI-authored cases per role, not reviewed by a
  person; a role's recall moves by one or two cases between runs.

## [0.1.0-rc1] — 2026-10 (install bundle, untagged)

The first customer-hosted install bundle (`repopulse-0.1.0-rc1-<os>-<arch>.tar.gz`, built
with `deploy/bundle.sh`), with the accuracy published on the About page measured on
2026-10-16 (`docs/benchmarks/report.json`). Everything before it is in `docs/STATUS.md`.
