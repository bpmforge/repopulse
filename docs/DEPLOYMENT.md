# RepoPulse — Deployment reference (customer-hosted)

What a RepoPulse install looks like on your host: the containers, what they
may reach, what is published, how secrets and migrations are handled, and what
to watch. The step-by-step install is [INSTALL.md](INSTALL.md); the operating
procedures are [RUNBOOK.md](RUNBOOK.md); every variable is in
[CONFIG.md](CONFIG.md).

Everything here was exercised on **linux/arm64 under rootless Podman 5.8 with
podman-compose 1.6**. Docker, amd64, rootful Podman and Windows/WSL2 are
untested; the scripts carry Docker code paths that are unit-tested against a
stub only. The bundle's `ARCHITECTURES.md` is the authoritative list and a row
moves from untested to tested only with a recorded run.

## 1. Images

Six images, built from this repository's `Dockerfile` targets and
`Containerfile.scan`, named `localhost/repopulse/<name>:<version>`:

| Image | Contents | Runs |
|---|---|---|
| `migrate` | the API build | one-shot: applies Drizzle migrations, then exits |
| `api` | Fastify: `/api/v1`, the events stream, auth, the webhook receiver | long-running |
| `worker` | BullMQ consumers: ingest, metrics, analysis, reports, scheduled sweeps | long-running |
| `scan-runner` | the one container that holds the runtime socket; launches scan containers for the worker | long-running |
| `web` | the Vite build served by nginx, which also proxies `/api` and `/healthz` to `api` | long-running; the only published port |
| `scan` | opengrep, lizard, jscpd, dependency-cruiser, syft, grype — pinned by version and checksum | per scan, `--network=none`, deleted afterwards |

Plus `docker.io/library/postgres:16` and `docker.io/valkey/valkey:9.0.7-alpine` (Valkey, the BSD-3-Clause Redis fork, running as the `redis` service), saved into the
bundle with the digests that were tested.

`localhost/` is the runtime's name for "loaded here". **No image is published
to any registry.** A bundle is built with `deploy/bundle.sh --version=<tag>`
and carried to the host; `install.sh` loads it. `dev` and `latest` are refused
as versions, and `up.sh` refuses to start pre-built images whose pinned
version is not loaded.

## 2. Compose layout

`deploy/compose.yaml` is the stack; the bundle ships the same file with the
`build:` stanzas removed. Services `postgres`, `redis`, `migrate`, `api`,
`worker`, `scan-runner` and `web` sit on one internal network, with a second
internal `scan` network between `worker` and `scan-runner`.

- **Published:** one port, `web`, at `${REPOPULSE_BIND:-127.0.0.1}:${REPOPULSE_PORT:-8099}`.
  It binds to loopback until you set `REPOPULSE_BIND=0.0.0.0`, which you do
  only behind your own TLS terminator.
- **Not published:** Postgres, Redis, the API, the worker and the scan-runner.
  The API is reached only through nginx in `web`.
- **Volumes:** `<project>_pgdata`, `<project>_redisdata` (durable),
  `<project>_reportdata` (durable: generated report PDFs and their data,
  mounted at `/app/.data` in both api and worker, not in `backup.sh`),
  `<project>_scan-scratch` (a tmpfs-backed scratch for one snapshot at a time,
  `SCAN_SCRATCH_SIZE`, default 2 GB). The compose project defaults to
  `repopulse`; `REPOPULSE_PROJECT` changes it, which is how a disposable copy
  for a restore test shares nothing with the live install.
- **Bind mount:** `SCAN_RULES_DIR` (default `deploy/scan-rules` beside the
  compose file) read-only into the worker and from there into every scan
  container. It must be an absolute path if you set it, and it must exist
  before `up` — `deploy/up.sh` creates it.
- **Restart policy** is `unless-stopped`, but on rootless Podman a
  SIGKILLed worker was **not** restarted in the 60 seconds the drill watched.
  Recovery is `deploy/up.sh`, not the policy.

The worker scales by replica count in principle (jobs are idempotent and the
API is stateless with sessions in Redis), but only one replica of each was run
in the evidence.

## 3. Secrets and configuration

`deploy/.env` is the only configuration file. `install.sh` (or
`deploy/configure.sh` from a checkout) writes it once with every secret
generated and mode `0600`, and never rewrites it, because rotating
`TOKEN_ENC_KEY` orphans every stored forge credential. Never commit it.

