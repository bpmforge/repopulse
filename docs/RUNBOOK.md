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
postgres container and fails every night into a log nobody reads.

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
   absolute path for it: `deploy/scan-rules` (or your `SCAN_RULES_DIR`) — the
   vulnerability database and rulepacks; `deploy/ca` (or `EXTRA_CA_DIR`) —
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
