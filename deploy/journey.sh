#!/usr/bin/env bash
# The COMPLETE CUSTOMER JOURNEY, from an empty disposable install (W17-30).
#
#   ./deploy/journey.sh run            # reset the demo stack, run the journey, keep evidence
#   ./deploy/journey.sh ctl stop worker    # the drills' hands (used by the spec, usable by you)
#   ./deploy/journey.sh ctl start worker
#   ./deploy/journey.sh ctl vulndb attach  # make the CVE database appear mid-run
#   ./deploy/journey.sh down           # stop the stack it started
#
# WHAT THIS PROVES, and what it does not. It boots the DEMO stack — the same
# api/worker/web images a customer runs, pointed at the fixture forge — plus one
# overlay service, a fixture model (deploy/compose.journey.yaml). Then it drives
# the product through a browser exactly as a newcomer would: first sign-in and
# the forced password change, connecting a token, choosing repositories,
# watching the backfill go live, pointing Tier-2 at the model, running scans,
# and the failure drills the ticket names. Every screen the spec captures shows
# data THIS run created; nothing is seeded.
#
# It does NOT prove the product against a real forge. That is a separate,
# credentialed run (e2e/smoke-real-forge.spec.ts) and its evidence is recorded
# separately — neither substitutes for the other (acceptance 4).
#
# EVIDENCE lands under docs/work/product-completion/evidence/w17-30-journey-<date>/:
# numbered screenshots, facts.jsonl (one line per thing the spec observed),
# model-requests.txt (what the product actually sent the model), run.json (tip
# SHA, timings, exit code) and the compose logs (*.log, gitignored — the
# summary markdown quotes what matters, as W17-29's does).
#
# SCAN RULES are staged into a private directory holding only the rulepacks,
# NOT the vulnerability database: the journey starts with the CVE database
# absent on purpose (the "unavailable scanner data" drill), and `ctl vulndb
# attach` clones it in when the spec reaches the recovery half. The clone is
# APFS/reflink where available, so a 2 GB database costs seconds, not a copy.

set -euo pipefail

cd "$(dirname "$0")/.."

OVERLAY=deploy/compose.journey.yaml
DEMO_FILE=deploy/compose.demo.yaml
PORT="${REPOPULSE_DEMO_PORT:-8090}"
URL="http://localhost:${PORT}"
# Under the repo, not $TMPDIR: podman machine on macOS shares /Users with the
# VM and a bind mount has to be a path the VM can see. Gitignored.
RULES_DIR="${JOURNEY_RULES_DIR:-$(pwd)/deploy/journey/.rules}"
SOURCE_RULES="${SCAN_RULES_SOURCE:-$(pwd)/deploy/scan-rules}"
EVIDENCE_DIR="${JOURNEY_EVIDENCE_DIR:-docs/work/product-completion/evidence/w17-30-journey-$(date -u +%Y%m%d)}"

# The same runtime pick and socket derivation as demo.sh, so `ctl` reaches the
# containers demo.sh started rather than a differently-named project.
if command -v docker >/dev/null 2>&1; then
  COMPOSE=(docker compose)
  RT=docker
elif command -v podman >/dev/null 2>&1; then
  COMPOSE=(podman compose)
  RT=podman
else
  echo "Neither docker nor podman is installed." >&2
  exit 1
fi
: "${SCAN_RUNTIME:=$RT}"
if [ -z "${CONTAINER_SOCKET:-}" ]; then
  if [ "$RT" = docker ]; then
    CONTAINER_SOCKET=/var/run/docker.sock
  else
    CONTAINER_SOCKET="$(podman info --format '{{.Host.RemoteSocket.Path}}' 2>/dev/null | sed 's#^unix://##' || true)"
    : "${CONTAINER_SOCKET:=/run/user/$(id -u)/podman/podman.sock}"
  fi
fi
export SCAN_RUNTIME CONTAINER_SOCKET
export SCAN_RULES_DIR="$RULES_DIR"
export DEMO_COMPOSE_OVERLAY="$OVERLAY"
export DEMO_EXTRA_SERVICES=model

compose() { "${COMPOSE[@]}" -f "$DEMO_FILE" -f "$OVERLAY" "$@"; }

# Reflink/clone copy where the filesystem offers it (APFS `cp -c`, btrfs/xfs
# `--reflink=auto`); a plain copy otherwise. Directory-recursive.
clone_dir() {
  local from="$1" to="$2"
  if [ "$(uname -s)" = Darwin ]; then
    cp -Rc "$from" "$to" 2>/dev/null || cp -R "$from" "$to"
  else
    cp -R --reflink=auto "$from" "$to"
  fi
}

