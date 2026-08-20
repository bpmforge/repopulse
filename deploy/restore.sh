#!/usr/bin/env sh
# RepoPulse restore (W11-03).
#
#   ./restore.sh repopulse-20260819T120000Z.sql
#   ./restore.sh --no-migrate repopulse-...sql     (rolling BACK to an older version)
#   ./restore.sh --yes repopulse-...sql            (no confirmation prompt)
#
# Restores into the compose stack's Postgres. STOPS the app containers first:
# restoring underneath a running API is how you get half-written rows and a
# worker inserting into tables that are being dropped.
#
# TOKEN_ENC_KEY must be the same one that was in use when the dump was taken.
# If it is not, the restore succeeds and every forge connection then fails to
# decrypt — which looks like a broken product rather than a wrong key, so this
# script refuses to run without it being set.
set -eu

RUNTIME="${RUNTIME:-podman}"
COMPOSE_FILE="${COMPOSE_FILE:-$(dirname "$0")/compose.yaml}"
ENV_FILE="${ENV_FILE:-$(dirname "$0")/.env}"
NO_MIGRATE=0
ASSUME_YES=0
while :; do
  case "${1:-}" in
    --yes) ASSUME_YES=1; shift ;;
    --no-migrate) NO_MIGRATE=1; shift ;;
    *) break ;;
  esac
done
# ROLLBACK PATH (--no-migrate): restoring an older dump and then migrating
# forward would re-apply exactly the migrations you are trying to get away
# from — the database would end up at the new schema with the old data in it,
# which is the worst of both. Roll the image tag back first, then restore with
# --no-migrate, then start.
DUMP="${1:-}"

[ -n "$DUMP" ] || { echo "usage: restore.sh <dump.sql>" >&2; exit 1; }
[ -f "$DUMP" ] || { echo "no such dump: $DUMP" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "no env file at $ENV_FILE" >&2; exit 1; }
# shellcheck disable=SC1090
. "$ENV_FILE"

: "${POSTGRES_USER:=repopulse}"
: "${POSTGRES_DB:=repopulse}"
[ -n "${POSTGRES_PASSWORD:-}" ] || { echo "POSTGRES_PASSWORD is not set" >&2; exit 1; }
[ -n "${TOKEN_ENC_KEY:-}" ] || {
  echo "TOKEN_ENC_KEY is not set in $ENV_FILE." >&2
  echo "Restore refused: without the key this dump was taken under, every forge" >&2
  echo "credential restored here is undecryptable." >&2
  exit 1
}

PROJECT="${PROJECT:-repopulse}"

# Finding the container WITHOUT `compose ps -q`: podman-compose does not accept
# it, and a customer may be on either implementation. The compose label is set
# by both, so it is the portable handle.
service_container() {
  "$RUNTIME" ps --filter "label=com.docker.compose.project=$PROJECT" \
                --filter "label=com.docker.compose.service=$1" \
                --format '{{.Names}}' | head -1
}

if [ "$ASSUME_YES" -ne 1 ]; then
  printf 'This REPLACES the contents of database %s. Type yes to continue: ' "$POSTGRES_DB"
  read -r answer
  [ "$answer" = "yes" ] || { echo "aborted"; exit 1; }
fi

# `down` the app services rather than `stop`: podman-compose leaves a stopped
# container that a later `up -d` will not always recreate, and the worker in
# particular came back missing during the W11-03 drill.
echo "stopping app containers (postgres stays up)"
"$RUNTIME" compose -f "$COMPOSE_FILE" rm -sf api worker web >/dev/null 2>&1 || true

CONTAINER="$(service_container postgres)"
[ -n "$CONTAINER" ] || { echo "postgres container is not running" >&2; exit 1; }

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
  # NAMED SERVICES, not a bare `up -d`. Found by running the rollback drill:
  # `up -d` starts the one-shot migrate service too, so the migrations you just
  # skipped run anyway and the rollback silently un-rolls itself. The database
  # was back at the new schema within seconds, reporting success.
  echo "starting app containers (migrate deliberately not started)"
  # --no-deps, or compose starts `migrate` as a dependency of api and the
  # migrations you just skipped run anyway. The rollback silently un-rolls
  # itself in about two seconds and reports success.
  "$RUNTIME" compose -f "$COMPOSE_FILE" up -d --no-deps api worker web
else
  echo "running migrations (a dump from an older version may be behind)"
  "$RUNTIME" compose -f "$COMPOSE_FILE" run --rm migrate
  echo "starting app containers"
  "$RUNTIME" compose -f "$COMPOSE_FILE" up -d
fi

echo
echo "restore complete. Check: your repository list, and that a forge connection"
echo "still syncs — that is the test of whether TOKEN_ENC_KEY matched."
