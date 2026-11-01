# Releasing RepoPulse

How a version gets cut. Every step below exists because something in the repository
enforces it; the enforcing file is named so the step is never done from memory.

## What a version is

- The string passed to `deploy/bundle.sh --version=<X.Y.Z>`. It goes into every image name,
  the tarball name, `VERSION`, `manifest.json`, `REPOPULSE_VERSION` in `deploy/.env`
  (`deploy/up.sh` refuses a version whose images are not loaded) and `DOCS_REF=v<X.Y.Z>`
  for in-app help links.
- The `version` field of the root `package.json` and the ten workspace `package.json`
  files, kept identical. `GET /api/v1/about` reports `REPOPULSE_VERSION` when set, else the
  package version (`apps/api/src/lib/release.ts`).
- The `release` field of `apps/web/src/about/release-accuracy.json`.
  `apps/web/src/about/accuracy.test.ts` fails when it differs from the web package version
  or when any number differs from `docs/benchmarks/report.json` — so a version bump without a
  fresh benchmark is a red suite, by design.
- A git tag `v<X.Y.Z>` on `main`, pushed to both remotes, plus a GitHub release carrying the
  bundle tarballs and their `.sha256` files.

## Checklist

1. **Board and docs.** Every ticket in the release is `done` in `plan.json`;
   `node scripts/validate-plan.mjs && node scripts/validate-traceability.mjs` pass;
   `docs/STATUS.md` has the wave entry; `CHANGELOG.md` has the version and date.
2. **Full gate on `main` with live infra** (CLAUDE.md law 3): dev stack up, then
   `pnpm lint && pnpm typecheck && pnpm test` — the ~1,000 DB/Redis-gated tests only run
   here; GitHub Actions on this private repository does not currently start runners.
   `pnpm db:generate` must show no drift against the committed migrations.
   `pnpm e2e` against the seeded stack.
3. **Review-quality evals** (`docs/MODEL_EVAL.md`, `docs/TRIAGE_EVAL.md`, W19-05) whenever a
   prompt changed since the last release. 0.2.0: yes — W23-06 moved the required-JSON block
   ahead of the PR context.
4. **Benchmark the release commit.** `pnpm --filter @repopulse/security bench:prepare-owasp`,
   `bench:prepare-juliet` (network to GitHub and NIST), then `bench` with opengrep installed;
   commit the regenerated `docs/benchmarks/report.{json,md}` and copy the rows into
   `apps/web/src/about/release-accuracy.json` with `release` set to the new version,
   `measured.commit` to the release commit, and the tool versions used. The About test is the
   check.
5. **Bump the version** in the root and all ten workspace `package.json` files and in
   `README.md` (the bundle file names). Commit `chore(release): vX.Y.Z`.
6. **Build the bundles** on a host with Podman: `deploy/bundle.sh --version=X.Y.Z` once per
   architecture (`--arch=arm64`, `--arch=amd64`); smoke each with its own `install.sh` on a
   clean machine (W22-15 is the record of the last such test); `deploy/smoke-report-pdf.sh`.
7. **Tag and publish.** `git tag -a vX.Y.Z -F <release notes>`; `git push origin main --tags
   && git push github main --tags`; GitHub release from the tag with the tarballs and
   `.sha256` files attached; the bundle `README.md` tells customers nothing is downloaded from
   anywhere else.
8. **Open-source release day only (W22-13):** make `bpmforge/lodestone` and
   `bpmforge/bpm-rulepacks` public together with RepoPulse; pin a tagged Lodestone release
   (W22-01); resolve the open licence items in the W22-13 notes (Redis image licence,
   source-offer wording for GPL/LGPL tools in the scan image, `UNLICENSED-REPOPULSE`
   provenance values); record each repository's licence, visibility and tag in `docs/STATUS.md`.
9. **Dogfood upgrade** on `repopulse.bpmforge.com` per `docs/DEPLOYMENT.md` (set
   `REPOPULSE_VERSION` and `SCAN_IMAGE`, `./install.sh`, verify, roll back if needed).

## Where 0.2.0 stands (2026-11-01)

Done: steps 1 (W23 wave closed; CHANGELOG written) and the offline half of step 2
(tsc, eslint, vitest with DB-gated files skipped: 4,631 tests, 0 failed).
Open: live-infra gate, evals, benchmark, version bump, bundles, tag, and the release-day
steps. These are tracked as ticket W23-10.