# The synced vulnerability database is read-only (grype writes it 0444 in a
# 0555 directory) and the clone keeps that, so a plain rm -rf refuses to take
# it back out. Make it ours first.
remove_dir() {
  [ -e "$1" ] || return 0
  chmod -R u+w "$1" 2>/dev/null || true
  rm -rf "$1"
}

stage_rules() {
  if [ ! -d "$SOURCE_RULES/rulepacks" ]; then
    echo "No rulepacks under $SOURCE_RULES — run ./deploy/scan-db-sync.sh first; the semgrep scan needs them." >&2
    exit 1
  fi
  remove_dir "$RULES_DIR"
  mkdir -p "$RULES_DIR"
  clone_dir "$SOURCE_RULES/rulepacks" "$RULES_DIR/rulepacks"
  [ -f "$SOURCE_RULES/rulepacks.sha256" ] && cp "$SOURCE_RULES/rulepacks.sha256" "$RULES_DIR/"
  # No vuln-db, on purpose — see the header.
  echo "Staged rulepacks into $RULES_DIR (vulnerability database deliberately absent)."
}

case "${1:-}" in
  run)
    shift
    stage_rules
    echo "Resetting the demo stack — the journey starts from an EMPTY install."
    ./deploy/demo.sh reset
    ./deploy/demo.sh up

    mkdir -p "$EVIDENCE_DIR"
    started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    tip="$(git rev-parse --short HEAD)"
    dirty="$(git status --porcelain | wc -l | tr -d ' ')"

    set +e
    JOURNEY_BASE_URL="$URL" \
    JOURNEY_EVIDENCE_DIR="$EVIDENCE_DIR" \
    JOURNEY_CTL="deploy/journey.sh" \
      pnpm exec playwright test -c playwright.journey.config.ts "$@"
    rc=$?
    set -e

    # What the product actually said to its services, kept beside the screens.
    # Logs are gitignored (*.log); the fixture-model line extract is not, and it
    # is the record that the checklist's request reached a model.
    for svc in model worker api forge; do
      compose logs --no-color "$svc" >"$EVIDENCE_DIR/compose-$svc.log" 2>&1 || true
    done
    grep -h '\[fixture-model\]' "$EVIDENCE_DIR/compose-model.log" >"$EVIDENCE_DIR/model-requests.txt" || true

    cat >"$EVIDENCE_DIR/run.json" <<EOF
{
  "ticket": "W17-30",
  "tip": "$tip",
  "dirty_paths_at_run": $dirty,
  "started_at": "$started_at",
  "finished_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "exit_code": $rc,
  "stack": "deploy/compose.demo.yaml + $OVERLAY",
  "runtime": "$RT",
  "url": "$URL",
  "scan_rules_dir": "$RULES_DIR"
}
EOF

    echo
    if [ "$rc" = 0 ]; then
      echo "JOURNEY PASSED. Evidence: $EVIDENCE_DIR"
    else
      echo "JOURNEY FAILED (exit $rc). Evidence and logs: $EVIDENCE_DIR" >&2
    fi
    echo "The stack is still up at $URL — ./deploy/journey.sh down stops it."
    exit "$rc"
    ;;

  ctl)
    action="${2:-}"
    target="${3:-}"
    case "$action" in
      stop|start|restart)
        # Only the services a drill is allowed to touch. Killing postgres would
        # be a different test and not one anyone asked for.
        case "$target" in
          worker|model) ;;
          *)
            echo "ctl $action: refusing '$target' — only worker and model are drill targets." >&2
            exit 2
            ;;
        esac
        compose "$action" "$target"
        echo "ctl: $action $target done"
        ;;
      vulndb)
        case "$target" in
          attach)
            if [ ! -d "$SOURCE_RULES/vuln-db" ]; then
              echo "ctl vulndb attach: no database under $SOURCE_RULES/vuln-db — run ./deploy/scan-db-sync.sh first." >&2
              exit 1
            fi
            remove_dir "$RULES_DIR/vuln-db"
            clone_dir "$SOURCE_RULES/vuln-db" "$RULES_DIR/vuln-db"
            echo "ctl: vulnerability database attached at $RULES_DIR/vuln-db"
            ;;
          detach)
            remove_dir "$RULES_DIR/vuln-db"
            echo "ctl: vulnerability database detached"
            ;;
          *)
            echo "usage: $0 ctl vulndb attach|detach" >&2
            exit 2
            ;;
        esac
        ;;
      *)
        echo "usage: $0 ctl stop|start|restart worker|model  |  ctl vulndb attach|detach" >&2
        exit 2
        ;;
    esac
    ;;

  down)
    ./deploy/demo.sh down
    ;;

  *)
    echo "usage: $0 run [playwright args] | ctl ... | down" >&2
    exit 2
    ;;
esac
