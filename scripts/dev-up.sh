#!/usr/bin/env bash
# dev-up.sh — start the RepoPulse dev data tier (Postgres 16 + Redis 7.2).
# W0-02: podman compose up, wait for both healthchecks to go healthy.
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT" || exit 1

COMPOSE_FILE="compose.dev.yaml"

# The Podman VM has to be up before `podman compose` means anything. On macOS
# and Windows a crashed or rebooted host leaves the machine stopped, and every
# compose command then fails with "Cannot connect to Podman" — which reads like
# a compose problem and is not one. On Linux podman is native, there is no
# machine, and this block is a no-op because `podman info` already succeeds.
if ! podman info >/dev/null 2>&1; then
  if podman machine list --format '{{.Name}}' 2>/dev/null | grep -q .; then
    echo "Podman VM is not running. Starting it..."
    # NOT fatal on non-zero. `podman machine stop` returns before the VM has
    # fully settled, so a start issued right after it can exit 1 with "already
    # running" while genuinely bringing the machine up. The `podman info`
    # recheck below is the arbiter; under `set -e` an unguarded start would
    # kill this script before that recheck ever ran.
    podman machine start || true
  else
    echo "FAIL: cannot reach Podman, and there is no machine to start." >&2
    echo "      On macOS/Windows: podman machine init && podman machine start" >&2
    echo "      On Linux: check the podman service is installed and running." >&2
    exit 1
  fi

  if ! podman info >/dev/null 2>&1; then
    echo "FAIL: Podman is still unreachable after starting the machine." >&2
    exit 1
  fi
fi

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
