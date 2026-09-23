#!/usr/bin/env sh
# RepoPulse restore (W11-03, target discipline + decrypt proof W17-29).
#
#   REPOPULSE_PROJECT=rp-verify ./restore.sh --yes repopulse-20260819T120000Z.sql
#   ./restore.sh --project=rp-verify repopulse-...sql
#   ./restore.sh --project=repopulse --production repopulse-...sql   (the live install)
#   ./restore.sh --project=rp-verify --no-migrate repopulse-...sql   (rolling BACK)
#   ./restore.sh --project=rp-verify --verify-only                    (no restore: just the key check)
#
# THE TARGET IS NEVER ASSUMED (W17-29). A restore drops every schema in the
# database it is pointed at, and this script used to point at the compose
# project's default name — the live install — unless told otherwise, while
# `PROJECT=other` only changed which Postgres it wrote to, NOT which app
# containers it stopped (there was no -p on the compose calls, so it took
# down production's api/worker/web on the way to restoring a scratch copy).
# Now: the project comes from --project= or REPOPULSE_PROJECT (the same
# variable up.sh uses), an unset target is refused, and the default project
# name `repopulse` — the customer's live install — is refused unless
# --production says that is what you mean.
#
# Restores into that project's Postgres. STOPS the app containers first:
# restoring underneath a running API is how you get half-written rows and a
# worker inserting into tables that are being dropped.
#
# TOKEN_ENC_KEY must be the same one that was in use when the dump was taken.
# If it is not, the restore succeeds and every forge connection then fails to
# decrypt — which looks like a broken product rather than a wrong key. Three
# things stand in the way of that (W17-29):
#   1. an unset or malformed key is refused before anything is touched;
#   2. backup.sh writes <dump>.manifest with a FINGERPRINT (sha256 prefix) of
#      the key the dump was taken under; a different key is refused before
#      the schemas are dropped;
#   3. after loading, every stored forge credential is decrypted IN the api
#      image with the real vault code — never a second implementation — and
#      the restore exits non-zero if any of them fails. Nothing decrypted is
#      printed; neither is the key.
set -eu

RUNTIME="${RUNTIME:-podman}"
COMPOSE_FILE="${COMPOSE_FILE:-$(dirname "$0")/compose.yaml}"
ENV_FILE="${ENV_FILE:-$(dirname "$0")/.env}"
NO_MIGRATE=0
ASSUME_YES=0
PRODUCTION=0
VERIFY_ONLY=0
# Legacy PROJECT= is still read, but there is no default any more.
PROJECT="${REPOPULSE_PROJECT:-${PROJECT:-}}"
while :; do
  case "${1:-}" in
    --yes) ASSUME_YES=1; shift ;;
    --no-migrate) NO_MIGRATE=1; shift ;;
    --production) PRODUCTION=1; shift ;;
    --verify-only) VERIFY_ONLY=1; shift ;;
    --project=*) PROJECT="${1#--project=}"; shift ;;
    --project) PROJECT="${2:-}"; shift 2 ;;
    --) shift; break ;;
    -*) echo "unknown option: $1" >&2; exit 1 ;;
    *) break ;;
  esac
done
# ROLLBACK PATH (--no-migrate): restoring an older dump and then migrating
# forward would re-apply exactly the migrations you are trying to get away
# from — the database would end up at the new schema with the old data in it,
# which is the worst of both. Roll the image tag back first, then restore with
# --no-migrate, then start.
DUMP="${1:-}"

usage() {
  cat >&2 <<EOF
usage: restore.sh --project=<compose project> [--yes] [--no-migrate] [--production] <dump.sql>
       restore.sh --project=<compose project> --verify-only

The project is the one the stack was started with (REPOPULSE_PROJECT for
up.sh; 'repopulse' if it was never set). It is never assumed: a restore drops
every schema in the target database.
EOF
}

