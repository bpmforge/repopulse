# RepoPulse operations runbook

Upgrade, backup, restore and rollback for a **customer-hosted** install.

Everything here is runnable by an admin with `deploy/compose.yaml`, `deploy/.env`
and a container runtime. No repository checkout, no access to anything of ours,
and no shell inside the database container beyond what these commands do for
you. Substitute `docker` for `podman` throughout if that is what you run.

Every procedure below **has been executed**, not just written. Where a step
exists because something failed during that execution, it says so.

---

## Before anything else: what a backup actually is

A backup is **two things**:

1. the Postgres dump, and
2. `TOKEN_ENC_KEY` from your `.env`.

Every forge credential in the dump is encrypted with that key. A dump without
it restores into an install whose connections can never authenticate — which
looks like a broken product rather than a missing key. **Store the key
somewhere other than beside the dump**, or you have put the lock and the key in
the same envelope.

---

## Backup

```sh
cd /path/to/repopulse
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

Nightly, from cron:

```
30 2 * * *  OUT_DIR=/backups /opt/repopulse/deploy/backup.sh >> /var/log/repopulse-backup.log 2>&1
```

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

```sh
cd /path/to/repopulse
./deploy/backup.sh                                     # 1. always, first
podman compose -f deploy/compose.yaml down             # 2. stop the old code
./deploy/up.sh --build                                # 3. migrate + start + verify
curl -f http://127.0.0.1:${REPOPULSE_PORT:-8080}/healthz && echo OK
```

**`up -d --build` on its own is not an upgrade.** Verified on Podman: it
rebuilds images and re-runs migrations while leaving the running containers
untouched, so the upgrade appears to succeed and every service keeps executing
the old code. `down` first.

**Downtime: about 45 seconds** on a warm image cache (measured: 44s from `down`
to `/healthz` answering 200, on an M2 with images already built). A cold build
is several minutes; pull or build the images *before* the `down` if that matters
to you.

Migrations run as a one-shot job that the API waits on, so the API never starts
against a schema it does not understand. Running `up` again later is a no-op:
the migration ledger is in the database.

**If a migration fails, the upgrade stops there** — proven by shipping a
deliberately broken migration through `up.sh` (W17-29): it exits non-zero with
`DATABASE MIGRATION FAILED`, api, worker and web are stopped, the ledger count
is unchanged and the failed migration's partial work is rolled back (drizzle
applies pending migrations in one transaction). Your data is as it was.
Postgres and Redis keep running. Fix the cause (or roll back, below), remove
the failed one-shot so the next `up` is not judged on it, and run `up.sh`
again:

```sh
podman logs $(podman ps -a --filter label=com.docker.compose.service=migrate -q | head -1)
podman rm -f $(podman ps -a --filter label=com.docker.compose.service=migrate -q)
./deploy/up.sh
```

(`up.sh` stops the app tier itself on a failed migration because podman-compose
1.6 starts api and worker regardless of `service_completed_successfully`;
docker compose honours it. Measured, W17-29.)

**Migrations are forward-only.** There is no down-migration and this runbook
will not pretend one is safe: rolling back is restoring the pre-upgrade dump
(next section), which is why step 1 above is not optional.

**Check you are actually running the new code**, because the failure mode above
is silent:

```sh
podman ps        # uptimes should be seconds, not the age of the last deploy
```

---

## Rollback

For when an upgrade is wrong and you want the previous version back.

```sh
podman compose -f deploy/compose.yaml down
# put the previous image tag back — edit REPOPULSE_VERSION (and SCAN_IMAGE) in deploy/.env
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

**Rolling the DATA back is proven. Rolling the CODE back needs versioned image
tags**, which this install does not yet publish (W11-01). Until it does,
"previous version" means an image you built and tagged yourself. Tag before you
upgrade:

```sh
podman tag repopulse/api:dev repopulse/api:$(date +%F)
```

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
run against the project named `repopulse`. The record of the last run is in
`docs/work/product-completion/evidence/`.

---

## Things that will bite you, from actually doing this

**`SCAN_RULES_DIR` must be an absolute path.** podman-compose does not resolve
a relative bind source against the compose file's directory, so `./scan-rules`
becomes wherever you happened to be standing — or nothing, and the worker fails
with `statfs /var/lib/repopulse/scan-rules: no such file or directory`, naming
the *container* path and sending you looking in the wrong place.

**The scan-rules directory has to exist before `up`.** It ships empty with a
README; `deploy/scan-db-sync.sh` fills it. `deploy/up.sh` creates it for you —
which is why it is the documented way in, and why a bare `compose up` is not:
that path started five of six services and still exited 0 (W16-04).

**Everything stuck in `Created`.** Something with a health check is not healthy.
`podman ps -a` says which, `podman logs <container>` says why.

**The worker will not start, `Invalid argument` on a tmpfs mount.** Fixed in the
shipped compose file (the scratch tmpfs uses the short form, which both runtimes
pass through verbatim). If you have edited it into the long `type: tmpfs` form,
podman-compose renders `mode: 0700` as `mode=448` and crun rejects the mount.

**A restarted api is invisible to web until web is recreated.** nginx resolves
the `api` upstream once, at startup. Restart (or crash-and-restart) the api
container alone and it gets a new address; `/healthz` and every API call
through the published port then hang until web is recreated — while `podman ps`
and `up.sh` both say every service is running. Measured in the W17-29 drill:
`compose stop api; up.sh` → `All services running`, `/healthz` timed out;
`down` + `up.sh` → 200. So **restart the stack, not one service**: `podman
compose -f deploy/compose.yaml down && ./deploy/up.sh` (about 8 seconds on a
warm image cache). Making web re-resolve is a change to the web image, not to
this runbook.

**The runtime does not restart a crashed container for you.** `restart:
unless-stopped` is in the compose file, but on rootless podman (podman machine,
5.8) a worker killed with SIGKILL stayed dead for the 60 seconds the drill
watched it. `up.sh` brought it back. Do not rely on the restart policy for
recovery; rely on `up.sh` (and see the previous item about web).

**`podman compose rm` does not exist.** podman-compose 1.6 has no `rm`
subcommand, and the W11-03 restore script's `compose rm -sf ... || true` had
been silently doing nothing under podman since it was written — the restore
loaded underneath a running api and worker. The scripts now `stop` and then
remove containers through the runtime by their compose labels; if you script
against this stack yourself, do the same (`podman ps -a --filter
label=com.docker.compose.service=<svc> -q | xargs podman rm -f`). Remove web
before api and api/worker before migrate: podman turns `depends_on` into a
container requirement and refuses the other order.

**Migration output looks alarming and is not.** The migrate job prints Postgres
NOTICE objects — `schema "drizzle" already exists, skipping`. They are notices,
not errors. The line that matters is the last one: `[migrate] up to date`.
