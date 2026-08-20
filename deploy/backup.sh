#!/usr/bin/env sh
# RepoPulse backup (W11-03).
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
set -eu

RUNTIME="${RUNTIME:-podman}"
COMPOSE_FILE="${COMPOSE_FILE:-$(dirname "$0")/compose.yaml}"
ENV_FILE="${ENV_FILE:-$(dirname "$0")/.env}"
OUT_DIR="${OUT_DIR:-.}"

[ -f "$ENV_FILE" ] || { echo "no env file at $ENV_FILE" >&2; exit 1; }
# shellcheck disable=SC1090
. "$ENV_FILE"

: "${POSTGRES_USER:=repopulse}"
: "${POSTGRES_DB:=repopulse}"
[ -n "${POSTGRES_PASSWORD:-}" ] || { echo "POSTGRES_PASSWORD is not set in $ENV_FILE" >&2; exit 1; }

PROJECT="${PROJECT:-repopulse}"

# Finding the container WITHOUT `compose ps -q`: podman-compose does not accept
# it, and a customer may be on either implementation. The compose label is set
# by both, so it is the portable handle.
service_container() {
  "$RUNTIME" ps --filter "label=com.docker.compose.project=$PROJECT" \
                --filter "label=com.docker.compose.service=$1" \
                --format '{{.Names}}' | head -1
}

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
OUT="$OUT_DIR/repopulse-$STAMP.sql"

CONTAINER="$(service_container postgres)"
[ -n "$CONTAINER" ] || { echo "postgres container is not running" >&2; exit 1; }

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
echo "wrote $OUT ($BYTES bytes)"
echo
echo "NOT YET A COMPLETE BACKUP. Store TOKEN_ENC_KEY from $ENV_FILE separately;"
echo "without it, every forge credential in this dump is undecryptable."
