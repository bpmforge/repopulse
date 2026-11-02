# RepoPulse operations runbook

Backup, restore (including onto a new server), upgrade, rollback, rotating
secrets, changing the install's address and what to do when it is down, for a
**customer-hosted** install.

Everything here is runnable by an admin with the install directory
(`deploy/compose.yaml`, `deploy/.env`, the `deploy/*.sh` scripts) and a
container runtime. No repository checkout, no access to anything of ours, and
no shell inside the database container beyond what these commands do for you.

Every procedure below **has been executed** on linux/arm64 under rootless
Podman 5.8 with podman-compose 1.6 (the drill record is in
`docs/work/product-completion/evidence/`). Docker is untested: substitute
`docker` for `podman` and expect the same script behaviour, but nobody has
watched it. Where a step exists because something failed during that
execution, it says so.

---

## Before anything else: what a backup actually is

A backup is **two things**:

1. the Postgres dump, and
2. `TOKEN_ENC_KEY` from your `deploy/.env`.

Every forge credential in the dump is encrypted with that key. A dump without
it restores into an install whose connections can never authenticate — which
looks like a broken product rather than a missing key. **Store the key
somewhere other than beside the dump**, or you have put the lock and the key in
the same envelope.

**What a backup does not hold.** Report *schedules* are stored only in Redis
(as repeatable jobs), not in Postgres, so a restore onto a new server, or a
lost Redis volume, brings back every report but none of the schedules. Write
down your schedules (Reports → Schedules) and create them again after a
restore. Generated report files live in the `reportdata` volume and are not in
the dump either; their history rows are, and each can be generated again.

---

## Backup

```sh
cd /path/to/repopulse                 # the install directory
./deploy/backup.sh                    # writes repopulse-<timestamp>.sql here
OUT_DIR=/backups ./deploy/backup.sh   # or somewhere else
```

The script refuses to report success on a dump that ended early: it checks for
the `PostgreSQL database dump complete` trailer. A truncated dump is still a
file, and the moment you find out otherwise should not be the restore.

It writes two files: `repopulse-<timestamp>.sql` and, beside it,
`repopulse-<timestamp>.sql.manifest` — the dump's sha256, the row counts of
`workspaces`, `repos`, `forge_connections` and `pull_requests` at the moment
of the dump, the number of applied migrations, and a **fingerprint** of
`TOKEN_ENC_KEY` (the first 16 hex characters of its sha256). The fingerprint
identifies the key; it cannot reproduce it, so the manifest is safe to keep
with the dump. It is what lets `restore.sh` refuse a wrong key *before* it
drops anything. The script also refuses to run at all if `.env` holds no key
or a malformed one: a dump taken then is a dump no key will ever open.

Backing up is non-destructive, so the project defaults to the live install
(`repopulse`); `--project=<name>` backs up another one.

Nightly, from cron — in the crontab of **the user who ran `install.sh`**
(`crontab -e` as that user), not root's. Rootless Podman keeps a separate
image store and container set per user: run as root, `backup.sh` finds no
postgres container and fails every night into a log nobody reads. So
`backup.sh` and `scan-db-sync.sh` refuse to run as root when `deploy/.env`
belongs to another user, and say whose crontab to use; set
`REPOPULSE_ALLOW_ROOT=1` only for a deliberately rootful install.

```
30 2 * * *  OUT_DIR=$HOME/repopulse-backups /opt/repopulse/deploy/backup.sh >> $HOME/repopulse-backup.log 2>&1
```

The jobs only run while that user's session manager is alive, which after a
reboot needs lingering: `sudo loginctl enable-linger <user>` (INSTALL →
*Start on boot*).

### Verify a backup (do this occasionally, not never)

Restore it into a **second, disposable compose project** — a whole stack on
another port and another set of volumes, sharing nothing with your install
but the images and your `.env`:

```sh
cd /path/to/repopulse
REPOPULSE_PROJECT=rp-verify REPOPULSE_PORT=8199 ./deploy/up.sh
./deploy/restore.sh --project=rp-verify --yes /backups/repopulse-<timestamp>.sql
#   ... rows before / rows after / "forge credentials: N of N decrypt" / All services running
curl -fs http://127.0.0.1:8199/healthz
podman compose -p rp-verify -f deploy/compose.yaml down -v      # -v: its volumes go too
```

That exercises everything a real restore does — including that every stored
forge credential decrypts with the key in your `.env` — and if the numbers
under `rows after` are not the numbers you expect, you have learned it on a
Tuesday afternoon and not during the outage. An untested backup is a
hypothesis.

To check only the key against a running project, without restoring:

```sh
./deploy/restore.sh --project=repopulse --verify-only
```

---

## Upgrade

### From a new bundle (the customer path)

