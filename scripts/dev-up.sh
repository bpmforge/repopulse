#!/usr/bin/env bash
# dev-up.sh — start the RepoPulse dev data tier (Postgres 16 + Redis 7.2).
# W0-02: podman compose up, wait for both healthchecks to go healthy.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

COMPOSE_FILE="compose.dev.yaml"

echo "Starting dev data tier ($COMPOSE_FILE)..."
podman compose -f "$COMPOSE_FILE" up -d

wait_healthy() {
  local name="$1"
  local tries=0
  local max_tries=30
  until [ "$(podman inspect --format '{{.State.Health.Status}}' "$name" 2>/dev/null)" = "healthy" ]; do
    tries=$((tries + 1))
    if [ "$tries" -ge "$max_tries" ]; then
      echo "FAIL: $name did not become healthy in time" >&2
      podman logs "$name" 2>&1 | tail -40 >&2
      exit 1
    fi
    sleep 2
  done
  echo "OK: $name is healthy"
}

wait_healthy repopulse-postgres
wait_healthy repopulse-redis

echo "Dev data tier is up: postgres on 127.0.0.1:5432, redis on 127.0.0.1:6379"