| Variable | Used by | Notes |
|---|---|---|
| `POSTGRES_PASSWORD`, `REDIS_PASSWORD` | data tier | generated; also embedded in the two URLs below |
| `DATABASE_URL`, `REDIS_URL` | api, worker | service hostnames on the internal network (`postgres:5432`, `redis:6379`) |
| `SESSION_SECRET` | api | signs session cookies; changing it logs everyone out |
| `TOKEN_ENC_KEY` | api, worker | AES-256-GCM key for forge credentials at rest. **Back it up separately from the database dump**; a dump without it restores connections that can never authenticate |
| `PUBLIC_BASE_URL`, `API_BASE_URL` | api, web | the URL users open; the OAuth callback and webhook URL are built from them |
| `REPOPULSE_PORT`, `REPOPULSE_BIND` | compose | the one published port and the interface it binds |
| `ADMIN_EMAIL`, `ADMIN_PASSWORD` | api | the bootstrap administrator, created on first boot, forced to change the password at first sign-in. Remove the password line afterwards |
| `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET` | api | optional: adds "Sign in with GitHub". Not used for data access |
| `OIDC_*` | api | optional: single sign-on. A half-configured group fails the boot on purpose |
| `FORGE_BASE_URL` | api, worker | deployment-wide default for a self-hosted forge; each connection can also carry its own |
| `SCAN_RULES_DIR`, `SCAN_SCRATCH_SIZE`, `SCAN_IMAGE`, `SCAN_RUNNER_TOKEN` | worker, scan-runner | scan data directory, scratch size, sandbox image, the shared secret between worker and runner (generated) |
| `REPOPULSE_VERSION`, `REPOPULSE_IMAGE_PREFIX` | compose | pinned by `install.sh`; change `REPOPULSE_VERSION` to roll to another loaded version |
| `DOCS_REF` (Dockerfile build argument) | web image build | the docs tag in-app help links point at; `deploy/bundle.sh` passes `v<version>`, any other build leaves it empty and the links use `main` |
| `NODE_ENV`, `LOG_LEVEL` | all | `production` (secure cookies) / `info` |

Not read by this release, though older templates mention them: `GITHUB_PAT`,
`GITHUB_APP_PRIVATE_KEY`, `WEBHOOK_SECRET` (webhook secrets are generated per
connection and stored encrypted). `LMSTUDIO_*` and `ANTHROPIC_API_KEY` are
superseded by **Settings → Models**, which needs no restart; the `LMSTUDIO_*`
pair is still honoured so an existing install keeps its model on upgrade.

Startup validates the whole matrix and refuses to boot on a missing or
malformed value, naming each one. **Settings → Setup** reports whether each
variable is *set*, never its value.

## 4. Reverse proxy, TLS, webhook ingress

RepoPulse does not terminate TLS. Put nginx, Caddy, Traefik or a cloud load
balancer in front of the published port:

- `/` → the published port, including `/api/` and the server-sent events
  stream at `/api/v1/events` (proxy buffering off, long read timeout).
- **Split exposure if your forge is on the internet.** The forge must reach
  the webhook receiver, so route `POST /api/v1/webhooks/github` (GitHub and
  Gitea) and `POST /api/v1/webhooks/gitlab` (GitLab) on the public vhost and
  everything else only where your users are (LAN, VPN, or an allowlist). The
  GitHub/Gitea receiver authenticates every delivery by an HMAC over the raw
  body with a per-connection secret, GitLab's by the shared token it sends;
  both do nothing but verify and enqueue, and a tampered or unsigned delivery
  is a 401 and a log line. A private
  install that cannot receive webhooks still ingests on the nightly reconcile.
- Add HSTS and the usual security headers at the proxy. Set
  `NODE_ENV=production` (the default the scripts write) so session cookies
  carry the Secure flag.
- `GET /metrics` on the API is **unauthenticated**; network topology is its
  boundary. Do not route it on the public vhost.

## 5. Migrations

The `migrate` service runs before `api` starts and exits; the API waits on it.
It prints what it did — `applied N migration(s)` on a first run, `up to date
(N already applied)` afterwards — so a rerun of `up` is a no-op on an applied
schema. Postgres NOTICE lines in its output are notices, not errors.

If a migration fails, `deploy/up.sh` exits non-zero with `DATABASE MIGRATION
FAILED`, **stops** web, api, worker and scan-runner itself (podman-compose
does not honour `service_completed_successfully`), and leaves the ledger and
data as they were: pending migrations apply in one transaction. Proven by
shipping a deliberately broken migration through the drill.

**Migrations are forward-only.** There is no down-migration. Rolling back is
restoring the pre-upgrade dump, which is why the RUNBOOK's upgrade begins with
a backup.

## 6. Backup and restore

A backup is two things: the Postgres dump and `TOKEN_ENC_KEY`. Redis is not
backed up — sessions re-login, queues rebuild from the warehouse's cursors.