# ---------------------------------------------------------------- target ----
if [ -z "$PROJECT" ]; then
  echo "RESTORE REFUSED: no target project." >&2
  echo >&2
  echo "Say which compose project to restore INTO with --project=<name> or" >&2
  echo "REPOPULSE_PROJECT=<name>. To verify a backup, restore it into a disposable" >&2
  echo "project (docs/RUNBOOK.md 'Verify a backup'), never into the live one by" >&2
  echo "accident. The live install is --project=repopulse --production." >&2
  echo >&2
  usage
  exit 1
fi
if [ "$PROJECT" = "repopulse" ] && [ "$PRODUCTION" -ne 1 ]; then
  echo "RESTORE REFUSED: --project=repopulse is the live install." >&2
  echo >&2
  echo "This restore drops every schema in that database and replaces it with the" >&2
  echo "dump. If that is what you mean — disaster recovery on the real install —" >&2
  echo "add --production. To check a backup, use a disposable project instead:" >&2
  echo "    REPOPULSE_PROJECT=rp-verify ./deploy/up.sh" >&2
  echo "    ./deploy/restore.sh --project=rp-verify --yes <dump.sql>" >&2
  exit 1
fi

if [ "$VERIFY_ONLY" -ne 1 ]; then
  [ -n "$DUMP" ] || { usage; exit 1; }
  [ -f "$DUMP" ] || { echo "no such dump: $DUMP" >&2; exit 1; }
fi
[ -f "$ENV_FILE" ] || { echo "no env file at $ENV_FILE" >&2; exit 1; }
# shellcheck disable=SC1090
. "$ENV_FILE"

: "${POSTGRES_USER:=repopulse}"
: "${POSTGRES_DB:=repopulse}"
[ -n "${POSTGRES_PASSWORD:-}" ] || { echo "POSTGRES_PASSWORD is not set" >&2; exit 1; }

# ------------------------------------------------------------------- key ----
# Refused BEFORE the prompt and before anything is stopped or dropped. The
# value is never echoed: a scrollback with TOKEN_ENC_KEY in it is a compromised
# install (configure.mjs says the same).
key_problem=""
if [ -z "${TOKEN_ENC_KEY:-}" ]; then
  key_problem="TOKEN_ENC_KEY is not set in $ENV_FILE."
else
  case "$TOKEN_ENC_KEY" in
    *[!0-9a-fA-F]*) key_problem="TOKEN_ENC_KEY in $ENV_FILE is not hex." ;;
    *) [ "${#TOKEN_ENC_KEY}" -eq 64 ] || key_problem="TOKEN_ENC_KEY in $ENV_FILE is ${#TOKEN_ENC_KEY} characters; a valid key is 64 hex characters (32 bytes)." ;;
  esac
fi
if [ -n "$key_problem" ]; then
  echo "RESTORE REFUSED: $key_problem" >&2
  echo "Without the key this dump was taken under, every forge credential restored" >&2
  echo "here is undecryptable. Put the key that was in use at backup time into" >&2
  echo "$ENV_FILE (it is the other half of the backup — see docs/RUNBOOK.md)." >&2
  exit 1
fi

# A NON-REVERSIBLE fingerprint of the key (sha256 prefix), the same one
# backup.sh records in the manifest. It identifies a key; it does not reveal it.
sha256_hex() { # stdin -> 64 hex chars, whichever tool this host has
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -c1-64
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 | cut -c1-64
  else openssl dgst -sha256 -r | cut -c1-64
  fi
}
KEY_FP="sha256:$(printf '%s' "$TOKEN_ENC_KEY" | tr 'A-F' 'a-f' | sha256_hex | cut -c1-16)"

# Finding the container WITHOUT `compose ps -q`: podman-compose does not accept
# it, and a customer may be on either implementation. The compose label is set
# by both, so it is the portable handle.
service_container() {
  "$RUNTIME" ps --filter "label=com.docker.compose.project=$PROJECT" \
                --filter "label=com.docker.compose.service=$1" \
                --format '{{.Names}}' | head -1
}

