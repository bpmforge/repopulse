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

Nightly, from cron:

```
30 2 * * *  OUT_DIR=/backups /opt/repopulse/deploy/backup.sh >> /var/log/repopulse-backup.log 2>&1
```

### Verify a backup (do this occasionally, not never)

Restore it into a scratch container that touches nothing of your install:

```sh
podman run -d --name rp-verify -p 55433:5432 \
  -e POSTGRES_USER=repopulse -e POSTGRES_DB=repopulse -e POSTGRES_PASSWORD=scratch \
  docker.io/library/postgres:16

podman exec -i -e PGPASSWORD=scratch rp-verify \
  psql -U repopulse -d repopulse -v ON_ERROR_STOP=1 --quiet < repopulse-<timestamp>.sql

podman exec -e PGPASSWORD=scratch rp-verify psql -U repopulse -d repopulse -tAc \
  "select (select count(*) from repos), (select count(*) from workspaces)"

podman rm -f rp-verify
```

An untested backup is a hypothesis.

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
# put the previous image tag back — edit REPOPULSE_VERSION in deploy/.env
./deploy/restore.sh --no-migrate repopulse-<pre-upgrade>.sql
```

Two things in that command are load-bearing, and both were found by running it:

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
./deploy/restore.sh repopulse-<timestamp>.sql
```

It stops the app containers, drops and reloads the schemas, runs migrations —
so a dump from an older version is brought forward — and starts everything
again. `TOKEN_ENC_KEY` must be the one that was in use when the dump was taken;
the script refuses to run if it is unset, because the alternative is a
successful restore whose every forge connection then fails to decrypt.

After a restore, check two things:

1. your repository list is back, and
2. a forge sync still works — which is the test of whether the key matched.

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

**Migration output looks alarming and is not.** The migrate job prints Postgres
NOTICE objects — `schema "drizzle" already exists, skipping`. They are notices,
not errors. The line that matters is the last one: `[migrate] up to date`.