`deploy/backup.sh` writes the dump and a manifest beside it (sha256, row
counts, migration count, and a fingerprint of the key — a prefix of its
sha256, never the key). `deploy/restore.sh` refuses a dump whose sha256 does
not match, a key whose fingerprint does not match, an unspecified target
project, and the live project without `--production`; after loading, it checks
that **every stored forge credential decrypts** and will not start the
application otherwise. The whole sequence, including wrong-key and
broken-migration cases, was run as a 44-check drill
(`scripts/drill-backup-restore.sh`); the record is under
`docs/work/product-completion/evidence/`. Procedures are in
[RUNBOOK.md](RUNBOOK.md).

## 7. Monitoring and health

- `GET /healthz` through the published port: liveness of the API with its
  Postgres and Redis checks. `deploy/up.sh` waits on it and on every service
  before reporting success.
- `GET /metrics` (Prometheus text format, API and worker): HTTP request
  duration by route pattern, forge budget gauges, queue and worker series as
  registered by each subsystem. Internal vhost only, as above.
- **Admin** shows the background worker's heartbeat ("Not working — no worker
  has published a heartbeat in the last minute") and a scan that no worker
  picked up in five minutes says so on the screen. Both were exercised by
  killing the worker in the recorded journey.
- **Settings → Setup** lists sign-in methods, configuration problems, forge
  connection state, selected repositories and the most recent webhook
  delivery.
- The scan-data sync: a `Built:` date under `deploy/scan-rules/vuln-db` that
  stops moving means the nightly cron is not running, and stale vulnerability
  data is quietly wrong rather than loudly broken. Alert on it.
- Structured JSON logs with request ids from every container via
  `podman compose logs`.

Suggested thresholds: `/healthz` failing; no worker heartbeat for more than a
minute; the vulnerability database older than five days (grype refuses it at
that point and the scan reports the age); sync lag over 24 hours on Settings →
Sync.

## 8. Upgrade and rollback

Summary; the tested commands are in [RUNBOOK.md](RUNBOOK.md).

Upgrade from a bundle: extract the new bundle beside the old one, copy
`deploy/.env` across, set `REPOPULSE_VERSION` and `SCAN_IMAGE` to the new
version, run `./install.sh`. The data volumes are shared by compose project
name, so nothing is copied. From a checkout: `backup.sh`, `compose down`,
`up.sh --build`. **`up -d --build` on its own is not an upgrade** on Podman:
it rebuilds images and re-runs migrations while leaving the running containers
untouched.

Rollback: `deploy/up.sh` from the old bundle directory (its `.env` pins the old
version and the old images are still loaded), then restore the pre-upgrade
dump with `--no-migrate`. Data rolls back by restore; code rolls back by
version pin. Both were exercised in the drill, on one image version only, so
the "upgrade" the drill proved is same-version; a real version step with a
pending migration was exercised only in the failure direction.

**Upgrade note - host names are no longer "on your network".** A model server
reached by a *name* (`lmstudio.local`, `models.internal`) used to count as local
for the egress audit even though the host policy had always required an explicit
off-network decision for it. Only IP addresses (loopback and private IPv4) count
now. After upgrading, such a connection is audited like any off-network call,
shown as *leaving* in Settings → Models, and refused by **Local only**. Nothing is
rewritten; to find them:

```sql
select name, base_url, allow_public_host from llm_providers
 where base_url ~* '^https?://[^/]*[a-z][^/:]*(:[0-9]+)?(/|$)'
   and base_url !~* '^https?://(localhost|\[::1\])(:[0-9]+)?(/|$)';
```

(also check `LMSTUDIO_BASE_URLS` in `deploy/.env`, which does not pass through the
host policy). To keep one on your network, give it its machine's IP address in
Settings → Models. If RepoPulse runs in a container, `localhost` is the container
itself - use the host's network address.

Restart the **stack**, not one service: `web` resolves the `api` address once
at startup, so an `api` restarted alone is unreachable through the published
port while every status says running. `compose down` then `deploy/up.sh` is
about ten seconds on a warm image cache.

## 9. Scan sandbox

The scanners run over an ephemeral API tarball of the repository — never a
clone — inside the `scan` image, launched by `scan-runner` on the worker's
behalf. The container may do nothing but read the snapshot and write two
tmpfs mounts:

- `--network=none` — a scan tool with a network is an exfiltration path for
  the source it is reading;
- `--read-only` root, `--cap-drop=ALL`, `--security-opt=no-new-privileges`,
  an unprivileged user, a pids limit;
- the snapshot mounted read-only and `noexec` — a repository is full of
  executable files someone else wrote;
- `/tmp` and any path a scanner declares, each a `noexec,nosuid` tmpfs;
- **no environment at all** — not a filtered copy of the worker's.

