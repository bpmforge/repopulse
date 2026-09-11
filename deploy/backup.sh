#!/usr/bin/env sh
# RepoPulse backup (W11-03; manifest added in W17-29).
#
#   ./backup.sh                              # the live install (compose project 'repopulse')
#   ./backup.sh --project=rp-verify          # any other project
#   OUT_DIR=/backups ./backup.sh
#
# Runs against a RUNNING compose stack and needs nothing but this file, your
# deploy/.env and podman (or docker). No repo checkout, no shell inside the
# database container, no access to anything of ours.
#
# WHAT A BACKUP IS: the Postgres dump plus TOKEN_ENC_KEY. The dump alone cannot
# be restored into a working install — every stored forge credential is
# encrypted with that key, and without it a restore comes up with connections
# it can never authenticate. Store the key somewhere OTHER than beside the
# dump, or you have stored the lock and the key in the same envelope.
#
# WHAT IS WRITTEN (W17-29): <dump>.sql and <dump>.sql.manifest. The manifest
# records the dump's sha256, the row counts of the tables that matter, the
# migration count, and a NON-REVERSIBLE fingerprint of TOKEN_ENC_KEY (a sha256
# prefix — it identifies the key, it cannot reproduce it). restore.sh uses it
# to refuse a modified dump and a wrong key BEFORE dropping anything, and to
# compare row counts after loading. The key itself is never written or printed.
#
# Backing up is non-destructive, so unlike restore.sh the project may default
# to the live install: that is what the nightly cron line in docs/RUNBOOK.md
# backs up.
set -eu

RUNTIME="${RUNTIME:-podman}"
COMPOSE_FILE="${COMPOSE_FILE:-$(dirname "$0")/compose.yaml}"
ENV_FILE="${ENV_FILE:-$(dirname "$0")/.env}"
OUT_DIR="${OUT_DIR:-.}"
PROJECT="${REPOPULSE_PROJECT:-${PROJECT:-repopulse}}"
while :; do
  case "${1:-}" in
    --project=*) PROJECT="${1#--project=}"; shift ;;
    --project) PROJECT="${2:-}"; shift 2 ;;
    '') break ;;
    *) echo "usage: backup.sh [--project=<compose project>]" >&2; exit 1 ;;
  esac
done
[ -n "$PROJECT" ] || { echo "--project= must not be empty" >&2; exit 1; }

[ -f "$ENV_FILE" ] || { echo "no env file at $ENV_FILE" >&2; exit 1; }
# shellcheck disable=SC1090
. "$ENV_FILE"

: "${POSTGRES_USER:=repopulse}"
: "${POSTGRES_DB:=repopulse}"
[ -n "${POSTGRES_PASSWORD:-}" ] || { echo "POSTGRES_PASSWORD is not set in $ENV_FILE" >&2; exit 1; }

# The key is checked at backup time too: a dump taken while .env holds no key
# (or a mangled one) is a dump whose credentials no key will ever open, and
# that is better learned now than at the restore.
key_problem=""
if [ -z "${TOKEN_ENC_KEY:-}" ]; then
  key_problem="TOKEN_ENC_KEY is not set in $ENV_FILE"
else
  case "$TOKEN_ENC_KEY" in
    *[!0-9a-fA-F]*) key_problem="TOKEN_ENC_KEY in $ENV_FILE is not hex" ;;
    *) [ "${#TOKEN_ENC_KEY}" -eq 64 ] || key_problem="TOKEN_ENC_KEY in $ENV_FILE is not 64 hex characters" ;;
  esac
fi
if [ -n "$key_problem" ]; then
  echo "BACKUP REFUSED: $key_problem." >&2
  echo "A dump is only half a backup, and the running stack cannot be using this key" >&2
  echo "either. Fix $ENV_FILE first (the value is never printed here)." >&2
  exit 1
fi

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

psql_in() { # $1 container; SQL on stdin; -tA output
  "$RUNTIME" exec -i -e PGPASSWORD="$POSTGRES_PASSWORD" "$1" \
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -tA -v ON_ERROR_STOP=1 --quiet
}

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$OUT_DIR/repopulse-$STAMP.sql"

CONTAINER="$(service_container postgres)"
[ -n "$CONTAINER" ] || { echo "postgres container is not running in compose project $PROJECT" >&2; exit 1; }

# Row counts BEFORE the dump, so what the backup holds is on record next to it
# and restore.sh can compare what it loaded. Missing tables (a database with no
# schema yet) count as "-" rather than aborting.
COUNTS=""
for t in workspaces repos forge_connections pull_requests; do
  n="$(printf 'select count(*) from %s;' "$t" | psql_in "$CONTAINER" 2>/dev/null || echo '-')"
  COUNTS="$COUNTS $t=$n"
done
COUNTS="${COUNTS# }"
MIGRATIONS="$(printf 'select count(*) from drizzle.__drizzle_migrations;' | psql_in "$CONTAINER" 2>/dev/null || echo 0)"

# --clean --if-exists so the dump can be restored over an existing database
# without a manual drop; a restore that needs a hand-typed DROP is a restore
# somebody gets wrong at 3am.
"$RUNTIME" exec -e PGPASSWORD="$POSTGRES_PASSWORD" "$CONTAINER" \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists --no-owner --no-privileges \
  > "$OUT"

# A dump that failed halfway is still a file. Check it ended properly rather
# than discovering it at restore time.
tail -5 "$OUT" | grep -q "PostgreSQL database dump complete" || {
  echo "dump did not complete — $OUT is NOT a usable backup" >&2
  exit 1
}

BYTES="$(wc -c < "$OUT" | tr -d ' ')"
SHA="$(sha256_hex < "$OUT")"
{
  echo "REPOPULSE_BACKUP_FORMAT=1"
  echo "DUMP=$(basename "$OUT")"
  echo "DUMP_SHA256=$SHA"
  echo "DUMP_BYTES=$BYTES"
  echo "TAKEN_AT=$STAMP"
  echo "PROJECT=$PROJECT"
  echo "REPOPULSE_VERSION=${REPOPULSE_VERSION:-}"
  echo "MIGRATIONS_APPLIED=$MIGRATIONS"
  echo "TOKEN_ENC_KEY_FINGERPRINT=$KEY_FP"
  for kv in $COUNTS; do
    echo "ROWS_$(printf '%s' "${kv%%=*}" | tr '[:lower:]' '[:upper:]')=${kv#*=}"
  done
} > "$OUT.manifest"

echo "wrote $OUT ($BYTES bytes, sha256 $SHA)"
echo "      $OUT.manifest (rows: $COUNTS; migrations: $MIGRATIONS; key fingerprint $KEY_FP)"
echo
echo "NOT YET A COMPLETE BACKUP. Store TOKEN_ENC_KEY from $ENV_FILE separately;"
echo "without it, every forge credential in this dump is undecryptable."