1. Extract the new bundle **beside** the old one; do not overwrite it.
2. Take a backup: `./deploy/backup.sh` in the old directory.
3. Copy `deploy/.env` from the old directory into the new one.
   Also carry over what lives **inside** the old directory unless you set an
   absolute path for it: the downloaded vulnerability data in
   `deploy/scan-rules` (or your `SCAN_RULES_DIR`) — its `vuln-db`, `malicious`
   and `package-index` folders, **not** `rulepacks` or `rulepacks.sha256`,
   which the new bundle ships newer and `install.sh` checks against its
   checksum; `deploy/ca` (or `EXTRA_CA_DIR`) —
   your internal-CA PEM, without which TLS to a self-hosted forge fails; and
   your backups. Then point the cron lines at the new directory. Setting
   `SCAN_RULES_DIR` and `EXTRA_CA_DIR` to absolute paths outside any bundle
   (for example `/srv/repopulse/scan-rules`) makes later upgrades skip this.
4. In the new `deploy/.env`, set `REPOPULSE_VERSION` and `SCAN_IMAGE` to the
   new version (the last lines of the file; `install.sh` tells you if they
   disagree with the bundle).
5. `podman compose -f deploy/compose.yaml down` in the **old** directory.
6. `./install.sh` in the new directory. Checksums are verified, the new images
   load beside the old ones, `.env` is kept byte for byte, migrations run once
   before the API starts, and the data volumes are shared by compose project
   name, so nothing is copied.
7. `curl -f http://127.0.0.1:${REPOPULSE_PORT:-8099}/healthz && echo OK`

Only one bundle version existed when this was drilled, so the rerun that was
recorded is an **upgrade-style rerun of the same version** on existing
volumes: `.env` preserved, data intact, migrate reporting up to date. A
version step with a pending migration has been exercised only in the failure
direction (below) and by a fresh-volume install applying every migration.

### From a checkout

```sh
cd /path/to/repopulse
./deploy/backup.sh                                     # 1. always, first
podman compose -f deploy/compose.yaml down             # 2. stop the old code
./deploy/up.sh --build                                # 3. migrate + start + verify
curl -f http://127.0.0.1:${REPOPULSE_PORT:-8099}/healthz && echo OK
```

**`up -d --build` on its own is not an upgrade.** Verified on Podman: it
rebuilds images and re-runs migrations while leaving the running containers
untouched, so the upgrade appears to succeed and every service keeps executing
the old code. `down` first.

**Downtime: about ten seconds** from `down` to `/healthz` answering 200 on a
warm image cache (measured in the drill). A cold build is several minutes;
pull or build the images *before* the `down` if that matters to you.

### What happens when a migration fails

Migrations run as a one-shot job that the API waits on, so the API never starts
against a schema it does not understand. Running `up` again later is a no-op:
the migration ledger is in the database.

**If a migration fails, the upgrade stops there** — proven by shipping a
deliberately broken migration through `up.sh`: it exits non-zero with
`DATABASE MIGRATION FAILED`, api, worker, web and scan-runner are stopped, the
ledger count is unchanged and the failed migration's partial work is rolled
back (pending migrations apply in one transaction). Your data is as it was.
Postgres and Redis keep running. Fix the cause (or roll back, below), remove
the failed one-shot so the next `up` is not judged on it, and run `up.sh`
again:

```sh
podman logs $(podman ps -a --filter label=com.docker.compose.service=migrate -q | head -1)
podman rm -f $(podman ps -a --filter label=com.docker.compose.service=migrate -q)
./deploy/up.sh
```

(`up.sh` stops the application tier itself on a failed migration because
podman-compose 1.6 starts api and worker regardless of
`service_completed_successfully`; docker compose honours it. Measured.)

**Migrations are forward-only.** There is no down-migration and this runbook
will not pretend one is safe: rolling back is restoring the pre-upgrade dump
(next section), which is why the backup step is not optional.

**Check you are actually running the new code**, because the failure mode above
is silent:

```sh
podman ps        # uptimes should be seconds, not the age of the last deploy
```

### Redis became Valkey (2026-11)

From November 2026 the `redis` service runs **Valkey 9.0.7**
(`valkey/valkey:9.0.7-alpine`, BSD-3-Clause) instead of `redis:7-alpine`, which
had moved to Redis 7.4 and a licence (RSALv2/SSPLv1) this bundle cannot ship.
The service is still called `redis`; the `repopulse_redisdata` volume,
`REDIS_URL` and `REDIS_PASSWORD` are unchanged, and nothing in `deploy/.env`
needs editing.

