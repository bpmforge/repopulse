# W17-29 — backup, restore and upgrade drill (podman, linux/arm64), 2026-09-10

Source under test: `3ed7ae2` (branch `codex/repopulse-product-completion`) plus
the W17-29 changes to `deploy/backup.sh`, `deploy/restore.sh`, `deploy/up.sh`
and the new `scripts/drill-backup-restore.sh`. Images: the W17-28 bundle build
`localhost/repopulse/*:0.1.0-rc1` (not rebuilt; the runtime stages carry
`apps/api/src` + `packages/`, not `deploy/`). Host: macOS 26 / M2 Max, podman
client 6.1.0 → podman machine (Fedora CoreOS, rootless, server 5.8.2),
podman-compose 1.6.0. **No docker on this host.**

Raw log of the passing run: `w17-29-backup-restore-drill-20260910.log`
(554 lines; the drill's last step greps it for the key and the plaintext
token — both absent). Two earlier runs failed and are what the fixes below
come from.

```
scripts/drill-backup-restore.sh --source=rp-drill-a --target=rp-drill-b --version=0.1.0-rc1
...
DRILL PASSED (44 checks)      00:23:01 → 00:27:49, both projects and their volumes removed
```

## Acceptance 1 — backup and restore, data checks before and after

Source project `rp-drill-a` (fresh `.env` from `configure.sh`, port 8301):
`drill_marker` row + one `forge_connections` row whose credential was
encrypted **inside the api image with `packages/auth` `encryptCredential`**
(token passed by env, never argv).

| | workspaces | repos | forge_connections | drill_marker | migrations |
|---|---|---|---|---|---|
| source, before backup | 2 | 0 | 1 | 1 | 29 |
| target `rp-drill-b`, fresh, before restore | 1 | 0 | 0 | (no table) | 29 |
| target, after `restore.sh --project=rp-drill-b` | 2 | 0 | 1 | 1 | 29 |

`backup.sh --project=rp-drill-a` → `repopulse-20260911T002319Z.sql`
(122,887 bytes, sha256 `ef0446e9…`) + `.manifest`:

```
REPOPULSE_BACKUP_FORMAT=1  DUMP_SHA256=ef0446e9…  DUMP_BYTES=122887  TAKEN_AT=20260911T002319Z
PROJECT=rp-drill-a  REPOPULSE_VERSION=0.1.0-rc1  MIGRATIONS_APPLIED=29
TOKEN_ENC_KEY_FINGERPRINT=sha256:aab2dcc7f0053913
ROWS_WORKSPACES=2  ROWS_REPOS=0  ROWS_FORGE_CONNECTIONS=1  ROWS_PULL_REQUESTS=0
```

Restore printed `rows before: workspaces=1 … forge_connections=0`,
`rows after: workspaces=2 … forge_connections=1` (equal to the manifest, checked
by the script), `[verify] forge credentials: 1 of 1 decrypt`, then started the
app through `up.sh`; `/healthz` 200 on the target's own port 8302. Rollback
shape (`--no-migrate`) also run: no migrate container created, ledger stays 29,
`/healthz` 200.

## Acceptance 2 — credentials decrypt; wrong / missing key fails closed

- Restore's own check and an independent `restore.sh --verify-only` on the
  target: **1 of 1 decrypt** with the operator's key.
