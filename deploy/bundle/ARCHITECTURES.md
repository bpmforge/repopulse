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
| linux/amd64 | any | **untested** | No amd64 build host was available. Cross-building under emulation was not attempted; the Dockerfile has no arch-specific steps known to us, but that is a reading, not a result. Build on an amd64 host with `deploy/bundle.sh` and add the row here from its smoke. |
| linux/arm64 | docker (any) | **untested** | No docker on the build host. `install.sh`, `up.sh` and `scan-runner` carry docker code paths (`RUNTIME=docker`, `/var/run/docker.sock`, docker argv for scans) that are unit-tested only. |
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
| `docker.io/library/redis:7-alpine` | queue (same note) |

## Adding a row

Build on the target host (`deploy/bundle.sh --version=<v>` in the source
repository), copy the tarball to a machine **without** the repository, run the
smoke in `docs/work/product-completion/evidence/w17-28-bundle-smoke-*.md`,
and move the row from *Untested* to *Tested* with a link to the evidence.
A row without evidence does not move.