**What an upgrading install sees: nothing, if it uses the new `compose.yaml`.**
Installs from before November ran Redis 7.4, which writes its data in RDB
format version 12. Valkey refuses that format by default and exits, which would
take everyone's sessions and every report schedule with it. The shipped
`compose.yaml` starts Valkey with `--rdb-version-check relaxed`, which loads it.
Measured on 2026-11-02 against real Redis 7.4.12 volumes from earlier installs
(Podman and Docker) and a synthetic one: every key came back, including both
kinds of BullMQ schedule, streams with their consumer groups, and session TTLs.
On a Podman install upgraded with the steps above, a browser session from
before the upgrade was still signed in afterwards, and the report schedule made
before it was still listed and still due on the same date. Valkey and Redis run
as the same uid and gid (999:1000) in their images, so the volume's file
ownership needs nothing.

The flag stays in `compose.yaml` for good. The old Redis data is converted only
when Valkey next rewrites its append-only file, which by default waits until
the file has grown by 64 MB. On an install this size that can take years. Do not
remove the flag. RDB version 12 adds only hash-field expiry, which neither
RepoPulse nor BullMQ uses, so relaxed loading skips nothing here.

**Check it after the upgrade:**

```sh
podman exec $(podman ps -q --filter label=com.docker.compose.service=redis) \
  sh -c 'REDISCLI_AUTH="$REDIS_PASSWORD" valkey-cli INFO server' | grep -E 'server_name|valkey_version'
# server_name:valkey
# valkey_version:9.0.7
```

`INFO` also still reports `redis_version:7.2.4` (Valkey's compatibility
version), and the image keeps `redis-cli` and `redis-server` as names for the
Valkey programs, so existing scripts keep working. Reports → Schedules should
list the same schedules as before.

**If redis will not start after the upgrade** and its log says
`Can't handle RDB format version 12`, the `compose.yaml` in use is not the one
shipped with this version: one carried over from the old bundle, or edited. `up.sh`
says so when it sees that log line. Use the shipped file, or add
`"--rdb-version-check", "relaxed"` to the end of your redis `command:`, and run
`./deploy/up.sh` again. **Do not delete the volume to get past it:** that is
everyone's sessions and every report schedule, and a backup does not hold the
schedules.

**Rolling back across this change.** Until Valkey rewrites the append-only file,
the old bundle's Redis 7.4 can still read the volume. After a rewrite it cannot:
the file then starts `VALKEY080` and Redis stops with
`Bad file format reading the append only file`. Both were measured. A rewrite
happens after 64 MB of writes or a manual `BGREWRITEAOF`, so do not run one
until you are sure you are keeping the new version. If you roll back after a
rewrite, keep Valkey: copy the whole `redis:` service from the new
`compose.yaml` into the old one. The Valkey image is already loaded, and the
older application talks to it the same way. Removing the volume also works, at
the cost above.

**Developers:** `compose.dev.yaml` used `redis:7.2`, whose data (RDB version 11)
Valkey reads without the flag. Recreate the container with
`podman compose -f compose.dev.yaml up -d redis`.

---

## Rollback

For when an upgrade is wrong and you want the previous version back. Code and
data roll back separately.

**Code:** the previous bundle directory still exists (you extracted beside it)
and its `.env` still pins the previous version, whose images are still loaded.
From a checkout, edit `REPOPULSE_VERSION` (and `SCAN_IMAGE`) in `deploy/.env`
back to the tag you were running; tag before you upgrade if you build your
own images (`podman tag localhost/repopulse/api:dev localhost/repopulse/api:$(date +%F)`).

**Data:**

```sh
podman compose -f deploy/compose.yaml down                       # in the NEW directory
cd /path/to/previous-bundle
podman compose -f deploy/compose.yaml up -d postgres redis      # the data tier only
./deploy/restore.sh --project=repopulse --production --no-migrate repopulse-<pre-upgrade>.sql
```

Three things in that command are load-bearing, and all were found by running it:

- **`--project=repopulse --production`.** The restore drops every schema in
  the database it is pointed at, so it never assumes which one. `repopulse`
  is the live install's compose project and is refused unless you add
  `--production`; any other name is a disposable copy (see *Verify a backup*).
- **`--no-migrate`.** Restoring an older dump and then migrating forward
  re-applies exactly the migrations you are rolling back from: you end up at
  the new schema with the old data in it. The flag skips them, and it also
  starts the app containers with `--no-deps` — because a plain `up -d` starts
  the one-shot migrate service as a dependency of the API, and the rollback
  silently un-rolls itself in about two seconds while reporting success.
- **The restore drops the schemas before loading.** `pg_dump --clean` cannot
  drop objects that tables added by *later* migrations depend on; it fails
  part-way with `constraint ... depends on index workspaces_pkey` and leaves
  the database half-restored. Dropping `public` and `drizzle` outright is the
  only path that works in both directions — and rollback is the direction you
  need it in.

