#!/usr/bin/env bash
# Bring up the customer-hostable stack (W16-04).
#
# WHY THIS EXISTS, rather than "just run compose up".
#
# `podman compose -f deploy/compose.yaml up -d` on a clean host starts five of
# six services and leaves the WORKER dead:
#
#   Error: statfs /var/lib/repopulse/scan-rules: no such file or directory
#
# SCAN_RULES_DIR defaults to an absolute host path that nothing creates — it is
# filled later by scan-db-sync.sh — and a bind mount whose source is missing
# fails at container-creation time, before any of our code runs. So the worker
# cannot degrade gracefully: there is nothing running to degrade.
#
# The damage is not the dead worker, it is that the stack LOOKS healthy. The web
# tier comes up and answers 200 on :8099, so the operator sees a working product
# that will never ingest anything, and the only evidence is one line in a compose
# log they have already scrolled past. podman-compose's own exit status does not
# save them either — the failing run printed `exit status 125` while the wrapper
# around it exited 0.
#
# This script fixes both halves: it makes the mount source exist before compose
# runs, and it verifies afterwards that every service is actually up, exiting
# non-zero with the names of the ones that are not.
#
# The repo already ships deploy/scan-rules/ for exactly this reason — see its
# README — but the compose default pointed somewhere else and defeated it. That
# default is deliberately unchanged: /var/lib/repopulse/scan-rules is the right
# answer for a production host where the rules are refreshed by a timer and must
# survive a checkout being deleted. This script picks the shipped directory only
# when the operator has not chosen one.

set -euo pipefail

cd "$(dirname "$0")"

if [ ! -f .env ]; then
  echo "deploy/.env is missing. Copy .env.example and fill it in:" >&2
  echo "    cp deploy/.env.example deploy/.env" >&2
  exit 1
fi

# Absolute, because podman-compose does not resolve a relative bind-mount source
# against the compose file's directory — it resolves it against the caller's cwd,
# or not at all. `pwd` here is deploy/, since we cd'd above.
: "${SCAN_RULES_DIR:=$(pwd)/scan-rules}"
export SCAN_RULES_DIR

# Create it rather than fail on it. An empty rules directory is a WORKING stack
# with dependency scanning unavailable, which the Security tab already says
# plainly ("No dependency scan has run for this repository — the CVE scanner is
# not available yet, so this is not a clean bill of health"). A missing directory
# is a stack with no ingestion at all and no explanation. The first is a state a
# person can understand and fix; the second is not.
mkdir -p "$SCAN_RULES_DIR"

if command -v podman >/dev/null 2>&1; then
  COMPOSE=(podman compose)
elif command -v docker >/dev/null 2>&1; then
  COMPOSE=(docker compose)
else
  echo "Neither podman nor docker is on PATH." >&2
  exit 1
fi

echo "scan rules: $SCAN_RULES_DIR"
if [ -z "$(ls -A "$SCAN_RULES_DIR" 2>/dev/null | grep -v '^README.md$\|^\.gitignore$' || true)" ]; then
  echo "  (empty — dependency scanning will report itself unavailable until you"
  echo "   run deploy/scan-db-sync.sh, which needs ~2 GB for the grype database)"
fi

"${COMPOSE[@]}" -f compose.yaml up -d "$@" || true

# VERIFY, because the compose wrapper's exit status cannot be trusted: the run
# that left the worker dead still exited 0 through podman-compose. `migrate` is
# excluded on purpose — it is a one-shot job and having EXITED is its success.
EXPECTED="postgres redis api worker web"
failed=""
for svc in $EXPECTED; do
  if ! "${COMPOSE[@]}" -f compose.yaml ps --format '{{.Names}} {{.State}}' 2>/dev/null |
    grep -qE "(^|[_-])${svc}(_[0-9]+)?[[:space:]]+(running|Up)"; then
    failed="$failed $svc"
  fi
done

if [ -n "$failed" ]; then
  echo >&2
  echo "STACK IS NOT HEALTHY — these services are not running:$failed" >&2
  echo >&2
  echo "The web tier may still answer on the published port, so do not take a" >&2
  echo "loading page as proof the stack came up. Logs for one of them:" >&2
  echo "    podman compose -f deploy/compose.yaml logs${failed}" >&2
  exit 1
fi

echo
echo "All services running. Open http://localhost:${REPOPULSE_PORT:-8099}"
