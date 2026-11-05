# Third-party notices

Repo Pulse itself is licensed under the Apache License 2.0 (`LICENSE`). This file
lists the third-party material that is either **in this repository** or **built
into the container images** this repository produces, with the licence each one
is under. It is an inventory, not legal advice.

Checked 2026-10-31 against `main` (`ac4a2752`); Redis replaced by Valkey 2026-11-02. Re-check when a pinned version in
`Dockerfile`, `Containerfile.scan`, `deploy/scan-tools/`, the checkov
requirements or the rule-pack ledger changes.

## 1. In this repository

| What | Where | Licence | Notes |
|---|---|---|---|
| 0xdea/semgrep-rules (49 files) | `packages/security/rulepacks/third-party/0xdea/` | MIT | Verbatim, pinned by commit in `LEDGER.json` |
| elttam/semgrep-rules (60 files) | `packages/security/rulepacks/third-party/elttam/` | MIT | Verbatim, pinned by commit |
| GitLab sast-rules (270 files) | `packages/security/rulepacks/third-party/gitlab/` | 244 MIT, 26 Apache-2.0 (gosec-derived `go/` rules) | Imported by per-file `License:` header; the GPL, LGPL, Commons Clause and GitLab EE folders are excluded |
| bpmforge/bpm-rulepacks (219 files) | `packages/security/rulepacks/third-party/bpm-rulepacks/` | MIT | The owner's own rules |
| gitleaks default config (`config/gitleaks.toml`, 222 secrets rules) | `packages/security/rulepacks/third-party/gitleaks/` | MIT (Zachary Rice) | Verbatim, pinned by commit; read by the secrets scanner, not Opengrep |
| OWASP Juice Shop excerpts | `packages/security/fixtures/benchmark/juice-shop/` | MIT | Benchmark fixture, LICENSE kept beside it |
| SampleCo (from bpmforge/slop-scorecard) | `packages/security/fixtures/benchmark/sampleco/` | MIT | The owner's own code |
| jwt-go (vendored in two fixtures) | `packages/security/fixtures/dependency/go-*/vendor/` | MIT | Test fixture for the reachability scanner |
| CycloneDX 1.7, cryptography-defs and JSF 0.82 JSON schemas | `packages/security/src/vex/schemas/` | Apache-2.0 | Published by the CycloneDX project |
| OpenVEX JSON schema | `packages/security/src/vex/schemas/openvex_json_schema.json` | Apache-2.0 | Published by the OpenVEX project |
| SPDX licence-id JSON schema (CycloneDX's `spdx.schema.json`, an enum of SPDX identifiers) | `packages/security/src/vex/schemas/spdx.schema.json` | Apache-2.0 | Published by the CycloneDX project (its `$id` is cyclonedx.org/schema/spdx.schema.json); the identifiers are SPDX's list |

**Not in this repository on purpose.** OWASP Benchmark (GPL-2.0) and the NIST
Juliet suite are fetched at benchmark-prep time into a gitignored cache; only our
own label files (`suite.json`) are committed. The Semgrep registry rules, the
Opengrep rules repository (Commons Clause), Trail of Bits rules (AGPL-3.0) and
TruffleHog's detectors (AGPL-3.0) are not used.

## 2. npm dependencies

Production dependencies of the workspace (`pnpm licenses list --prod`, 145
packages): MIT 120, Apache-2.0 10, ISC 6, BSD-3-Clause 4, Unlicense 3,
BSD-2-Clause 1, 0BSD 1. No copyleft licences.

Development-only dependencies also include MPL-2.0 (axe-core,
@axe-core/playwright, lightningcss), CC-BY-4.0 (caniuse-lite data),
BlueOak-1.0.0 (minimatch), Python-2.0 (argparse) and MIT-0. None of these
ship in the images.

The scan image's Node tools (`deploy/scan-tools/package-lock.json`: jscpd 4.3.0,
dependency-cruiser 17.4.3 and their dependencies, 155 packages in all) are MIT, ISC, Apache-2.0,
and one `(WTFPL OR MIT)` (spark-md5).

## 3. Built into the container images