---

## Restore (disaster recovery, not rollback)

Same-version restore into a working stack:

```sh
./deploy/restore.sh --project=repopulse --production repopulse-<timestamp>.sql
```

It stops the app containers, drops and reloads the schemas, runs migrations —
so a dump from an older version is brought forward — checks what it loaded,
and starts everything again through `up.sh`. On the way it prints `rows
before:` and `rows after:` (the four tables the manifest records) so the
outcome is on record, and it will not report success unless:

1. the dump matches the sha256 in its manifest (a truncated or edited dump is
   refused before anything is dropped);
2. `TOKEN_ENC_KEY` in `.env` has the fingerprint the manifest recorded (a
   different key is refused before anything is dropped);
3. after loading, **every stored forge credential decrypts** — checked inside
   the api image with the product's own vault code, not a copy of it. If any
   fails, the restore exits non-zero with `RESTORE INCOMPLETE`, the app
   containers stay down, and the fix is to put the right key in `.env` and run
   `./deploy/restore.sh --project=repopulse --verify-only`.

The key must be the one in use when the dump was taken. An unset or malformed
key is refused outright, because the alternative is a successful-looking
restore whose every forge connection then fails to decrypt. Neither the key
nor any decrypted value is ever printed. A dump from before the manifest
existed still restores; check 3 is then the only guard, and it still fails
the restore rather than passing it.

After a restore, check two things:

1. your repository list is back, and
2. a forge sync still works — which is the end-to-end test of the key.

### Restore onto a new server (the old one is gone)