compose() { "$RUNTIME" compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"; }
DEPLOY_DIR="$(cd "$(dirname "$COMPOSE_FILE")" && pwd)"

# The api service bind-mounts SCAN_RULES_DIR (compose resolves it shell-then-
# .env; up.sh defaults it to deploy/scan-rules). The credential check below
# runs the api image through compose, so the same default is needed here or
# the run fails at container creation on a host without /var/lib/repopulse.
if [ -z "${SCAN_RULES_DIR:-}" ]; then SCAN_RULES_DIR="$DEPLOY_DIR/scan-rules"; fi
export SCAN_RULES_DIR
mkdir -p "$SCAN_RULES_DIR"
# Same for the optional internal-CA directory (api + worker mount it). Read
# from .env first, so an operator's EXTRA_CA_DIR is kept, not replaced.
if [ -z "${EXTRA_CA_DIR:-}" ] && [ -f "$ENV_FILE" ]; then
  EXTRA_CA_DIR="$(sed -n 's/^EXTRA_CA_DIR=//p' "$ENV_FILE" | tail -n1)"
fi
if [ -z "${EXTRA_CA_DIR:-}" ]; then EXTRA_CA_DIR="$DEPLOY_DIR/ca"; fi
export EXTRA_CA_DIR
mkdir -p "$EXTRA_CA_DIR"

psql_in() { # $1 container; SQL on stdin; -tA output
  "$RUNTIME" exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" "$1" \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -v ON_ERROR_STOP=1 --quiet
}

# The row counts backup.sh records, in the same order, so before/after can be
# compared by eye and by the manifest check below. Missing tables (a database
# with no schema yet) count as "-" rather than aborting.
row_counts() { # $1 container -> "workspaces=N repos=N forge_connections=N pull_requests=N"
  out=""
  for t in workspaces repos forge_connections pull_requests; do
    n="$(printf 'select count(*) from %s;' "$t" | psql_in "$1" 2>/dev/null || echo '-')"
    out="$out $t=$n"
  done
  printf '%s' "${out# }"
}

# ------------------------------------------------- credential decrypt check --
# Runs INSIDE the api image, through compose, so it uses the stack's own
# DATABASE_URL and TOKEN_ENC_KEY (from env_file) and the same vault module the
# product decrypts with — packages/auth/src/credentials/vault.ts — rather than a
# copy of the algorithm in shell. tsx reads the program from stdin; resolution
# is from /app/apps/api, where the workspace packages are linked (the image's
# working directory is /app, where they are not). Prints counts and the ids
# that failed, never a plaintext and never the key.
verify_credentials() {
  compose run --rm --no-deps -T api sh -c 'cd /app/apps/api && exec tsx -' <<'TS'
import { credentials } from '@repopulse/auth';
import { createDb } from '@repopulse/shared';

const key = credentials.loadTokenKey();
const db = createDb(process.env.DATABASE_URL ?? '');
try {
  const rows = (await db.$client`
    select id, key_version, credential_ciphertext, credential_iv
    from forge_connections order by id`) as unknown as {
    id: number; key_version: number; credential_ciphertext: Uint8Array; credential_iv: Uint8Array;
  }[];
  const failed: number[] = [];
  for (const r of rows) {
    try {
      credentials.decryptCredential(
        { ciphertext: Buffer.from(r.credential_ciphertext), iv: Buffer.from(r.credential_iv), keyVersion: r.key_version },
        key,
      );
    } catch {
      failed.push(r.id);
    }
  }
  console.log(`[verify] forge credentials: ${rows.length - failed.length} of ${rows.length} decrypt with this TOKEN_ENC_KEY`);
  if (rows.length === 0) console.log('[verify] (no forge connections stored — the key was validated but nothing exercised it)');
  if (failed.length > 0) {
    console.error(`[verify] FAILED: connection id(s) ${failed.join(', ')} do not decrypt — TOKEN_ENC_KEY is not the key they were encrypted under`);
    process.exitCode = 2;
  }
} finally {
  await db.$client.end();
}
TS
}

if [ "$VERIFY_ONLY" -eq 1 ]; then
  echo "verifying stored credentials in project $PROJECT against the key in $ENV_FILE (fingerprint $KEY_FP)"
  CONTAINER="$(service_container postgres)"
  [ -n "$CONTAINER" ] || { echo "postgres container is not running in project $PROJECT" >&2; exit 1; }
  echo "rows: $(row_counts "$CONTAINER")"
  verify_credentials
  exit $?
fi

# ------------------------------------------------------------- manifest -----
# backup.sh writes <dump>.manifest beside the dump (W17-29). When it is there,
# the dump is checked against the sha256 it recorded, and the key against the
# fingerprint it recorded — BEFORE anything is dropped. An older dump with no
# manifest is still restored; the post-load decrypt check is then the only
# guard, and it still fails the restore rather than passing it.
MANIFEST="$DUMP.manifest"
M_KEY_FP=""; M_COUNTS=""
if [ -f "$MANIFEST" ]; then
  m_sha="$(sed -n 's/^DUMP_SHA256=//p' "$MANIFEST")"
  if [ -n "$m_sha" ]; then
    have_sha="$(sha256_hex < "$DUMP")"
    if [ "$have_sha" != "$m_sha" ]; then
      echo "RESTORE REFUSED: $DUMP does not match the sha256 in $MANIFEST." >&2
      echo "The dump was modified or truncated after backup.sh wrote it. Use another copy." >&2
      exit 1
    fi
  fi
  M_KEY_FP="$(sed -n 's/^TOKEN_ENC_KEY_FINGERPRINT=//p' "$MANIFEST")"
  if [ -n "$M_KEY_FP" ] && [ "$M_KEY_FP" != "$KEY_FP" ]; then
    echo "RESTORE REFUSED: TOKEN_ENC_KEY in $ENV_FILE is not the key this dump was taken under." >&2
    echo "  dump was encrypted under key $M_KEY_FP" >&2
    echo "  $ENV_FILE holds key      $KEY_FP" >&2
    echo "Restoring anyway would load every forge credential in an undecryptable form." >&2
    echo "Put the key that was in use at backup time into $ENV_FILE. (If the manifest" >&2
    echo "is wrong, delete it; the post-restore decrypt check will still refuse to" >&2
    echo "report success on credentials that do not open.)" >&2
    exit 1
  fi
  M_COUNTS="$(sed -n 's/^ROWS_//p' "$MANIFEST" | tr '[:upper:]' '[:lower:]' | tr '\n' ' ')"
  echo "manifest: $MANIFEST (dump sha256 ok, key fingerprint $KEY_FP matches)"
else
  echo "no manifest beside $DUMP (older backup): key checked after load only"
fi

if [ "$ASSUME_YES" -ne 1 ]; then
  printf 'This REPLACES the contents of database %s in compose project %s. Type yes to continue: ' "$POSTGRES_DB" "$PROJECT"
  read -r answer
  [ "$answer" = "yes" ] || { echo "aborted"; exit 1; }
fi

# STOP, THEN REMOVE BY LABEL — not `compose rm`. podman-compose has no `rm`
# subcommand at all (1.6.0: "invalid choice: 'rm'"), and the W11-03 script's
# `compose rm -sf ... || true` hid that, so under podman it restored underneath
# a running api and worker while saying it had stopped them (found by the
# W17-29 drill: the api was still up after a failed restore). `stop` exists in
# both providers; removal goes through the runtime by the compose labels both
# set, in dependency order, because podman turns depends_on into container
# requirements and refuses to remove api while web still exists. Removed
# rather than left stopped: a stopped container is not always recreated by a
# later `up -d`, and the worker in particular came back missing in W11-03.
echo "stopping app containers of project $PROJECT (postgres stays up)"
compose stop web api worker scan-runner >/dev/null 2>&1 || true
for svc in web api worker scan-runner migrate; do
  for id in $("$RUNTIME" ps -a --filter "label=com.docker.compose.project=$PROJECT" \
                             --filter "label=com.docker.compose.service=$svc" -q); do
    "$RUNTIME" rm -f "$id" >/dev/null
  done
done
for svc in web api worker scan-runner; do
  if [ -n "$(service_container "$svc")" ]; then
    echo "RESTORE REFUSED: $svc is still running in project $PROJECT after stop; not restoring underneath it." >&2
    exit 1
  fi
done

CONTAINER="$(service_container postgres)"
[ -n "$CONTAINER" ] || { echo "postgres container is not running in project $PROJECT" >&2; exit 1; }

echo "rows before: $(row_counts "$CONTAINER")"
[ -n "$M_COUNTS" ] && echo "rows in dump (manifest): $M_COUNTS"

# DROP AND RECREATE THE SCHEMAS FIRST, rather than trusting the dump's own
# `--clean` statements.
#
# Found by running a rollback drill (W11-03): restoring an OLDER dump into a
# NEWER schema fails part-way, because pg_dump's DROP statements cannot remove
# objects that tables added by later migrations still depend on —
# "constraint sboms_workspace_id_fkey depends on index workspaces_pkey".
# The restore then stops half-applied. Dropping the schemas outright is the
# only path that works in both directions, and rollback is exactly the
# direction people need it in.
echo "dropping existing schemas"
"$RUNTIME" exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" "$CONTAINER" \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 --quiet <<'SQL'
drop schema if exists drizzle cascade;
drop schema if exists public cascade;
create schema public;
SQL

echo "restoring $DUMP"
# ON_ERROR_STOP=1 so a broken dump fails loudly instead of leaving a database
# that is half the old data and half the new.
"$RUNTIME" exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" "$CONTAINER" \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 --quiet < "$DUMP"

if [ "$NO_MIGRATE" -eq 1 ]; then
  echo "skipping migrations (--no-migrate): the restored schema is left exactly as dumped"
else
  echo "running migrations (a dump from an older version may be behind)"
  compose run --rm migrate
fi

AFTER="$(row_counts "$CONTAINER")"
echo "rows after:  $AFTER"
if [ -n "$M_COUNTS" ] && [ "$AFTER " != "$M_COUNTS" ]; then
  echo "RESTORE INCOMPLETE: row counts after loading differ from the manifest." >&2
  echo "  manifest: $M_COUNTS" >&2
  echo "  loaded:   $AFTER" >&2
  echo "The app containers were NOT started. The dump or the load is not what the backup recorded." >&2
  exit 1
fi

# Credentials are checked BEFORE the app comes back. A restore whose forge
# connections cannot decrypt is not a successful restore, whatever psql said.
echo "checking that stored forge credentials decrypt with this TOKEN_ENC_KEY"
if ! verify_credentials; then
  echo >&2
  echo "RESTORE INCOMPLETE: the data is loaded but its forge credentials do not" >&2
  echo "decrypt with the TOKEN_ENC_KEY in $ENV_FILE. The app containers were NOT" >&2
  echo "started. Put the key that was in use when this dump was taken into" >&2
  echo "$ENV_FILE and run:  ./restore.sh --project=$PROJECT --verify-only" >&2
  exit 1
fi

# THE APP COMES BACK THROUGH up.sh, not a raw `compose up` (W17-29). up.sh is
# what derives CONTAINER_SOCKET for scan-runner and SCAN_RULES_DIR for the
# worker, and it verifies every service is actually running before it says so;
# a raw `up -d` here recreated scan-runner against compose's stock socket path
# and reported success over a container that could not start.
export REPOPULSE_PROJECT="$PROJECT"
if [ "$NO_MIGRATE" -eq 1 ]; then
  # NAMED SERVICES with --no-deps, not a bare `up`. Found by running the
  # rollback drill: `up -d` starts the one-shot migrate service too (as a
  # dependency of api), so the migrations you just skipped run anyway and the
  # rollback silently un-rolls itself in about two seconds, reporting success.
  # The migrate container was removed above, so up.sh has nothing to inspect —
  # it may have been the FAILED migrate of the upgrade being rolled back.
  echo "starting app containers (migrate deliberately not started)"
  "$DEPLOY_DIR/up.sh" --no-deps api worker scan-runner web
else
  echo "starting app containers"
  "$DEPLOY_DIR/up.sh"
fi

echo
echo "restore complete into project $PROJECT: rows and credentials verified above."
echo "Check your repository list, and that a forge connection still syncs."
