# Changelog

All notable changes to RepoPulse are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow
[Semantic Versioning](https://semver.org/). The version is the one `deploy/bundle.sh
--version=` stamps into every image name, the tarball and `VERSION`; it is also what
`GET /api/v1/about` reports and what the About page's published accuracy is pinned to.

The release procedure is in [docs/RELEASE.md](docs/RELEASE.md).

## [Unreleased]

## [0.3.0] — 2026-11-19

### Added
- **AI first look after the first scan (W25, W27-05..12).** When a repository's first scan
  finishes and a model is configured, a short review reads the strongest-signal production
  files and raises findings by area (security, code health, performance, best practices, AI
  slop, test coverage). It runs as a small fixed number of model calls
  (`FIRST_LOOK_CALLS`), security first, and no longer waits behind the CVE checks.
- **AI review findings on the pull request page (W27-36).** Findings from an AI review of a
  pull request are stored against that pull request and listed under "New on this PR". Rows
  that no second model has confirmed carry a "not in CI" badge and do not fail a CI check;
  `repopulse check --include-unconfirmed-ai` (API: `include_unconfirmed_ai=true`) counts them.
- **The pull request page shows its files and size (W27-37).** The PR scan now stores the
  changed-file list, so the page shows files, churn and a size label.
- **A reasoning setting for pull request and folder reviews (W27-26).**
- **Settings for AI depth and speed (W27-16):** `AI_JUDGE_REASONING`,
  `FIRST_LOOK_QUICK_REASONING`, `FIRST_LOOK_CALLS`. Defaults are unchanged.
- **Rules, all starting in shadow:** `bpm-go-open-redirect` (Go), `slop.undeclared_package`
  and `bpm-perf-sql-call-in-loop` (W27-17, W27-21); gitleaks' rule set imported as shadow
  candidates for the secrets scanner (W22-07).
- **Code map on Lodestone, names and lines only (W22-01 slice 1).** Migration 0068.
- **Findings list sorts by any column (W26-05);** finding page diff in Unified, Split and
  Patch views; grouped Repository and Settings tabs; a UI polish pass over the shell and shared
  components (W26-01..04).
- **Screenshot tours** in `docs/tour/`: eleven tours, one per job, including the AI review and
  pull request tours.
- **docs/INSTALL.md "Which model: fast or private"** with measured times for a local 27B model
  and a small hosted model.

### Changed
- **Only pertinent code is reviewed (W25-16, W27-01).** Tests, fixtures, generated and vendored
  code are skipped by code health, anti-slop and every AI step, and do not count toward
  findings or scores. The secrets scan still covers them.
- **A repository AI pass re-reads only changed files (W25-07).** Files are tracked by sha-256
  (migration 0069); "Full review" forces a full pass.
- **Each AI area reads only its own kind of code, at function level (W27-07, W27-08).**
- **CVE checks never re-ask for the same advisory and package, and use no reasoning; triage,
  judge and second opinions keep it (W27-03, W27-06).** Verdicts are short everywhere.
- **Anti-slop judgement runs after the scan, with memory of earlier verdicts (W27-02,
  migration 0070);** rule findings are kept when a model call fails (W25-20). The scanner reads
  up to 20,000 files and says why when partial (W25-08).
- **First look ranking (W25-09, W27-12, W27-33, W27-34):** production source before tests,
  fixtures, constants, migrations and seed or dev tooling; large files no longer crowd out the
  rest of the budget.
- **zod 4 (W27-38).** zod ^4.6.7 with `fastify-type-provider-zod` ^7. No API change intended.

### Fixed
- Cancelling an AI pass or judge run aborts its in-flight model call (W25-06).
- A reply that contains only reasoning no longer fails a review (W25-18).
- A busy model makes a pass wait instead of fail; scan rows report what really ran (W25).
- Report health matches the dashboard; pass run time is shown (W27-13).
- `POST /repos/:id/sync` (API) works again (W27-18).
- Gitea pull request patches come from the `.diff` endpoint; rule findings on a pull request
  carry its id (W27-19, W27-20).
- `child-process-concat` needs a `child_process` receiver; `includes-in-loop` skips receivers
  typed string (W27-14, W21-20).
- An empty catch with a reason comment is not a finding.
- The Gitea token instructions list `read:issue` (W25-10).
- The supply-chain register keeps its row (W25-08).
- Pull requests: one brought in by Sync now or the nightly reconcile gets its scan; a second
  push updates the stored head commit; a run closes the findings the pull request introduced
  and then fixed (W27-23, W27-24, W27-29, W27-30).
- AI passes left behind by a stopped worker are closed or queued again at boot (W27-22).
- Fix drafts: a context line without its leading space, and a JSON answer inside a code
  fence, are both read (W27-25, W27-28).
- The worker log says why no AI review was queued when only an admin can change it (W27-31).

### Security
- Dependency advisories cleared: `pnpm audit` reports none. zod 3 → 4 (GHSA-mrhx-c7xc-m3w5,
  High), vite and vitest patch releases, and overrides for fast-uri, seroval, minimatch and
  glob (W27-15, W27-38).

### Known limitations
- With the Claude Code CLI backend, the API container cannot run the CLI the worker runs, so
  Settings shows a false "containers disagree" and Test connection cannot pass (W27-27).
- A hosted model needs two separate opt-ins, for the review and for the CVE second opinion,
  and a refusal shows only in the worker log (W27-32).
- `repopulse check` needs the full commit id (W27-35).
- The accuracy benchmark measures the rule-based checks only; there is no accuracy figure for
  the AI layer yet.

### Upgrading from 0.2.0
- Migrations 0068 to 0070 apply on start. No configuration change is required.

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
- The About page names the licence (Apache License 2.0) and links the third-party notices.
  (W23-10)
- Agreement Delete/Cancel buttons meet the 24px minimum target size (WCAG 2.5.8). (W23-10)
- Install bundles built on macOS no longer carry macOS extended attributes, which made GNU tar
  print an "unknown extended header keyword" warning per file on extraction. (W23-10)
- The amd64 scan image builds again under emulation: the helm/kustomize self-check is skipped
  on a cross-build (the binaries are still checksum-verified). (W23-10)

### Verified for this release (W23-10, 2026-11-02, macOS arm64 with Podman)
- `pnpm lint`, `pnpm typecheck`, `pnpm test` with live Postgres 16 and Valkey 9.0.7:
  5,936 passed, 22 skipped, 0 failed (613 files).
- `pnpm e2e` against the seeded dev stack: 164 passed, 17 skipped, 0 failed. The first run
  (152 passed, 11 failed) found a persona race in the suite, an undecryptable seeded
  credential, two wrong expectations in the new scan-scope spec and the routing overflow
  above, all fixed.
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
