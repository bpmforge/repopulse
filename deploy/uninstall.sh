#!/usr/bin/env sh
# Uninstall RepoPulse (W20-15, UX_TODO X-27).
#
#   ./uninstall.sh                               # the live install (compose project 'repopulse')
#   ./uninstall.sh --project=rp-verify           # any other compose project
#   ./uninstall.sh --keep-webhooks               # skip step 1 (the forge is already gone)
#
# Taking the stack down is not the same as removing the product. Tracking a
# repository registers a push webhook on it, and left behind, every repository
# keeps sending deliveries that fail to a server that no longer exists. So,
# IN THIS ORDER (each step asks first unless --yes):
#
#   1. removes every webhook RepoPulse registered, through the running api
#      image and the budgeted forge client (needs the stack up: it reads which
#      repositories and connections there are from the database);
#   2. offers a final backup.sh export, so nothing is lost by accident;
#   3. `down -v`: stops the stack and deletes its volumes (database, Redis,
#      generated reports) — and the named scan scratch and Claude CLI volumes;
#   4. deletes the scan-rules and internal-CA folders;
#   5. prints what only you can do: the cron lines to delete, and the forge
#      tokens and CI tokens to revoke on the forge and in your pipelines.
#
# Backups you took are NOT deleted: they are yours, wherever OUT_DIR put them.
set -eu

RUNTIME="${RUNTIME:-podman}"
DEPLOY_DIR="$(dirname "$0")"
COMPOSE_FILE="${COMPOSE_FILE:-$DEPLOY_DIR/compose.yaml}"
ENV_FILE="${ENV_FILE:-$DEPLOY_DIR/.env}"
PROJECT="${REPOPULSE_PROJECT:-${PROJECT:-repopulse}}"
ASSUME_YES=0
KEEP_WEBHOOKS=0
while :; do
  case "${1:-}" in
    --yes) ASSUME_YES=1; shift ;;
    --keep-webhooks) KEEP_WEBHOOKS=1; shift ;;
    --project=*) PROJECT="${1#--project=}"; shift ;;
    --project) PROJECT="${2:-}"; shift 2 ;;
    '') break ;;
    *) echo "usage: uninstall.sh [--project=<compose project>] [--keep-webhooks] [--yes]" >&2; exit 1 ;;
  esac
done
[ -n "$PROJECT" ] || { echo "--project= must not be empty" >&2; exit 1; }
[ -f "$ENV_FILE" ] || { echo "no env file at $ENV_FILE" >&2; exit 1; }

env_value() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n1 | tr -d '"'"'"' \r'; }
SCAN_RULES_DIR="$(env_value SCAN_RULES_DIR)"; SCAN_RULES_DIR="${SCAN_RULES_DIR:-/var/lib/repopulse/scan-rules}"
EXTRA_CA_DIR="$(env_value EXTRA_CA_DIR)"; EXTRA_CA_DIR="${EXTRA_CA_DIR:-/var/lib/repopulse/ca}"
PUBLIC_BASE_URL="$(env_value PUBLIC_BASE_URL)"

compose() { "$RUNTIME" compose -p "$PROJECT" -f "$COMPOSE_FILE" "$@"; }

confirm() { # $1 question -> 0 on yes
  [ "$ASSUME_YES" -eq 1 ] && return 0
  printf '%s [y/N] ' "$1"
  read -r answer
  case "$answer" in y|Y|yes|YES) return 0 ;; *) return 1 ;; esac
}

echo "Uninstalling RepoPulse (compose project $PROJECT)"
echo

# 1. Webhooks, while the database still says where they are.
if [ "$KEEP_WEBHOOKS" -eq 1 ]; then
  echo "1. Webhooks: skipped (--keep-webhooks). Remove them in the forge by hand."
elif confirm "1. Remove the webhooks RepoPulse registered on your forge (pointing at ${PUBLIC_BASE_URL:-PUBLIC_BASE_URL})?"; then
  if compose run --rm --no-deps -T api sh -c "cd /app/apps/api && exec tsx src/cli/remove-webhooks.ts"; then
    echo "   Webhooks removed."
    echo "   Hooks are matched by their delivery address: any registered under an earlier"
    echo "   PUBLIC_BASE_URL are not touched. Remove those in the forge by hand."
  else
    echo "   Some webhooks were not removed (listed above). Remove those in the forge:" >&2
    echo "   repository Settings -> Webhooks, the one pointing at ${PUBLIC_BASE_URL:-your RepoPulse address}." >&2
    confirm "   Carry on with the uninstall anyway?" || { echo "Stopped. Nothing else was changed."; exit 1; }
  fi
else
  echo "   Skipped. Every tracked repository will keep sending deliveries to ${PUBLIC_BASE_URL:-this server}."
fi
echo

# 2. A last export.
if confirm "2. Take a final backup first (deploy/backup.sh, into ${OUT_DIR:-the current directory})?"; then
  "$DEPLOY_DIR/backup.sh" --project="$PROJECT"
  echo "   The backup is useless without TOKEN_ENC_KEY: copy it out of $ENV_FILE now if you may restore."
fi
echo

# 3. The stack and its data.
confirm "3. Stop the stack and DELETE its volumes (database, Redis, reports, scan scratch, Claude CLI)?" || {
  echo "Stopped before deleting anything. The webhooks step (if run) is already done."
  exit 1
}
compose down -v
# Fixed-name volumes outlive `down -v` when another compose file declared them.
"$RUNTIME" volume rm -f repopulse-scan-scratch >/dev/null 2>&1 || true
"$RUNTIME" volume rm -f "${PROJECT}_claude-cli" >/dev/null 2>&1 || true
echo

# 4. Host folders.
for dir in "$SCAN_RULES_DIR" "$EXTRA_CA_DIR"; do
  [ -d "$dir" ] || continue
  if confirm "4. Delete $dir?"; then
    rm -rf "$dir" 2>/dev/null || echo "   Could not delete $dir (owned by root?): sudo rm -rf $dir" >&2
  fi
done
echo

# 5. What only you can do.
cat <<EOF
5. Left for you to do — RepoPulse cannot do these for you:

   - Delete the RepoPulse cron lines (crontab -e as the user who ran install.sh):
     the nightly backup.sh and scan-db-sync.sh entries.
   - Revoke the forge access tokens (PATs) you gave RepoPulse, on the forge:
     GitHub: Settings -> Developer settings -> Personal access tokens;
     GitLab: User settings -> Access tokens; Gitea: Settings -> Applications.
     A GitHub App: uninstall it from the organisation's Installed GitHub Apps.
   - Remove the REPOPULSE_TOKEN CI secrets from your pipelines (the CI tokens
     died with the database, but the pipelines still hold them).
   - Delete $ENV_FILE once you no longer need TOKEN_ENC_KEY for old backups.
   - Delete the images if you want the disk back: $RUNTIME image ls | grep repopulse
EOF