Snapshots are extracted into a tmpfs (`SCAN_SCRATCH_SIZE`, default 2 GB), not a
volume, so customer source never reaches a disk that survives a reboot or a
volume backup. Size it for the largest single repository plus headroom;
extraction aborts with `size_cap` rather than filling the mount. The scan
deletes its snapshot in a `finally`, and the worker's orphan sweeper (at boot
and hourly) removes anything a SIGKILL left behind.

`scan-runner` needs the runtime's API socket. On Linux with rootless Podman
that is `systemctl --user enable --now podman.socket`; `up.sh` derives the
socket path and the runner's uid from the runtime that started it. The runner
listens on TCP inside the `scan` network and refuses to start without
`SCAN_RUNNER_TOKEN`, which the worker presents on every request.

### Rulepacks and the vulnerability database

The scan container cannot fetch anything. `deploy/scan-db-sync.sh` runs on
the **host**, nightly, and fills `SCAN_RULES_DIR`:

```
0 3 * * * /opt/repopulse/deploy/scan-db-sync.sh >> /var/log/repopulse-scan-sync.log 2>&1
```

It copies the in-house rulepacks (Semgrep's registry packs are licence-barred
for service use, so ours travel with the code) and writes `rulepacks.sha256`
beside them; then, unless `SCAN_SYNC_VULN_DB=0`, it fetches grype's
vulnerability database into `vuln-db` using the scan image's own pinned grype,
so the fetcher and the reader can never disagree about the format. The host
needs outbound HTTPS to `grype.anchore.io` and **5 GB** under the directory:
the database is about 1.9 GiB and a refresh stages the new copy beside the
live one before renaming. The script checks free space and refuses rather than
filling the disk. A partial sync exits non-zero.

Until the database exists, the dependency scanner reports itself unavailable
on the Security tab and names this script. That is the design: a repository
with no findings must not look like a repository that is clean.

### Updating rulepacks and advisory data between releases (W19-06)

The shipped rulepacks move with the product. To move them **between** releases,
use a signed bundle: one JSON file holding the whole rulepack tree, a SHA-256
per file and an Ed25519 signature. The signature, not the channel, is the trust,
so a bundle can arrive by download, USB stick or email.

```sh
# you, once: trust the publisher's PUBLIC key. Nothing is trusted by default.
mkdir -p "$SCAN_RULES_DIR/rulepack-bundle/trusted-keys"
cp publisher.public.pem "$SCAN_RULES_DIR/rulepack-bundle/trusted-keys/"

# on your own schedule (cron, systemd timer, a CronJob) - or by hand, offline:
node --import tsx packages/security/src/updates/cli.ts install \
  --root "$SCAN_RULES_DIR/rulepack-bundle" --file bundle.json      # offline
node --import tsx packages/security/src/updates/cli.ts install \
  --root "$SCAN_RULES_DIR/rulepack-bundle" --url https://you.example/bundle.json

node ... cli.ts status   --root "$SCAN_RULES_DIR/rulepack-bundle"  # exits 1 if stale (45 days)
node ... cli.ts rollback --root "$SCAN_RULES_DIR/rulepack-bundle"  # previous bundle
node ... cli.ts rollback --root "$SCAN_RULES_DIR/rulepack-bundle" --to-shipped
```

An install refuses, and changes nothing, when any file's hash differs, a path
could leave the directory, the signing key is not one you trust, or the version
is not newer than the installed one (going back is `rollback`, on purpose). It
stages, re-hashes and renames; `current` moves by an atomic symlink swap, so a
crash leaves the old version active. Three versions are kept. The next
`deploy/scan-db-sync.sh` run mounts the installed bundle **instead of** the
shipped packs and records which one in `rulepacks.version`. After you upgrade
the product, install a bundle at least as new as the release, or `rollback
--to-shipped`: an old bundle keeps old rules.

The vulnerability database has its own offline path: set
`SCAN_VULN_DB_ARCHIVE` to a database archive you carried in and
`SCAN_VULN_DB_ARCHIVE_SHA256` to its checksum (the sync refuses without it).
`SCAN_KEEP_PREVIOUS_DB=1` keeps one earlier copy so
`deploy/scan-db-rollback.sh` can swap back (provision **8 GB**, not 5).

**Not verified end to end.** The bundle tool, the rulepack step of the sync script
and the rollback swap were run for real on a development machine; the grype
import path and the keep-previous branch were syntax- and lint-checked only (no
database archive or scan image was available), so try them on a staging host
first. The advisory data itself is Anchore's and is not signed by us; only its
checksum, which you supply, is checked.

## 10. Maintainers' own install

The maintainers run RepoPulse on their own infrastructure behind their own
reverse proxy as the dogfood install. Nothing about that install is part of
the product: its hostnames, TLS setup and backup targets are one operator's
specifics and are deliberately not described here.
