#!/usr/bin/env bash
# dev-down.sh — stop the RepoPulse dev data tier. Pass --volumes to also
# wipe the named Postgres/Redis volumes (destroys local dev data).
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

COMPOSE_FILE="compose.dev.yaml"

if [ "${1:-}" = "--volumes" ]; then
  echo "Stopping dev data tier and removing volumes ($COMPOSE_FILE)..."
  podman compose -f "$COMPOSE_FILE" down --volumes
else
  echo "Stopping dev data tier ($COMPOSE_FILE)..."
  podman compose -f "$COMPOSE_FILE" down
fi
