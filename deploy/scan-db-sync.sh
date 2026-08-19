#!/usr/bin/env bash
# Host-side scan data sync (W8-12, SECURITY_SUITE.md §2.2, NFR-14).
#
# THE WHOLE POINT: the container that runs third-party scan binaries over a
# customer's source has --network=none. It therefore cannot fetch a rulepack or
# a vulnerability database, and that is not an inconvenience to work around —
# it is the control. This script is the other side of it: it runs on the HOST,
# on a schedule, fetches what the scanners need into a directory, and that
# directory is mounted read-only into the scan container.
#
# Run it from cron/systemd nightly:
#   0 3 * * *  /opt/repopulse/deploy/scan-db-sync.sh >> /var/log/repopulse-scan-sync.log 2>&1
#
# Exit codes: 0 = everything synced, 1 = a source failed. A partial sync is
# reported loudly rather than left to look like a successful one, because a
# scanner running against a stale rulepack still reports findings and still
# looks green.
set -euo pipefail

DEST="${SCAN_RULES_DIR:-/var/lib/repopulse/scan-rules}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
FAILED=0

log() { printf '[scan-db-sync] %s\n' "$*"; }

mkdir -p "$DEST"

# ---- 1. Our own rulepacks -------------------------------------------------
# Shipped in the repository rather than fetched from a registry: SECURITY_SUITE
# §3.3 bars Semgrep's registry packs (p/*, --config auto) for service use on
# licence grounds, so the packs we run are ours and travel with the code.
if [ -d "$REPO_ROOT/packages/security/rulepacks" ]; then
  log "syncing in-house rulepacks"
  # REPLACED, not merged. Two reasons, both found by running this twice:
  # the files are chmod 0444 below, so a second copy over them fails with
  # "Permission denied"; and a rule DELETED upstream would otherwise live on
  # in the mount forever, which is the failure mode where a scanner keeps
  # firing a rule that was withdrawn.
  rm -rf "$DEST/rulepacks"
  install -d "$DEST/rulepacks"
  cp -R "$REPO_ROOT/packages/security/rulepacks/." "$DEST/rulepacks/"
  find "$DEST/rulepacks" -type f -exec chmod 0444 {} +
  ( cd "$DEST/rulepacks" && find . -type f -print0 | sort -z | xargs -0 shasum -a 256 ) \
    > "$DEST/rulepacks.sha256"
  log "rulepacks synced: $(wc -l < "$DEST/rulepacks.sha256" | tr -d ' ') files"
else
  log "ERROR: no rulepack directory at $REPO_ROOT/packages/security/rulepacks"
  FAILED=1
fi

# ---- 2. Vulnerability databases -------------------------------------------
# NOT IMPLEMENTED, and deliberately noisy about it. grype/OSV/KEV are what the
# dependency scanner (W8-06) needs, and W8-06 is blocked because none of those
# tools are installed. Writing a fetch here for a tool nobody can run would be
# code that has never executed, pretending to be a control.
#
# When W8-06 unblocks, this is where the pinned, checksum-verified downloads
# go — into "$DEST/vuln-db" — and the scan container gets them the same way it
# gets the rulepacks: read-only, host-fetched, never over its own network.
if [ "${SCAN_SYNC_VULN_DB:-0}" = "1" ]; then
  log "ERROR: vulnerability-database sync is not implemented (W8-06 is blocked:"
  log "       syft/grype/osv-scanner are not installed). Unset SCAN_SYNC_VULN_DB."
  FAILED=1
else
  log "vulnerability-database sync: skipped (not implemented — see W8-06)"
fi

if [ "$FAILED" -ne 0 ]; then
  log "FAILED — the scan mount may be stale or incomplete"
  exit 1
fi

log "done: $DEST"