The order matters: the new install must start with the **old** key, or
`restore.sh` refuses the dump ("TOKEN_ENC_KEY in .env is not the key this dump
was taken under"). You need the dump, its `.manifest`, and either the old
`deploy/.env` or at least the `TOKEN_ENC_KEY` you saved from it.

1. On the new server, as the user who will run it, extract the bundle of the
   **same version** the dump was taken on (`RepoPulse <version>` at the top of
   Settings → System health, or `REPOPULSE_VERSION` in the old `.env`).
   Restore first, upgrade after.
2. **Before `install.sh`**, put the old `.env` at `deploy/.env` in the new
   directory. `install.sh` keeps an existing `.env` and never regenerates its
   secrets. Then check the values that name the old machine:
   `PUBLIC_BASE_URL` (a new hostname: see *Change the install's address*),
   and `SCAN_RULES_DIR` / `EXTRA_CA_DIR` if they were absolute paths there.
   Copy your internal-CA PEM back into `deploy/ca` (or `EXTRA_CA_DIR`).
   Only the key was saved? Run `install.sh` normally, then replace the
   `TOKEN_ENC_KEY=` line in the new `deploy/.env` with the saved value.
3. `./install.sh` — loads the images and starts an empty stack.
4. `./deploy/restore.sh --project=repopulse --production <dump>` — reloads the
   data and restarts the stack with the key now in `.env`.
5. `./deploy/scan-db-sync.sh` — the vulnerability database is not in the dump.
6. Install the two cron lines (*Backup*, and INSTALL → *Scan data*) for this
   user, enable lingering (INSTALL → *Start on boot*), and recreate any report
   schedules (*What a backup does not hold*).
7. Check that the repository list is back and a forge sync works.

### Change the install's address

`PUBLIC_BASE_URL` is where browsers, sign-in callbacks and forge webhooks reach
the install. To change it (a new domain, http to https, a restore onto a
server with another name):

1. Edit `PUBLIC_BASE_URL` (and `API_BASE_URL` if it was set to the same value)
   in `deploy/.env`, then `./deploy/up.sh`.
2. Update the callback URL registered with your identity provider (OIDC) and
   with the GitHub OAuth app if you use "Sign in with GitHub"; both name the
   old host until you do.
3. **Webhooks still point at the old address.** Each one is registered once,
   when its repository is first tracked, and nothing re-registers it yet.
   Until you edit them on the forge (each repository's webhook settings: change
   the host in the payload URL, keep the path), live updates stop, and data
   arrives only with the nightly sync.

### The drill (how the above was proven)

`scripts/drill-backup-restore.sh` (repository checkout, podman or docker,
images already built) runs the whole story against two disposable projects it
creates and destroys: seed a marker row and a forge credential → backup →
refusals (no target, live target) → restore into the other project → row
counts equal, credential decrypts → wrong key refused by manifest; wrong key
with no manifest loads, fails the decrypt check, exits non-zero, app not
started; missing key refused → a deliberately broken migration halts `up.sh`
with data and ledger untouched → recovery → stopped services recover → the
upgrade sequence → the key value is absent from the entire log. It refuses to
run against the project named `repopulse`. 44 checks; the record of the last
run is in `docs/work/product-completion/evidence/`.

### Restore onto a new server (the old one is gone)

The procedure above restores into a stack that is already running with the
right key. On a **new** machine it is not: `install.sh` (or `configure.sh`)
writes a fresh `deploy/.env` with a newly generated `TOKEN_ENC_KEY`, and
`restore.sh` then refuses the dump ("TOKEN_ENC_KEY in .env is not the key this
dump was taken under"). So the order matters (W20-10, UX_TODO ADM-76):

1. **Gather** the dump and its `.manifest`, and the old `deploy/.env` — or at
   least the `TOKEN_ENC_KEY` you stored separately. Without the key the
   restore can still load the data, but every forge credential, webhook secret
   and model API key has to be entered again.
2. **Extract the same version's bundle** as the one the dump was taken on (the
   manifest's `REPOPULSE_VERSION`). A newer bundle works too — migrations run
   forward on restore — but the same version is the boring path.
3. **Put the old `.env` in place BEFORE installing:** copy it to
   `deploy/.env` in the new directory. If you only kept the key, run
   `./deploy/configure.sh` first and then replace its `TOKEN_ENC_KEY=` line
   with the saved key. Carry over, too: `SCAN_RULES_DIR` and `EXTRA_CA_DIR`
   (and the internal-CA PEM inside it, or TLS to a self-hosted forge fails),
   and check `PUBLIC_BASE_URL`, `API_BASE_URL` and `REPOPULSE_PORT` — if the
   new server has a different address, also follow *Change the install's
   address* below once the restore is done.
4. `./install.sh` — it keeps the `.env` it finds and starts an empty stack.
5. `./deploy/restore.sh --project=repopulse --production repopulse-<timestamp>.sql`
   (the full command: the target is never assumed). It checks the dump and the
   key, loads it, migrates forward and proves every credential decrypts.
6. `./deploy/scan-db-sync.sh` — the vulnerability database is not in the
   dump.
7. Put the cron lines back (backup, scan-db-sync), pointing at the new
   directory.
8. **Check a sync works:** Settings → System health shows Database, Worker and
   Forge connection working, and Settings → Sync moves a repository. That is
   the end-to-end proof the key is right.

### Change the install's address (`PUBLIC_BASE_URL`)

Moving to a new hostname, a new domain or from http to https after
repositories are tracked (W20-10, UX_TODO ADM-77). Each repository's push
webhook was registered once, when it was first tracked, pointing at the
address in force then — so after a move every forge keeps delivering to the
old address and live updates stop without a warning (only the nightly
reconcile still runs). Sign-in callbacks registered with your identity
provider and GitHub App name the old address too.

1. Edit `deploy/.env`: `PUBLIC_BASE_URL`, `API_BASE_URL` (normally the same
   origin), and `REPOPULSE_PORT` / `REPOPULSE_BIND` if those change.
   `configure.sh` will not rewrite an existing `.env`; edit it by hand.
2. If you sign in with OIDC, change the redirect URI registered with the IdP
   to `<new address>/auth/oidc/callback`, and `OIDC_REDIRECT_URI` in `.env`
   to match. If you use "Sign in with GitHub", change the GitHub App's
   callback URL to `<new address>/auth/callback`.
3. Restart: `podman compose -f deploy/compose.yaml down && ./deploy/up.sh`.
4. **Re-register the webhooks:** Settings → Connections → *Re-register
   webhooks* on each connection. It registers each tracked (not paused)
   repository's hook at the new address with the connection's existing
   secret and reports any repository it could not (the forge account needs
   admin on that repository).
5. Delete the hooks that still point at the **old** address in each forge
   (repository → Settings → Webhooks). RepoPulse cannot delete them for you
   yet; until you do, the forge records failed deliveries to a host that no
   longer answers, which is harmless but noisy.
6. Check: push to a tracked repository and watch Settings → Sync show it
   within a minute.

---

## Hand over the install / rotate secrets

When someone who could read `deploy/.env` (or a backup of it) leaves, or a
secret may have been exposed (W20-10, UX_TODO ADM-45). Rotate each value below
that they could have seen. Take a backup first.

| Secret | How to rotate | Who is signed out |
|---|---|---|
| `TOKEN_ENC_KEY` | `./deploy/rotate-token-key.sh` (below) | nobody |
| `SESSION_SECRET` | `openssl rand -hex 32` into `.env`, restart the stack | **everyone** — every session cookie was signed with the old value |
| `POSTGRES_PASSWORD` | change the role, then `.env` (below), restart | nobody |
| `REDIS_PASSWORD` | `.env` (`REDIS_PASSWORD` and the password in `REDIS_URL`), restart | nobody (sessions are kept in Redis's volume) |
| `ADMIN_PASSWORD` | only used to create the first account: delete the line from `.env`, then change that account's password in **Account → Change password** | that account's other sessions |
| `SCAN_RUNNER_TOKEN` | `openssl rand -hex 32` into `.env`, restart the stack | nobody |
| OIDC / GitHub App client secrets | regenerate at the provider, put the new value in `.env`, restart | nobody |
| Forge tokens, model API keys | replace them in Settings → Connections / Models; revoke the old ones at the forge or vendor | nobody |

**`TOKEN_ENC_KEY`.** A new key on its own makes every stored credential
undecryptable, so it has to be swept:

```sh
./deploy/rotate-token-key.sh          # generates the new key, dry run, asks, rotates
```

It opens every stored secret under the current key first (a dry run that
writes nothing), stops the api and worker, re-seals every forge token,
webhook secret and model API key under the new key **in one transaction**
inside the api image, saves the old `.env` as `deploy/.env.pre-rotate-<stamp>`
(mode 600), writes the new key into `deploy/.env` and starts the api and worker
again. If anything does not open, nothing is changed. Neither key is printed;
the new one reaches the container on stdin. From a checkout:
`TOKEN_ENC_KEY=<current> NEW_TOKEN_ENC_KEY=<new> pnpm rotate:token-key [--dry-run]`.

Afterwards: **backups taken before the rotation need the OLD key** — store it
(from the `.env.pre-rotate` copy) with those backups, then delete the copy from
the server. Store the new key separately from the dumps, and take a fresh
backup. Settings → System health shows the key fingerprint of the newest
backup, so you can see when the fresh one has been taken.

**`POSTGRES_PASSWORD`.** The data volume keeps the password it was created
with, so change it inside Postgres first:

```sh
podman compose -f deploy/compose.yaml exec postgres \
  psql -U repopulse -d repopulse -c "ALTER ROLE repopulse PASSWORD '<new>'"
```

then set `POSTGRES_PASSWORD` and the password inside `DATABASE_URL` in `.env`
to the same value, and restart the stack. `up.sh` names a `28P01` failure
(password mismatch) if the two disagree.

**Sign everyone out of one account.** A password change (by the member, or an
admin's **Reset password…** in Settings → Members) ends every other session of
that account. A member can also use **Sign out everywhere** in the user menu.
The `reset:password` command line does not end sessions, but the forced
password change it leads to does.

---

## When the app is down

What users see, how to check, and how to recover (W20-10, UX_TODO ADM-44).
**Settings → System health** answers most of this from the browser as long as
the api is up; the commands below are for when it cannot.

### The disk is full

*What users see:* saving anything fails with "Internal Server Error"; reports
fail to generate; System health shows **Disk space — Not working**, or
Postgres stops answering.

*Check:* `df -h` on the server. Postgres data, report files (the `reportdata`
volume), scan data under `SCAN_RULES_DIR`, container images and — by default —
the backups (`OUT_DIR` defaults to the directory `backup.sh` runs in) all grow
on this host, and nothing removes old backups for you.

*Recover:*

1. Move old backups off the host (keep the newest few, each with its
   `.manifest`), and point `OUT_DIR` at another disk in the cron line.
2. `podman image prune` removes images of versions you no longer run.
3. `podman system df` shows which volume is large. A `reportdata` volume full
   of old PDFs can be trimmed: a report whose files are gone keeps its row and
   can be generated again.
4. `./deploy/up.sh` once there is room; it says which services did not come
   back.

### Postgres is not answering

*What users see:* one banner, "RepoPulse can't reach its database", instead of
the app (or over it, if it happened mid-session); nothing on screen is
current. Sign-in fails.

*Check:* `podman compose -f deploy/compose.yaml ps` — is `postgres` running and
healthy? `podman compose -f deploy/compose.yaml logs --tail 50 postgres` says
why. `curl -s localhost:<port>/healthz` from the server prints
`postgres=down` while it is down.

*Recover:* a full disk (above) is the usual cause. Otherwise
`podman compose -f deploy/compose.yaml down && ./deploy/up.sh`. If Postgres
will not start because its data is damaged, restore the newest backup (see
*Restore*). The app recovers on its own once Postgres answers: the outage
banner checks every ten seconds.

### Redis is not answering

*What users see:* the same outage banner naming Redis; everyone is signed out
(sessions live in Redis); live updates, syncs, scans and reports stop.

*Check:* `podman compose -f deploy/compose.yaml logs --tail 50 redis`. A
`NOAUTH`/`WRONGPASS` in the api log means `REDIS_PASSWORD` and the password in
`REDIS_URL` disagree.

*Recover:* `podman compose -f deploy/compose.yaml down && ./deploy/up.sh`.
Queued jobs survive a restart (append-only file on the `redisdata` volume);
sessions do too, unless the volume was removed.

---

## Routine care

**Scan data, nightly.** `deploy/scan-db-sync.sh` from cron (INSTALL.md). A
`Built:` date under `deploy/scan-rules/vuln-db` that stops moving means the
job is not running, and dependency scans will start refusing the database
after five days — loudly, naming its age, which is the better failure.

**The advisory data stamp, and what "rematched" means (W23-04).**
`scan-db-sync.sh` writes `scan-rules/vuln-db.version` — one line,
`<schema>@<build timestamp>` (for example `6@2026-10-31T01:12:09Z`) — each time
it swaps in a new vulnerability database. A database synced before this existed
has no file; the worker derives the identical string from grype's own
`import.json`, so upgrading does not by itself trigger anything. Every
dependency and container-image run records the stamp it matched against.

Before fetching a repository's source, the dependency and image scanners and
the architecture register compare what they read last time with what is there
now, through the forge's contents API (a handful of small calls, no archive):

- **Nothing changed** (same manifests and stamp; same Dockerfiles and compose
  files and stamp; same commit tree). The run is recorded as *up to date*
  ("Nothing this scanner reads changed…") and no source is fetched. "Full
  rescan" on the Security tab overrides it.
- **Rematched** (dependency scanner only: same manifests, new stamp). The
  stored SBOM for that repository is matched again against the new database —
  no archive, no syft. New advisories appear, withdrawn ones close, exactly as
  a full scan would report them. What a rematch does not re-check is whether
  the source *imports or calls* a package, because the source is not read: a
  CVE that already existed keeps its stored reasoning untouched, and a CVE new
  to the repository is filed at the manifest tier and says so in its text. The
  next scan after a manifest change is a full one and fills that in.
- **Anything else** (manifests, Dockerfiles or tree changed; no earlier run; a
  file the forge would not return in full; a forge error) is a full scan. The
  gate only ever errs toward scanning.

Two limits, stated: the gate knows the manifest and Dockerfile paths the last
full run found plus the usual root files, so a brand-new nested manifest is
noticed by "Full rescan" or by the next scan that is full for another reason,
not by the gate. And an image named by a moving tag (`node:20`,
not `@sha256:`) is never skipped unless a digest source is wired, because a tag
can move with no file changing. The architecture gate needs the forge to report
a commit's tree sha; on a forge that does not, it simply always scans.

**Restart the stack, not one service.** `podman compose -f deploy/compose.yaml
down && ./deploy/up.sh`, about ten seconds on a warm image cache. See below
for why.

**Reset a forgotten password.** An administrator resets any member who signs
in with a password from **Settings → Members → Reset password…**: a one-time
password is shown once and the member must change it at their next sign-in.
Members who sign in with SSO or GitHub have no password here; their identity
provider handles it. If the locked-out person *is* the only administrator,
reset from the host instead (prints the one-time password, writes an audit
line):

```sh
pnpm reset:password --email you@example.com                     # from a checkout
podman compose -f deploy/compose.yaml exec api \
  tsx apps/api/src/cli/reset-password.ts --email you@example.com  # a bundle install
```

A reset from Settings ends every session that account had (W20-10). The
command line does not, but the forced password change it leads to does.

**Check the worker from Settings.** "Background worker — Not working" means no
heartbeat in the last minute; `./deploy/up.sh` brings it back and reports what
it found.

---

## When the app is down

Everything below runs as the user who ran `install.sh`, from the bundle
directory. Start every case with the same two checks:

```sh
curl -s http://127.0.0.1:${REPOPULSE_PORT:-8099}/healthz; echo   # names what is down: postgres=down redis=ok
podman compose -f deploy/compose.yaml ps                         # which containers are up, restarting or exited
```

**What people see.** With Postgres or Redis down, a browser that opens
RepoPulse gets one screen, "RepoPulse can’t reach its database" (or Redis),
which re-checks every 10 seconds and opens the app by itself when the server
recovers. Someone already in the app gets the same message as a banner over
the page. Nothing they see is current until it clears. Settings → System health
needs the database itself, so while it is down that screen cannot load either:
use the two commands above.

### The disk is full

Settings → System health has a **Disk space** row: *Degraded* under 10 % or
5 GB free, *Not working* under 3 % or 1 GB. Postgres, report files (the
`reportdata` volume), backups (`OUT_DIR`, the bundle directory unless you
moved it) and scan data usually share one disk, and none of them has a
retention limit. When the disk fills, writes fail first: syncs stop, reports
end failed, and sign-in can fail because sessions cannot be stored.

1. See what is using it: `df -h`, then `du -sh deploy/scan-rules
   ~/repopulse-backups` (or wherever `OUT_DIR` points) and
   `podman system df`.
2. Free space, safest first: delete old backups you have copied elsewhere;
   `podman image prune` (old release images after an upgrade);
   `deploy/scan-rules/vuln-db.old` if a sync left one.
3. Run `./deploy/up.sh`. Postgres recovers by itself once it can write again;
   it does not need a restore.

### Postgres is not answering

1. `podman compose -f deploy/compose.yaml logs --tail=100 postgres`. A full
   disk ("No space left on device") is the usual cause: see above.
2. `./deploy/up.sh` restarts whatever is stopped and waits for it to be
   healthy.
3. If Postgres starts and immediately exits with a data-directory error, stop
   here and restore the last backup (*Restore* above). Do not delete the
   volume to "start fresh": that is the data.

### Redis is not answering

1. `podman compose -f deploy/compose.yaml logs --tail=100 redis`.
2. `./deploy/up.sh`.
3. What can be lost: sessions live in Redis, so everyone may have to sign in
   again. If Redis came back *empty* (its volume was lost, not just the
   container restarted), jobs that were queued but not started are gone: the
   nightly sweeps are registered again when the worker starts, but report
   schedules exist only in Redis and must be created again in Reports, and a
   repository stuck mid-backfill is restarted from Settings → Sync (Pause,
   then Resume). Warehouse data is not affected; none of it is stored in
   Redis.

---

## Things that will bite you, from actually doing this

**`SCAN_RULES_DIR` must be an absolute path.** podman-compose does not resolve
a relative bind source against the compose file's directory, so `./scan-rules`
becomes wherever you happened to be standing — or nothing, and the worker fails
with `statfs ...: no such file or directory`, naming the *container* path and
sending you looking in the wrong place. Leave it blank to use the shipped
`deploy/scan-rules`.

**The scan-data directory has to exist before `up`.** It ships with a README;
`deploy/scan-db-sync.sh` fills it. `deploy/up.sh` creates it for you — which is
why it is the documented way in, and why a bare `compose up` is not: that path
started five of six services and still exited 0.

**Everything stuck in `Created`.** Something with a health check is not healthy.
`podman ps -a` says which, `podman logs <container>` says why.

**`DATABASE MIGRATION FAILED` on a host that has run RepoPulse before.** A
`repopulse_pgdata` volume from an earlier install under a different password
is still there. `up.sh` names the cause (Postgres `28P01`) and the two ways
out: restore the matching `deploy/.env`, or remove the volume knowingly —
which destroys that data.

**The worker will not start, `Invalid argument` on a tmpfs mount.** Fixed in
the shipped compose file (the scratch tmpfs uses the short form, which both
runtimes pass through verbatim). If you have edited it into the long
`type: tmpfs` form, podman-compose renders `mode: 0700` as `mode=448` and crun
rejects the mount.

**A restarted api is invisible to web until web is recreated.** nginx resolves
the `api` upstream once, at startup. Restart (or crash-and-restart) the api
container alone and it gets a new address; `/healthz` and every API call
through the published port then hang until web is recreated — while `podman ps`
and `up.sh` both say every service is running. Measured in the drill:
`compose stop api; up.sh` → `All services running`, `/healthz` timed out;
`down` + `up.sh` → 200. So **restart the stack, not one service**. Making web
re-resolve is a change to the web image, not to this runbook.

**The runtime does not restart a crashed container for you.** `restart:
unless-stopped` is in the compose file, but on rootless podman a worker killed
with SIGKILL stayed dead for the 60 seconds the drill watched it. `up.sh`
brought it back. Do not rely on the restart policy for recovery; rely on
`up.sh` (and see the previous item about web).

**`podman compose rm` does not exist.** podman-compose 1.6 has no `rm`
subcommand, and an earlier `restore.sh` had been silently doing nothing under
podman — the restore loaded underneath a running api and worker. The scripts
now `stop` and then remove containers through the runtime by their compose
labels; if you script against this stack yourself, do the same (`podman ps -a
--filter label=com.docker.compose.service=<svc> -q | xargs podman rm -f`).
Remove web before api and api/worker before migrate: podman turns
`depends_on` into a container requirement and refuses the other order.

**Migration output looks alarming and is not.** The migrate job may print
Postgres NOTICE lines — `schema "drizzle" already exists, skipping`. They are
notices, not errors. The line that matters is the last one: `[migrate] up to
date (N migration(s) already applied)` or `[migrate] applied N migration(s)`.

**`scan-runner` is not running on Linux.** Almost always the Podman API socket
is not enabled: `systemctl --user enable --now podman.socket`, then `up.sh`.
Until it is, every tool-based scan reports the sandbox as unavailable and no
findings are written — which the Security tab says, rather than showing a
clean result.
