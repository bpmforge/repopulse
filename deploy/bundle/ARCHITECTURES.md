# Supported CPU architectures and runtimes

This file is written from **actual build and smoke results**, not from what
ought to work. A row is "tested" only when a bundle was built, extracted on a
host without the source repository, installed with `install.sh`, answered on
its published port, and kept its data across a restart. Everything else is
listed as untested so nobody infers support that was never demonstrated.

One bundle holds images for one architecture, named in `VERSION`
(`PLATFORM=`). `install.sh` refuses to load a bundle onto a different one.

## Tested

| Platform | Runtime | Host | Result | Evidence |
|---|---|---|---|---|
| linux/arm64 | podman 5.8.2 (rootless, Fedora CoreOS VM via podman machine applehv), client podman 6.1.0 on macOS 26 / Apple M2 Max, podman-compose 1.6 | build **and** smoke | built, extracted outside the repo, installed, `/healthz` 200 through the web proxy, data persisted across `down`/`up` | `docs/work/product-completion/evidence/w17-28-bundle-smoke-20260910.md` in the source repository |

## Untested — do not infer

| Platform | Runtime | Status | Why |
|---|---|---|---|
| linux/amd64 | podman, **under qemu-user emulation only** | **built + emulated smoke; no real amd64 host yet** | 2026-09-23, commit 39439c8: `deploy/bundle.sh --arch=amd64` cross-built all six images on the arm64 host above (the SPA assets build on the build platform — esbuild aborts under qemu). `install.sh` (with the `REPOPULSE_ALLOW_EMULATED_ARCH=1` test hatch) loaded them, ran migrations, and the stack answered `/healthz` 200, admin sign-in, forced password change and `/setup/status` 200, with api, worker, web, migrate and postgres all amd64. **Deviation:** upstream `redis:7-alpine` for amd64 segfaults under qemu-user, so the native arm64 redis was substituted. Not tested: a restart/persistence cycle, scans, and any real amd64 CPU. Evidence: `docs/work/product-completion/evidence/v1-selfhost-20260923/amd64-smoke-final.log` in the source repository. Run the same smoke on a real amd64 host (W11-05) before calling it tested. |
| any | docker (any) | **untested** | No docker on the build host (2026-09-23: still no docker, colima, nerdctl or lima on it). `install.sh`, `up.sh` and `scan-runner` carry docker code paths (`RUNTIME=docker`, `/var/run/docker.sock`, docker argv for scans) that are unit-tested only. |
| linux/arm64 | rootful podman | **untested** | Only rootless podman was exercised. `up.sh` derives the root socket path (`/run/podman/podman.sock`) but nothing ran against it. |
| any | SELinux-enforcing hosts (Fedora, RHEL) | **partially** | The podman machine VM is Fedora CoreOS with SELinux, so the `label=disable` on scan-runner and `:z` on the scratch volume were exercised there. A bare-metal enforcing host was not. |
| any | Windows / WSL2 | **untested** | Never attempted. Bind mounts under WSL2 (`SCAN_RULES_DIR`) and the podman socket path are the known unknowns. |
| linux/arm64 | podman < 5, docker < 24 | **untested** | Older compose providers differ in label and `depends_on` handling that `up.sh` relies on. |

## Base images inside the archive

Recorded per bundle in `manifest.json` with the digest that was saved.

| Image | Role |
|---|---|
| `node:22.23.1-alpine` | api, worker, migrate, scan-runner |
| `nginx:1.27-alpine` | web |
| `alpine:3.20` | scan sandbox |
| `docker.io/library/postgres:16` | database (floating upstream tag; the digest in `manifest.json` is what you got) |
| `docker.io/valkey/valkey:9.0.7-alpine` | queue, as the `redis` service (same note). Replaced `redis:7-alpine` on 2026-11-02 (W22-13); the amd64 emulated smoke above predates it |

## Adding a row

Build on the target host (`deploy/bundle.sh --version=<v>` in the source
repository), copy the tarball to a machine **without** the repository, run the
smoke in `docs/work/product-completion/evidence/w17-28-bundle-smoke-*.md`,
and move the row from *Untested* to *Tested* with a link to the evidence.
A row without evidence does not move.
