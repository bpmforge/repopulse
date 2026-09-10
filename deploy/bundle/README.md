# RepoPulse — portable install bundle

This directory is a complete, offline install of one RepoPulse version. It
contains the container images, the compose file and the scripts that run
them. It needs **a container runtime and nothing else**: no source checkout,
no Node, no pnpm, no registry account, no network access at install time.

What you need on the host:

- Podman 5+ with `podman-compose`, or Docker 24+ with the compose plugin
- the CPU architecture named in `VERSION` (`PLATFORM=`); `install.sh` checks
  this and refuses a mismatch. See `ARCHITECTURES.md` for what has actually
  been built and tested.
- about 4 GB of disk for images, plus room for your data
- a hostname your users will open, and your own TLS terminator in front
  (RepoPulse binds to 127.0.0.1 by default and does not terminate TLS)

## Install

```bash
# On the machine you copied the tarball to:
shasum -a 256 -c repopulse-<version>-<os>-<arch>.tar.gz.sha256   # or sha256sum -c
tar -xzf repopulse-<version>-<os>-<arch>.tar.gz
cd repopulse-<version>-<os>-<arch>
./install.sh --url=https://repopulse.example.com --admin-email=you@example.com
```

`install.sh` verifies every file against `SHA256SUMS`, checks the
architecture, loads the images, writes `deploy/.env` with every secret
generated, then runs `deploy/up.sh`, which starts the stack and **verifies
each service is running and healthy** before it reports success. If anything
is not, it exits non-zero and names the service and the log command. Do not
take a loading page as proof: the web tier can answer while the worker is
dead, which is exactly why `up.sh` checks.

The first administrator's password comes from `ADMIN_PASSWORD` in the
environment or a `deploy/admin-password` file — never from an argument, so it
does not land in shell history. You must change it at first sign-in.

```bash
ADMIN_PASSWORD='a long passphrase' ./install.sh --url=... --admin-email=...
```

Then open the URL. Connecting a forge (GitHub App or Gitea token) is done
from inside the product after you sign in.

## What is where

| Path | What it is |
|---|---|
| `VERSION` | the version tag, image prefix, platform and source commit |
| `manifest.json` | every image by name, id and digest, plus the build host and runtime |
| `SHA256SUMS` | checksum of every file here except itself |
| `images/repopulse-images.tar` | one archive: `migrate`, `api`, `worker`, `scan-runner`, `web`, `scan`, and the `postgres:16` and `redis:7-alpine` they were tested with |
| `deploy/compose.yaml` | the stack; identical to the source repository's except no `build:` stanzas |
| `deploy/.env` | written by `install.sh`; **back it up** — `TOKEN_ENC_KEY` decrypts stored forge credentials |
| `deploy/scan-rules/` | rulepacks for code scanning, pre-installed; `deploy/scan-db-sync.sh` refreshes them and fetches the vulnerability database |

Images are named `localhost/repopulse/<name>:<version>`. No registry is
involved; `localhost/` is the runtime's name for "loaded here".

## Day-to-day

```bash
deploy/up.sh                      # start (or restart) and verify — safe to rerun
podman compose -f deploy/compose.yaml down     # stop; data stays in the volumes
deploy/backup.sh                  # dump the database to a file
deploy/restore.sh <dump>          # restore it
deploy/scan-db-sync.sh            # refresh scan rules + fetch the CVE database (nightly cron)
```

Data lives in two named volumes, `repopulse_pgdata` and `repopulse_redisdata`.
`down` keeps them; only `down -v` deletes them.

Dependency (CVE) scanning needs the grype database, which is **not** in the
bundle — it aggregates 26 upstream feeds on their own terms, so your install
fetches it directly. Run `deploy/scan-db-sync.sh` once the stack is up
(needs outbound HTTPS to grype.anchore.io and ~5 GB under
`deploy/scan-rules`). Until then the Security tab says the scanner is
unavailable rather than pretending a clean result.

## Upgrading

1. Extract the new bundle **beside** the old one, do not overwrite it.
2. Copy `deploy/.env` from the old directory into the new one.
3. In the new `deploy/.env`, set `REPOPULSE_VERSION` and `SCAN_IMAGE` to the
   new version (the last three lines of the file; `install.sh` tells you if
   they disagree with the bundle).
4. `./install.sh` in the new directory. Migrations run once, before the API
   starts; the data volumes are shared by compose project name, so nothing is
   copied.
5. To roll back: `deploy/up.sh` from the old directory. Its `.env` still pins
   the old version and the old images are still loaded.

## Troubleshooting

- **`CHECKSUM MISMATCH`** — the tarball was truncated or altered in transit.
  Re-copy it and check `.tar.gz.sha256` before extracting.
- **`ARCHITECTURE MISMATCH`** — this bundle's images are for another CPU.
  There is one bundle per architecture; see `ARCHITECTURES.md`.
- **`image ... is not present`** from `up.sh` — the images were not loaded
  under the name `.env` pins. Run `./install.sh` again; it reloads them.
- **`STACK IS NOT HEALTHY`** — `up.sh` names the services that did not come
  up and prints the `logs` command. `scan-runner` not running on Linux
  almost always means the podman API socket is not enabled:
  `systemctl --user enable --now podman.socket`.
- **`DATABASE MIGRATION FAILED`** — the schema was not applied and nothing
  was started against it. The log command it prints has the reason.
- **Scans report "unavailable"** — the `scan-runner` service cannot reach the
  runtime socket, or the scan image is missing. `podman logs` on it says which.
