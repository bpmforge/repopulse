#!/usr/bin/env bash
# Bring up the LOCAL DEMO stack (W16-60).
#
#   ./deploy/demo.sh          # build if needed, start, wait, print where to go
#   ./deploy/demo.sh down     # stop it
#   ./deploy/demo.sh reset    # stop it AND delete the database volume
#
# WHY THIS EXISTS rather than "just run compose up", for the same reason up.sh
# does: podman-compose can start most of a stack, leave one service dead, and
# exit 0 — so the operator sees a web tier answering 200 and a product that will
# never ingest anything. This waits for the entrance to actually answer and then
# names any service that is not running, exiting non-zero if one is missing.
#
# Unlike up.sh there is no .env to check: the demo stack has no secrets worth
# having, which is the whole point of it being loopback-only.

set -euo pipefail

cd "$(dirname "$0")/.."

COMPOSE_FILE=deploy/compose.demo.yaml
PORT="${REPOPULSE_DEMO_PORT:-8090}"
URL="http://localhost:${PORT}"

# podman on this machine, docker elsewhere — whichever is present.
if command -v docker >/dev/null 2>&1; then
  COMPOSE=(docker compose)
elif command -v podman >/dev/null 2>&1; then
  COMPOSE=(podman compose)
else
  echo "Neither docker nor podman is installed." >&2
  exit 1
fi

case "${1:-up}" in
  down)
    "${COMPOSE[@]}" -f "$COMPOSE_FILE" down
    exit 0
    ;;
  reset)
    # -v takes the volume with it, so the next start is a genuinely first boot:
    # empty warehouse, no connection, the bootstrap admin created again. That is
    # the state the demo is FOR, and the only way to get back to it.
    "${COMPOSE[@]}" -f "$COMPOSE_FILE" down -v
    echo "Reset. The next start will be a first boot again."
    exit 0
    ;;
  up) ;;
  *)
    echo "usage: $0 [up|down|reset]" >&2
    exit 2
    ;;
esac

echo "Building and starting the demo stack (the first build takes a few minutes)…"
"${COMPOSE[@]}" -f "$COMPOSE_FILE" up -d --build

# WAIT FOR THE ENTRANCE, not for compose to return. compose returning means the
# containers were created, which is a different fact from the product answering.
echo -n "Waiting for ${URL} "
for _ in $(seq 1 90); do
  if curl -fsS -o /dev/null "${URL}/healthz" 2>/dev/null; then
    ready=1
    break
  fi
  echo -n "."
  sleep 2
done
echo

if [ "${ready:-0}" != "1" ]; then
  echo "The demo did not answer on ${URL} within 3 minutes." >&2
  echo "Logs:  ${COMPOSE[*]} -f ${COMPOSE_FILE} logs" >&2
  exit 1
fi

# AND CHECK EVERY SERVICE, because the entrance answering says nothing about the
# worker — which is the half that does the ingesting.
#
# Checked against `compose ps` WITHOUT `--filter`: podman-compose does not
# support that flag and answers with its usage text, so the first version of
# this check found nothing running and declared a healthy stack broken. A
# launcher that cries wolf gets ignored exactly like one that stays silent.
#
# The container NAME is what identifies the service in both runtimes
# (<project>_<service>_1 under podman-compose, <project>-<service>-1 under
# docker compose), and "Up" is what both print for a running one.
ps_out="$("${COMPOSE[@]}" -f "$COMPOSE_FILE" ps 2>/dev/null || true)"
missing=""
for svc in postgres redis forge api worker web; do
  if ! printf '%s\n' "$ps_out" | grep -E "[_-]${svc}[_-]1" | grep -q "Up"; then
    missing="${missing} ${svc}"
  fi
done

if [ -n "$missing" ]; then
  echo "These services are NOT running:${missing}" >&2
  echo "The product will look like it works and will not ingest anything." >&2
  echo "Logs:  ${COMPOSE[*]} -f ${COMPOSE_FILE} logs${missing}" >&2
  exit 1
fi

# READ FROM THE FIXTURE, not copied into this script. The value changing and
# this file still printing the old one would break the single step the operator
# cannot work out for themselves.
FIXTURE_TOKEN=$(grep -oE "ghp_[A-Za-z0-9_]+" packages/shared/src/testing/fake/forge.ts | head -1)

cat <<EOF

  RepoPulse demo is up.

    ${URL}
    demo@repopulse.local / demo-password-change-me

  It starts EMPTY, on purpose — everything from here is done in the UI:

    0. Sign in, and the product will make you choose a new password. That is
       the real first-boot behaviour for an account created from ADMIN_PASSWORD,
       not a demo quirk — an install whose admin keeps the password it was
       handed is one nobody changed.
    1. Admin → Connections.  Paste the fixture token:
         ${FIXTURE_TOKEN}
       Leave the instance URL blank; the stack already points at the fixture.
    2. Select the repositories to track, and press Track.
    3. Watch Admin → Sync.  The backfill lands, then the repos go live.
    4. Org Overview and the repo tabs fill in as the warehouse does.

  Optional, also in the UI:
    Admin → Models     point Tier-2 at a local LLM (nothing else needs it)
    Admin → Settings   bot list, stale-PR window, health weights
    Repo → Security    run the scanners

  Stop it:   ./deploy/demo.sh down
  Start over: ./deploy/demo.sh reset

EOF
