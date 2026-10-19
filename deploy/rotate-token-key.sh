#!/usr/bin/env sh
# Rotate TOKEN_ENC_KEY on a running install (W20-10, UX_TODO ADM-45).
#
#   ./rotate-token-key.sh                       # the live install (project 'repopulse')
#   ./rotate-token-key.sh --project=rp-verify   # any other compose project
#   NEW_TOKEN_ENC_KEY=<64 hex> ./rotate-token-key.sh --yes
#
# WHEN: someone who could read deploy/.env (or a backup of the key) leaves, or
# the key may have been exposed. TOKEN_ENC_KEY seals every forge token, every
# connection's webhook secret and every model API key; a new key on its own
# makes all of them undecryptable, so they are re-sealed first.
#
# WHAT IT DOES, in order:
#   1. checks the current key in .env, and generates the new one (or takes
#      NEW_TOKEN_ENC_KEY from the environment);
#   2. a DRY RUN that opens every stored secret under the current key and says
#      how many there are — nothing is written, and anything unopenable stops
#      here;
#   3. stops the api and worker (nothing may seal a new secret under the old
#      key half-way through), re-seals everything in ONE transaction inside the
#      api image, with the real vault code;
#   4. keeps a copy of the old .env as .env.pre-rotate-<stamp> (mode 600) and
#      writes the new key into .env;
#   5. starts the api and worker again.
#
# Nobody is signed out: sessions are signed with SESSION_SECRET, not this key.
# Backups taken BEFORE the rotation can only be restored with the OLD key —
# keep the old key with them (it is in the .env.pre-rotate copy), and take a
# fresh backup now. Neither key is ever printed; the new key reaches the
# container on stdin, never on a command line `ps` can show.
set -eu

RUNTIME="${RUNTIME:-podman}"
COMPOSE_FILE="${COMPOSE_FILE:-$(dirname "$0")/compose.yaml}"
ENV_FILE="${ENV_FILE:-$(dirname "$0")/.env}"
PROJECT="${REPOPULSE_PROJECT:-${PROJECT:-repopulse}}"
ASSUME_YES=0
while :; do
  case "${1:-}" in
    --yes) ASSUME_YES=1; shift ;;
    --project=*) PROJECT="${1#--project=}"; shift ;;
    --project) PROJECT="${2:-}"; shift 2 ;;
    '') break ;;
    *) echo "usage: rotate-token-key.sh [--project=<compose project>] [--yes]" >&2; exit 1 ;;
  esac
done
[ -n "$PROJECT" ] || { echo "--project= must not be empty" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "no env file at $ENV_FILE" >&2; exit 1; }

hex64() { # $1 value -> exit 0 when it is 64 hex characters
  case "$1" in
    ''|*[!0-9a-fA-F]*) return 1 ;;
    *) [ "${#1}" -eq 64 ] ;;
  esac
}

# The current key, read from .env without sourcing anything else into this
# shell's view of NEW_TOKEN_ENC_KEY.
CURRENT="$(sed -n 's/^TOKEN_ENC_KEY=//p' "$ENV_FILE" | tail -n1 | tr -d '"'"'"' \r')"
hex64 "$CURRENT" || {
  echo "ROTATION REFUSED: TOKEN_ENC_KEY in $ENV_FILE is missing or not 64 hex characters." >&2
  echo "The running stack cannot be using it either; fix .env first (the value is never printed)." >&2
  exit 1
}

NEW="${NEW_TOKEN_ENC_KEY:-}"
if [ -z "$NEW" ]; then
  if command -v openssl >/dev/null 2>&1; then
    NEW="$(openssl rand -hex 32)"
  else
    NEW="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  fi
fi
hex64 "$NEW" || { echo "ROTATION REFUSED: NEW_TOKEN_ENC_KEY is not 64 hex characters." >&2; exit 1; }
[ "$(printf '%s' "$NEW" | tr 'A-F' 'a-f')" != "$(printf '%s' "$CURRENT" | tr 'A-F' 'a-f')" ] || {
  echo "ROTATION REFUSED: the new key is the same as the current one." >&2
  exit 1
}

sha256_hex() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | cut -c1-64
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 | cut -c1-64
  else openssl dgst -sha256 -r | cut -c1-64
  fi
}
fingerprint() { printf 'sha256:%s' "$(printf '%s' "$1" | tr 'A-F' 'a-f' | sha256_hex | cut -c1-16)"; }

compose() { "$RUNTIME" compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"; }

# The re-seal runs in the api image with the stack's own DATABASE_URL and the
# CURRENT key (env_file); the new key arrives on stdin.
reseal() { # $1 = --dry-run or empty
  printf '%s\n' "$NEW" | compose run --rm --no-deps -T api sh -c \
    "read -r NEW_TOKEN_ENC_KEY && export NEW_TOKEN_ENC_KEY && cd /app/apps/api && exec tsx src/cli/rotate-token-key.ts $1"
}

echo "Rotating TOKEN_ENC_KEY for compose project $PROJECT"
echo "  current key $(fingerprint "$CURRENT") -> new key $(fingerprint "$NEW")"
echo
echo "Dry run (nothing is written):"
reseal --dry-run || { echo "ROTATION STOPPED at the dry run; nothing was changed." >&2; exit 1; }

if [ "$ASSUME_YES" -ne 1 ]; then
  printf 'Stop the api and worker, re-seal, and write the new key to %s? [y/N] ' "$ENV_FILE"
  read -r answer
  case "$answer" in y|Y|yes|YES) ;; *) echo "Nothing changed."; exit 1 ;; esac
fi

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
BACKUP_ENV="$ENV_FILE.pre-rotate-$STAMP"
( umask 077 && cp "$ENV_FILE" "$BACKUP_ENV" )

compose stop api worker
if ! reseal ""; then
  echo "ROTATION FAILED: nothing was changed (one transaction). Starting the api and worker again on the current key." >&2
  compose up -d api worker
  exit 1
fi

# Replace exactly the TOKEN_ENC_KEY line; everything else in .env stays as it was.
TMP="$ENV_FILE.rotate-tmp"
( umask 077 && awk -v k="$NEW" 'BEGIN{done=0} /^TOKEN_ENC_KEY=/{ if(!done){print "TOKEN_ENC_KEY=" k; done=1}; next } {print} END{ if(!done) print "TOKEN_ENC_KEY=" k }' "$ENV_FILE" > "$TMP" )
mv "$TMP" "$ENV_FILE"

compose up -d api worker

echo
echo "Done. TOKEN_ENC_KEY is now $(fingerprint "$NEW")."
echo "  - The old .env is kept as $BACKUP_ENV (mode 600). Backups taken before"
echo "    now need the OLD key from it: store that key with those backups, then"
echo "    delete the copy from this server."
echo "  - Store the NEW key somewhere other than beside your backups, and take a"
echo "    fresh backup now: ./backup.sh"
echo "  - Nobody was signed out (sessions use SESSION_SECRET, not this key)."