- **Wrong key, manifest present:** `RESTORE REFUSED: TOKEN_ENC_KEY in ./.env
  is not the key this dump was taken under` naming both fingerprints
  (`sha256:aab2dcc7…` vs the wrong key's) — exit 1 **before** anything was
  stopped or dropped; the target api was still running afterwards.
- **Wrong key, no manifest** (an older backup): the dump loads, then
  `[verify] forge credentials: 0 of 1 decrypt` → `RESTORE INCOMPLETE`, exit 1,
  app containers **not** started.
- **Missing key:** `RESTORE REFUSED: TOKEN_ENC_KEY is not set`, exit 1;
  `backup.sh` with no key: `BACKUP REFUSED`, exit 1.
- Correct key back: restore succeeds again (1 of 1), app started.
- The key value and the plaintext token are absent from the whole log, the
  dump and the manifest (grepped by the drill; the manifest holds a sha256
  prefix of the key, not the key).

## Acceptance 3 — migration failure halts startup; stopped services recover

A copy of `packages/shared/drizzle` with an appended migration
`0029_w17_29_broken_on_purpose` (`CREATE TABLE drill_should_not_exist; SELECT
1/0;`) bind-mounted over the migrate image's folder in the disposable
project's compose file, then `up.sh`:

```
DATABASE MIGRATION FAILED (exit 1).   migrate log: PostgresError: division by zero
api: exited  worker: exited            ledger: 29 before, 29 after
no drill_should_not_exist table        drill_marker row intact
```

Fixed the file, removed the containers, `up.sh` → all services running,
`[migrate] up to date (29 migration(s) already applied)`, `/healthz` 200.

Stopped services: `compose stop api worker` → `up.sh` → both running again.
SIGKILL of the worker: **not** restarted by the runtime within 60 s
(`restart: unless-stopped`, rootless podman machine) — `up.sh` recovered it.
Upgrade sequence (RUNBOOK): backup → `down` → `up.sh` in 10 s → `/healthz`
200, marker intact, credential still decrypts.

## Acceptance 4 — refuses an unspecified or production target

`restore.sh --yes <dump>` (no project) → `RESTORE REFUSED: no target project`,
exit 1. `restore.sh --project=repopulse --yes <dump>` →
`RESTORE REFUSED: --project=repopulse is the live install`, exit 1 (`--production`
opens it). The drill itself refuses `repopulse` as either side with no
override, and refuses unset/identical names and floating tags. Unit-tested in
`apps/api/test/ops/deploy-restore.test.ts` (15 tests, stub runtime that
records calls: every refusal happens before any runtime call).

## Defects found by the drill (all fixed here)

1. **`podman compose rm` does not exist** (podman-compose 1.6: `invalid choice:
   'rm'`). The W11-03 `restore.sh` ran `compose rm -sf api worker web ||
   true` with output discarded, so under podman it never stopped anything and
   restored underneath a running api/worker. Run 2 caught it: the api was
   still running after a failed restore. Now `compose stop` + removal by
   compose label through the runtime, in podman dependency order (web → api,
   worker → migrate), and the script refuses to proceed if any app container
   is still running.
2. **W11-03 `restore.sh` had no `-p`**: `PROJECT=other` changed which Postgres
   it wrote to but the compose calls addressed the default project — the live
   install's app containers. Every compose call now carries `-p "$PROJECT"`
   (asserted by a unit test).
3. **podman-compose does not honour `condition: service_completed_successfully`.**
   With the app containers properly absent, `up -d` started api and worker
   after migrate exited 1, while `up.sh` said "Nothing else was started".
   `up.sh` now stops web/api/worker/scan-runner itself on a failed migration
   and says so (docker compose holds them back on its own).
4. **A restarted api is invisible to web.** nginx resolves `api` once at
   startup; `compose stop api; up.sh` → "All services running" but `/healthz`
   via the published port timed out (curl 000). `down` + `up.sh` → 200.
   Documented in the RUNBOOK; the drill records the finding and proves the
   remedy. The real fix (re-resolution in the web image) is outside this
   ticket's write scope — **follow-up needed**.
5. `compose run` executes with cwd `/app`, where the workspace packages are
   not linked; the in-image checks `cd /app/apps/api` first.

## Gate

`pnpm lint` 0, `pnpm typecheck` 0, `validate-compose` PASS, `validate-plan`
OK; test counts in the STATUS entry. New tests: `deploy-restore.test.ts` (15).

## Residuals (not proven here)

- docker and amd64: untested (none on this host). The label-based removal
  and `compose stop` are the same on docker; the dependency ordering is only
  needed on podman.
- Only one image version exists, so the "upgrade" is same-version: migrate
  reports up to date rather than applying anything. A real upgrade with a
  pending migration is exercised only in the failure direction (the broken
  0029) and by W17-28's fresh-volume install (29 applied).
- `restart: unless-stopped` did not restart a SIGKILLed worker on rootless
  podman machine; not investigated further, documented as "use up.sh".
- Under one hand-made inconsistent state during investigation (api container
  removal refused because web still existed, then a broken migrate),
  `podman compose up -d` hung for >5 minutes; `up.sh` does not bound the
  compose call itself, only the wait after it. Not reproduced by the drill.
- Migrations remain forward-only; the runbook says so and promises no
  down-migration.