These are downloaded and pinned (by version and checksum) when an image is
built. They are not in the git repository. Repo Pulse runs each as a separate
program, so their licences do not extend to Repo Pulse's own code. Every image
carries this file, `LICENSE` and `NOTICE` (under `/app/` in the application
images, `/usr/share/doc/repopulse/` in the web and scan images), and so does
every bundle.

**Source for the copyleft components.** Opengrep (LGPL-2.1), ShellCheck,
hadolint and Cppcheck (GPL-3.0) are used unmodified, at exactly the versions
listed below. The complete corresponding source of each is the upstream release
of that version, published at the repository named in the table. We also offer,
for at least three years from the date we distribute an image or bundle that
contains them, to provide a copy of that source on request, at no charge beyond
the cost of delivery. Ask by opening an issue on the Repo Pulse repository. The
same applies to the GPL and LGPL packages in the Alpine and Debian base layers,
whose source is published by those distributions for the base versions named
here.

### Scan image (`Containerfile.scan`)

| Tool | Version | Licence | Source |
|---|---|---|---|
| Opengrep | 1.27.1 | **LGPL-2.1** | github.com/opengrep/opengrep |
| ShellCheck | 0.11.0 | **GPL-3.0** | github.com/koalaman/shellcheck |
| hadolint | 2.15.1 | **GPL-3.0** | github.com/hadolint/hadolint |
| Cppcheck | 2.22.0 | **GPL-3.0-or-later** | github.com/danmar/cppcheck (built from the release tarball) |
| actionlint | 1.7.12 | MIT | github.com/rhysd/actionlint |
| Ruff | 0.16.3 | MIT | github.com/astral-sh/ruff |
| Biome | 2.5.9 | MIT OR Apache-2.0 | github.com/biomejs/biome |
| Lizard | 1.24.0 | MIT | github.com/terryyin/lizard |
| Pygments | 2.21.0 | BSD-2-Clause | github.com/pygments/pygments |
| grimp | 3.15 | BSD-2-Clause | github.com/python-grimp/grimp |
| Syft | 1.51.0 | Apache-2.0 | github.com/anchore/syft |
| Grype | 0.117.0 | Apache-2.0 | github.com/anchore/grype |
| Helm | 3.16.4 | Apache-2.0 | github.com/helm/helm |
| Kustomize | 5.5.0 | Apache-2.0 | github.com/kubernetes-sigs/kustomize |
| Checkov | 3.3.29 | Apache-2.0 | github.com/bridgecrewio/checkov |
| Checkov's 95 Python dependencies | pinned in `packages/security/sandbox/checkov-requirements.txt` | MIT, BSD, Apache-2.0, PSF, ISC-style; MPL-2.0 for certifi, tqdm (dual MIT) and orjson (dual Apache/MIT) | PyPI |
| Alpine Linux 3.20 base packages (busybox, musl, python3, nodejs and others) | 3.20 | Mixed, including GPL-2.0 (busybox) | Alpine package sources |

### Application images (`Dockerfile`)

| Component | Licence |
|---|---|
| Node.js 22 (`node:22.23.1-alpine`, `-bookworm-slim`) | MIT (bundles OpenSSL Apache-2.0, ICU and others) |
| tsx 4.23.1 | MIT |
| Playwright and its Chromium headless shell (worker, report PDFs) | Apache-2.0; Chromium BSD-3-Clause plus its bundled third-party licences |
| Debian bookworm packages installed for Chromium | Mixed, including GPL and LGPL libraries |
| nginx 1.27 (web image) | BSD-2-Clause |
| podman-remote, docker-cli (scan-runner image) | Apache-2.0 |

### Images the bundle carries as-is (`deploy/bundle.sh`)

| Image | Licence | Note |
|---|---|---|
| `postgres:16` | PostgreSQL Licence | Permissive |
| `valkey/valkey:9.0.7-alpine` | BSD-3-Clause | Runs as the `redis` service. Replaced `redis:7-alpine` (W22-13), which had become Redis 7.4, licensed RSALv2 / SSPLv1 and not open source |

### Data fetched at run time, never bundled

The vulnerability database Grype downloads, OSV, CISA KEV and EPSS are fetched by
the customer's own install (`deploy/scan-db-sync.sh`) and are under their own
terms; `docs/INSTALL.md` describes them.
