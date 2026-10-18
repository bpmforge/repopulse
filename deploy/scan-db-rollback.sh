#!/usr/bin/env bash
# Goes back to the previous vulnerability database (W19-06).
#
# Only possible when the sync ran with SCAN_KEEP_PREVIOUS_DB=1, which keeps one
# earlier copy as vuln-db.prev (it costs a third ~1.9 GiB copy of disk while the
# next sync stages: provision 8 GB, not 5). The two are SWAPPED rather than the
# newer one deleted, so a rollback can itself be undone by running this again.
#
# Stop the worker's scans first if you can; the swap is two renames, so a scan
# that starts between them sees no database and reports it, never a clean result.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
env_value() {
  if [ -n "${!1:-}" ]; then printf '%s' "${!1}"
  elif [ -f "$SCRIPT_DIR/.env" ]; then sed -n "s/^$1=//p" "$SCRIPT_DIR/.env" | tail -n1; fi
}
DEST="$(env_value SCAN_RULES_DIR)"
: "${DEST:=$SCRIPT_DIR/scan-rules}"
LIVE="$DEST/vuln-db"
PREV="$DEST/vuln-db.prev"

if [ ! -d "$PREV" ]; then
  echo "[scan-db-rollback] no previous database at $PREV - run the sync with SCAN_KEEP_PREVIOUS_DB=1 first" >&2
  exit 1
fi
if [ ! -d "$LIVE" ]; then
  echo "[scan-db-rollback] no live database at $LIVE to swap with" >&2
  exit 1
fi

SWAP="$DEST/vuln-db.swap"
rm -rf "$SWAP"
mv "$LIVE" "$SWAP"
mv "$PREV" "$LIVE"
mv "$SWAP" "$PREV"
echo "[scan-db-rollback] swapped: $LIVE is now the previous database; the one you left is $PREV (run again to undo)"
